# Avatar AI Landing Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone, premium dark landing page for Avatar AI that showcases the product (hero video of the real avatar) and drives visitors to sign up and try the app.

**Architecture:** A separate, **pure static** site (no Node, no build step, no secrets) in its own repo `talking-aiavatar-landing`, deployed to its own Vercel project. "Try now" buttons deep-link to the existing app's login page. This keeps the app URL stable for existing users, the landing instant-loading, and the surface zero-risk.

**Tech Stack:** Vanilla HTML + CSS + JS (zero dependencies — matches repo conventions, no pipeline). User-provided hero background video (`mp4`/`webm`, muted autoplay loop). Deploy: Vercel static.

**Design skills to load at build time:** `high-end-visual-design`, `frontend-design`, `design-taste-frontend` (user explicitly demanded: dark, premium, **not** an "AI-looking" landing page).

## Global Constraints

- Dark theme, keep the name **"Avatar AI"** (no rename).
- **No AI-slop**: no purple/indigo gradients, no floating robot icons, no glassmorphism overload, no "Unlock the future" copy. Human, cinematic, editorial.
- Humanizing copy: the product is a *person* (brunette female avatar), not a bot. Emotion + warmth + craft.
- Hero uses a **user-provided background video** (the real avatar demo). Build against a placeholder `<video>` + poster until the asset arrives; swap-in must be a one-line change.
- "Try now" CTA → `https://talking-aiavatar.vercel.app/login.html` (opens in new tab).
- Sections (user-selected): Hero + CTA, Features grid, closing CTA band, minimal footer. **No** testimonials/pricing/FAQ.
- Static only: no server, no API keys, no analytics scripts (or privacy-friendly opt-in later).
- All new code is vanilla ES modules / plain CSS. No build tooling.

---

## File Structure

```
talking-aiavatar-landing/          (new repo, sibling of avatar-ai)
  index.html                       — single-page landing (all sections)
  css/style.css                    — design tokens + all styles
  js/main.js                       — tiny JS: scroll reveal, video handling, micro-interactions
  assets/                          — hero.mp4 (user), poster.jpg, favicon.svg, og-image.png
  .gitignore
  README.md                        — URL, how to swap the video, how to deploy
```

No separate files per section — one small page keeps it fast and reviewable.

---

## Task 1: Scaffold the landing repo

**Files:**
- Create: `talking-aiavatar-landing/` (git init, `-b main`), `index.html`, `css/style.css`, `js/main.js`, `assets/`, `.gitignore`, `README.md`

- [ ] **Step 1: Create folder structure + git init + minimal files**

```bash
mkdir -p talking-aiavatar-landing/{css,js,assets}
cd talking-aiavatar-landing && git init -b main
```

- [ ] **Step 2: Write `.gitignore`**

```gitignore
node_modules/
.DS_Store
*.log
.vercel/
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: scaffold landing page repo"
```

**Deliverable:** Clean, tracked repo with placeholder files that will each be filled by later tasks.

---

## Task 2: Design tokens + base stylesheet

**Files:**
- Modify: `css/style.css` (create)

- [ ] **Step 1: Define tokens** — dark, warm, editorial (load `high-end-visual-design` skill first). Recommended direction: near-black `#0B0B0D` base, warm bone-white text, one **vivid amber/ember accent** (distinct from the app's blue — hero is human warmth, not tech-blue), film grain overlay, generous whitespace, `clamp()` fluid type.
- [ ] **Step 2: Typography** — distinctive pairing that reads *human*, not chatbot: display serif or tight grotesque for headlines (e.g. Fraunces / Instrument Serif × Inter / Geist via Google Fonts), tracked-out uppercase kickers.
- [ ] **Step 3: Base primitives** — reset, buttons (magnetic hover), links, focus-visible rings, selection color, reduced-motion support.
- [ ] **Step 4: Commit** — `git commit -m "feat: design tokens and base styles"`

**Deliverable:** A style system that looks like a high-end agency site, audited against the anti-slop checklist.

---

## Task 3: Hero section (video background + CTA)

**Files:**
- Modify: `index.html`, `css/style.css`, `js/main.js`

- [ ] **Step 1: HTML** — full-viewport hero: `<video autoplay muted loop playsinline>` (placeholder `src`, `poster`), cinematic gradient + vignette overlays so text stays readable, kicker line, big headline, subline, primary CTA **"Try it now — it's free"** (→ app login, `target="_blank"`), secondary link, scroll cue.
- [ ] **Step 2: CSS** — hero layout, fluid type (headline ~`clamp(2.5rem, 7vw, 6rem)`), text-over-video contrast, scroll cue animation.
- [ ] **Step 3: JS** — video: try `play()` after first interaction for reliable autoplay; swap-in ready via one `const HERO_VIDEO = "assets/hero.mp4"` line.
- [ ] **Step 4: Commit** — `feat: hero section with video background`

**Copy draft (edit freely):**
- Kicker: `A REAL-TIME AI COMPANION`
- Headline options: *"Talk to a face, not a chatbot."* / *"She listens. She speaks. She looks you in the eye."*
- Sub: *"Avatar AI is a lifelike 3D assistant that answers out loud in real time — powered by Kimi & ElevenLabs. No typing walls. Just conversation."*

**Deliverable:** Hero that immediately sells the product and the video asset carries the wow.

---

## Task 4: Features grid (6 cards)

**Files:**
- Modify: `index.html`, `css/style.css`

- [ ] **Step 1: HTML** — 6 cards, editorial style (thin hairline borders, number/wordmark index, no icon-grid cliché):
  1. **Real-time conversation** — she replies out loud, instantly
  2. **Lifelike lip sync** — every word matches her mouth
  3. **Talk, don't type** — speak with your mic
  4. **Show, don't tell** — upload images & files, she reads them
  5. **She remembers** — per-account chat history
  6. **Free to start** — the 3D avatar runs right in your browser
- [ ] **Step 2: CSS** — grid (`repeat(auto-fit, minmax(...))`), hover micro-interactions (border glow, translate, corner accent), subtle reveal-on-scroll.
- [ ] **Step 3: Commit** — `feat: features grid`

**Deliverable:** A features section that builds desire — every card maps to a real working feature of the app.

---

## Task 5: Closing CTA band + footer

**Files:**
- Modify: `index.html`, `css/style.css`

- [ ] **Step 1: HTML** — full-width final CTA: short punchy line (*"Meet her."* / *"Start talking."*), repeat primary button, tiny trust note (*"Free to start · No credit card"*). Footer: brand mark, app link, copyright.
- [ ] **Step 2: CSS** — band styling with the accent treatment; footer minimal.
- [ ] **Step 3: Commit** — `feat: closing CTA and footer`

**Deliverable:** A single, unmissable ask.

---

## Task 6: Motion, polish, responsiveness

**Files:**
- Modify: `css/style.css`, `js/main.js`

- [ ] **Step 1: JS** — IntersectionObserver scroll-reveal (respect `prefers-reduced-motion`), magnetic primary button, video interaction unlock.
- [ ] **Step 2: CSS** — responsive breakpoints (hero text stack, grid collapse), focus states, hover transitions everywhere, 60fps hints (transform/opacity only).
- [ ] **Step 3: Validate** — `node --check js/main.js`, open locally (`npx serve` or python http.server), browser-use screenshot at desktop + mobile widths, check console errors.
- [ ] **Step 4: Commit** — `feat: motion, polish, responsiveness`

**Deliverable:** Feels expensive. No jank, no console errors.

---

## Task 7: SEO + meta + favicon

**Files:**
- Modify: `index.html`, `assets/favicon.svg`

- [ ] **Step 1:** `<title>Avatar AI — A real-time 3D AI companion that talks back</title>`, meta description, canonical (deployed URL once known), Open Graph (title, description, image `assets/og-image.png`), theme-color, favicon SVG (simple mark, not a robot).
- [ ] **Step 2: Commit** — `feat: SEO and meta tags`

**Deliverable:** Shares and search results look intentional.

---

## Task 8: Create repo, deploy to Vercel, verify

**Files:**
- Repo: `talking-aiavatar-landing` (private or public — ask user), Vercel project `talking-aiavatar-landing`

- [ ] **Step 1:** `gh repo create talking-aiavatar-landing --source=. --push` (visibility per user preference)
- [ ] **Step 2:** `vercel projects add talking-aiavatar-landing && vercel link --yes --project talking-aiavatar-landing && vercel --prod --yes`
- [ ] **Step 3:** Verify live: `curl` status codes, hero loads, video asset 200, CTA link correct. Update README + canonical with final URL.
- [ ] **Step 4: Commit + push** (canonical/README updates)

**Deliverable:** Live at `https://talking-aiavatar-landing.vercel.app` (URL to confirm).

---

## Task 9: Final review pass

- [ ] **Step 1:** Spawn `code-reviewer-deepseek-flash` on the landing page changes.
- [ ] **Step 2:** Browser-use final screenshot (desktop + mobile) against the deployed URL; verify CTA reaches the app login page.
- [ ] **Step 3:** Fix anything found, commit.

**Deliverable:** Shipped, reviewed, verified.

---

## Open items / dependencies

- **Hero video**: user to provide the background video of the real avatar (+ optional poster/OG image). Build proceeds with a placeholder video until it arrives; swap is one line (`HERO_VIDEO`).
- **Repo visibility**: ask user whether the landing repo should be public or private.
- **Deployed URL**: confirm the Vercel project name / final URL for the canonical tag and README.

## Self-review checklist

- Spec coverage: showcase→signups ✅ (hero sells, features build desire, CTA everywhere); video hero ✅ (Task 3); features grid ✅ (Task 4); dark, non-AI design ✅ (Task 2 + skills); separate repo + Vercel + Try-now deep link ✅ (Task 8); "Avatar AI" name ✅.
- Placeholder scan: video asset is the only external dependency and is explicitly handled with a swap-line.
- Type/name consistency: sections, classes, and `HERO_VIDEO` const referenced consistently across tasks.
