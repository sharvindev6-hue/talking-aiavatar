import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query } from "../db.js";
import { requireAuth } from "../auth.js";

export function createHistoryRouter() {
  const router = Router();
  router.use(requireAuth);

  // GET /api/history/sessions — list the user's chat sessions
  router.get("/sessions", async (req, res, next) => {
    try {
      const { rows } = await query(
        `SELECT cs.id, cs.title, cs.created_at, cs.updated_at,
                (SELECT count(*) FROM messages m WHERE m.session_id = cs.id) AS message_count
           FROM chat_sessions cs
          WHERE cs.user_id = $1
          ORDER BY cs.updated_at DESC`,
        [req.user.id]
      );
      res.json({
        sessions: rows.map((s) => ({
          id: s.id,
          title: s.title,
          createdAt: s.created_at,
          updatedAt: s.updated_at,
          messageCount: Number(s.message_count),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/history/sessions — create a new session (optional title)
  router.post("/sessions", async (req, res, next) => {
    try {
      const id = randomUUID();
      const title = String(req.body?.title || "New chat").slice(0, 60);
      await query(
        "INSERT INTO chat_sessions (id, user_id, title) VALUES ($1, $2, $3)",
        [id, req.user.id, title]
      );
      const { rows } = await query(
        "SELECT id, title, created_at, updated_at FROM chat_sessions WHERE id = $1",
        [id]
      );
      res.status(201).json({ session: rows[0] });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/history/sessions/:id — a session with its messages
  router.get("/sessions/:id", async (req, res, next) => {
    try {
      const session = await getOwnedSession(req.params.id, req.user.id);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      const { rows } = await query(
        `SELECT id, role, content, emotion, gesture, attachments, created_at
           FROM messages
          WHERE session_id = $1
          ORDER BY created_at ASC`,
        [req.params.id]
      );
      res.json({
        session,
        messages: rows.map((m) => ({
          ...m,
          attachments:
            typeof m.attachments === "string"
              ? JSON.parse(m.attachments || "[]")
              : m.attachments || [],
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/history/sessions/:id — rename a session
  router.patch("/sessions/:id", async (req, res, next) => {
    try {
      const session = await getOwnedSession(req.params.id, req.user.id);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      const title = String(req.body?.title || "").trim().slice(0, 60);
      if (!title) {
        res.status(400).json({ error: "title required" });
        return;
      }
      await query("UPDATE chat_sessions SET title = $1 WHERE id = $2", [
        title,
        req.params.id,
      ]);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/history/sessions/:id
  router.delete("/sessions/:id", async (req, res, next) => {
    try {
      const session = await getOwnedSession(req.params.id, req.user.id);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      await query("DELETE FROM chat_sessions WHERE id = $1", [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

async function getOwnedSession(id, userId) {
  const { rows } = await query(
    "SELECT * FROM chat_sessions WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rows[0] || null;
}
