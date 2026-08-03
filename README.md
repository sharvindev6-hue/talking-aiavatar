# Avatar AI

Real-time 3D conversational avatar with lip sync, powered by **NVIDIA Kimi** (brain) and **ElevenLabs** (voice).

## Features

- Split-screen UI: 3D avatar (left) + chat (right)
- Streaming LLM responses via NVIDIA NIM Kimi
- Real-time lip sync via ElevenLabs TTS + TalkingHead
- Voice input (browser Speech Recognition) with barge-in
- Gestures and moods driven by structured LLM output

## Setup

1. Copy `.env.example` to `.env` and add your API keys:

```bash
cp .env.example .env
```

2. Install dependencies:

```bash
npm install
```

3. Start the server:

```bash
npm start
```

4. Open http://localhost:3000

## API keys

| Variable | Source |
|----------|--------|
| `NVIDIA_API_KEY` | [NVIDIA API](https://build.nvidia.com/) — Kimi NIM (`moonshotai/kimi-k2.6`) |
| `ELEVENLABS_API_KEY` | [ElevenLabs](https://elevenlabs.io) — Profile → API key |

Keys are stored server-side only. Never commit `.env`.

## Optional: NVIDIA Audio2Face-3D

Set `A2F_ENABLED=true` and deploy the [Audio2Face-3D NIM](https://github.com/NVIDIA/Audio2Face-3D-Samples) separately. The app uses TalkingHead word-based lip sync by default.

## Architecture

```
Browser                    Node server                 APIs
────────                   ───────────                 ────
Chat UI  ──POST /api/chat──►  Kimi proxy  ──────────►  NVIDIA NIM
Avatar   ◄──SSE stream──────  (streaming)
TTS WS   ──/elevenlabs/*───►  WS proxy    ──────────►  ElevenLabs
TalkingHead (3D + lip sync)
```

## Security

- API keys live only in `.env` (gitignored) and are redacted from every error
  response, log, and status payload before they could reach a client.
- Cost-bearing endpoints (`/api/chat`, `/api/tts`, `/api/voices`) require login and
  are rate-limited; the WebSocket proxy requires a session and a path whitelist.
- Security headers (CSP, X-Frame-Options, nosniff), restricted CORS + origin checks,
  scrypt password hashing, hashed session tokens, and parameterized SQL throughout.
- Rotate API keys if they were ever shared in chat or committed to git.

## Tests

```bash
npm test
```

Syntax checks every server file, then unit-tests the secret scrubber, rate limiter,
and AI reply parser. Runs in CI on every push (see `.github/workflows/ci.yml`).

## Deployment

See **[DEPLOYMENT.md](DEPLOYMENT.md)** — GitHub repo, Vercel import, env vars, and
CI/CD. The app deploys as a Vercel serverless function backed by Neon Postgres.
