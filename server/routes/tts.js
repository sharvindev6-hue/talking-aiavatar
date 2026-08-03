import { Router } from "express";
import { requireAuth } from "../auth.js";
import { scrubSecrets, createRateLimiter } from "../security.js";

const MAX_TTS_CHARS = 5000; // ElevenLabs limit; also bounds cost per request

export function createTTSRouter() {
  const router = Router();

  // TTS generates paid audio with the server's key — require login and cap usage.
  router.post(
    "/stream",
    createRateLimiter({ windowMs: 60_000, max: 30 }), // per-IP shield
    requireAuth,
    createRateLimiter({
      windowMs: 60_000,
      max: 20,
      key: (req) => `u:${req.user.id}`,
    }),
    async (req, res) => {
      const apiKey = process.env.ELEVENLABS_API_KEY;
      const voiceId = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
      const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";
      const { text } = req.body || {};

      if (!apiKey) {
        res.status(500).json({ error: "ElevenLabs API key not configured" });
        return;
      }
      const cleanText = String(text || "").trim().slice(0, MAX_TTS_CHARS);
      if (!cleanText) {
        res.status(400).json({ error: "text required" });
        return;
      }

    try {
      const upstream = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream/with-timestamps?output_format=pcm_22050`,
        {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            text: cleanText,
            model_id: modelId,
          }),
        }
      );

      if (!upstream.ok) {
        const errText = await upstream.text();
        res.status(upstream.status).json({ error: scrubSecrets(errText) });
        return;
      }

      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Cache-Control", "no-cache");

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim()) res.write(line + "\n");
        }
      }
      if (buffer.trim()) res.write(buffer + "\n");
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: scrubSecrets(err.message) });
      } else {
        res.end();
      }
    }
    }
  );

  return router;
}
