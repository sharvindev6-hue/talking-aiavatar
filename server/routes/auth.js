import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query } from "../db.js";
import {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  SESSION_COOKIE,
} from "../auth.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PASSWORD_LENGTH = 128;

// In-memory rate limiter (per IP) for auth endpoints.
// Simple for local dev; swap for Upstash Ratelimit before scaling out on Vercel.
const attempts = new Map();
const LIMIT = 10; // requests
const WINDOW_MS = 60_000; // per minute

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.t > WINDOW_MS) {
    attempts.set(ip, { n: 1, t: now });
    next();
    return;
  }
  rec.n += 1;
  if (rec.n > LIMIT) {
    res.status(429).json({ error: "Too many attempts. Try again in a minute." });
    return;
  }
  next();
}

// Periodically clear old entries so the map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of attempts) {
    if (now - rec.t > WINDOW_MS) attempts.delete(ip);
  }
}, WINDOW_MS).unref();

// Fixed dummy hash used to equalize login timing for unknown emails.
const DUMMY_HASH = hashPassword("dummy-password-for-timing");

function publicUser(row) {
  return { id: row.id, email: row.email, createdAt: row.created_at };
}

export function createAuthRouter() {
  const router = Router();

  // POST /api/auth/register { email, password }
  router.post("/register", rateLimit, async (req, res, next) => {
    try {
      const email = String(req.body?.email || "").trim().toLowerCase();
      const password = String(req.body?.password || "");

      if (!EMAIL_RE.test(email)) {
        res.status(400).json({ error: "Enter a valid email address." });
        return;
      }
      if (password.length < 8) {
        res.status(400).json({ error: "Password must be at least 8 characters." });
        return;
      }
      if (password.length > MAX_PASSWORD_LENGTH) {
        res.status(400).json({ error: "Password is too long." });
        return;
      }

      const existing = await query("SELECT id FROM users WHERE email = $1", [email]);
      if (existing.rows[0]) {
        res.status(409).json({ error: "An account with this email already exists." });
        return;
      }

      const id = randomUUID();
      await query(
        "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)",
        [id, email, hashPassword(password)]
      );

      const token = await createSession(id);
      setSessionCookie(res, token);
      res.status(201).json({ user: { id, email } });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/auth/login { email, password }
  router.post("/login", rateLimit, async (req, res, next) => {
    try {
      const email = String(req.body?.email || "").trim().toLowerCase();
      const password = String(req.body?.password || "");

      const { rows } = await query("SELECT * FROM users WHERE email = $1", [email]);
      const user = rows[0];
      // Run scrypt against a dummy hash when the user doesn't exist so
      // response timing doesn't reveal which emails are registered.
      const ok =
        user && password
          ? verifyPassword(password, user.password_hash)
          : verifyPassword(password, DUMMY_HASH);
      if (!user || !ok) {
        res.status(401).json({ error: "Incorrect email or password." });
        return;
      }

      // Purge this user's expired sessions on login.
      await query("DELETE FROM sessions WHERE user_id = $1 AND expires_at <= now()", [user.id]);

      const token = await createSession(user.id);
      setSessionCookie(res, token);
      res.json({ user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/auth/logout
  router.post("/logout", async (req, res, next) => {
    try {
      await destroySession(req.cookies?.[SESSION_COOKIE]);
      clearSessionCookie(res);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/auth/me — current user (requires valid session)
  router.get("/me", requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  return router;
}
