// Permanent test suite: syntax checks + security/parser unit tests.
// Run with `npm test`. Requires no database, API keys, or network.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrubSecrets, createRateLimiter } from "../server/security.js";
import { parseAssistantJson } from "../server/routes/chat.js";
import {
  normalizeFact,
  factsOverlap,
  parseExtraction,
} from "../server/memory.js";
import { looksLikeReminder } from "../server/reminders.js";
import { currentTimeBlock } from "../server/tools.js";
import { detectSkill, createSkill, listSkills, deleteSkill, matchSkills } from "../server/skills.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let failures = 0;
let checks = 0;
function check(name, cond) {
  checks++;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}`);
  }
}

// --- 1. All server files must parse ---
console.log("syntax:");
for (const dir of ["server", "server/routes"]) {
  const full = path.join(ROOT, dir);
  for (const f of readdirSync(full).filter((x) => x.endsWith(".js"))) {
    checks++;
    try {
      execFileSync(process.execPath, ["--check", path.join(full, f)], {
        stdio: "pipe",
      });
    } catch {
      failures++;
      console.error(`FAIL  syntax: ${dir}/${f}`);
    }
  }
}
console.log(`  ${checks} files parsed`);

// --- 2. Secret scrubbing (API keys must never reach clients/logs) ---
console.log("scrubSecrets:");
check(
  "redacts nvidia key",
  !scrubSecrets("key nvapi-abc123def456ghi789jkl012mno").includes("abc123def456ghi789")
);
check(
  "redacts elevenlabs key",
  !scrubSecrets("bad sk_abcdef0123456789abcdef0123456789").includes("sk_abcdef")
);
check(
  "redacts db connection string",
  !scrubSecrets("conn postgresql://user:hunter2@ep-1.aws.neon.tech/db").includes("hunter2")
);
check(
  "redacts bearer token",
  !scrubSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.token").includes(
    "eyJhbGci"
  )
);
check(
  "redacts xi-api-key header",
  !scrubSecrets("xi-api-key: sk_abcdef0123456789abcdef0123456789").includes("sk_abcdef")
);
check(
  "redacts url with password",
  !scrubSecrets("https://user:secret@example.com").includes("secret")
);
check("leaves plain text intact", scrubSecrets("hello world") === "hello world");

// --- 3. Rate limiter ---
console.log("rate limiter:");
{
  const limit = createRateLimiter({ windowMs: 60_000, max: 3 });
  const req = { ip: "1.2.3.4" };
  let status = 0;
  const res = { setHeader() {}, status(s) { status = s; return this; }, json() {} };
  let allowed = 0;
  for (let i = 0; i < 5; i++) limit(req, res, () => allowed++);
  check("allows up to max", allowed === 3);
  check("rejects with 429 over limit", status === 429);
}

// --- 4. AI reply parser ---
console.log("parseAssistantJson:");
check(
  "parses plain JSON",
  parseAssistantJson('{"say":"Hi","emotion":"happy","gesture":"none"}').say === "Hi"
);
check(
  "repairs truncated JSON",
  parseAssistantJson('{"say": "Only one answer here because the model stopped early.').say.startsWith(
    "Only one answer"
  )
);
check(
  "joins multi-object replies",
  parseAssistantJson(
    '{"say":"1. A","emotion":"neutral","gesture":"none"}{"say":"2. B","emotion":"happy","gesture":"wave"}'
  ).say.includes("2. B")
);
check(
  "handles literal newlines + embedded quotes",
  (() => {
    const raw = '{"say":"a \\"quoted\\" word\\nsecond line","emotion":"neutral","gesture":"none"}';
    const s = parseAssistantJson(raw).say;
    return s.includes("quoted") && s.includes("second line");
  })()
);
check(
  "never emits bare key for truncated JSON",
  !parseAssistantJson('{"say": "Full reply that got cut off mid-answer').say.startsWith("say")
);

// --- 5. Memory engine helpers (pure functions, no DB) ---
console.log("memory helpers:");
check("normalizeFact lowercases + trims", normalizeFact("  Likes Pizza! ") === "likes pizza");
check("normalizeFact strips trailing punct", normalizeFact("Likes Pizza?.") === "likes pizza");
check("factsOverlap exact", factsOverlap("likes pizza", "likes pizza"));
check(
  "factsOverlap containment (long enough)",
  factsOverlap("prefers short answers", "prefers short answers in chat")
);
check(
  "factsOverlap rejects too-short containment",
  !factsOverlap("work", "working on a project")
);
check("factsOverlap rejects unrelated", !factsOverlap("likes pizza", "plays guitar"));
check(
  "parseExtraction strict JSON",
  (() => {
    const out = parseExtraction(
      '{"facts":[{"fact":"likes pizza","category":"preference","confidence":1}],"summary":"Chit-chat about food.","key_points":["pizza"]}'
    );
    return out.facts.length === 1 && out.facts[0].fact === "likes pizza" && out.summary.includes("food");
  })()
);
check(
  "parseExtraction rejects bad category",
  (() => {
    const out = parseExtraction('{"facts":[{"fact":"x","category":"hack","confidence":1}]}');
    return out.facts[0].category === "other";
  })()
);
check("parseExtraction empty on junk", parseExtraction("no json here").facts.length === 0);

// --- 6. Reminder detection (pure regex) ---
console.log("reminders:");
check("detects 'remind me to'", looksLikeReminder("remind me to call mom"));
check("detects 'set a reminder'", looksLikeReminder("set a reminder for tomorrow"));
check("detects 'don't forget to'", looksLikeReminder("don't forget to pay rent"));
check("rejects plain chat", !looksLikeReminder("what's the weather like?"));
check("rejects empty", !looksLikeReminder(""));

// --- 7. Tools: time block (pure) ---
console.log("tools:");
check("time block mentions a time", /Current time/.test(currentTimeBlock()));
check("time block contains a real year", /\d{4}/.test(currentTimeBlock()));

// --- 8. Skills module loads (exports exist, no DB calls made here) ---
console.log("skills:");
check("module exports create/list/delete/match",
  [detectSkill, createSkill, listSkills, deleteSkill, matchSkills].every((f) => typeof f === "function"));

console.log(`\n${checks} checks, ${failures} failed`);
process.exit(failures ? 1 : 0);
