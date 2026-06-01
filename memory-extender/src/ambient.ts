// Tier 3: Ambient detail classifier
//
// Finds throwaway sentences that reveal who someone IS — preferences, history,
// identity markers, relationships — rather than what they're doing right now.
// One batched LLM call per turn against pre-filtered candidate sentences.
// Fires async from process-turn, never blocks the lorebook update.

import type { Lane } from "./storage.js";

// ── Candidate extraction ──────────────────────────────────────────────────────

const FIRST_PERSON_RE = /\b(I|my|me|we|our|I'm|I've|I'd|I'll)\b/i;

export function extractCandidates(text: string): string[] {
  return text
    .split(/(?<=[.!])\s+|\n+/)
    .map(s => s.trim())
    .filter(s =>
      s.length > 10 &&
      s.length <= 120 &&
      !s.endsWith("?") &&
      FIRST_PERSON_RE.test(s),
    );
}

// ── LLM call ──────────────────────────────────────────────────────────────────

export interface AmbientFact {
  text: string;   // original sentence
  fact: string;   // concise extracted fact
  lane: Lane;
}

const SYSTEM_PROMPT = `You are extracting stable facts from conversation sentences.

A stable fact reveals something lasting about who a person IS: preferences, history, identity, relationships, circumstances, recurring patterns. NOT temporary actions, in-scene events, or things that only matter right now.

Examples of stable facts:
- "I grew up in Texas" → grew up in Texas
- "I cried at the MGS3 ending" → was moved to tears by MGS3's ending
- "I've been coding for ten years" → has ~10 years coding experience
- "My dog's name is Biscuit" → has a dog named Biscuit

NOT stable facts (skip these):
- "I'm going to the store" (temporary action)
- "I love this scene" (in-context reaction)
- "I said that last turn" (meta-reference)

Return a JSON array. Each entry: {"text":"<original sentence>","fact":"<concise fact>","lane":"user_topics|character_topics"}.
Use "user_topics" if the fact is about the human user, "character_topics" if about the AI character.
Return [] if nothing qualifies. Raw JSON only — no explanation, no markdown.`;

async function callLocal(prompt: string): Promise<string | null> {
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
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        stream: false,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json?.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

function parseFactsJson(raw: string | null): AmbientFact[] {
  if (!raw) return [];
  const attempts = [raw.trim(), raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? ""];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      const parsed = JSON.parse(attempt);
      if (!Array.isArray(parsed)) continue;
      return parsed.filter(
        (f): f is AmbientFact =>
          typeof f?.text === "string" &&
          typeof f?.fact === "string" &&
          (f?.lane === "user_topics" || f?.lane === "character_topics"),
      );
    } catch { /* try next */ }
  }
  return [];
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface AmbientInput {
  userText: string;
  characterText: string;
}

async function callExternal(prompt: string): Promise<string | null> {
  const { getCachedAuth } = await import("./auth-cache.js");
  const auth = getCachedAuth();
  if (!auth) return null;
  const upstream = (process.env.MARINARA_EXTENDER_DIGEST_UPSTREAM ?? "https://api.openai.com").replace(/\/$/, "");
  const model = process.env.MARINARA_EXTENDER_DIGEST_MODEL ?? "gpt-4o-mini";
  try {
    const res = await fetch(`${upstream}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json?.choices?.[0]?.message?.content ?? null;
  } catch { return null; }
}

function looksLikeJson(s: string): boolean {
  const t = s.trim();
  return t.startsWith("[") || t.startsWith("{");
}

export async function classifyAmbient(input: AmbientInput): Promise<AmbientFact[]> {
  const userCandidates = extractCandidates(input.userText);
  const charCandidates = extractCandidates(input.characterText);

  if (userCandidates.length === 0 && charCandidates.length === 0) return [];

  const lines: string[] = [];
  for (const s of userCandidates) lines.push(`[user] ${s}`);
  for (const s of charCandidates) lines.push(`[character] ${s}`);

  const prompt = `Sentences to evaluate:\n${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}`;

  let raw = await callLocal(prompt);
  if (raw !== null && !looksLikeJson(raw)) {
    console.warn("[ME:ambient] local model returned prose — falling back to external API");
    raw = null;
  }
  if (raw === null) raw = await callExternal(prompt);

  const facts = parseFactsJson(raw);

  if (facts.length > 0) {
    console.info(`[ME:ambient] found ${facts.length} ambient fact(s) from ${lines.length} candidate(s)`);
  }

  return facts;
}
