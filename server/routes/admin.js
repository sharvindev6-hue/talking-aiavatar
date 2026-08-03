import { Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { query } from "../db.js";
import { createRateLimiter } from "../security.js";

// Admin access is separate from app accounts. Only the single email in
// ADMIN_EMAIL with the password in ADMIN_PASSWORD can log in, and the login
// issues its own signed session cookie (no user row required).
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_COOKIE = "avatar_admin";
const ADMIN_SESSION_HOURS = 12;

// Signing key for admin sessions: prefer an explicit ADMIN_SESSION_SECRET;
// otherwise derive one from the password/email so every deployment still has
// a stable, secret-derived key.
const ADMIN_SECRET =
  process.env.ADMIN_SESSION_SECRET ||
  createHmac("sha256", "avatar-admin")
    .update(`${ADMIN_PASSWORD}|${ADMIN_EMAIL}`)
    .digest("hex");

// The fallback key is derived from the password, so an unset secret weakens
// cookie security if the password ever leaks. Make it obvious at boot.
if (!process.env.ADMIN_SESSION_SECRET) {
  console.warn(
    "[security] ADMIN_SESSION_SECRET not set — admin cookies signed with a key derived from ADMIN_PASSWORD. Set a random one in production (openssl rand -hex 32)."
  );
}

export function isAdminEmail(email) {
  return (
    Boolean(ADMIN_EMAIL) &&
    String(email || "").trim().toLowerCase() === ADMIN_EMAIL
  );
}

function safeEqual(a, b) {
  const ha = createHmac("sha256", "avatar-pw").update(String(a)).digest();
  const hb = createHmac("sha256", "avatar-pw").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

function adminToken(email) {
  const payload = Buffer.from(
    JSON.stringify({ email, exp: Date.now() + ADMIN_SESSION_HOURS * 3600 * 1000 })
  ).toString("base64url");
  const sig = createHmac("sha256", ADMIN_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

function readAdmin(req) {
  const raw = req.cookies?.[ADMIN_COOKIE];
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = createHmac("sha256", ADMIN_SECRET)
    .update(payload)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.email || Date.now() > data.exp) return null;
    if (ADMIN_EMAIL && data.email !== ADMIN_EMAIL) return null;
    return data;
  } catch {
    return null;
  }
}

function setAdminCookie(res, email) {
  res.cookie(ADMIN_COOKIE, adminToken(email), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: ADMIN_SESSION_HOURS * 3600 * 1000,
    path: "/",
  });
}

function clearAdminCookie(res) {
  res.clearCookie(ADMIN_COOKIE, { path: "/" });
}

function requireAdmin(req, res, next) {
  if (!readAdmin(req)) {
    res.status(401).json({ error: "Admin login required" });
    return;
  }
  next();
}

// Login attempts get a tight per-IP cap (brute-force protection).
const loginLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 10,
  key: (req) => `adminlogin:${req.ip}`,
});

// Guard the admin data API against scraping/abuse (per IP).
const adminLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 300,
  key: (req) => `admin:${req.ip}`,
});

function withAttachments(m) {
  let attachments = [];
  try {
    attachments =
      typeof m.attachments === "string"
        ? JSON.parse(m.attachments || "[]")
        : m.attachments || [];
  } catch {
    attachments = [];
  }
  return {
    ...m,
    attachments: attachments.map((a) => ({
      name: a.name || "file",
      type: a.type || "application/octet-stream",
      size: a.size || 0,
    })),
  };
}

export function createAdminRouter() {
  const router = Router();

  // POST /api/admin/login { email, password } — the dedicated admin gate.
  router.post("/login", loginLimiter, (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    const emailOk = ADMIN_EMAIL && email === ADMIN_EMAIL;
    const passOk = ADMIN_PASSWORD && safeEqual(password, ADMIN_PASSWORD);
    if (!emailOk || !passOk) {
      res.status(401).json({ error: "Incorrect email or password." });
      return;
    }
    setAdminCookie(res, ADMIN_EMAIL);
    res.json({ ok: true, email: ADMIN_EMAIL });
  });

  // POST /api/admin/logout
  router.post("/logout", (req, res) => {
    clearAdminCookie(res);
    res.json({ ok: true });
  });

  // GET /api/admin/me — current admin (from the signed cookie)
  router.get("/me", requireAdmin, (req, res) => {
    res.json({ email: readAdmin(req).email });
  });

  // Everything below requires a valid admin session.
  router.use(requireAdmin, adminLimiter);

  // GET /api/admin/stats — headline numbers + daily message series
  router.get("/stats", async (_req, res, next) => {
    try {
      const [totals, daily, topUsers] = await Promise.all([
        query(`
          SELECT
            (SELECT count(*) FROM users)::int AS users,
            (SELECT count(*) FROM chat_sessions)::int AS sessions,
            (SELECT count(*) FROM messages)::int AS messages,
            (SELECT count(*) FROM messages
              WHERE created_at > now() - interval '24 hours')::int AS messages_24h,
            (SELECT count(DISTINCT cs.user_id) FROM messages m
              JOIN chat_sessions cs ON cs.id = m.session_id
              WHERE m.created_at > now() - interval '24 hours')::int AS active_24h,
            (SELECT count(DISTINCT cs.user_id) FROM messages m
              JOIN chat_sessions cs ON cs.id = m.session_id
              WHERE m.created_at > now() - interval '5 minutes')::int AS active_5m,
            (SELECT count(*) FROM users
              WHERE created_at > now() - interval '24 hours')::int AS new_users_24h,
            (SELECT count(*) FROM users
              WHERE created_at > now() - interval '7 days')::int AS new_users_7d
        `),
        query(`
          SELECT to_char(day, 'YYYY-MM-DD') AS day, count(m.id)::int AS count
            FROM generate_series(
                   date_trunc('day', now() AT TIME ZONE 'UTC' - interval '13 days'),
                   date_trunc('day', now() AT TIME ZONE 'UTC'),
                   interval '1 day'
                 ) AS day
            LEFT JOIN messages m
              ON date_trunc('day', m.created_at AT TIME ZONE 'UTC') = day
           GROUP BY day
           ORDER BY day ASC
        `),
        query(`
          SELECT u.id, u.email,
                 count(m.id)::int AS messages
            FROM users u
            LEFT JOIN chat_sessions cs ON cs.user_id = u.id
            LEFT JOIN messages m ON m.session_id = cs.id
           GROUP BY u.id, u.email
           ORDER BY messages DESC
           LIMIT 5
        `),
      ]);

      res.json({
        ...totals.rows[0],
        daily: daily.rows.map((d) => ({ day: d.day, count: d.count })),
        topUsers: topUsers.rows.map((u) => ({
          id: u.id,
          email: u.email,
          messages: u.messages,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/admin/users?q=&limit=&offset= — every account with activity counts
  router.get("/users", async (req, res, next) => {
    try {
      const q = String(req.query.q || "").trim().slice(0, 120);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

      const [rows, total] = await Promise.all([
        query(
          `SELECT * FROM (
             SELECT u.id, u.email, u.created_at,
                    (SELECT count(*) FROM chat_sessions cs
                      WHERE cs.user_id = u.id)::int AS session_count,
                    (SELECT count(*) FROM messages m
                      JOIN chat_sessions cs ON cs.id = m.session_id
                      WHERE cs.user_id = u.id)::int AS message_count,
                    (SELECT max(m.created_at) FROM messages m
                      JOIN chat_sessions cs ON cs.id = m.session_id
                      WHERE cs.user_id = u.id) AS last_active
               FROM users u
              WHERE $1 = '' OR u.email ILIKE '%' || $1 || '%'
           ) t
           ORDER BY COALESCE(last_active, created_at) DESC
           LIMIT $2 OFFSET $3`,
          [q, limit, offset]
        ),
        query(
          `SELECT count(*)::int AS total FROM users u
            WHERE $1 = '' OR u.email ILIKE '%' || $1 || '%'`,
          [q]
        ),
      ]);

      res.json({
        users: rows.rows.map((u) => ({
          id: u.id,
          email: u.email,
          createdAt: u.created_at,
          sessions: u.session_count,
          messages: u.message_count,
          lastActive: u.last_active,
          isAdmin: isAdminEmail(u.email),
        })),
        total: total.rows[0].total,
        limit,
        offset,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/admin/users/:id — one account + their chat sessions
  router.get("/users/:id", async (req, res, next) => {
    try {
      const userRows = await query("SELECT id, email, created_at FROM users WHERE id = $1", [
        req.params.id,
      ]);
      if (!userRows.rows[0]) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      const sessionRows = await query(
        `SELECT cs.id, cs.title, cs.created_at, cs.updated_at,
                (SELECT count(*) FROM messages m
                  WHERE m.session_id = cs.id)::int AS message_count,
                (SELECT max(m.created_at) FROM messages m
                  WHERE m.session_id = cs.id) AS last_active
           FROM chat_sessions cs
          WHERE cs.user_id = $1
          ORDER BY cs.updated_at DESC`,
        [req.params.id]
      );
      res.json({
        user: { ...userRows.rows[0], isAdmin: isAdminEmail(userRows.rows[0].email) },
        sessions: sessionRows.rows.map((s) => ({
          id: s.id,
          title: s.title,
          createdAt: s.created_at,
          updatedAt: s.updated_at,
          messages: s.message_count,
          lastActive: s.last_active,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/admin/users/:id/messages?limit=&offset= — everything the user
  // sent to the model (and the avatar's replies) across all sessions
  router.get("/users/:id/messages", async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

      const rows = await query(
        `SELECT m.id, m.role, m.content, m.emotion, m.gesture, m.attachments,
                m.created_at, cs.title AS session_title, cs.id AS session_id
           FROM messages m
           JOIN chat_sessions cs ON cs.id = m.session_id
          WHERE cs.user_id = $1
          ORDER BY m.created_at DESC
          LIMIT $2 OFFSET $3`,
        [req.params.id, limit, offset]
      );
      res.json({
        messages: rows.rows.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          emotion: m.emotion,
          gesture: m.gesture,
          createdAt: m.created_at,
          sessionId: m.session_id,
          sessionTitle: m.session_title,
          ...withAttachments(m),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/admin/feed?q=&limit= — the latest activity across all users
  // (the "watch the app happen" view). Searchable by email or content.
  router.get("/feed", async (req, res, next) => {
    try {
      const q = String(req.query.q || "").trim().slice(0, 120);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

      const rows = await query(
        `SELECT m.id, m.role, m.content, m.created_at,
                cs.title AS session_title, cs.id AS session_id,
                u.id AS user_id, u.email AS user_email
           FROM messages m
           JOIN chat_sessions cs ON cs.id = m.session_id
           JOIN users u ON u.id = cs.user_id
          WHERE $1 = ''
             OR u.email ILIKE '%' || $1 || '%'
             OR m.content ILIKE '%' || $1 || '%'
          ORDER BY m.created_at DESC
          LIMIT $2`,
        [q, limit]
      );
      res.json({
        feed: rows.rows.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.created_at,
          sessionId: m.session_id,
          sessionTitle: m.session_title,
          userId: m.user_id,
          userEmail: m.user_email,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
