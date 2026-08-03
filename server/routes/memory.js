import { Router } from "express";
import { requireAuth } from "../auth.js";
import { createRateLimiter } from "../security.js";
import {
  listFacts,
  listSummaries,
  forgetFact,
  forgetMatching,
} from "../memory.js";

export function createMemoryRouter() {
  const router = Router();
  router.use(requireAuth);

  // GET /api/memory — everything the avatar remembers about this user.
  router.get("/", async (req, res, next) => {
    try {
      const [facts, summaries] = await Promise.all([
        listFacts(req.user.id),
        listSummaries(req.user.id),
      ]);
      res.json({ facts, summaries });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/memory/facts/:id — forget one specific fact.
  router.delete("/facts/:id", async (req, res, next) => {
    try {
      const ok = await forgetFact(req.user.id, String(req.params.id || ""));
      if (!ok) {
        res.status(404).json({ error: "Memory not found" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/memory/forget { match? } — forget matching facts (fuzzy), or
  // everything when no match is given. Bounded so a forget-all can't be
  // spammed into a denial-of-service.
  router.post(
    "/forget",
    createRateLimiter({ windowMs: 60_000, max: 30, key: (req) => `mem:${req.user.id}` }),
    async (req, res, next) => {
      try {
        const match = typeof req.body?.match === "string" ? req.body.match.trim().slice(0, 200) : "";
        const removed = await forgetMatching(req.user.id, match || null);
        res.json({ ok: true, removed });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
