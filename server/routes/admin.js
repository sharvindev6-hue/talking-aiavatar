import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../auth.js";
import { createRateLimiter } from "../security.js";

// Admins are the users whose emails appear in ADMIN_EMAILS (comma-separated).
// No DB column needed — the operator controls access from the env, and the
// admin UI reads from the same list.
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

export function isAdminEmail(email) {
  return ADMIN_EMAILS.has(String(email || "").trim().toLowerCase());
}

function requireAdmin(req, res, next) {
  if (!req.user || !isAdminEmail(req.user.email)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

// Guard the admin API against scraping/abuse (per IP).
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
  router.use(requireAuth, requireAdmin, adminLimiter);

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
