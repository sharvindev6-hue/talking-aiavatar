import { Router } from "express";

/**
 * Optional NVIDIA Audio2Face-3D integration point.
 * Deploy Audio2Face-3D NIM separately and set A2F_ENABLED=true + A2F_NIM_URL.
 * Default lip sync uses TalkingHead word-based visemes from ElevenLabs alignment.
 */
export function createA2FRouter() {
  const router = Router();

  router.get("/status", (_req, res) => {
    res.json({
      enabled: process.env.A2F_ENABLED === "true",
      nimUrl: process.env.A2F_NIM_URL || null,
      fallback: "talkinghead-words",
    });
  });

  router.post("/stream", (_req, res) => {
    if (process.env.A2F_ENABLED !== "true") {
      res.status(501).json({
        error: "Audio2Face-3D not enabled. Set A2F_ENABLED=true and deploy the NIM.",
        fallback: "talkinghead-words",
      });
      return;
    }
    res.status(501).json({ error: "A2F NIM proxy not configured. Set A2F_NIM_URL." });
  });

  return router;
}
