import { Router } from "express";
import { scrubSecrets } from "../security.js";

async function validateElevenLabs() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID || "CwhRBWXzGAHq8TQ4Fs17";
  const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";
  if (!apiKey) return { ok: false, error: "Missing ELEVENLABS_API_KEY in .env" };

  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "ok", model_id: modelId }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    const msg = body?.detail?.message || `ElevenLabs error (${res.status})`;
    if (body?.detail?.code === "paid_plan_required") {
      return {
        ok: false,
        error: `${scrubSecrets(msg)} — set ELEVENLABS_VOICE_ID to a free-tier voice (e.g. Roger: CwhRBWXzGAHq8TQ4Fs17).`,
      };
    }
    // Never echo upstream error text verbatim — it can contain the API key.
    return { ok: false, error: scrubSecrets(msg) };
  } catch (err) {
    return { ok: false, error: scrubSecrets(err.message) };
  }
}

async function validateNvidia() {
  const apiKey = process.env.NVIDIA_API_KEY;
  const baseUrl = process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
  const model = process.env.NVIDIA_MODEL || "moonshotai/kimi-k2.6";
  if (!apiKey) return { ok: false, error: "Missing NVIDIA_API_KEY in .env" };

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 32,
        stream: false,
        chat_template_kwargs: { thinking: false },
      }),
    });
    if (res.ok) return { ok: true, model };
    const text = await res.text();
    // Scrub: NVIDIA error text can include the raw API key.
    return {
      ok: false,
      error: scrubSecrets(text.slice(0, 200)) || `NVIDIA error (${res.status})`,
    };
  } catch (err) {
    return { ok: false, error: scrubSecrets(err.message) };
  }
}

export function createStatusRouter() {
  const router = Router();
  let cache = null;
  let cacheTime = 0;

  router.get("/", async (_req, res) => {
    const now = Date.now();
    if (!cache || now - cacheTime > 120_000) {
      const [elevenlabs, nvidia] = await Promise.all([
        validateElevenLabs(),
        validateNvidia(),
      ]);
      cache = {
        elevenlabs: elevenlabs.ok,
        elevenlabsError: elevenlabs.error || null,
        nvidia: nvidia.ok,
        nvidiaError: nvidia.error || null,
        model: process.env.NVIDIA_MODEL || "moonshotai/kimi-k2.6",
        voiceId: process.env.ELEVENLABS_VOICE_ID || "CwhRBWXzGAHq8TQ4Fs17",
        modelId: process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5",
        a2fEnabled: process.env.A2F_ENABLED === "true",
        ready: elevenlabs.ok && nvidia.ok,
      };
      cacheTime = now;
    }
    res.json(cache);
  });

  return router;
}
