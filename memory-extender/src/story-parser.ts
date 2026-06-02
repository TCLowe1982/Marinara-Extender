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

// Matches "Name: text", "**Name:** text", "*Name:* text" — RP and chat export formats.
const ATTRIBUTION_LINE_RE = /^(?:\*{1,2})?[A-Z][A-Za-z0-9 _'-]{0,40}(?:\*{1,2})?:\s+\S/m;
const MIN_ATTRIBUTED_LINES = 3;

function countAttributedLines(text: string): number {
  return text.split("\n").filter(l => ATTRIBUTION_LINE_RE.test(l.trim())).length;
}

function isPreAttributed(text: string): boolean {
  return countAttributedLines(text) >= MIN_ATTRIBUTED_LINES;
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
        max_tokens: Math.min(8192, Math.ceil(text.length / 2.5)),
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

// ── Public API ────────────────────────────────────────────────────────────────

export interface ParseStoryOptions {
  characters?: string[];
  forceFallback?: boolean;
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
  const { characters = [], forceFallback = false } = options;

  // Fast path: text is already attributed (RP log, chat export).
  if (!forceFallback && isPreAttributed(text)) {
    console.info("[story-parser] pre-attributed format detected — skipping LLM call");
    return {
      messages: [{ role: "assistant", content: normaliseAttributed(text) }],
      method: "pre-attributed",
    };
  }

  if (!forceFallback) {
    // Try local model first.
    const local = await callLocal(text, characters);
    if (local && isValidAttribution(local)) {
      console.info("[story-parser] local model attribution ok");
      return { messages: [{ role: "assistant", content: local }], method: "local-llm" };
    }
    if (local) {
      console.warn("[story-parser] local model returned prose instead of attribution — trying external API");
    } else {
      console.info("[story-parser] local model unavailable — trying external API");
    }

    // Fall back to external API.
    const external = await callExternal(text, characters);
    if (external && isValidAttribution(external)) {
      console.info("[story-parser] external API attribution ok");
      return { messages: [{ role: "assistant", content: external }], method: "external-llm" };
    }
    if (external) {
      console.warn("[story-parser] external API also returned prose — falling back to paragraph split");
    } else {
      console.warn("[story-parser] external API unavailable — falling back to paragraph split");
    }
  }

  console.warn("[story-parser] paragraph-split fallback — speaker attribution unavailable");
  return { messages: paragraphSplit(text), method: "paragraph" };
}
