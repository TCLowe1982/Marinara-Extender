// Story-to-Memory Parser (Phase 4)
//
// Converts raw prose fiction into DigestMessage[] for the sentiment pipeline.
//
// Primary (LLM attribution): sends the prose to the sidecar with a reformatting
//   prompt; the model adds "Name: " prefixes so the existing chunker can do
//   accurate per-speaker emotional analysis.
//
// Fallback (paragraph split): each paragraph becomes a "Narrator: " message.
//   Speaker attribution is lost but emotional classification still works — the
//   beats are just attributed to the narrator rather than individual characters.
//
// The attributed output is passed as a single DigestMessage. The chunker's
// line-by-line parser detects "Name: " prefixes within it and splits correctly.

import { getCachedAuth } from "./auth-cache.js";
import type { DigestMessage } from "./digest.js";

// ── Attribution prompt ────────────────────────────────────────────────────────

function buildAttributionPrompt(characters: string[]): string {
  const charHint = characters.length > 0
    ? `Known characters in this passage: ${characters.join(", ")}.`
    : "Identify character names from the text itself.";

  return `You are a dialogue attribution assistant. Reformat the provided story passage so that every segment of dialogue and narration is prefixed with the speaker's name and a colon.

Rules:
- Dialogue: attribute to the character who is speaking, inferred from context ("she said", "he replied", paragraph order, prior speaker, etc.)
- Narration, action, and description: prefix with "Narrator:"
- Preserve the original wording exactly — do not paraphrase, summarize, or add anything
- Put each attributed segment on its own line; split dialogue from surrounding narration when they appear in the same sentence
- If a character is unnamed in the passage, use a consistent label like "Character_A"
${charHint}

Output only the reformatted passage. No commentary, no explanation, no markdown.`;
}

// ── LLM calls ─────────────────────────────────────────────────────────────────

async function callSidecar(text: string, characters: string[]): Promise<string | null> {
  const engineUrl = (process.env.MARINARA_ENGINE_URL ?? "http://localhost:7860").replace(/\/$/, "");
  try {
    const res = await fetch(`${engineUrl}/api/sidecar/tracker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemPrompt: buildAttributionPrompt(characters),
        userPrompt: text,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: string };
    return json.result?.trim() || null;
  } catch {
    return null;
  }
}

async function callExternal(text: string, characters: string[]): Promise<string> {
  const auth = getCachedAuth();
  if (!auth) {
    throw new Error(
      "Story parser: sidecar unavailable and no API key set. Enable a local model or set MARINARA_EXTENDER_API_KEY.",
    );
  }

  const upstream = (process.env.MARINARA_EXTENDER_DIGEST_UPSTREAM ?? "https://api.openai.com")
    .replace(/\/$/, "");
  const model = process.env.MARINARA_EXTENDER_DIGEST_MODEL ?? "gpt-4o-mini";

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
      // Attribution output is similar length to input; give generous headroom.
      max_tokens: Math.min(8192, Math.ceil(text.length / 2.5)),
    }),
  });

  if (!res.ok) {
    throw new Error(`Story parser: external API failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json?.choices?.[0]?.message?.content?.trim() ?? "";
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
  // Known character names to help the LLM with attribution.
  // The more complete, the better — include both sides of a conversation.
  characters?: string[];
  // Skip the LLM pre-pass and go straight to paragraph split (for testing).
  forceFallback?: boolean;
}

export interface ParseStoryResult {
  messages: DigestMessage[];
  method: "llm" | "paragraph";
}

export async function parseStoryToMessages(
  text: string,
  options: ParseStoryOptions = {},
): Promise<ParseStoryResult> {
  const { characters = [], forceFallback = false } = options;

  if (!forceFallback) {
    // Try sidecar first; if unavailable, try external API.
    let attributed = await callSidecar(text, characters);

    if (!attributed) {
      try {
        attributed = await callExternal(text, characters);
      } catch (err) {
        console.warn(
          "[story-parser] LLM attribution failed, falling back to paragraph split:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (attributed) {
      // Single message containing the reformatted text.
      // The chunker's line parser detects "Name: " prefixes within it.
      return {
        messages: [{ role: "assistant", content: attributed }],
        method: "llm",
      };
    }
  }

  console.warn("[story-parser] Using paragraph-split fallback — speaker attribution unavailable.");
  return { messages: paragraphSplit(text), method: "paragraph" };
}
