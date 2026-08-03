import { Router } from "express";
import { requireAuth } from "../auth.js";
import { createRateLimiter } from "../security.js";
import { listSkills, deleteSkill, createSkill } from "../skills.js";

export function createSkillsRouter() {
  const router = Router();
  router.use(requireAuth);

  // GET /api/skills — list the user's saved skills.
  router.get("/", async (req, res, next) => {
    try {
      const skills = await listSkills(req.user.id);
      res.json({ skills });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/skills { name, description, trigger, instructions } — save a
  // skill the user (or the avatar) created.
  router.post(
    "/",
    createRateLimiter({ windowMs: 60_000, max: 10, key: (req) => `sk:${req.user.id}` }),
    async (req, res, next) => {
      try {
        const created = await createSkill(req.user.id, {
          name: req.body?.name,
          description: req.body?.description,
          trigger: req.body?.trigger,
          instructions: req.body?.instructions,
        });
        if (!created) {
          res.status(400).json({ error: "Could not create skill (invalid or duplicate)" });
          return;
        }
        res.status(201).json({ skill: created });
      } catch (err) {
        next(err);
      }
    }
  );

  // DELETE /api/skills/:id — remove a skill.
  router.delete("/:id", async (req, res, next) => {
    try {
      const ok = await deleteSkill(req.user.id, String(req.params.id || ""));
      if (!ok) {
        res.status(404).json({ error: "Skill not found" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
