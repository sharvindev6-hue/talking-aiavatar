import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query } from "../db.js";
import { requireAuth } from "../auth.js";
import { scrubSecrets, createRateLimiter } from "../security.js";
import {
  buildMemoryBlock,
  catchUpMemory,
  extractMemoryForSession,
} from "../memory.js";
import {
  looksLikeReminder,
  parseReminderIntent,
  createReminder,
} from "../reminders.js";
import { detectSkill, createSkill, matchSkills } from "../skills.js";
import { currentTimeBlock, webSearch } from "../tools.js";

const MAX_MESSAGE_CHARS = 10000; // bounds LLM cost per request

const SYSTEM_PROMPT =
  'You are Kimi. Reply ONLY with JSON: {"say":"hello","emotion":"happy","gesture":"none"}. When asked for a list of answers, include every single one, fully and completely.';

const FEW_SHOT = [
  { role: "user", content: "Hello" },
  {
    role: "assistant",
    content: '{"say":"Hi there!","emotion":"happy","gesture":"none"}',
  },
];

const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024; // 4 MB per file (base64-decoded)

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

async function callModel({ apiKey, baseUrl, model, messages, maxTokens = 2048, onDelta }) {
  const payload = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.1,
    stream: !!onDelta,
  };
  // Kimi NIM expects this flag; other models reject unknown params.
  if (model.startsWith("moonshotai/")) {
    payload.chat_template_kwargs = { thinking: false };
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    let message = text.slice(0, 300) || `NVIDIA error ${response.status}`;
    try {
      const j = JSON.parse(text);
      if (j?.error?.message) message = String(j.error.message).slice(0, 300);
    } catch {
      /* keep the raw body */
    }
    // NVIDIA error text can include the raw API key — scrub before it
    // reaches a client or the logs.
    throw new Error(scrubSecrets(message));
  }

  // Streaming mode: parse OpenAI-compatible SSE chunks and emit deltas as
  // they arrive, while still accumulating the full text for the final parse.
  if (onDelta && response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const data = t.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          const delta = j.choices?.[0]?.delta?.content || "";
          if (delta) {
            content += delta;
            onDelta(delta, content);
          }
        } catch {
          /* ignore malformed chunk */
        }
      }
    }
    const parsed = parseAssistantJson(content);
    return { data: null, content, parsed };
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";
  const parsed = parseAssistantJson(content);
  return { data, content, parsed };
}

/** Validate and normalize an attachment from the client. */
function sanitizeAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw.slice(0, MAX_ATTACHMENTS)) {
    if (!a?.dataUrl) continue;

    const dataUrl = String(a.dataUrl);
    // Only accept data URLs, and only for types they claim to be.
    if (!dataUrl.startsWith("data:")) continue;
    if (!dataUrl.includes(",")) continue;

    const name = String(a.name || "file").slice(0, 120);

    // Derive the real MIME type from the data URL itself, then validate it.
    // The client may compress images (e.g. PNG -> JPEG), so the declared type
    // can't be trusted to match — but the data URL prefix is authoritative.
    const mimeMatch = dataUrl.match(/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);/i);
    const mime = mimeMatch ? mimeMatch[1].toLowerCase() : null;
    if (!mime) continue;

    let type;
    if (IMAGE_TYPES.has(mime)) {
      type = mime; // real image data URL (png/jpeg/webp/gif)
    } else if (mime.startsWith("image/")) {
      continue; // reject scriptable image types like image/svg+xml
    } else {
      // Non-image files (pdf, txt, doc, ...): neutralize to octet-stream so
      // a crafted data:text/html payload can't render as a live page.
      type = "application/octet-stream";
    }

    try {
      const base64 = dataUrl.split(",")[1] || "";
      // Cheap pre-check before decoding: base64 is ~4/3 the binary size.
      if (base64.length > Math.ceil(MAX_ATTACHMENT_BYTES * 1.4) + 16) continue;
      const size = atob(base64).length;
      if (size > MAX_ATTACHMENT_BYTES) continue;
      // For non-image files, wrap the payload in a neutral octet-stream
      // data URL so a crafted payload can't render as a live page.
      const safeDataUrl =
        type === "application/octet-stream"
          ? `data:application/octet-stream;base64,${base64}`
          : dataUrl;

      // Carry the extracted document content (from the client) so the LLM
      // can actually read the file. Capped to keep payloads reasonable.
      const extractedText = String(a.extractedText || "")
        .trim()
        .slice(0, 20000) || null;

      // Rasterized pages for scanned PDFs — only accept raster image data
      // URLs (png/jpeg/webp). SVG can carry scripts; pdf.js rasterizes to
      // JPEG anyway, so there's no legit reason to accept it.
      const pageImages = Array.isArray(a.pageImages)
        ? a.pageImages
            .slice(0, 3)
            .filter((u) =>
              typeof u === "string" &&
              /^data:image\/(png|jpe?g|webp);base64,/.test(u)
            )
            .map((u) => u.slice(0, 3_000_000))
        : [];

      out.push({ name, type, size, dataUrl: safeDataUrl, extractedText, pageImages });
    } catch {
      continue;
    }
  }
  return out;
}

/** Build the LLM user content: plain string, or multimodal when images exist. */
function buildUserContent(message, attachments, { vision = true } = {}) {
  const images = attachments.filter((a) => IMAGE_TYPES.has(a.type));
  const files = attachments.filter((a) => !IMAGE_TYPES.has(a.type));
  const pageImages = attachments.flatMap((a) => a.pageImages || []);

  const hasMultimodal = images.length > 0 || pageImages.length > 0;

  const textParts = [];
  if (message) textParts.push(message);
  for (const f of files) {
    if (f.extractedText) {
      textParts.push(`[File: ${f.name}]\n${f.extractedText}`);
    } else {
      // Always mention attached files, even alongside images.
      textParts.push(`[Attached file: ${f.name}]`);
    }
  }

  if (textParts.length === 0) {
    textParts.push("What can you tell me about this attachment?");
  }

  // Non-vision models reject content arrays ("multimodal processing is not
  // enabled"), so document text must be inline text rather than an array.
  // When the active model can't see images, describe them as text instead
  // of sending image_url parts (which would hard-fail the whole request).
  if (!hasMultimodal || !vision) {
    for (const img of images) {
      textParts.push(`[Image: ${img.name}]`);
    }
    for (let i = 0; i < pageImages.length; i++) {
      textParts.push(`[Scanned page ${i + 1}]`);
    }
    return textParts.join("\n\n");
  }

  const content = [{ type: "text", text: textParts.join("\n\n") }];
  for (const img of images) {
    content.push({ type: "image_url", image_url: { url: img.dataUrl } });
  }
  for (const pi of pageImages) {
    content.push({ type: "image_url", image_url: { url: pi } });
  }
  return content;
}

/** Rebuild a stored user message as LLM content (multimodal if it had images). */
function historyUserContent(m, vision = true) {
  let attachments = [];
  try {
    attachments = m.attachments || [];
  } catch {
    attachments = [];
  }
  return buildUserContent(m.content || "", attachments, { vision });
}

/** Does a stored message carry images the model must be able to see? */
function messageHasImages(m) {
  let attachments = [];
  try {
    attachments = m.attachments || [];
  } catch {
    attachments = [];
  }
  return (
    attachments.some((a) => IMAGE_TYPES.has(a.type)) ||
    attachments.some((a) => (a.pageImages || []).length > 0)
  );
}

/** Persist one message and bump the session's updated_at. */
async function saveMessage(sessionId, { role, content, raw, emotion, gesture, attachments }) {
  const id = randomUUID();
  await query(
    `INSERT INTO messages (id, session_id, role, content, raw, emotion, gesture, attachments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      sessionId,
      role,
      content,
      raw || content,
      emotion || "neutral",
      gesture || "none",
      JSON.stringify(attachments || []),
    ]
  );
  await query("UPDATE chat_sessions SET updated_at = now() WHERE id = $1", [
    sessionId,
  ]);
}

export function createChatRouter() {
  const router = Router();

  // POST /api/chat { sessionId, message, attachments } — requires login
  router.post(
    "/",
    createRateLimiter({ windowMs: 60_000, max: 60 }), // per-IP shield
    requireAuth,
    createRateLimiter({
      windowMs: 60_000,
      max: 40,
      key: (req) => `u:${req.user.id}`,
    }),
    async (req, res, next) => {
    const apiKey = process.env.NVIDIA_API_KEY;
    const baseUrl = process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
    const model = process.env.NVIDIA_MODEL || "moonshotai/kimi-k2.6";
    const visionModel = process.env.VISION_MODEL || "meta/llama-3.2-90b-vision-instruct";

    // Hermes-style streaming: when the client asks, reply with Server-Sent
    // Events instead of a JSON blob — deltas flow in as the model generates.
    const stream = req.body?.stream === true;
    const sse = (event, data) => {
      if (stream) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const sendError = (status, error) => {
      if (stream) {
        if (!res.headersSent) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
        }
        sse("error", { error });
        res.end();
      } else {
        res.status(status).json({ error });
      }
    };

    if (!apiKey) {
      sendError(500, "NVIDIA API key not configured");
      return;
    }

    const { sessionId, attachments } = req.body || {};
    // Only plain strings are accepted as messages (an object/array body
    // would otherwise throw or slip through as "[object Object]").
    const message = typeof req.body?.message === "string" ? req.body.message : "";
    if (!sessionId) {
      sendError(400, "sessionId required");
      return;
    }
    if (!message.trim() && (!attachments || attachments.length === 0)) {
      sendError(400, "message required");
      return;
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      sendError(400, "Message is too long");
      return;
    }

    try {
      // The session must belong to the logged-in user.
      const session = await query(
        "SELECT * FROM chat_sessions WHERE id = $1 AND user_id = $2",
        [sessionId, req.user.id]
      );
      if (!session.rows[0]) {
        sendError(404, "Session not found");
        return;
      }

      const clean = sanitizeAttachments(attachments);
      const hasImages = messageHasImages({ attachments: clean });

      // Load full conversation history so the LLM has context across reloads.
      const hist = await query(
        "SELECT role, raw, content, attachments FROM messages WHERE session_id = $1 ORDER BY created_at ASC",
        [sessionId]
      );

      // If ANY message in the thread contains images, the whole conversation
      // must use the vision model — otherwise the non-vision model hard-fails
      // on the multimodal history (and the avatar would "forget" images).
      const useVision = hasImages || hist.rows.some(messageHasImages);
      const activeModel = useVision ? visionModel : model;

      // Long-term memory: serverless-safe catch-up (learn the previous
      // exchange now if the post-response extraction was killed) + real
      // facts & session summaries injected as a [MEMORY] block. Memory is
      // best-effort — a hiccup must never break the chat reply.
      await catchUpMemory(req.user.id, sessionId);
      let memoryBlock = null;
      try {
        memoryBlock = await buildMemoryBlock(req.user.id, sessionId);
      } catch {
        memoryBlock = null;
      }

      // Hermes-style automations: if the user asked for a reminder, parse it
      // and create it BEFORE the reply so the avatar can confirm naturally.
      let reminderNote = null;
      if (looksLikeReminder(message)) {
        try {
          const parsedReminder = await parseReminderIntent(message);
          if (parsedReminder.reminder) {
            const created = await createReminder(req.user.id, {
              message: parsedReminder.message,
              when: parsedReminder.when,
              whenText: message.trim().slice(0, 120),
            });
            if (created) {
              reminderNote =
                `A reminder was just created for the user: "${created.message}" ` +
                `scheduled for ${new Date(created.nextFireAt).toLocaleString()}. ` +
                `Confirm it briefly and warmly in your reply.`;
            }
          }
        } catch {
          /* reminder parsing is best-effort */
        }
      }

      // Hermes-style procedural memory: if a saved skill's trigger matches
      // this message, inject its instructions.
      let skillBlock = null;
      try {
        skillBlock = await matchSkills(req.user.id, message);
      } catch {
        skillBlock = null;
      }

      // Hermes-style skill creation: if the user explicitly asks to remember
      // a task as a skill, distill and save it before replying.
      let skillCreatedNote = null;
      if (/remember this as a skill|save this as a skill|create a skill/i.test(message)) {
        try {
          const detected = await detectSkill(message);
          if (detected) {
            const saved = await createSkill(req.user.id, detected);
            if (saved) {
              skillCreatedNote =
                `The user asked you to save a skill. You just created skill "${saved.name}" ` +
                `(trigger: "${saved.trigger}"). Tell them it's saved and how to use it.`;
            }
          }
        } catch {
          /* skill creation is best-effort */
        }
      }

      const extraBlocks = [
        currentTimeBlock(),
        memoryBlock,
        skillBlock,
        reminderNote,
        skillCreatedNote,
      ].filter(Boolean);
      const systemContent = extraBlocks.length
        ? `${SYSTEM_PROMPT}\n\n${extraBlocks.join("\n\n")}`
        : SYSTEM_PROMPT;

      const buildLlmMessages = (userText) => [
        { role: "system", content: systemContent },
        ...FEW_SHOT,
        ...hist.rows.map((m) =>
          m.role === "user"
            ? { role: "user", content: historyUserContent(m, useVision) }
            : { role: "assistant", content: m.raw || m.content }
        ),
        {
          role: "user",
          content: buildUserContent(userText, clean, { vision: useVision }),
        },
      ];

      // Begin the SSE stream just before the first model call so errors
      // that happened earlier still produce a clean JSON/SSE error.
      if (stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        sse("start", { sessionId });
      }
      const streamDelta = stream
        ? (delta, full) => sse("delta", { delta, full })
        : undefined;

      let result = await callModel({
        apiKey,
        baseUrl,
        model: activeModel,
        messages: buildLlmMessages(message.trim()),
        maxTokens: 2048,
        onDelta: streamDelta,
      });

      // Hermes-style tool use: run up to 2 tool iterations. If the model
      // asks for a web search, execute it server-side and feed the results
      // back as a follow-up turn so it can answer from real data.
      for (let toolRound = 0; toolRound < 2; toolRound++) {
        if (!/\{\s*"tool"\s*:\s*"web_search"/.test(result.content)) break;
        const qm = result.content.match(/"query"\s*:\s*"((?:[^"\\]|\\.)*?)\s*"/);
        const query = qm ? qm[1].replace(/\\"/g, '"') : null;
        if (!query) break;
        const searchBlock = await webSearch(query);
        if (!searchBlock) break;
        if (stream) sse("reset", { reason: "tool" });
        result = await callModel({
          apiKey,
          baseUrl,
          model: activeModel,
          messages: [
            ...buildLlmMessages(message.trim()),
            { role: "assistant", content: result.content },
            {
              role: "user",
              content:
                searchBlock +
                "\n\nNow answer the user's original question using these results. Reply with the usual JSON envelope.",
            },
          ],
          maxTokens: 2048,
          onDelta: streamDelta,
        });
      }

      if (!isValidParsed(result.parsed, message)) {
        // Retry with the same history (and images) so context is never lost.
        // Add a direct instruction so stub replies ("Here are the answers:")
        // get pushed to actually output the full content.
        const retryText =
          message.trim() ||
          "Describe the attached image in a friendly sentence." +
          "\n\nIMPORTANT: Write out the complete answer now, all of it. Do not just acknowledge or promise — output the full content immediately.";
        if (stream) sse("reset", { reason: "retry" });
        result = await callModel({
          apiKey,
          baseUrl,
          model: activeModel,
          messages: buildLlmMessages(retryText),
          maxTokens: 2048,
          onDelta: streamDelta,
        });
      }

      if (!isValidParsed(result.parsed)) {
        result.parsed = {
          say: hasImages
            ? "I can see your image! Tell me more about it."
            : "Hi! I'm here and ready to chat.",
          emotion: "happy",
          gesture: "none",
        };
      }

      // Persist the exchange (attachments live on the user message).
      await saveMessage(sessionId, {
        role: "user",
        content: message.trim() || `[${clean.length} attachment(s)]`,
        attachments: clean,
      });
      await saveMessage(sessionId, {
        role: "assistant",
        content: result.parsed.say,
        raw: result.content,
        emotion: result.parsed.emotion,
        gesture: result.parsed.gesture,
      });

      // Auto-title the session from the first user message.
      if (hist.rows.length === 0) {
        const title =
          message.trim().slice(0, 48) ||
          (clean.length > 0 ? `Shared ${clean[0].name}` : "New chat");
        await query("UPDATE chat_sessions SET title = $1 WHERE id = $2", [
          title,
          sessionId,
        ]);
      }

      // Learn from this exchange in the background (best-effort, never blocks
      // the reply). On serverless deploys the function may return before the
      // extraction finishes — the next request will still recall the facts
      // that did land, and the memory drawer stays consistent.
      extractMemoryForSession(req.user.id, sessionId);

      if (stream) {
        sse("done", { content: result.content, parsed: result.parsed });
        res.end();
      } else {
        res.json({ content: result.content, parsed: result.parsed });
      }
    } catch (err) {
      if (stream && res.headersSent) {
        sse("error", { error: "Reply stream failed — please try again." });
        res.end();
        return;
      }
      next(err);
    }
    }
  );

  return router;
}

function isValidParsed(parsed, userMessage) {
  const say = parsed?.say?.trim();
  if (!say || say.length <= 2 || say.length >= 8000 || say.startsWith("Sorry")) {
    return false;
  }
  // Reject stub replies ("Here are the answers:") when the user clearly
  // asked for a full list — retry with a direct instruction instead.
  if (
    say.length < 60 &&
    /\b(?:all|every|complete|toutes|tous|liste|list|answers|réponses)\b/i.test(
      userMessage || ""
    )
  ) {
    return false;
  }
  return true;
}

export function parseAssistantJson(raw) {
  let trimmed = (raw || "").trim();
  trimmed = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  // The model sometimes emits one JSON object PER ANSWER, concatenated
  // (e.g. {"say":"1. ..."} {"say":"2. ..."}). When we see more than one
  // "say" key, join all of their values into a single complete reply.
  const anchoredSays = [
    ...trimmed.matchAll(/"say"\s*:\s*"([\s\S]*?)"\s*,\s*"(?:emotion|gesture)"/g),
  ].map((m) => m[1].replace(/\\"/g, '"'));
  const plainSays = [
    ...trimmed.matchAll(/"say"\s*:\s*"((?:[^"\\]|\\.)*?)"/g),
  ].map((m) => m[1].replace(/\\"/g, '"'));
  const says = anchoredSays.length >= 2 ? anchoredSays : plainSays;
  // Only join when there are actually 2+ JSON objects (2+ "{" braces) —
  // otherwise a single reply that merely quotes "say" text would be falsely
  // joined into fragments. The model may interleave question text between
  // objects, so brace counting (not a "}{" boundary) is the safe signal.
  if (says.length >= 2 && (trimmed.match(/\{/g) || []).length >= 2) {
    const emotions = [...trimmed.matchAll(/"emotion"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
    const gestures = [...trimmed.matchAll(/"gesture"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
    return {
      say: says.join("\n\n").slice(0, 8000),
      emotion: emotions.length ? emotions[emotions.length - 1] : "neutral",
      gesture: gestures.length ? gestures[gestures.length - 1] : "none",
    };
  }

  // 1. Try the outermost JSON object (greedy: match the LAST closing brace,
  //    so nested braces or braces inside strings don't truncate the parse).
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    // Models sometimes emit literal newlines inside string values, which is
    // invalid JSON — repair them within quoted strings before parsing.
    const repaired = jsonMatch[0].replace(/"((?:[^"\\]|\\.)*?)"/g, (m) =>
      m.replace(/\r?\n/g, "\\n")
    );
    try {
      const parsed = normalizeParsed(JSON.parse(repaired), trimmed);
      if (parsed.say) return parsed;
    } catch {
      /* fall through */
    }
  }

  // 2. Repair truncated/malformed JSON: pull out the "say" value directly.
  //    Anchor on the following "emotion"/"gesture" key (the prompt always
  //    emits them) so embedded literal quotes inside the reply don't
  //    truncate it. No length cap here — replies can be long lists.
  const sayMatch =
    trimmed.match(/"say"\s*:\s*"([\s\S]*?)"\s*,\s*"(?:emotion|gesture)"/) ||
    trimmed.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (sayMatch) {
    const say = sayMatch[1].replace(/\\"/g, '"').trim();
    if (say) return { say: say.slice(0, 8000), emotion: "neutral", gesture: "none" };
  }

  // 3. First quoted phrase — long enough to never match a bare JSON key
  //    like "say" (which caused replies of just the word "say").
  const quoted = trimmed.match(/"((?:[^"\\]|\\.){8,300})"/);
  if (quoted) {
    return {
      say: quoted[1].replace(/\\"/g, '"'),
      emotion: "happy",
      gesture: "none",
    };
  }

  // 4. First standalone line that isn't JSON punctuation.
  const line = trimmed
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 3 && !l.startsWith("{") && !l.startsWith(">"));
  if (line) {
    return { say: line.slice(0, 300), emotion: "neutral", gesture: "none" };
  }

  return { say: "", emotion: "neutral", gesture: "none" };
}

function normalizeParsed(parsed) {
  return {
    say: String(parsed.say || parsed.reply || "").trim().slice(0, 8000),
    emotion: parsed.emotion || "neutral",
    gesture: parsed.gesture || "none",
  };
}
