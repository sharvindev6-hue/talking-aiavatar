// Shared security helpers: secret scrubbing and in-memory rate limiting.

// Patterns that can appear in upstream error messages, logs, or stack traces.
// NVIDIA keys: nvapi-…; ElevenLabs keys: sk_… / sk-…; Bearer tokens;
// "xi-api-key" headers; generic api_key fields; Postgres/URLs with credentials.
const KEY_PATTERNS = [
  /nvapi-[A-Za-z0-9_-]{8,}/g,
  /\bsk_[A-Za-z0-9]{16,}/g,
  /\bsk-[A-Za-z0-9]{16,}/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/gi,
  /xi-api-key[^\n]{0,60}/gi,
  /api[_-]?key["':=\s]+[A-Za-z0-9._-]{16,}/gi,
  /postgres(?:ql)?:\/\/[^\s"'<>]+/gi,
  /https?:\/\/[^\s"'<>/\s]+:[^@\s"'<>]+@/gi, // URL with embedded password
];

/**
 * Redact anything that looks like an API key, token, or credential from a
 * string. Use before sending error text to clients or writing to logs.
 */
export function scrubSecrets(value) {
  if (typeof value !== "string") return value;
  let out = value;
  for (const re of KEY_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

/**
 * In-memory sliding-window rate limiter middleware factory.
 * Keyed by req.ip by default; pass `key` to key on e.g. req.user.id.
 * Note: in-memory is fine for a single instance (local/VPS); swap for a
 * distributed store (Upstash/Vercel KV) if you scale to many instances.
 */
export function createRateLimiter({
  windowMs = 60_000,
  max = 100,
  key = (req) => req.ip || "unknown",
}) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, rec] of hits) if (now > rec.resetAt) hits.delete(k);
  }, Math.min(windowMs, 60_000));
  timer.unref();

  return function rateLimit(req, res, next) {
    const k = key(req);
    const now = Date.now();
    const rec = hits.get(k);
    if (!rec || now > rec.resetAt) {
      hits.set(k, { n: 1, resetAt: now + windowMs });
      return next();
    }
    rec.n += 1;
    if (rec.n > max) {
      res.setHeader("Retry-After", String(Math.ceil((rec.resetAt - now) / 1000)));
      return res
        .status(429)
        .json({ error: "Too many requests. Please slow down and try again." });
    }
    return next();
  };
}
