// Story-to-Memory Parser
//
// Converts raw prose or RP text into DigestMessage[] for the sentiment pipeline.
//
// Input formats handled:
//   1. Pre-attributed text — already has "Name: " or "**Name:**" lines (RP logs,
//      chat exports). Normalised and passed directly to the chunker.
//   2. Plain prose — sent to the LLM (local → external) for speaker attribution.
//      The model adds "Name: " prefixes so the chunker can do per-speaker analysis.
//   3. Fallback — paragraph split with "Narrator: " prefix when all LLM calls fail.
//
// Priority: local Ollama → external API → paragraph split.

import { getCachedAuth } from "./auth-cache.js";
import type { DigestMessage } from "./digest.js";

// ── Format detection ──────────────────────────────────────────────────────────
// If the text already has recognisable dialogue attribution, skip the LLM call.

// Matches "Name: text", "**Name:** text", "*Name:* text" — RP and chat export
// formats. Capturing group 1 is the speaker label (lazy, so it stops at the
// first colon rather than swallowing a whole prose sentence with a mid-colon).
const ATTRIBUTION_LINE_RE = /^(?:\*{1,2})?([A-Z][A-Za-z0-9 _'-]{0,40}?)(?:\*{1,2})?:\s+\S/;
const MIN_ATTRIBUTED_LINES = 3;
const MIN_ATTRIBUTED_FRACTION = 0.4;

// Prefixes that look like attribution but are document headers/metadata or the
// start of a prose sentence — never real dialogue speakers.
const NON_SPEAKER_PREFIXES = new Set([
  "date", "time", "note", "ps", "subject", "from", "to", "re", "cc", "bcc",
  "chat", "chapter", "part", "author", "title", "setting", "location", "summary",
  "warning", "content warning", "cw", "tags", "prologue", "epilogue", "the",
]);

function countAttributedLines(text: string): number {
  return text.split("\n").filter((l) => ATTRIBUTION_LINE_RE.test(l.trim())).length;
}

// True only when the text reads like a real dialogue log: a few speakers who
// RECUR and who account for a substantial share of the lines. Prose with stray
// colons ("Date:", "The one that meant the most:") yields many one-off labels
// covering few lines — that must go to the LLM attribution path, not skip it.
export function isPreAttributed(text: string): boolean {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;

  const counts = new Map<string, number>();
  let attributed = 0;
  for (const line of lines) {
    const m = ATTRIBUTION_LINE_RE.exec(line);
    if (!m) continue;
    const label = m[1]!.trim();
    if (label.length < 2 || NON_SPEAKER_PREFIXES.has(label.toLowerCase())) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
    attributed++;
  }

  // Lines belonging to speakers who appear at least twice (dialogue alternates
  // and repeats; incidental prose colons do not).
  let recurringLines = 0;
  for (const n of counts.values()) if (n >= 2) recurringLines += n;

  return recurringLines >= MIN_ATTRIBUTED_LINES && attributed / lines.length >= MIN_ATTRIBUTED_FRACTION;
}

// ── Pre-attributed normalisation ──────────────────────────────────────────────
// Strips markdown bold/italic around the speaker label and normalises to "Name: ".

function normaliseAttributed(text: string): string {
  return text
    .split("\n")
    .map(line => line.replace(/^\*{1,2}([A-Za-z0-9 _'-]+)\*{1,2}:/, "$1:"))
    .join("\n");
}

// ── Attribution validation ────────────────────────────────────────────────────
// After an LLM call, check that the output actually contains attributed lines.
// If the model returned prose instead, the call failed.

function isValidAttribution(text: string): boolean {
  return countAttributedLines(text) >= MIN_ATTRIBUTED_LINES;
}

// ── Attribution prompt ────────────────────────────────────────────────────────

function buildAttributionPrompt(characters: string[]): string {
  const charHint = characters.length > 0
    ? `Known characters: ${characters.join(", ")}.`
    : "Identify character names from the text itself.";

  return `You are a dialogue attribution assistant. Reformat the story passage so every segment is prefixed with the speaker name and a colon.

Rules:
- Dialogue: attribute to the speaking character (infer from context, "she said", paragraph order, etc.)
- Narration, action, description: prefix with "Narrator:"
- Preserve the original wording exactly — do not paraphrase, summarize, or add anything
- One attributed segment per line; split dialogue from narration when mixed in the same sentence
- Unnamed characters: use a consistent label like "Character_A"
${charHint}

Output ONLY the reformatted passage. No commentary, no explanation, no markdown fences.`;
}

// ── LLM calls ─────────────────────────────────────────────────────────────────

async function callLocal(text: string, characters: string[]): Promise<string | null> {
  const base = (process.env.MARINARA_EXTENDER_LOCAL_URL ?? "").replace(/\/$/, "");
  if (!base) return null;
  const model = process.env.MARINARA_EXTENDER_LOCAL_MODEL ?? "phi3:mini";

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: buildAttributionPrompt(characters) },
          { role: "user",   content: text },
        ],
        temperature: 0.1,
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json?.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

async function callExternal(text: string, characters: string[]): Promise<string | null> {
  const auth = getCachedAuth();
  if (!auth) return null;

  const upstream = (process.env.MARINARA_EXTENDER_DIGEST_UPSTREAM ?? "https://api.openai.com")
    .replace(/\/$/, "");
  const model = process.env.MARINARA_EXTENDER_DIGEST_MODEL ?? "gpt-4o-mini";

  try {
    const res = await fetch(`${upstream}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: buildAttributionPrompt(characters) },
          { role: "user",   content: text },
        ],
        temperature: 0.1,
        // Attribution output is ~as long as the input; allow plenty of room so
        // larger external windows aren't truncated.
        max_tokens: Math.min(16384, Math.ceil(text.length / 2.5)),
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json?.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

// ── Fallback: paragraph split ─────────────────────────────────────────────────

function paragraphSplit(text: string): DigestMessage[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ role: "assistant" as const, content: `Narrator: ${p}` }));
}

// ── Input windowing ───────────────────────────────────────────────────────────
// A single attribution call caps output at ~8k tokens, and the attributed text
// is roughly as long as the input — so a long story would lose its tail. Split
// at paragraph boundaries into windows small enough that each window's output
// fits comfortably under the cap, then attribute each independently.

// Local models handle smaller contexts/outputs; the external API can take much
// larger windows, meaning fewer round-trips and more consistent speaker labels.
const MAX_ATTRIBUTION_WINDOW_CHARS_LOCAL = 12_000;
const MAX_ATTRIBUTION_WINDOW_CHARS_EXTERNAL = 28_000;

function splitIntoWindows(text: string, maxChars: number): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const windows: string[] = [];
  let buffer = "";
  for (const para of paragraphs) {
    if (buffer && buffer.length + para.length + 2 > maxChars) {
      windows.push(buffer);
      buffer = para;
    } else {
      buffer = buffer ? `${buffer}\n\n${para}` : para;
    }
  }
  if (buffer.trim()) windows.push(buffer);
  return windows.length > 0 ? windows : [text];
}

// Attribute one window. When useExternal is set, go straight to the external API
// (skipping the local model); otherwise local → external → paragraph-split.
async function attributeWindow(
  text: string,
  characters: string[],
  useExternal: boolean,
): Promise<{ messages: DigestMessage[]; method: ParseMethod }> {
  if (!useExternal) {
    const local = await callLocal(text, characters);
    if (local && isValidAttribution(local)) {
      return { messages: [{ role: "assistant", content: local }], method: "local-llm" };
    }
  }
  const external = await callExternal(text, characters);
  if (external && isValidAttribution(external)) {
    return { messages: [{ role: "assistant", content: external }], method: "external-llm" };
  }
  return { messages: paragraphSplit(text), method: "paragraph" };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ParseStoryOptions {
  characters?: string[];
  forceFallback?: boolean;
  // Skip the local model and attribute via the external API, using larger
  // windows (fewer calls, more consistent labels).
  useExternal?: boolean;
  // Aborts the (potentially long) multi-window attribution loop.
  signal?: AbortSignal;
  // Called as each window begins attribution (1-based). Lets the caller render
  // progress for the otherwise-silent multi-window attribution phase.
  onWindow?: (current: number, total: number) => void;
  // Cached attributed output per window from a prior run (index i present =>
  // window i is already attributed and is reused instead of re-calling the LLM).
  cachedWindows?: DigestMessage[][];
  // Called after a window is freshly attributed, so the caller can persist it
  // for resume. Awaited so the checkpoint is durable before the next window.
  onWindowDone?: (index: number, messages: DigestMessage[]) => void | Promise<void>;
}

export type ParseMethod = "pre-attributed" | "local-llm" | "external-llm" | "paragraph";

export interface ParseStoryResult {
  messages: DigestMessage[];
  method: ParseMethod;
}

export async function parseStoryToMessages(
  text: string,
  options: ParseStoryOptions = {},
): Promise<ParseStoryResult> {
  const { characters = [], forceFallback = false, useExternal = false, signal, onWindow, cachedWindows, onWindowDone } = options;

  // Fast path: text is already attributed (RP log, chat export).
  if (!forceFallback && isPreAttributed(text)) {
    console.info("[story-parser] pre-attributed format detected — skipping LLM call");
    return {
      messages: [{ role: "assistant", content: normaliseAttributed(text) }],
      method: "pre-attributed",
    };
  }

  if (forceFallback) {
    console.warn("[story-parser] forced paragraph-split fallback");
    return { messages: paragraphSplit(text), method: "paragraph" };
  }

  // Window large inputs so attribution output isn't truncated by the token cap.
  const windowChars = useExternal ? MAX_ATTRIBUTION_WINDOW_CHARS_EXTERNAL : MAX_ATTRIBUTION_WINDOW_CHARS_LOCAL;
  const windows = splitIntoWindows(text, windowChars);
  if (windows.length > 1) {
    console.info(`[story-parser] long input — attributing in ${windows.length} windows (${useExternal ? "external" : "local"})`);
  }

  const messages: DigestMessage[] = [];
  const methodsUsed = new Set<ParseMethod>();
  for (let i = 0; i < windows.length; i++) {
    if (signal?.aborted) throw new Error("cancelled");
    onWindow?.(i + 1, windows.length);

    // Reuse a previously-attributed window (resume) instead of re-calling the LLM.
    const cached = cachedWindows?.[i];
    if (cached && cached.length) {
      messages.push(...cached);
      continue;
    }

    const result = await attributeWindow(windows[i]!, characters, useExternal);
    messages.push(...result.messages);
    methodsUsed.add(result.method);
    if (onWindowDone) await onWindowDone(i, result.messages);
  }

  // Report the lowest-fidelity method any window needed (cached windows excluded).
  const method: ParseMethod = methodsUsed.has("paragraph")
    ? "paragraph"
    : methodsUsed.has("external-llm")
      ? "external-llm"
      : methodsUsed.has("local-llm")
        ? "local-llm"
        : (useExternal ? "external-llm" : "local-llm"); // all windows cached
  console.info(`[story-parser] attribution complete — method:${method}, ${messages.length} segment(s)`);
  return { messages, method };
}
