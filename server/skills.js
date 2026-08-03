// Hermes-style procedural memory: skills.
//
// When the user repeats a task shape (or says "remember this as a skill"),
// the avatar asks the LLM to distill it into a reusable skill: a trigger
// phrase + step-by-step instructions. On later requests whose message
// matches a skill trigger, the skill's instructions are injected into the
// system prompt and its usage_count increments (self-reinforcement).

import { randomUUID } from "node:crypto";
import { query } from "./db.js";

const MAX_SKILLS_PER_USER = 50;
const MAX_TRIGGER_CHARS = 120;
const MAX_INSTRUCTIONS_CHARS = 1500;
const MAX_NAME_CHARS = 80;
const MAX_DESC_CHARS = 200;

const DETECT_PROMPT = `You distill a user request into a reusable skill for an AI companion.
The user just asked the assistant to do a task. If this looks like a repeatable task (not a one-off question), extract:
- name: short camel-case name
- description: one line about what it does
- trigger: a phrase the user might say again to ask for this (lowercase, e.g. "summarize my emails", "make a study plan")
- instructions: 2-5 concise steps the assistant should follow
Return ONLY a JSON object:
{"skill":true,"name":"...","description":"...","trigger":"...","instructions":"..."}
If it's NOT a repeatable task (greeting, one-off question, small talk), return {"skill":false}.`;

/**
 * Ask the LLM whether a user message represents a skill-worthy, repeatable
 * task and, if so, distill it into a skill. Never throws.
 */
export async function detectSkill(userMessage) {
  try {
    const apiKey = process.env.NVIDIA_API_KEY;
    const baseUrl = process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
    const model = process.env.NVIDIA_MODEL || "moonshotai/kimi-k2.6";
    if (!apiKey) return null;

    const payload = {
      model,
      messages: [
        { role: "system", content: DETECT_PROMPT },
        { role: "user", content: String(userMessage || "").slice(0, 600) },
      ],
      max_tokens: 400,
      temperature: 0.2,
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
    if (!response.ok) return null;

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const parsed = JSON.parse(
      match[0].replace(/"((?:[^"\\]|\\.)*?)"/g, (m) => m.replace(/\r?\n/g, "\\n"))
    );
    if (!parsed.skill) return null;

    const skill = {
      name: String(parsed.name || "").trim().slice(0, MAX_NAME_CHARS),
      description: String(parsed.description || "").trim().slice(0, MAX_DESC_CHARS),
      trigger: String(parsed.trigger || "").trim().toLowerCase().slice(0, MAX_TRIGGER_CHARS),
      instructions: String(parsed.instructions || "").trim().slice(0, MAX_INSTRUCTIONS_CHARS),
    };
    if (!skill.name || !skill.trigger || !skill.instructions) return null;
    return skill;
  } catch {
    return null;
  }
}

/** Create a skill for a user. Returns the row, or null over the cap/dup name. */
export async function createSkill(userId, skill) {
  const name = String(skill.name || "").trim().slice(0, MAX_NAME_CHARS);
  const trigger = String(skill.trigger || "").trim().toLowerCase().slice(0, MAX_TRIGGER_CHARS);
  const instructions = String(skill.instructions || "").trim().slice(0, MAX_INSTRUCTIONS_CHARS);
  if (!name || !trigger || !instructions) return null;

  const { rows } = await query(
    "SELECT count(*)::int AS n FROM skills WHERE user_id = $1",
    [userId]
  );
  if (rows[0]?.n >= MAX_SKILLS_PER_USER) return null;

  const { rows: dup } = await query(
    "SELECT id FROM skills WHERE user_id = $1 AND LOWER(name) = LOWER($2)",
    [userId, name]
  );
  if (dup[0]) return null;

  const id = randomUUID();
  await query(
    `INSERT INTO skills (id, user_id, name, description, trigger, instructions)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      userId,
      name,
      String(skill.description || "").trim().slice(0, MAX_DESC_CHARS),
      trigger,
      instructions,
    ]
  );
  return { id, name, description: skill.description, trigger, instructions };
}

/** List a user's skills (most used first). */
export async function listSkills(userId) {
  const { rows } = await query(
    `SELECT id, name, description, trigger, instructions, usage_count
       FROM skills
      WHERE user_id = $1
      ORDER BY usage_count DESC, created_at ASC`,
    [userId]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    trigger: r.trigger,
    instructions: r.instructions,
    usageCount: Number(r.usage_count),
  }));
}

/** Delete a skill (scoped to the user). */
export async function deleteSkill(userId, id) {
  const { rowCount } = await query(
    "DELETE FROM skills WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rowCount > 0;
}

/**
 * Find skills whose trigger phrase appears in the user's message. Returns
 * their instructions as a single string block to inject into the system
 * prompt, and bumps usage_count. Never throws.
 */
export async function matchSkills(userId, userMessage) {
  try {
    const text = String(userMessage || "").toLowerCase();
    const { rows } = await query(
      "SELECT id, name, trigger, instructions FROM skills WHERE user_id = $1",
      [userId]
    );
    const hits = rows.filter(
      (s) => s.trigger && text.includes(s.trigger.toLowerCase())
    );
    if (hits.length === 0) return null;

    await query(
      "UPDATE skills SET usage_count = usage_count + 1, last_used_at = now() WHERE id = ANY($1::text[])",
      [hits.map((s) => s.id)]
    );

    const parts = hits.map(
      (s) => `SKILL "${s.name}" (activated — follow these steps):\n${s.instructions}`
    );
    return (
      "The user's message activates the following saved skill(s). Follow them carefully, " +
      "and mention you used the skill when relevant.\n\n" +
      parts.join("\n\n")
    );
  } catch {
    return null;
  }
}
