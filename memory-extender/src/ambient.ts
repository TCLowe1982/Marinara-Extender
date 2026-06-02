// Tier 3: Ambient detail classifier
//
// Finds throwaway sentences that reveal who someone IS — preferences, history,
// identity markers, relationships — rather than what they're doing right now.
// One batched LLM call per turn against pre-filtered candidate sentences.
// Fires async from process-turn, never blocks the lorebook update.

import type { Lane } from "./storage.js";

// ── Candidate extraction ──────────────────────────────────────────────────────

const FIRST_PERSON_RE  = /\b(I|my|me|we|our|I'm|I've|I'd|I'll)\b/i;
// Proper noun as sentence subject: "Sarah said", "Dr. Johnson is", "Mom called"
const NAMED_SUBJECT_RE = /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(is|was|said|told|called|mentioned|asked|works|lives|has|had|goes|studies|knows|thinks|feels|told|gave|came|left|helped|showed|found)/;

export function extractCandidates(text: string): string[] {
  return text
    .split(/(?<=[.!])\s+|\n+/)
    .map(s => s.trim())
    .filter(s =>
      s.length > 10 &&
      s.length <= 120 &&
      !s.endsWith("?") &&
      (FIRST_PERSON_RE.test(s) || NAMED_SUBJECT_RE.test(s)),
    );
}

// ── LLM call ──────────────────────────────────────────────────────────────────

export interface AmbientFact {
  text: string;   // original sentence
  fact: string;   // concise extracted fact
  lane: Lane;
  scope: "character" | "chat"; // character = permanent; chat = this conversation only
}

const SYSTEM_PROMPT = `You are extracting facts from conversation sentences and deciding how long they matter.

SCOPE RULES:
- "character" scope = permanent facts about who someone IS. Save these.
- "chat" scope = facts only relevant to this conversation (plans for today, current tasks, temporary states). Save these too, but flag them correctly.
- Skip entirely: pure actions with no informational content, meta-references, in-scene roleplay events.

Examples:
- "I grew up in Texas" → character scope, user_topics
- "I cried at the MGS3 ending" → character scope, user_topics
- "I've been coding for ten years" → character scope, user_topics
- "My dog's name is Biscuit" → character scope, user_topics
- "I have a meeting until 5 PM" → chat scope, user_topics
- "I'm working on the ledger logic today" → chat scope, user_topics
- "She always deflects with humor when nervous" → character scope, character_topics

Return a JSON array. Each entry: {"text":"<original sentence>","fact":"<concise fact>","lane":"user_topics|character_topics","scope":"character|chat"}.
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
      return parsed
        .filter(
          (f): f is AmbientFact =>
            typeof f?.text === "string" &&
            typeof f?.fact === "string" &&
            (f?.lane === "user_topics" || f?.lane === "character_topics"),
        )
        .map((f) => ({
          ...f,
          scope: f.scope === "chat" ? "chat" : "character",
        }));
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
