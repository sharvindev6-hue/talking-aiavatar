# Avatar AI → Hermes-style upgrade plan

Goal: turn the 3D avatar app into a Hermes-agent-grade companion — real persistent
memory, streaming chat, scheduled automations, and skills/tools — while keeping the
**3D avatar as the centerpiece** (user decision).

Current state (audited):
- 3D avatar (three.js + TalkingHead), ElevenLabs TTS, Kimi LLM via NVIDIA NIM
- Accounts (scrypt + sessions), chat history in Postgres (Neon), attachments,
  admin console. All deployed on Vercel, security-hardened.
- "Memory" today is primitive: first + last 3 msgs of 3 recent sessions, 5000-char cap.

---

## Phase 1 — Real memory (fixes the #1 complaint: "it has no memory")

### Schema (added to initSchema in server/db.js)
```sql
CREATE TABLE IF NOT EXISTS memory_facts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  fact TEXT NOT NULL,
  category TEXT,                  -- preference | personal | project | habit | other
  source_session_id TEXT,
  confidence INTEGER DEFAULT 1,   -- 1 = stated explicitly, 0 = inferred
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_memory_facts_user ON memory_facts(user_id);

CREATE TABLE IF NOT EXISTS session_summaries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL UNIQUE REFERENCES chat_sessions(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  key_points JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Pipeline (new module server/memory.js)
- **Extract** — after each assistant turn, call the LLM with a strict JSON prompt to
  pull `{facts: [{fact, category, confidence}], summary, key_points}` for the exchange.
  Run asynchronously (fire-and-forget), capped at one extraction per session per ~2 min.
- **Dedupe** — facts are deduped by normalized text (lowercase, trim, fuzzy-contains);
  newest wins. Per-user fact cap (~300) with LRU eviction by last_used_at.
- **Forget** — user says "forget that I like X" → delete matching fact(s); "forget
  everything" → clear facts for the user (keep sessions).
- **Recall** — on each chat request, replace the crude buildMemoryBlock recap with:
  top ~12 facts (recency + confidence) + the 5 most recent session summaries,
  injected as a `[MEMORY]` system block. Track last_used_at.

### UI
- "What I remember" drawer (side panel, toggleable): list facts by category,
  delete-per-fact ("forget"), copy. Keep avatar center; drawer overlays on demand.

### Admin
- Add memory_facts + session_summaries counts to the admin analytics overview.

---

## Phase 2 — Streaming + UI upgrade

### Server
- New `POST /api/chat/stream` (SSE) — same validation/auth/rate-limit as /api/chat but
  calls NIM with `stream: true`, parses `data:` chunks, emits:
  `event: delta` (token), `event: done` (final {say, emotion, gesture, raw}).
  Buffers full text so the final JSON envelope is still validated (same retry logic).
  Keep the existing non-stream endpoint as fallback (feature-flag).

### Client (public/js/chat.js + app.js)
- `fetch` + ReadableStream reader; render tokens into the live bubble (preserve
  markdown/parse.js rendering), typing/thinking indicator while waiting for first token,
  Stop button (AbortController) to cancel streaming.
- Session sidebar (uses existing /api/history): list chats, switch, new-chat, delete.
- Light context meter chip: "memory: N facts · summary of last session".

---

## Phase 3 — Scheduled automations

### Schema
```sql
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  schedule TEXT NOT NULL,           -- raw natural-language ("tomorrow 7pm")
  cron TEXT,                        -- resolved cron expr if applicable
  next_fire_at TIMESTAMPTZ,
  fired_count INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(next_fire_at) WHERE enabled;
```

### Flow
- Intent detection in chat route: if the message looks like a reminder ("remind me",
  "set a reminder", "wake me at...") → LLM extraction `{message, when}` → insert row.
- Delivery: avatar is chat-only (no push channel), so:
  - Client polls `GET /api/reminders/due` every 30s while the tab is open; due
    reminders get announced by the avatar as an assistant message.
  - On login / app open, missed reminders are announced once.
  - Vercel Cron (`vercel.json`: `*/5 * * * *` → `GET /api/reminders/tick`) marks
    due reminders as fired so polling stays consistent; local dev uses a setInterval.
- Commands: "list my reminders", "delete reminder ...".

---

## Phase 4 — Skills & tools

### Skills (schema + detector)
```sql
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  trigger TEXT NOT NULL,            -- keyword/pattern matched at request time
  instructions TEXT NOT NULL,       -- reusable step-by-step the LLM injects
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
- Detector: when a user repeats a similar request shape (or says "remember this as a
  skill"), LLM generates {name, description, trigger, instructions}; store; auto-match
  incoming messages by trigger; inject instructions into system prompt; /skills lists.

### Tools (MVP, risk-flagged)
- **Time/date** — built-in, always available (no API).
- **Web search** — JSON tool-loop: LLM emits `{"tool":"web_search","query":...}` in
  JSON mode → server executes a search API call → results fed back as a follow-up turn
  (max 2 iterations). NOTE: NIM model tool-calling reliability is unproven — keep the
  loop optional/configurable and fall back to plain answers if the model won't comply.

---

## Cross-cutting
- Migrations: all CREATE IF NOT EXISTS in initSchema (existing pattern).
- Security: scrubSecrets on every new endpoint; rate limits on /api/chat/stream,
  /api/reminders/*, /api/skills/*; input caps on all new fields.
- Tests (scripts/test.mjs): memory extract/dedupe/recall unit tests, reminder
  parse tests, stream parser test.
- Deploy per phase (commit → push → vercel --prod → verify live) like the hardening work.
- Vercel env: no new keys needed for Phases 1-3; Phase 4 web search may need a key
  (decide provider when we get there).

## Risks
1. NIM streaming/tool-calling reliability → keep non-stream fallback + config flags.
2. Background extraction adds LLM calls/cost → batch at session end, per-user caps.
3. Reminders can't push (no notification channel) → in-app delivery only, set
   expectations in UI copy.
