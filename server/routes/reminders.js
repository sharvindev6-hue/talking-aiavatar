import { Router } from "express";
import { requireAuth } from "../auth.js";
import { createRateLimiter } from "../security.js";
import {
  listReminders,
  deleteReminder,
  getDueReminders,
  tickDueReminders,
} from "../reminders.js";

export function createRemindersRouter() {
  const router = Router();

  // GET /api/reminders — list the user's upcoming reminders.
  router.get("/", requireAuth, async (req, res, next) => {
    try {
      const reminders = await listReminders(req.user.id);
      res.json({ reminders });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/reminders/due — reminders that have come due. The client polls
  // this while open; due reminders are marked fired here so each one is
  // announced exactly once.
  router.get(
    "/due",
    requireAuth,
    createRateLimiter({
      windowMs: 60_000,
      max: 30,
      key: (req) => `rem:${req.user.id}`,
    }),
    async (req, res, next) => {
      try {
        const due = await getDueReminders(req.user.id, { markFired: true });
        res.json({ due });
      } catch (err) {
        next(err);
      }
    }
  );

  // DELETE /api/reminders/:id — cancel a reminder.
  router.delete("/:id", requireAuth, async (req, res, next) => {
    try {
      const ok = await deleteReminder(req.user.id, String(req.params.id || ""));
      if (!ok) {
        res.status(404).json({ error: "Reminder not found" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/reminders/tick — Vercel cron entrypoint (no user auth; guarded
  // by the vercel-cron User-Agent and/or an unguessable CRON_SECRET query
  // param). Marks globally-due reminders as fired so polls converge.
  router.get("/tick", async (req, res, next) => {
    const isVercelCron = /vercel-cron/i.test(req.headers["user-agent"] || "");
    const secret = process.env.CRON_SECRET;
    if (!isVercelCron && (!secret || req.query.secret !== secret)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    try {
      const fired = await tickDueReminders();
      res.json({ ok: true, fired });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
