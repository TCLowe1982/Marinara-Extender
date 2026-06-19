// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Tier 3: Ambient detail classifier
//
// Finds throwaway sentences that reveal who someone IS — preferences, history,
// identity markers, relationships — rather than what they're doing right now.
// One batched LLM call per turn against pre-filtered candidate sentences.
// Fires async from process-turn, never blocks the lorebook update.

import type { Lane } from "./storage.js";
import { localUrl, localEnabled, localModel, externalUpstream, externalModel } from "./llm-config.js";

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
  // Who the fact is about: "user", or a character name from the roster. The
  // [character] block carries every character in a multi-character RP message,
  // so the block label alone cannot attribute a fact. Optional for back-compat.
  subject?: string;
}

const SYSTEM_PROMPT = `You are extracting facts from conversation sentences and deciding how long they matter.

SCOPE RULES:
- "character" scope = permanent facts about who someone IS. Save these.
- "chat" scope = facts only relevant to this conversation (plans for today, current tasks, temporary states). Save these too, but flag them correctly.
- Skip entirely: pure actions with no informational content, meta-references, in-scene roleplay events.

SUBJECT RULE:
- subject = who the fact is ABOUT. Use "user" for the human player; use the character's name for a fact about that character.
- A [character] sentence may describe ANY character in the scene, not just the one whose turn it is — attribute by content, not by block label. Pick names from the "Known characters" list when one is provided.

Examples:
- "I grew up in Texas" (said by user) → character scope, user_topics, subject "user"
- "I cried at the MGS3 ending" (said by user) → character scope, user_topics, subject "user"
- "I've been coding for ten years" → character scope, user_topics, subject "user"
- "My dog's name is Biscuit" → character scope, user_topics, subject "user"
- "I have a meeting until 5 PM" → chat scope, user_topics, subject "user"
- "I'm working on the ledger logic today" → chat scope, user_topics, subject "user"
- "She always deflects with humor when nervous" (about Priya) → character scope, character_topics, subject "Priya"
- "Mari grew up in Kraków" (in any block) → character scope, character_topics, subject "Mari"

SKIP examples — these are NOT facts, return nothing for them:
- "She adds an item to the list" → SKIP (in-scene action, no information about who anyone IS)
- "He presses his mouth to her shoulder" → SKIP (physical roleplay action)
- "Her shoulders shake against his palm" → SKIP (moment-to-moment scene description)
A fact survives the scene it was said in. If it only describes what bodies are
doing right now, it is scene narration — skip it.

Return a JSON object of this exact shape:
{"facts":[{"text":"<original sentence>","fact":"<concise fact>","lane":"user_topics|character_topics","scope":"character|chat","subject":"<user or character name>"}]}
Return {"facts":[]} if nothing qualifies. Raw JSON only — no explanation, no markdown.`;

async function callLocal(prompt: string, system: string = SYSTEM_PROMPT): Promise<string | null> {
  if (!localEnabled()) return null;
  const base = localUrl();
  const model = localModel();

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        stream: false,
        // Force valid JSON so small local models can't return prose and trigger
        // the external-API fallback every turn.
        response_format: { type: "json_object" },
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
      // Accept both the {facts:[...]} object shape and a bare [...] array.
      const arr = Array.isArray(parsed) ? parsed : (parsed?.facts ?? null);
      if (!Array.isArray(arr)) continue;
      return arr
        .filter(
          (f): f is AmbientFact =>
            typeof f?.text === "string" &&
            typeof f?.fact === "string" &&
            (f?.lane === "user_topics" || f?.lane === "character_topics"),
        )
        .map((f) => ({
          ...f,
          scope: f.scope === "chat" ? "chat" : "character",
          subject: typeof (f as { subject?: unknown }).subject === "string" && (f as { subject: string }).subject.trim()
            ? (f as { subject: string }).subject.trim()
            : undefined,
        }));
    } catch { /* try next */ }
  }
  return [];
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface AmbientInput {
  userText: string;
  characterText: string;
  // Known character names shown to the model so fact subjects come back as
  // resolvable names instead of pronouns or invented labels.
  roster?: string[];
}

async function callExternal(prompt: string, system: string = SYSTEM_PROMPT): Promise<string | null> {
  const { getCachedAuth } = await import("./auth-cache.js");
  const auth = getCachedAuth();
  if (!auth) return null;
  const upstream = externalUpstream();
  const model = externalModel();
  try {
    const res = await fetch(`${upstream}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 1500,
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

  const rosterLine = input.roster && input.roster.length > 0
    ? `Known characters: ${input.roster.join(", ")}\n\n`
    : "";
  const prompt = `${rosterLine}Sentences to evaluate:\n${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}`;

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

// ── Scene fact extraction (1dn) ─────────────────────────────────────────────────
// classifyAmbient pre-filters to short candidate sentences — right for live
// throwaway lines, wrong for dense scene prose, where a durable fact spans
// fragments ("Warlock. Pact of the Tome. My patron is the Narrative.") and the
// candidate filter drops the load-bearing pieces. This reads the prose directly
// and assembles facts, reusing the same output shape, routing, and dedup.

const SCENE_FACTS_SYSTEM_PROMPT = `You are reading a roleplay scene transcript and extracting DURABLE FACTS — things that stay true after the scene ends and are worth remembering long-term.

EXTRACT facts about:
- identity & self-concept (a class/archetype a character claims, their role, what they call themselves)
- stable preferences, tastes, strongly-held opinions
- backstory & history (where they grew up, defining past events, things they've done)
- relationships and dynamics that persist
- worldbuilding / lore the characters establish as true

A durable fact may span SEVERAL sentences — assemble it into one. Example: from
"Warlock. Pact of the Tome. My patron is the Narrative itself." extract one fact:
the speaker's D&D class is a Pact of the Tome Warlock whose patron is the Narrative.

Be EXHAUSTIVE. A passage usually contains several durable facts, about different
people and topics. List every one — do not stop at the most prominent; a quiet
identity fact (a class, a hometown, a job) matters as much as a vivid one.

DO NOT extract anything that is merely what is happening right now. LITMUS TEST:
"would this still be true next week, in a completely different scene?" If no, SKIP it.
Skip:
- physical action / choreography (who touched, kissed, moved, is lying down)
- transient bodily or emotional states (aroused, wet, crying, pupils dilated, holding a cup)
- where someone is or what they are wearing AT THIS MOMENT (in his bed, wearing his shirt)
- agreeing to or about to do something in this scene (agrees to a threesome tonight)
- pure dialogue or narration with no lasting information
A durable fact is identity, history, preference, relationship, or lore — it outlives
the scene. "Mari grew up in Kraków" survives; "Mari is being kissed" does not.

SUBJECT = who the fact is ABOUT: "user" for the human player, otherwise the
character's name (prefer a name from the Known characters list). Lines are
prefixed with the speaker, but attribute by CONTENT — a character often states a
fact about ANOTHER character or about the user.
SCOPE = "character" (permanent) or "chat" (only relevant to this conversation).
LANE = user_topics for facts about the user/player; character_topics for facts about a character.

Return JSON only: {"facts":[{"text":"<short supporting quote/paraphrase>","fact":"<the durable fact>","lane":"user_topics|character_topics","scope":"character|chat","subject":"<user or name>"}]}
Return {"facts":[]} if nothing durable is stated. No markdown, no explanation.`;

// Fact extraction is RARE (once per scene/import) and QUALITY-critical, unlike
// per-turn beats (frequent, latency-sensitive — local is right there). So facts
// prefer the strongest model available. MARINARA_EXTENDER_FACTS_MODEL:
//   "external" — always the configured API   "local" — always the local model
//   "auto" (default) — external when an API key is set, else local.
export function factsPreferExternal(): boolean {
  const v = process.env.MARINARA_EXTENDER_FACTS_MODEL?.trim().toLowerCase();
  if (v === "external") return true;
  if (v === "local") return false;
  return !!process.env.MARINARA_EXTENDER_API_KEY; // auto
}

// Reads a window of scene prose (speaker-prefixed lines) and returns durable
// facts. Same AmbientFact shape, so the caller routes/dedups identically.
export async function classifySceneFacts(sceneText: string, roster: string[] = []): Promise<AmbientFact[]> {
  if (!sceneText.trim()) return [];
  const rosterLine = roster.length > 0 ? `Known characters: ${roster.join(", ")}\n\n` : "";
  const prompt = `${rosterLine}Scene transcript:\n${sceneText}`;

  // Try the preferred model, then fall back to the other so a missing key or a
  // down endpoint still yields whatever the available model can manage. Parse
  // each result with parseFactsJson (which already unwraps ```json fences and
  // bare arrays) rather than pre-gating on looksLikeJson — a frontier model
  // routinely fences or prefaces its JSON, and gating threw that away.
  const ext = () => callExternal(prompt, SCENE_FACTS_SYSTEM_PROMPT);
  const loc = () => callLocal(prompt, SCENE_FACTS_SYSTEM_PROMPT);
  const order = factsPreferExternal() ? [ext, loc] : [loc, ext];

  for (const call of order) {
    const facts = parseFactsJson(await call());
    if (facts.length > 0) return facts;
  }
  return [];
}

// ── Durability judge (1dn, verify-before-assemble) ──────────────────────────────
// classifySceneFacts has high recall but leaks: transient states, in-scene
// dialogue, over-attribution. A second pass audits the candidates and keeps only
// the durable ones before they're written to permanent memory. Prefers the same
// strong model; fails OPEN (keeps all) if unavailable, so a judge hiccup never
// silently drops everything — the dry-run preview is the human backstop.

// Calibration note for the next person who tightens this prompt (967): the
// failure mode addressed below is "transient framed as identity" (a scene event
// wearing an "X is a person who recently…" mask). The SYMMETRIC failure — "real
// identity framed as transient" (e.g. "Mari, in this moment, is the chair of the
// CS department", where the misleading "in this moment" wraps a durable fact) —
// is NOT yet handled here and should KEEP. It's left out of 967's scope on
// purpose; see __tests__/judge-calibration.test.ts for that case as a fixture.
const JUDGE_SYSTEM_PROMPT = `You audit candidate facts pulled from a roleplay scene and keep ONLY the durable ones for long-term memory. Permanent memory must stay clean, so when in doubt, DROP.

KEEP only a fact that would still be true next week, in a completely different scene:
- identity / self-concept (a class, role, or archetype someone claims; what they are)
- biography & history (where they grew up, their job, a past event that DEFINES them or reshapes their world — e.g. "exposed the Hargrove experiments", "discovered the department's papers were built on a fraud engine", "named her Elden Ring character after MGS3's The Boss")
- a STABLE preference or habit stated as a general truth ("prefers cold weather", "always wakes with one eye open")
- a persistent relationship or piece of world/lore (incl. a named dynamic — "calls him her 'chaos goblin'")

DROP (these are NOT durable, no matter how fact-like the phrasing):
- anything describing THIS MOMENT: in his bed, wearing his shirt now, holding a pencil, hair disheveled right now
- bodily/emotional states: aroused, "body responding with arousal", dick stiffening, turned on by X, wet, crying
- something happening or agreed to within this scene only (agrees to a threesome; uses an endearment right now)
- raw dialogue or introspection quoted as if it were a fact ("Yes, that's the joy of science", "You did it last night too", "I feel…")
- a "preference" that is really just current arousal ("he is aroused by her in his shirt" — DROP)
- vague, narrative, or empty statements

THE MASK TEST — the most common miss. A transient scene event is often dressed in durable-sounding "identity" framing. The mask does NOT change the substance. Strip the identity clause and judge the core assertion:
- "Mari is a professor who recently had vigorous sex on her desk and then relaxed in the chair, covered in semen" → the core is a scene EVENT (what she did this scene); the only durable part ("is a professor") is already known. DROP — that's inventory, not identity.
- "Mari wants to ruin Hargrove's chair, expressing this during intimate moments" → an episodic DESIRE felt in a moment, masked as a standing trait. DROP.
Contrast — these KEEP because the core is a DEFINING event or a standing dynamic, not a scene action:
- "Mari discovered her department's publication record was built on Hargrove's fraud engine" → a discovery that reshapes her world. KEEP.
- "Mari calls Thomas her 'chaos goblin'" → names a persistent relationship dynamic. KEEP.

Test each one: strip the scene away — is there a standalone fact about who someone IS or a DEFINING thing that happened in their life? A specific scene action (where, with whom, covered in what) is NOT that, even when phrased as "X is someone who did Y". If it only matters inside this moment, DROP it.

You are given a numbered list. Return ONLY the indices to keep.
Return JSON: {"keep":[<indices>]}. No prose, no markdown.`;

function parseKeepIndices(raw: string | null): number[] | null {
  if (!raw) return null;
  const attempts = [raw.trim(), raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? ""];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      const parsed = JSON.parse(attempt) as unknown;
      const arr = Array.isArray(parsed)
        ? parsed
        : (Array.isArray((parsed as { keep?: unknown })?.keep) ? (parsed as { keep: unknown[] }).keep : null);
      if (!arr) continue;
      return arr.map(Number).filter((n) => Number.isInteger(n));
    } catch { /* try next */ }
  }
  return null;
}

export async function judgeDurableFacts(facts: AmbientFact[]): Promise<AmbientFact[]> {
  if (facts.length === 0) return facts;
  const list = facts.map((f, i) => `${i}. [about: ${f.subject ?? "?"}] ${f.fact}`).join("\n");
  const prompt = `Candidate facts:\n${list}`;

  const ext = () => callExternal(prompt, JUDGE_SYSTEM_PROMPT);
  const loc = () => callLocal(prompt, JUDGE_SYSTEM_PROMPT);
  const order = factsPreferExternal() ? [ext, loc] : [loc, ext];

  let keep: number[] | null = null;
  for (const call of order) {
    keep = parseKeepIndices(await call());
    if (keep !== null) break;
  }
  if (keep === null) {
    console.warn(`[ME:facts-judge] judge unavailable — keeping all ${facts.length} (fail-open)`);
    return facts;
  }
  const set = new Set(keep);
  const kept = facts.filter((_, i) => set.has(i));
  console.info(`[ME:facts-judge] kept ${kept.length}/${facts.length} as durable`);
  return kept;
}
