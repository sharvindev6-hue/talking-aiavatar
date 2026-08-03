// Permanent test suite: syntax checks + security/parser unit tests.
// Run with `npm test`. Requires no database, API keys, or network.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrubSecrets, createRateLimiter } from "../server/security.js";
import { parseAssistantJson } from "../server/routes/chat.js";

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

console.log(`\n${checks} checks, ${failures} failed`);
process.exit(failures ? 1 : 0);
