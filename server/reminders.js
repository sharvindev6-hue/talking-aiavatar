// Hermes-style scheduled automations: natural-language reminders.
//
// The avatar can create reminders from chat ("remind me tomorrow at 7pm to
// call mom"), list them, and delete them. Delivery is in-app: the client
// polls /api/reminders/due while open, and missed reminders are announced on
// next login. A Vercel cron marks due reminders as fired so state stays
// consistent between polls.

import { randomUUID } from "node:crypto";
import { query } from "./db.js";

const MAX_REMINDERS_PER_USER = 50;
const MAX_MESSAGE_CHARS = 300;
const MAX_WHEN_CHARS = 100;

// Prompts the LLM to turn free-form scheduling language into a fire time.
// We pass the current time so relative phrases ("tomorrow 7pm") resolve to
// an absolute instant.
const PARSE_PROMPT = (nowIso) => `You convert a user's reminder request into a precise schedule.
Current time (server): ${nowIso}
Return ONLY a JSON object:
{"reminder":true,"message":"the thing to be reminded about, cleaned up","when":"ISO 8601 timestamp for when it should fire"}
Rules:
- If this is NOT a reminder request, return {"reminder":false}.
- Resolve relative time ("tomorrow 7pm", "in 2 hours", "next monday 9am") to an absolute ISO timestamp using the current time above.
- If no time is given, default to 1 hour from now.
- The message must be short and about the action the user wants to be reminded of.`;

/**
 * Parse a user message to see if it's a reminder request, using the LLM.
 * Returns { reminder, message, when } or { reminder: false }. Never throws.
 */
export async function parseReminderIntent(userMessage) {
  try {
    const apiKey = process.env.NVIDIA_API_KEY;
    const baseUrl = process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
    const model = process.env.NVIDIA_MODEL || "moonshotai/kimi-k2.6";
    if (!apiKey) return { reminder: false };

    const payload = {
      model,
      messages: [
        { role: "system", content: PARSE_PROMPT(new Date().toISOString()) },
        { role: "user", content: String(userMessage || "").slice(0, 500) },
      ],
      max_tokens: 200,
      temperature: 0.1,
      stream: false,
    };
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
    if (!response.ok) return { reminder: false };

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return { reminder: false };

    const parsed = JSON.parse(
      match[0].replace(/"((?:[^"\\]|\\.)*?)"/g, (m) => m.replace(/\r?\n/g, "\\n"))
    );
    if (!parsed.reminder) return { reminder: false };

    const when = new Date(parsed.when);
    if (Number.isNaN(when.getTime())) return { reminder: false };

    return {
      reminder: true,
      message: String(parsed.message || "").trim().slice(0, MAX_MESSAGE_CHARS),
      when: when.toISOString(),
    };
  } catch {
    return { reminder: false };
  }
}

/** Cheap pre-check: does the message even look like a reminder request? */
export function looksLikeReminder(message) {
  return /(remind me|set a reminder|reminder|wake me|remind us|don'?t forget to|nudge me)/i.test(
    String(message || "")
  );
}

/** Create a reminder. Returns the row or null if over cap. */
export async function createReminder(userId, { message, when, whenText }) {
  const cleanMessage = String(message || "").trim().slice(0, MAX_MESSAGE_CHARS);
  if (!cleanMessage) return null;

  const { rows } = await query(
    "SELECT count(*)::int AS n FROM reminders WHERE user_id = $1 AND enabled",
    [userId]
  );
  if (rows[0]?.n >= MAX_REMINDERS_PER_USER) return null;

  const id = randomUUID();
  await query(
    `INSERT INTO reminders (id, user_id, message, when_text, next_fire_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      id,
      userId,
      cleanMessage,
      String(whenText || "").trim().slice(0, MAX_WHEN_CHARS) || cleanMessage,
      when,
    ]
  );
  return { id, message: cleanMessage, nextFireAt: when };
}

/** List a user's enabled reminders, soonest first. */
export async function listReminders(userId) {
  const { rows } = await query(
    `SELECT id, message, when_text, next_fire_at, fired_count
       FROM reminders
      WHERE user_id = $1 AND enabled
      ORDER BY next_fire_at ASC`,
    [userId]
  );
  return rows.map((r) => ({
    id: r.id,
    message: r.message,
    whenText: r.when_text,
    nextFireAt: r.next_fire_at,
    firedCount: Number(r.fired_count),
  }));
}

/** Delete a reminder (scoped to the user). */
export async function deleteReminder(userId, id) {
  const { rowCount } = await query(
    "DELETE FROM reminders WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rowCount > 0;
}

/**
 * Fetch reminders that are due now. When markFired is true, delivery and
 * the fired-mark happen in ONE atomic UPDATE ... RETURNING so:
 *   - each due reminder is announced exactly once (no cross-tab race), and
 *   - reminders stay enabled until actually delivered, so a reminder that
 *     comes due while the user is away is caught up on next visit.
 * The old Vercel-cron approach disabled reminders globally before the user
 * could ever see them — that silently lost reminders, so it was removed.
 */
export async function getDueReminders(userId, { markFired = false } = {}) {
  if (markFired) {
    const { rows } = await query(
      `UPDATE reminders
          SET fired_count = fired_count + 1, enabled = false
        WHERE user_id = $1 AND enabled AND next_fire_at <= now()
        RETURNING id, message, next_fire_at`,
      [userId]
    );
    return rows.map((r) => ({
      id: r.id,
      message: r.message,
      nextFireAt: r.next_fire_at,
    }));
  }

  const { rows } = await query(
    `SELECT id, message, next_fire_at
       FROM reminders
      WHERE user_id = $1 AND enabled AND next_fire_at <= now()
      ORDER BY next_fire_at ASC`,
    [userId]
  );
  return rows.map((r) => ({
    id: r.id,
    message: r.message,
    nextFireAt: r.next_fire_at,
  }));
}

/**
 * Kept for backward compatibility (old deployments may still call it via
 * cron), but now a no-op: global disabling removed because it silently
 * destroyed reminders before the user's poller could deliver them.
 */
export async function tickDueReminders() {
  return 0;
}
