import "dotenv/config";
import express from "express";
import cors from "cors";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Explicit allowlist of origins that may call the API with cookies.
let ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:3003"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Guard against a misconfigured/empty ALLOWED_ORIGINS env (e.g. ",").
if (ALLOWED_ORIGINS.length === 0) {
  ALLOWED_ORIGINS = ["http://localhost:3000", "http://localhost:3003"];
}

const app = express();

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

// CORS: reflect only allowlisted origins (same-origin is always fine).
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  })
);

// CSRF defense-in-depth: reject mutating requests from unknown origins.
app.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
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
