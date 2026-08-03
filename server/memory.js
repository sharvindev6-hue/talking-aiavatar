// Hermes-style long-term memory engine.
//
// - After each exchange, an LLM pass extracts durable facts about the user
//   and a short session summary.
// - Facts are deduped (normalized text) and capped per user (LRU eviction).
// - On each chat request, the top facts + recent session summaries are
//   injected as a [MEMORY] system block so the avatar remembers across chats.
// - Users can "forget" things by name (or everything) at any time.
//
// All calls are best-effort: memory extraction must never block or break a
// chat reply, so every public function swallows errors and the caller runs
// them fire-and-forget.

import { randomUUID } from "node:crypto";
import { query } from "./db.js";

const MAX_FACTS_PER_USER = 300; // LRU eviction beyond this
const MAX_FACTS_IN_RECALL = 12; // facts injected per request
const MAX_SUMMARIES_IN_RECALL = 5; // recent session summaries injected per request
const MAX_MEMORY_CHARS = 4000; // total budget for the memory system block
const MAX_FACT_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 1200;

const VALID_CATEGORIES = new Set([
  "preference",
  "personal",
  "project",
  "habit",
  "other",
]);

const EXTRACT_PROMPT = `You are a memory engine for an AI companion. From the conversation below, extract durable facts about the user and write a short summary.

Rules:
- Only extract facts the USER stated or that are clearly implied as stable preferences, personal details, projects, or habits.
- Skip transient things (a single question, a one-off greeting, conversation filler).
- Write each fact as a short standalone phrase (e.g. "likes French literature", "studies in high school", "prefers short answers").
- category is one of: preference | personal | project | habit | other
- confidence is 1 when the user stated it directly, 0 when it's only implied.
- Keep facts distinct — do not repeat the same fact with different wording.

Reply with ONLY a JSON object, no markdown, no commentary:
{"facts":[{"fact":"...","category":"...","confidence":1}],"summary":"one or two sentences capturing what this conversation was about","key_points":["short bullet","short bullet"]}`;

/**
 * Pure helper: normalize a fact for dedupe (lowercase, collapse whitespace,
 * strip trailing punctuation).
 */
export function normalizeFact(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/g, "")
    .slice(0, MAX_FACT_LENGTH);
}

/**
 * Pure helper: does fact `a` already cover fact `b`? Uses normalized exact
 * match, or one normalized string containing the other (min length guard so
 * short words like "work" don't over-match).
 */
export function factsOverlap(a, b) {
  const na = normalizeFact(a);
  const nb = normalizeFact(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const short = na.length <= nb.length ? na : nb;
  const long = na.length >= nb.length ? na : nb;
  return short.length >= 12 && long.includes(short);
}

/** Parse the LLM's extraction reply into { facts, summary, keyPoints }. */
export function parseExtraction(raw) {
  const out = { facts: [], summary: "", keyPoints: [] };
  const text = String(raw || "").trim();
  if (!text) return out;

  // 1. Try strict JSON (greedy outermost object).
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(
        jsonMatch[0].replace(/"((?:[^"\\]|\\.)*?)"/g, (m) =>
          m.replace(/\r?\n/g, "\\n")
        )
      );
      if (Array.isArray(parsed.facts)) {
        for (const f of parsed.facts.slice(0, 20)) {
          const fact = String(f?.fact || "").trim().slice(0, MAX_FACT_LENGTH);
          if (!fact) continue;
          const category = VALID_CATEGORIES.has(f?.category)
            ? f.category
            : "other";
          out.facts.push({
            fact,
            category,
            confidence: Number(f?.confidence) === 0 ? 0 : 1,
          });
        }
      }
      out.summary = String(parsed.summary || "").trim().slice(0, MAX_SUMMARY_LENGTH);
      if (Array.isArray(parsed.key_points)) {
        out.keyPoints = parsed.key_points
          .filter((k) => typeof k === "string")
          .map((k) => k.trim().slice(0, 200))
          .filter(Boolean)
          .slice(0, 8);
      }
      return out;
    } catch {
      /* fall through to regex */
    }
  }

  // 2. Loose fallback: pull "fact"/"summary" string values with a regex.
  for (const m of text.matchAll(/"fact"\s*:\s*"((?:[^"\\]|\\.)*?)"/g)) {
    const fact = m[1].replace(/\\"/g, '"').trim().slice(0, MAX_FACT_LENGTH);
    if (fact) out.facts.push({ fact, category: "other", confidence: 1 });
  }
  const sum = text.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*?)"/);
  if (sum) out.summary = sum[1].replace(/\\"/g, '"').trim().slice(0, MAX_SUMMARY_LENGTH);
  return out;
}

/**
 * Run the extraction LLM pass for a session's recent messages and persist
 * facts + a session summary. Call fire-and-forget; never throws.
 */
/**
 * Serverless-safe memory catch-up. Called at the START of each chat request:
 * if this session has messages newer than its last summary, run extraction
 * now (awaited, but cheap) so production memory actually persists — the
 * fire-and-forget path after res.json() can be killed by lambda teardown.
 * Never throws.
 */
export async function catchUpMemory(userId, sessionId) {
  try {
    const [{ rows: newest }, { rows: summaries }] = await Promise.all([
      query(
        "SELECT MAX(created_at) AS t FROM messages WHERE session_id = $1",
        [sessionId]
      ),
      query(
        "SELECT updated_at FROM session_summaries WHERE session_id = $1",
        [sessionId]
      ),
    ]);
    const lastMsg = newest[0]?.t ? new Date(newest[0].t) : null;
    const summarizedAt = summaries[0]?.updated_at
      ? new Date(summaries[0].updated_at)
      : null;
    // Nothing newer than the last summary → already up to date.
    if (!lastMsg) return null;
    if (summarizedAt && lastMsg <= summarizedAt) return null;
    return extractMemoryForSession(userId, sessionId);
  } catch {
    return null; // memory must never break the chat reply
  }
}

export async function extractMemoryForSession(userId, sessionId) {
  try {
    const apiKey = process.env.NVIDIA_API_KEY;
    const baseUrl = process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
    const model = process.env.NVIDIA_MODEL || "moonshotai/kimi-k2.6";
    if (!apiKey) return null;

    // Recent messages (user + assistant) to learn from. Cap so long sessions
    // stay cheap: last 10 messages or since the last summary, whichever smaller.
    const { rows: msgs } = await query(
      `SELECT role, content FROM messages
        WHERE session_id = $1
        ORDER BY created_at DESC LIMIT 10`,
      [sessionId]
    );
    if (msgs.length < 2) return null;

    const transcript = msgs
      .reverse()
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${String(m.content || "").slice(0, 1500)}`)
      .join("\n\n")
      .slice(0, 12000);

    const payload = {
      model,
      messages: [
        { role: "system", content: EXTRACT_PROMPT },
        { role: "user", content: `Conversation:\n\n${transcript}` },
      ],
      max_tokens: 700,
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
    if (!response.ok) return null;

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";
    const extracted = parseExtraction(content);
    if (extracted.facts.length === 0 && !extracted.summary) return null;

    await saveFacts(userId, extracted.facts, sessionId);
    await saveSummary(userId, sessionId, extracted.summary, extracted.keyPoints);
    return extracted;
  } catch {
    return null; // memory extraction is best-effort — never break the chat
  }
}

/** Persist new facts with dedupe + per-user cap (LRU eviction). */
async function saveFacts(userId, facts, sessionId) {
  if (!facts?.length) return;

  const { rows: existing } = await query(
    "SELECT id, fact, last_used_at FROM memory_facts WHERE user_id = $1",
    [userId]
  );

  for (const f of facts) {
    const dup = existing.find((e) => factsOverlap(e.fact, f.fact));
    if (dup) {
      // Refresh recency so frequently-referenced facts stay in recall.
      await query(
        "UPDATE memory_facts SET last_used_at = now(), confidence = GREATEST(confidence, $1) WHERE id = $2",
        [f.confidence, dup.id]
      );
      continue;
    }
    await query(
      `INSERT INTO memory_facts (id, user_id, fact, category, confidence, source_session_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        userId,
        f.fact,
        VALID_CATEGORIES.has(f.category) ? f.category : "other",
        f.confidence,
        sessionId,
      ]
    );
  }

  // LRU eviction: keep only the most recent MAX_FACTS_PER_USER.
  const { rows: all } = await query(
    "SELECT id FROM memory_facts WHERE user_id = $1 ORDER BY COALESCE(last_used_at, created_at) DESC",
    [userId]
  );
  if (all.length > MAX_FACTS_PER_USER) {
    const excess = all.slice(MAX_FACTS_PER_USER).map((r) => r.id);
    await query("DELETE FROM memory_facts WHERE id = ANY($1::text[])", [excess]);
  }
}

/** Upsert the LLM summary of a session. */
async function saveSummary(userId, sessionId, summary, keyPoints) {
  if (!summary) return;
  await query(
    `INSERT INTO session_summaries (id, user_id, session_id, summary, key_points)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (session_id) DO UPDATE
       SET summary = EXCLUDED.summary,
           key_points = EXCLUDED.key_points,
           updated_at = now()`,
    [randomUUID(), userId, sessionId, summary, JSON.stringify(keyPoints || [])]
  );
}

/**
 * Build the [MEMORY] system block for a chat request: top facts about the
 * user + recent session summaries. Returns null when there's nothing yet.
 */
export async function buildMemoryBlock(userId, currentSessionId) {
  const [factsRes, sumsRes] = await Promise.all([
    query(
      `SELECT fact, category FROM memory_facts
        WHERE user_id = $1
        ORDER BY COALESCE(last_used_at, created_at) DESC
        LIMIT $2`,
      [userId, MAX_FACTS_IN_RECALL]
    ),
    query(
      `SELECT ss.summary, cs.title, ss.updated_at
         FROM session_summaries ss
         JOIN chat_sessions cs ON cs.id = ss.session_id
        WHERE ss.user_id = $1 AND ss.session_id <> $2
        ORDER BY ss.updated_at DESC
        LIMIT $3`,
      [userId, currentSessionId, MAX_SUMMARIES_IN_RECALL]
    ),
  ]);

  const facts = factsRes.rows;
  const summaries = sumsRes.rows;
  if (facts.length === 0 && summaries.length === 0) return null;

  const parts = [];
  let total = 0;

  if (facts.length > 0) {
    const lines = facts.map(
      (f) => `- ${f.fact}${f.category && f.category !== "other" ? ` (${f.category})` : ""}`
    );
    const block = `[MEMORY — things I know about this user]\n${lines.join("\n")}`;
    parts.push(block);
    total += block.length;
  }

  if (summaries.length > 0) {
    const lines = summaries.map(
      (s) =>
        `- "${s.title || "Untitled"}" (${new Date(s.updated_at).toLocaleDateString()}): ${String(s.summary).slice(0, 300)}`
    );
    const block = `[MEMORY — recent conversations with this user]\n${lines.join("\n")}`;
    if (total + block.length <= MAX_MEMORY_CHARS) parts.push(block);
  }

  if (parts.length === 0) return null;
  return (
    "The following is long-term memory about this user (from past sessions, not the live thread). " +
    "Use it for continuity — reference relevant facts naturally when they fit.\n\n" +
    parts.join("\n\n")
  );
}

/** List a user's stored facts (newest first) for the "What I remember" drawer. */
export async function listFacts(userId) {
  const { rows } = await query(
    `SELECT id, fact, category, confidence, created_at, last_used_at
       FROM memory_facts
      WHERE user_id = $1
      ORDER BY COALESCE(last_used_at, created_at) DESC`,
    [userId]
  );
  return rows;
}

/** List a user's recent session summaries. */
export async function listSummaries(userId) {
  const { rows } = await query(
    `SELECT ss.id, ss.session_id, ss.summary, ss.updated_at, cs.title
       FROM session_summaries ss
       JOIN chat_sessions cs ON cs.id = ss.session_id
      WHERE ss.user_id = $1
      ORDER BY ss.updated_at DESC
      LIMIT 20`,
    [userId]
  );
  return rows;
}

/** Forget a single fact by id (scoped to the user). */
export async function forgetFact(userId, factId) {
  const { rowCount } = await query(
    "DELETE FROM memory_facts WHERE id = $1 AND user_id = $2",
    [factId, userId]
  );
  return rowCount > 0;
}

/**
 * Forget facts matching a phrase (fuzzy). Returns how many were removed.
 * `null` target forgets everything.
 */
export async function forgetMatching(userId, target) {
  if (!target) {
    const { rowCount } = await query("DELETE FROM memory_facts WHERE user_id = $1", [
      userId,
    ]);
    return rowCount;
  }
  const needle = normalizeFact(target);
  const { rows } = await query("SELECT id, fact FROM memory_facts WHERE user_id = $1", [
    userId,
  ]);
  // Substring matching is only trustworthy for reasonably long needles — a
  // 2-4 char needle like "hi" would match the middle of many unrelated
  // facts. Shorter needles fall back to factsOverlap, which enforces a
  // minimum containment length, so nothing unintended gets deleted.
  const canSubstring = needle.length >= 5;
  const hit = rows.filter((r) => {
    const nf = normalizeFact(r.fact);
    if (canSubstring && (nf.includes(needle) || needle.includes(nf))) return true;
    return factsOverlap(r.fact, target);
  });
  if (hit.length === 0) return 0;
  await query("DELETE FROM memory_facts WHERE id = ANY($1::text[])", [
    hit.map((r) => r.id),
  ]);
  return hit.length;
}
