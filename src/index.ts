import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

// ──────────────────────────────────────────────────────────────────────────
// Config — the main knobs
// ──────────────────────────────────────────────────────────────────────────
const BRIEF_NAME = "Toshi";
const MODEL = "gemini-2.5-flash"; // free-tier model with Google Search grounding (3.x / pro need a paid plan)
const TZ = "Europe/Podgorica"; // Montenegro (CET/CEST)
const MAX_TOKENS = 8192; // headroom — Gemini's "thinking" shares this output budget
const TELEGRAM_LIMIT = 3900; // headroom under Telegram's 4096 (UTF-16 code units)

// The section list lives in ONE place and drives the system prompt below.
const SECTIONS = [
  { emoji: "🪙", name: "Crypto", guidance: "BTC, ETH and notable alts; major headlines, ETF/institutional flows, regulation." },
  { emoji: "🐸", name: "Memecoins", guidance: "Biggest movers, new launches gaining real traction, narrative shifts. Flag that these are high-risk and volatile." },
  { emoji: "📈", name: "Stocks & Markets", guidance: "Major indices, big single-name moves, macro/Fed data, notable earnings." },
  { emoji: "🌍", name: "World", guidance: "The most significant global news stories." },
  { emoji: "🥊", name: "UFC / MMA", guidance: "Recent fight results, upcoming cards, and big news (title changes, signings, injuries)." },
  { emoji: "🤖", name: "AI (Anthropic first)", guidance: "PRIORITY SECTION — give it the most depth and a few extra bullets. LEAD with Anthropic / Claude (model & product releases, research, safety & policy, funding, hiring, leadership), then other major labs (OpenAI, Google DeepMind, Meta, xAI, Mistral) and notable AI product/tooling news. Never skip this section; if there's genuinely no Anthropic news, say so in one line and cover the broader AI landscape." },
  { emoji: "⭐", name: "Wildcard", guidance: "One genuinely interesting story that doesn't fit above (optional)." },
] as const;

// Read once for the failure handler; validated properly inside run().
const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ──────────────────────────────────────────────────────────────────────────
// Prompt
// ──────────────────────────────────────────────────────────────────────────
function buildSystemPrompt(todayLabel: string): string {
  const sectionLines = SECTIONS.map((s) => `${s.emoji} ${s.name} — ${s.guidance}`).join("\n");
  return [
    `You are ${BRIEF_NAME}, a daily news brief writer. Today is ${todayLabel}.`,
    `Use Google Search to find the most important developments from the ~24 hours ending now, then write ONE concise brief.`,
    ``,
    `SECTIONS (use this order; skip any that are genuinely empty on a slow day):`,
    sectionLines,
    ``,
    `FORMAT RULES:`,
    `- Open with one header line exactly: "${BRIEF_NAME} — ${todayLabel}".`,
    `- Then one line starting "Big picture: " — 1-2 sentences summarising the day's most important threads.`,
    `- Then the sections, using the emoji section headers exactly as listed above.`,
    `- Under each section, bullets that start with "• ". One or two punchy, well-summarised sentences each. No fluff, no hedging.`,
    `- Lead with what matters most to someone tracking crypto and markets; the AI (Anthropic) section is a priority and should be thorough.`,
    `- PLAIN TEXT ONLY. No markdown: no **bold**, no ## headers, no [text](url) links — they render as literal characters in Telegram.`,
    `- Name the source of each item in plain text, e.g. "(Reuters)". Do NOT paste raw URLs — a linked "Sources" list is appended automatically.`,
    `- Keep the main brief tight (~500-650 words). Prioritise ruthlessly.`,
    `- Output ONLY the brief itself — no preamble, no sign-off, no meta commentary.`,
  ].join("\n");
}

// Telegram is sent as plain text; strip any stray markdown the model emits so
// **bold**, # headers, and [text](url) don't render as literal characters.
function toPlainText(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [text](url) -> text
    .replace(/(^|\n)\s{0,3}#{1,6}\s+/g, "$1") // leading # headers
    .replace(/\*+/g, "") // ** and * emphasis markers
    .replace(/`+/g, ""); // stray backticks
}

// ──────────────────────────────────────────────────────────────────────────
// Generate the brief (Gemini + Google Search grounding)
// ──────────────────────────────────────────────────────────────────────────
type BriefResult = { text: string; sources: { title: string; uri: string }[] };

// Gemini's free tier occasionally returns a transient 503 (high demand), 429, or
// other 5xx. Retry a few times with exponential backoff so one blip doesn't skip
// the day's brief.
async function generateContentWithRetry(ai: GoogleGenAI, params: any) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (e: any) {
      const info = `${e?.status ?? e?.code ?? ""} ${e?.message ?? e}`;
      const transient = /\b(429|500|502|503|504)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand/i.test(info);
      if (!transient || attempt >= 6) throw e;
      const delayMs = Math.min(60000, 4000 * 2 ** (attempt - 1)); // 4s, 8s, 16s, 32s, 60s (~2 min total)
      console.warn(`Gemini transient error (attempt ${attempt}/6); retrying in ${delayMs / 1000}s…`);
      await sleep(delayMs);
    }
  }
}

async function generateBrief(todayLabel: string): Promise<BriefResult> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const response = await generateContentWithRetry(ai, {
    model: MODEL,
    contents: "Write today's brief.",
    config: {
      systemInstruction: buildSystemPrompt(todayLabel),
      tools: [{ googleSearch: {} }], // grounding: Gemini searches + cites server-side, one shot
      maxOutputTokens: MAX_TOKENS,
    },
  });

  const finish = String(response.candidates?.[0]?.finishReason ?? "STOP");
  if (finish !== "STOP" && finish !== "MAX_TOKENS") {
    console.warn(`Gemini finishReason=${finish} — response may be blocked or empty.`);
  }
  if (finish === "MAX_TOKENS") {
    console.warn("Hit maxOutputTokens — brief may be truncated; consider raising MAX_TOKENS.");
  }

  // Real source links Gemini grounded on (each chunk: { web: { uri, title } }).
  // Dedupe by publisher domain and keep the first few.
  const chunks: any[] = (response.candidates?.[0]?.groundingMetadata as any)?.groundingChunks ?? [];
  const seen = new Set<string>();
  const sources: { title: string; uri: string }[] = [];
  for (const c of chunks) {
    const uri: string | undefined = c?.web?.uri;
    const title: string = c?.web?.title ?? "source";
    if (!uri || seen.has(title)) continue;
    seen.add(title);
    sources.push({ title, uri });
    if (sources.length >= 8) break;
  }

  return { text: (response.text ?? "").trim(), sources };
}

// ──────────────────────────────────────────────────────────────────────────
// Telegram delivery (plain text, chunked, sequential)
// ──────────────────────────────────────────────────────────────────────────
function chunk(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if (line.length > TELEGRAM_LIMIT) {
      // Single over-long line (e.g. a pasted URL): hard-slice as a last resort.
      if (buf) { out.push(buf); buf = ""; }
      for (let i = 0; i < line.length; i += TELEGRAM_LIMIT) out.push(line.slice(i, i + TELEGRAM_LIMIT));
      continue;
    }
    if (buf && buf.length + 1 + line.length > TELEGRAM_LIMIT) { out.push(buf); buf = ""; }
    buf = buf ? buf + "\n" + line : line;
  }
  if (buf) out.push(buf);
  return out;
}

async function tgSend(text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  // No parse_mode = plain text, which sidesteps all Markdown/HTML entity-parse errors.
  const body = JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true });
  let attempt = 0;
  while (true) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    const j: any = await r.json();
    if (j.ok) return;
    if (j.error_code === 429 && attempt++ < 1) {
      await sleep(((j.parameters?.retry_after ?? 1) + 0.5) * 1000); // honor retry_after, then retry once
      continue;
    }
    throw new Error(`Telegram ${j.error_code}: ${j.description}`);
  }
}

async function sendToTelegram(text: string): Promise<void> {
  for (const part of chunk(text)) {
    await tgSend(part);
    await sleep(1000); // stay under the per-chat rate limit
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────
async function run(): Promise<void> {
  // Preview mode (`--print` or DRY_RUN=1) prints the brief to the terminal instead
  // of sending it, so you can see output with only a GEMINI_API_KEY set.
  const preview = process.argv.includes("--print") || process.env.DRY_RUN === "1";
  const required = preview
    ? ["GEMINI_API_KEY"]
    : ["GEMINI_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];
  for (const name of required) {
    if (!process.env[name]) throw new Error(`Missing required env var: ${name}`);
  }

  // Compute the date in MY timezone — don't let the model guess "today".
  const todayLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date());

  const { text: rawBrief, sources } = await generateBrief(todayLabel);
  let text =
    toPlainText(rawBrief).trim() ||
    `🗞️ ${BRIEF_NAME} — ${todayLabel}\n\nQuiet news day — nothing notable in the last 24h.`;
  if (sources.length) {
    text += "\n\n🔗 Sources (from this morning's search)\n" + sources.map((s) => `• ${s.title} — ${s.uri}`).join("\n");
  }

  if (preview) {
    console.log(`\n----- PREVIEW for ${todayLabel} (not sent to Telegram) -----\n`);
    console.log(text);
    console.log(`\n----- ${text.length} chars -----`);
    return;
  }

  await sendToTelegram(text);
  console.log(`Sent ${text.length} chars to Telegram.`);
}

run().catch(async (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("Brief failed:", msg);
  // Turn a silent failure into a visible ping (only if we have Telegram creds).
  if (TOKEN && CHAT_ID) {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: `⚠️ ${BRIEF_NAME} failed: ${msg.slice(0, 300)}` }),
    }).catch(() => {});
  }
  process.exit(1);
});
