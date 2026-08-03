import { Router } from "express";
import { requireAuth } from "../auth.js";
import { scrubSecrets } from "../security.js";

export function createVoicesRouter() {
  const router = Router();
  router.use(requireAuth); // only logged-in users may list voices (uses API key)

  router.get("/", async (_req, res) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: "ElevenLabs API key not configured" });
      return;
    }

    try {
      const response = await fetch("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": apiKey },
      });

      if (!response.ok) {
        const text = await response.text();
        res.status(response.status).json({ error: scrubSecrets(text) });
        return;
      }

      const data = await response.json();
      res.json({
        defaultVoiceId: process.env.ELEVENLABS_VOICE_ID || "CwhRBWXzGAHq8TQ4Fs17",
        voices: (data.voices || []).map((v) => ({
          id: v.voice_id,
          name: v.name,
          category: v.category,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: scrubSecrets(err.message) });
    }
  });

  return router;
}
