# Deployment Guide — Avatar AI

This project is built to deploy as a **Vercel serverless app** with **Neon Postgres** and
a **GitHub Actions** CI pipeline. Everything below is tested against the local code.

---

## 1. Create the GitHub repository & push

```bash
cd avatar-ai

# (already done locally) first commit
git add -A
git commit -m "Initial commit: Avatar AI full-stack"

# create a private repo on GitHub (or public) and push
gh repo create avatar-ai --private --source=. --push
```

> The `.env` file is gitignored — **your API keys never leave this machine.**

## 2. Import into Vercel

1. Go to https://vercel.com → **Add New → Project**
2. Import the `avatar-ai` GitHub repo
3. Vercel auto-detects `vercel.json` (one serverless function serves both API + UI)
4. Under **Environment Variables**, add **exactly these**:

| Name | Value |
|------|-------|
| `ELEVENLABS_API_KEY` | your ElevenLabs key |
| `ELEVENLABS_VOICE_ID` | your voice id |
| `ELEVENLABS_MODEL_ID` | `eleven_turbo_v2_5` |
| `NVIDIA_API_KEY` | your NVIDIA NIM key |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` |
| `NVIDIA_MODEL` | `meta/llama-3.1-70b-instruct` |
| `VISION_MODEL` | `meta/llama-3.2-90b-vision-instruct` |
| `DATABASE_URL` | your **pooled** Neon connection string |
| `TRUST_PROXY` | `true` (so rate limits see real client IPs) |
| `ALLOWED_ORIGINS` | *(optional)* strict origin allowlist. Leave unset and the app
  accepts **same-origin requests only** — which works automatically on localhost
  and every Vercel URL (main + previews). Set it later (e.g. `https://your-app.vercel.app`)
  once you want a strict allowlist. |
| `A2F_ENABLED` | `false` |

5. Click **Deploy** — no origin configuration needed afterwards.

## 3. After first deploy

- Vercel gives you a URL like `https://avatar-ai.vercel.app`
- Optional: add a custom domain in Vercel → **Domains**
- Tip: if you ever change the domain or add custom domains, the same-origin
  default keeps working; only set `ALLOWED_ORIGINS` if you need a strict
  allowlist (e.g. API access from another site).

## 4. CI/CD (already configured)

`.github/workflows/ci.yml` runs on every push/PR to `main`:

- `npm ci`
- `npm test` (syntax checks + security + parser unit tests)

Vercel's GitHub integration auto-deploys every push to `main` (preview deploys on PRs).

## Admin console (separate private repo)

The operator dashboard (analytics, user chat history, live activity feed) lives in its own
**private** repository (`talking-aiavatar-admin`) as a standalone app that reads from the
same database. It is not part of this public codebase.

- **Live:** https://talking-aiavatar-admin.vercel.app (dedicated admin login)
- **Repo:** https://github.com/sharvindev6-hue/talking-aiavatar-admin (private)

See that repo's README for how to run and deploy it.

## Notes & known limits

- **Attachments**: images are compressed in the browser before upload. Vercel's Hobby
  plan limits request bodies to ~4.5 MB — fine for a few photos, but a large multi-file
  upload could exceed it. (Pro plan raises this; or we move files to Vercel Blob.)
- **WebSockets**: the ElevenLabs WS proxy is local-only; the deployed app uses the HTTP
  `/api/tts/stream` endpoint, which works on serverless.
- **Rate limits** are in-memory (per instance). On Vercel's many instances they're a
  per-instance approximation; swap for Upstash when you scale past a handful of users.
- **Backups**: Neon auto-backups your database. Vercel handles uptime/SSL/CDN.

## Local development (unchanged)

```bash
npm install
cp .env.example .env   # add your keys
npm run dev            # http://localhost:3003
```
