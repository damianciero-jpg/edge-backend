# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Commands

```bash
node server.js        # Dev server at localhost:3001
vercel --prod         # Deploy to production (no build step needed)
```

**There is no build step.** This is a plain Express/Node.js app served directly by Vercel.

**Deploy:**
```bash
vercel --prod
```
Never use the `functions` key alongside `builds` in `vercel.json` — it causes a config conflict. Use `builds[0].config.maxDuration` instead.

## Architecture

**EDGE** is an AI-powered sports betting analytics PWA. Users get live odds from The Odds API, then run Claude AI to model expected value (EV) on any game. Free users get 2 analysis credits; paid users subscribe or buy credit packs via Stripe.

### Stack
- **Backend**: Express.js running as a Vercel serverless function
- **Frontend**: Single HTML file (`public/index.html`) — all CSS, HTML, and JS in one file (~1100 lines)
- **Storage**: Upstash Redis in production, local JSON files in dev (KV adapter pattern)
- **AI**: Anthropic Claude API — Haiku for Quick mode, Sonnet for Research mode
- **Payments**: Stripe (subscriptions + one-time credit packs)
- **Odds data**: The Odds API

### File Layout
```
server.js                  — Express entry point, mounts all routes
vercel.json                — Vercel config (builds + maxDuration:300)
routes/
  analyze.js               — POST /api/analyze — Claude AI analysis
  checkout.js              — POST /api/checkout — Stripe checkout sessions
  webhook.js               — POST /api/webhook — Stripe webhook handler
  admin.js                 — /api/admin/* — admin endpoints (password protected)
lib/
  users.js                 — User CRUD: credits, subscriber status
  limits.js                — Global and per-user daily rate limits
  config.js                — App config (Stripe keys) read from Redis or env vars
public/
  index.html               — Entire frontend: CSS + HTML + JS in one file
  admin.html               — Admin panel UI
  manifest.json            — PWA manifest
  icon.svg                 — App icon
```

### Storage: KV Adapter Pattern
Every lib file checks `USE_KV = !!process.env.UPSTASH_REDIS_REST_URL`:
- **Production (Vercel)**: Upstash Redis via REST API
- **Local dev**: JSON files (`users.json`, `daily.json`, `config.json`)
- **Vercel file paths**: Always use `/tmp/` prefix — the project root is **read-only** on Vercel Lambda. Detect with `process.env.VERCEL`.

```js
const DB_PATH = process.env.VERCEL ? '/tmp/users.json' : path.join(__dirname, '..', 'users.json');
```

### AI Analysis: Two Modes
| Mode | Model | Tools | Timeout | Cost |
|------|-------|-------|---------|------|
| ⚡ Quick | `claude-haiku-4-5-20251001` | none | 30s SDK / 200s client | 1 credit |
| 🔍 Research | `claude-sonnet-4-6` | `web_search_20250305` | 180s SDK / 200s client | 1 credit |

**System prompt rule**: Always instruct Claude to return ONLY raw JSON — no markdown, no `//` comments, no preamble. Start response with `{`, end with `}`.

**Credit deduction**: Happens AFTER a successful API response (fire-and-forget). Never deduct before — timeouts/errors must not consume credits.

**JSON parsing**: Strip `//` comments and trailing commas before `JSON.parse`:
```js
const cleanJson = m[0].replace(/\/\/[^\n]*/g, '').replace(/,(\s*[}\]])/g, '$1');
```

### Rate Limiting
- `withTimeout(promise, ms, label)` — wraps all Redis calls. Non-fatal Redis slowness never blocks routes.
- Global daily limit: `GLOBAL_DAILY_LIMIT` env var (default 150)
- Per-subscriber daily limit: `MAX_DAILY_ANALYSES` env var (default 20)
- Free users: credit balance is the limit (no daily counter)

### Stripe: Dynamic Key Loading
Stripe keys are **never hardcoded**. Read per-request via `getCfg()`:
```js
const stripeKey = await getCfg('stripeSecretKey', 'STRIPE_SECRET_KEY');
```
`getCfg(redisKey, envVar, fallback)` — checks Redis config first, then env var, then fallback. Admin can update keys via `/admin.html` without redeploying.

## Environment Variables

| Variable | Used by | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `routes/analyze.js` | Claude API |
| `UPSTASH_REDIS_REST_URL` | all `lib/` files | Upstash Redis URL |
| `UPSTASH_REDIS_REST_TOKEN` | all `lib/` files | Upstash Redis token |
| `ODDS_API_KEY` | `public/index.html` (client-side) | The Odds API |
| `STRIPE_SECRET_KEY` | `routes/checkout.js`, `routes/webhook.js` | Overridden by Redis config |
| `STRIPE_WEBHOOK_SECRET` | `routes/webhook.js` | Overridden by Redis config |
| `STRIPE_SUB_PRICE_ID` | `routes/checkout.js` | Monthly subscription |
| `STRIPE_CREDITS_10_PRICE_ID` | `routes/checkout.js` | 10-credit pack ($4.99) |
| `STRIPE_CREDITS_50_PRICE_ID` | `routes/checkout.js` | 50-credit pack ($14.99) |
| `ADMIN_PASSWORD` | `routes/admin.js` | Default: `edge-admin-2026` |
| `GLOBAL_DAILY_LIMIT` | `lib/limits.js` | Default: 150 |
| `MAX_DAILY_ANALYSES` | `lib/limits.js` | Default: 20 |

## Admin Panel

URL: `/admin.html`  
Password: `edge-admin-2026` (set via `ADMIN_PASSWORD` env var)

Admin can:
- View/reset global and per-user daily counts
- Adjust daily limits without redeploying
- Add/edit Stripe keys (stored in Redis, override env vars)
- Manage users: add credits, toggle subscriber status

## User Identity (Current)

Users are currently **anonymous** — a UUID is generated client-side and stored in `localStorage`. No real accounts exist. Free credits are tied to this UUID; clearing storage gets a new UUID and more free credits.

**Planned**: Magic-link email auth. Email becomes the persistent userId. Closes the credit-farming loophole.

## Rules

- **No TypeScript** — plain JavaScript only.
- **AI models** — `claude-haiku-4-5-20251001` for Quick, `claude-sonnet-4-6` for Research. Never swap.
- **Stripe keys** — always load via `getCfg()`, never hardcode.
- **vercel.json** — use `builds[0].config.maxDuration`, never add a `functions` key alongside `builds`.
- **File writes on Vercel** — always use `/tmp/` path, never the project root.
- **Credits** — deduct only after successful AI response. Never before.
- **Frontend** — everything in `public/index.html`. No separate JS files, no bundler.
