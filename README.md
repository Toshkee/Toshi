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
3. Trigger a test run any time from the **Actions** tab → *Daily News Brief* →
   **Run workflow**.

### Scheduling — why there are two triggers

GitHub's own `schedule:` cron is **best-effort and routinely runs hours late**
(it once delivered this brief at noon instead of 10:00). So the workflow uses two
triggers, made duplicate-proof by an idempotency guard (the first step skips the
run if a brief already succeeded today):

- **Primary — an external scheduler fires it on time.** A free
  [cron-job.org](https://cron-job.org) job calls the GitHub API to launch the
  workflow at **10:00 Europe/Podgorica**, within seconds, following DST
  automatically (no seasonal edits). One-time setup:
  1. Create a **fine-grained Personal Access Token** (GitHub → Settings →
     Developer settings → *Fine-grained tokens*): *Repository access* → only
     `Toshkee/Toshi`; *Permissions* → **Repository → Actions: Read and write**.
     Set an expiry and note the renewal date.
  2. On cron-job.org, create a job:
     - **URL:** `https://api.github.com/repos/Toshkee/Toshi/actions/workflows/daily.yml/dispatches`
     - **Method:** `POST`
     - **Headers:** `Authorization: Bearer <YOUR_TOKEN>`,
       `Accept: application/vnd.github+json`,
       `X-GitHub-Api-Version: 2022-11-28`, `Content-Type: application/json`
     - **Body:** `{"ref":"main"}`
     - **Schedule:** every day at `10:00`, timezone **Europe/Podgorica**
     - A successful dispatch returns **HTTP 204** (empty body). Enable
       cron-job.org's failure notifications so you hear about a broken trigger.
  Keep the token only in cron-job.org; rotate it before it expires.
- **Fallback — the GitHub `schedule:` cron** (`15 9 * * *`). Best-effort and
  intentionally placed *after* the 10:00 primary window, so on a normal day the
  guard sees the primary already succeeded and skips it. It only actually delivers
  on days the primary didn't fire — so the two triggers never double-send.

If you're not in Montenegro, set `const TZ` in `src/index.ts` and the cron-job.org
job's timezone to your zone (the fallback `cron:` is UTC and DST-agnostic, but as a
safety net its exact time doesn't need to be precise).

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
- **On-time delivery:** the external cron-job.org trigger (see *Scheduling* above)
  fires the workflow on time; the GitHub `schedule:` cron is only a late-running
  fallback. Either way the 24-hour window is computed from the *actual* run time,
  so a delayed run never creates gaps.
- **60-day auto-disable:** GitHub disables *scheduled* workflows after 60 days with
  no repo commits — but the cron-job.org trigger uses `workflow_dispatch`, which is
  **not** subject to that rule, so your daily brief keeps coming even if the fallback
  cron gets disabled. If you ever rely on the fallback again, re-enable it from the
  Actions tab (the failure ping doubles as a heartbeat so you'll notice silence).
- **Secrets:** `.env` is git-ignored; only `.env.example` (placeholders) is
  committed. Never log `process.env` or full Telegram request URLs (the bot token
  is in the URL path, and Actions logs are world-readable on public repos).
- **Grounding attribution:** Google's grounding terms ask apps to surface search
  suggestions/sources. This is a personal brief to your own chat; the prompt has
  the model name sources inline (e.g. "(Reuters)"). Keep that in mind if you ever
  make it public-facing.
