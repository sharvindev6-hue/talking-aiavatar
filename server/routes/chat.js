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

async function callModel({ apiKey, baseUrl, model, messages, maxTokens = 2048 }) {
  const payload = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.1,
    stream: false,
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

    if (!apiKey) {
      res.status(500).json({ error: "NVIDIA API key not configured" });
      return;
    }

    const { sessionId, attachments } = req.body || {};
    // Only plain strings are accepted as messages (an object/array body
    // would otherwise throw or slip through as "[object Object]").
    const message = typeof req.body?.message === "string" ? req.body.message : "";
    if (!sessionId) {
      res.status(400).json({ error: "sessionId required" });
      return;
    }
    if (!message.trim() && (!attachments || attachments.length === 0)) {
      res.status(400).json({ error: "message required" });
      return;
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      res.status(400).json({ error: "Message is too long" });
      return;
    }

    try {
      // The session must belong to the logged-in user.
      const session = await query(
        "SELECT * FROM chat_sessions WHERE id = $1 AND user_id = $2",
        [sessionId, req.user.id]
      );
      if (!session.rows[0]) {
        res.status(404).json({ error: "Session not found" });
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
      const systemContent = memoryBlock
        ? `${SYSTEM_PROMPT}\n\n${memoryBlock}`
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

      let result = await callModel({
        apiKey,
        baseUrl,
        model: activeModel,
        messages: buildLlmMessages(message.trim()),
        maxTokens: 2048,
      });

      if (!isValidParsed(result.parsed, message)) {
        // Retry with the same history (and images) so context is never lost.
        // Add a direct instruction so stub replies ("Here are the answers:")
        // get pushed to actually output the full content.
        const retryText =
          message.trim() ||
          "Describe the attached image in a friendly sentence." +
          "\n\nIMPORTANT: Write out the complete answer now, all of it. Do not just acknowledge or promise — output the full content immediately.";
        result = await callModel({
          apiKey,
          baseUrl,
          model: activeModel,
          messages: buildLlmMessages(retryText),
          maxTokens: 2048,
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

      res.json({ content: result.content, parsed: result.parsed });
    } catch (err) {
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
