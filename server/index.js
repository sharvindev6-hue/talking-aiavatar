import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { setupElevenLabsProxy } from "./elevenlabs-proxy.js";
import { initSchema, dbConfigured } from "./db.js";
import { scrubSecrets, createRateLimiter } from "./security.js";
import { createChatRouter } from "./routes/chat.js";
import { createStatusRouter } from "./routes/status.js";
import { createVoicesRouter } from "./routes/voices.js";
import { createA2FRouter } from "./routes/a2f.js";
import { createTTSRouter } from "./routes/tts.js";
import { createAuthRouter } from "./routes/auth.js";
import { createHistoryRouter } from "./routes/history.js";
import { createMemoryRouter } from "./routes/memory.js";
import { createRemindersRouter } from "./routes/reminders.js";
import { createSkillsRouter } from "./routes/skills.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Origin policy.
// - If ALLOWED_ORIGINS is explicitly set, ONLY those origins may call the API
//   with cookies (strict allowlist — recommended once you have a stable
//   production domain).
// - If it is NOT set, default to same-origin only: a request's Origin must
//   match its own Host. This is safe (a foreign site's origin never matches
//   our host) and means the app works out of the box on any deployment
//   domain — localhost, the main Vercel URL, and Vercel preview deployments.
const EXPLICIT_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function originAllowed(req, origin) {
  if (!origin) return true; // same-origin GETs, curl, native clients
  if (EXPLICIT_ORIGINS.length > 0) return EXPLICIT_ORIGINS.includes(origin);
  // Same-origin default: compare the Origin against this request's own host.
  // Only trust x-forwarded-proto when behind a reverse proxy (TRUST_PROXY=true,
  // as on Vercel); otherwise use the connection's actual protocol.
  const proto =
    process.env.TRUST_PROXY === "true"
      ? String(
          req.headers["x-forwarded-proto"] || req.protocol || "http"
        )
          .split(",")[0]
          .trim()
      : req.protocol || "http";
  const host = req.headers.host || "";
  return origin === `${proto}://${host}`;
}

const app = express();
app.disable("x-powered-by");

// Behind a reverse proxy (Vercel/nginx) set TRUST_PROXY=true so req.ip comes
// from X-Forwarded-For and IP-based rate limits work per real client.
if (process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}

// --- Security headers (defense in depth) ---
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "connect-src 'self' blob: https://cdn.jsdelivr.net ws: wss:",
  "worker-src 'self' blob: https://cdn.jsdelivr.net",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(self), geolocation=(), payment=(), usb=()"
  );
  res.setHeader("Content-Security-Policy", CSP);
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// CORS: reflect the request origin when allowed (same-origin is always fine),
// and answer preflights. Implemented inline so the same origin policy is used
// for both CORS headers and the CSRF check below.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Vary", "Origin");
    if (originAllowed(req, origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
  }
  if (req.method === "OPTIONS") {
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      req.headers["access-control-request-headers"] || "Content-Type,Authorization"
    );
    res.setHeader("Access-Control-Max-Age", "86400");
    return res.status(204).end();
  }
  next();
});

// CSRF defense-in-depth: reject mutating requests from unknown origins.
app.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin && !originAllowed(req, origin)) {
      return res.status(403).json({ error: "Forbidden origin" });
    }
  }
  next();
});

// Cheap per-IP shield BEFORE body parsing so oversized bodies can't be used
// to exhaust memory, and mutating endpoints get a baseline cap.
const apiShield = createRateLimiter({ windowMs: 60_000, max: 120 });
app.use("/api", (req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    return apiShield(req, res, next);
  }
  return next();
});

app.use(express.json({ limit: "25mb" })); // larger limit for base64 image attachments
app.use(cookieParser());

app.use("/api/status", createStatusRouter());
app.use("/api/chat", createChatRouter());
app.use("/api/voices", createVoicesRouter());
app.use("/api/a2f", createA2FRouter());
app.use("/api/tts", createTTSRouter());
app.use("/api/auth", createAuthRouter());
app.use("/api/history", createHistoryRouter());
app.use("/api/memory", createMemoryRouter());
app.use("/api/reminders", createRemindersRouter());
app.use("/api/skills", createSkillsRouter());

const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir, { index: false }));
app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// JSON error handler (keeps API errors tidy instead of HTML stack traces)
app.use((err, _req, res, _next) => {
  console.error("Server error:", scrubSecrets(err.message || err));
  const status = err.status || 500;
  if (res.headersSent) {
    res.end();
    return;
  }
  // Never leak internal details (connection strings, API keys, driver errors).
  const message =
    process.env.NODE_ENV === "production"
      ? "Internal server error"
      : scrubSecrets(err.message) || "Internal server error";
  res.status(status).json({ error: message });
});

// Vercel serverless mode: export the Express app (no manual listen).
export default app;

// Initialize the database schema when a connection string is present.
if (dbConfigured) {
  initSchema()
    .then((ok) => ok && console.log("Database schema ready"))
    .catch((err) => console.error("Database schema init failed:", err.message));
} else {
  console.warn(
    "DATABASE_URL not set — accounts and chat history are disabled until you add it to .env"
  );
}

// Local mode only: HTTP server + WebSocket proxy + listen.
// (Vercel functions don't support WebSocket upgrades; the client uses the
// HTTP /api/tts/stream endpoint, so the proxy is local-only anyway.)
if (!process.env.VERCEL) {
  const server = http.createServer(app);
  setupElevenLabsProxy(server);
  server.listen(PORT, () => {
    console.log(`Avatar AI running at http://localhost:${PORT}`);
  });
}
