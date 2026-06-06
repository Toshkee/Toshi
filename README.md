# Toshi — Daily News Brief

A small personal app that once a day asks Gemini to web-search the last 24 hours
of news and sends a single concise brief to your Telegram. No news APIs —
Gemini's **Google Search grounding** does the gathering and the writing.

## How it works

`src/index.ts` makes one Gemini API call (`@google/genai`) with the
**Google Search** grounding tool, which searches the web and writes the brief in
one shot, then sends it to Telegram as plain text (chunked under the 4096-char
limit). A GitHub Actions cron runs it daily; `workflow_dispatch` lets you trigger
it by hand.

## 1. Prerequisites

- **Node 20+**
- **Gemini API key — free** from Google AI Studio: https://aistudio.google.com/apikey
  (no billing required for the free tier; grounded-search has a generous daily
  free quota — check current limits if you scale up)
- **A Telegram bot + your chat id** (below)

## 2. Create the Telegram bot and get your chat id

1. In Telegram, message **@BotFather** → `/newbot` → follow the prompts → copy
   the **bot token** it gives you.
2. **Send your new bot any message** (e.g. "hi"). A bot can't start a
   conversation, so this step is required before the next one returns anything.
3. Open this URL in a browser (paste your token):
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
4. In the JSON, read `result[0].message.chat.id` — that integer is your
   `TELEGRAM_CHAT_ID` (it's negative for groups; store it without quotes).

## 3. Local setup

```bash
npm install
cp .env.example .env   # then fill in the values
npm run preview        # prints the brief to your terminal (needs ONLY GEMINI_API_KEY; no Telegram)
npm start              # sends today's brief to your Telegram
```

Set your timezone once in `src/index.ts` (`const TZ = ...`) so the header date
and the 24-hour window match your clock.

## 4. Deploy (daily automation)

1. Create a GitHub repo and push this project.
2. In the repo: **Settings → Secrets and variables → Actions → New repository
   secret**, and add all three:
   - `GEMINI_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
3. It now runs on the daily cron in `.github/workflows/daily.yml`. Trigger a test
   run any time from the **Actions** tab → *Daily News Brief* → **Run workflow**.

The cron is **21:00 UTC** (06:00 Asia/Tokyo). Change both the `cron:` line and
`TZ` together if you want a different local delivery time.

## Customising

- **Sections:** edit the `SECTIONS` array in `src/index.ts` — it drives the
  prompt, so adding/removing a category is a one-line change.
- **Quality vs. cost:** `gemini-2.5-flash` is the default because it's on the free
  tier (grounding included). Newer models (`gemini-3.5-flash`, `gemini-3.1-pro`)
  give higher quality but currently require a **paid** plan on your key — swap
  `MODEL` once billing is enabled.
- **Preferred sources:** Google Search grounding has no hard domain allowlist, but
  you can tell the model in the system prompt to prioritise outlets you trust
  (e.g. "prefer Reuters, CoinDesk, ESPN").

## Good to know

- **Failures ping you:** if a run errors, it sends a one-line "failed" message to
  the same chat and exits non-zero (red in the Actions tab) — so a broken run
  isn't silent.
- **Cost:** the Gemini free tier covers a once-a-day brief; beyond it, Flash is
  very cheap. `gemini-3.1-pro` costs more — swap only if you want the quality.
- **Schedule drift:** GitHub Actions cron is best-effort and often runs 10–60+ min
  late; the 24-hour window is computed from the actual run time, so delays don't
  create gaps.
- **60-day auto-disable:** GitHub disables scheduled workflows after 60 days with
  no repo commits. If briefs stop, re-enable from the Actions tab (the failure
  ping doubles as a heartbeat so you'll notice silence).
- **Secrets:** `.env` is git-ignored; only `.env.example` (placeholders) is
  committed. Never log `process.env` or full Telegram request URLs (the bot token
  is in the URL path, and Actions logs are world-readable on public repos).
- **Grounding attribution:** Google's grounding terms ask apps to surface search
  suggestions/sources. This is a personal brief to your own chat; the prompt has
  the model name sources inline (e.g. "(Reuters)"). Keep that in mind if you ever
  make it public-facing.
