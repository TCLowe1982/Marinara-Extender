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
import { keepUserClause, userSpokenLines } from "./user-clause.js";
import { USER_SENTINEL } from "./subject.js";

// ── Candidate extraction ──────────────────────────────────────────────────────

const FIRST_PERSON_RE  = /\b(I|my|me|we|our|I'm|I've|I'd|I'll)\b/i;
// Proper noun as sentence subject: "Sarah said", "Dr. Johnson is", "Mom called"
const NAMED_SUBJECT_RE = /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(is|was|said|told|called|mentioned|asked|works|lives|has|had|goes|studies|knows|thinks|feels|told|gave|came|left|helped|showed|found)/;

// SECOND PERSON (cye6) — the missing grammatical person.
//
// The two patterns above admit a speaker describing THEMSELVES and a speaker
// describing a THIRD PARTY BY NAME. Neither admits a speaker describing THE
// PERSON THEY ARE TALKING TO, which in a roleplay is the dominant register for
// facts about the user. Measured store-wide: 118,405 sentences sit inside the
// length/question window, 33,411 pass the person test, and 15,681 are dropped
// though second-person — the gate discards 31.9% of what it could admit, purely
// for addressing the user directly.
//
// The concrete loss: of 23 sentences asserting Thomas's origin, 3 survive and
// none of them states it. "you're from independence, missouri, dead center of
// the dialect zone" is 68 characters — well inside the window — and dies here.
const SECOND_PERSON_RE = /\b(you|your|yours|you're|youre|you've|you'd|you'll)\b/i;

export interface CandidateOptions {
  /**
   * Admit second-person sentences. OFF by default so production behaviour is
   * unchanged until downstream precision has been RE-MEASURED at the new scope
   * — admitting these is a large increase in candidate volume, and every
   * precision figure downstream was measured without them ("rule breadth
   * survives its scope", the code-filter lesson).
   */
  admitSecondPerson?: boolean;
}

export function extractCandidates(text: string, opts: CandidateOptions = {}): string[] {
  return text
    .split(/(?<=[.!])\s+|\n+/)
    .map(s => s.trim())
    .filter(s =>
      s.length > 10 &&
      s.length <= 120 &&
      !s.endsWith("?") &&
      (FIRST_PERSON_RE.test(s) || NAMED_SUBJECT_RE.test(s) ||
        (!!opts.admitSecondPerson && SECOND_PERSON_RE.test(s))),
    );
}

/**
 * Who a second-person sentence is ABOUT, given who said it. This is the whole
 * reason the fix is not "add you|your to the regex": second person is
 * DIRECTIONAL. "you're from Independence" said BY a character is about the
 * USER; said BY the user it is about the CHARACTER. Getting this backwards is
 * the referent bleed that filed three RP lines as biography of TC (qhej/hhdr).
 *
 * The direction is already structural at the call site — classifyAmbient
 * receives userText and characterText separately and tags the prompt lines
 * [user] / [character] — so nothing needs threading; it only needs using.
 */
export function secondPersonSubject(speaker: "user" | "character"): "user" | "character" {
  return speaker === "user" ? "character" : "user";
}

export function isSecondPerson(sentence: string): boolean {
  return SECOND_PERSON_RE.test(sentence);
}

/**
 * A sentence that survives the gate ONLY because of second person — no "I", no
 * named subject. These are the 15,739 the gate has been discarding, and they
 * are the only ones the direction rule has anything to say about. A mixed
 * sentence ("I told you I'm from Texas") already had a first-person claim and
 * must keep it.
 */
export function isSecondPersonOnly(sentence: string): boolean {
  return SECOND_PERSON_RE.test(sentence)
    && !FIRST_PERSON_RE.test(sentence)
    && !NAMED_SUBJECT_RE.test(sentence);
}

// DEFAULT OFF, BY MEASUREMENT (cye6 slice 3). This shipped default-on, per the
// house posture that opt-in causes silent degradation. The bench then measured
// the population it admits and it FAILED ITS OWN PRE-REGISTERED BAR:
//
//   second-person facts   29% precise, 34% misattributed   (bar: >=60%, <=25%)
//   existing population   43% precise at baseline
//
// So the gate admits 161 facts per 60 turns of which roughly 114 are unsound or
// filed on the wrong person — and 34% misattribution is more than double the
// baseline population's 15%. Misattribution is the dangerous class: a fact about
// a character filed on the user is the qhej/hhdr failure, and it is worse than
// the omission cye6 exists to fix.
//
// The pre-registered fallback (subject position instead of presence) does NOT
// rescue it: 27% on the same labels, two points WORSE, while dropping 62 of the
// 161. Slice 1 predicted subject position would be "a big precision win". It is
// not. It is the same precision over a smaller set.
//
// Blended across both populations arm B scores 51% against arm A's 43%, which
// looks like a win and is exactly the number the per-population reporting exists
// to refuse. The bar was set before the data and the data did not clear it.
//
// MARINARA_EXTENDER_SECOND_PERSON=1 turns it on. The switch stays because the
// population is real — su6h's omission is genuine and 15,739 sentences are still
// invisible — but it does not ship until the ATTRIBUTION defect is fixed, which
// is a different ticket. See the notes on cye6.
export function secondPersonEnabled(): boolean {
  return process.env.MARINARA_EXTENDER_SECOND_PERSON === "1";
}

// ── Direction of address, enforced ───────────────────────────────────────────
//
// The prompt is told the rule. This is the half the code decides, because one
// direction is grammatically CERTAIN and the other is not:
//
//   USER BLOCK, second person   "you" said by the user is NEVER the user.
//     The speaker is one known person, so "not about the speaker" names exactly
//     who it is not. This is the qhej/hhdr failure — three user_topics rows put
//     TC in Texas because a character's line was filed as his biography — and
//     admitting second person is precisely what would scale it. Refused here.
//
//   CHARACTER BLOCK, second person   NOT enforceable, and the slice-1 note
//     overstated it. secondPersonSubject() assumes the character is addressing
//     the USER, which is true in a 1:1 and false the moment two characters talk
//     to each other in a group scene. The [character] block carries every
//     character in the message, so "not about the speaker" cannot name anyone.
//     The model gets the rule and the block label; the code does not overrule it.
//
// 92.7% of the admitted population is the character half — the recall win su6h
// needs, judged by the model. 7.3% is the user half — the dangerous one, and
// the one arithmetic can close. Refusals are COUNTED, not silent.

// Compare on the text the model echoes back, which is usually but not always
// byte-identical to the candidate it was given.
function normText(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function attributedToUser(f: AmbientFact): boolean {
  const s = (f.subject ?? "").trim().toLowerCase();
  return s === USER_SENTINEL || (!s && f.lane === "user_topics");
}

export interface DirectionCounts {
  /** Reassigned to the session character — the addressee, in a 1:1. */
  reassigned: number;
  /** No addressee to name: kept, but stripped of the false user claim. */
  refused: number;
}

export function enforceAddressDirection(
  facts: AmbientFact[],
  userAddressed: Iterable<string>,
  characterName?: string,
): { facts: AmbientFact[]; counts: DirectionCounts } {
  const addressed = new Set([...userAddressed].map(normText));
  if (addressed.size === 0) return { facts, counts: { reassigned: 0, refused: 0 } };

  const counts: DirectionCounts = { reassigned: 0, refused: 0 };
  const out = facts.map((f) => {
    if (!addressed.has(normText(f.text)) || !attributedToUser(f)) return f;
    if (characterName?.trim()) {
      counts.reassigned++;
      return { ...f, subject: characterName.trim(), lane: "character_topics" as Lane };
    }
    // Nobody to name. Keep the memory, drop the claim, demote out of the
    // permanent ledger — route and mark, never drop.
    counts.refused++;
    return { ...f, subject: undefined, lane: "character_topics" as Lane, scope: "chat" as const };
  });
  return { facts: out, counts };
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

export const SYSTEM_PROMPT = `You are extracting facts from conversation sentences and deciding how long they matter.

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

ONE SENTENCE CAN CARRY TWO FACTS ABOUT DIFFERENT PEOPLE. Return BOTH — and never
drop the user's half to keep someone else's. "I was in the Army, and Mari is
Polish." is two facts, not one:
  {"text":"I was in the Army, and Mari is Polish.","fact":"The user served in the Army","lane":"user_topics","scope":"character","subject":"user"}
  {"text":"I was in the Army, and Mari is Polish.","fact":"Mari is Polish","lane":"character_topics","scope":"character","subject":"Mari"}
The same applies when the user's clause sits beside several third-party ones:
"It was my fourth sapper stakes, and Sgt Roger's 6th?" contains the USER's fourth
as well as Sgt Roger's sixth. Both survive.

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

// Exported for the precision bench (cye6 slice 3). A bench that reimplements the
// parser is measuring its own reimplementation, not the pipeline. Pure, no I/O.
export function parseFactsJson(raw: string | null): AmbientFact[] {
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
  // The session character — who the user is talking TO. Used only by the
  // direction rule, to name the addressee of a second-person line the user
  // spoke. Absent means "no addressee to name", not "the user".
  characterName?: string;
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

// Declared user forms (egj3), so a fact phrased "TC served in the Army" is
// recognised as already carrying the user. Dynamically imported — same reason as
// auth-cache above, and it keeps the pure clause logic free of storage I/O.
// Never throws: a missing or unreadable declaration just means no extra forms.
async function declaredUserForms(): Promise<string[]> {
  try {
    const { readUserIdentity } = await import("./user-identity.js");
    return (await readUserIdentity())?.aliases ?? [];
  } catch {
    return [];
  }
}

export async function classifyAmbient(input: AmbientInput): Promise<AmbientFact[]> {
  // cye6: second person is admitted. The gate could see a speaker describing
  // THEMSELVES and a speaker naming a THIRD PARTY, and was structurally unable
  // to see a speaker describing THE PERSON THEY ARE TALKING TO — which in a
  // roleplay is the dominant register for facts about the user. Measured cost
  // is +1.75 candidate lines per turn in the one batched call; measured gain is
  // 15,739 sentences, 92.7% of them directionally about the user.
  const admit = secondPersonEnabled();
  const userCandidates = extractCandidates(input.userText, { admitSecondPerson: admit });
  const charCandidates = extractCandidates(input.characterText, { admitSecondPerson: admit });

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

  // 2tro: restore the user's clause if the model kept only the third-person half.
  const restored = keepUserClause(parseFactsJson(raw), {
    userText: input.userText,
    userForms: await declaredUserForms(),
    thirdParties: input.roster ?? [],
  });

  // The direction rule runs LAST, after keepUserClause — which exists to put a
  // user claim BACK when the model dropped it, and would happily resurrect the
  // exact attribution the rule refuses.
  const { facts, counts } = enforceAddressDirection(
    restored,
    admit ? userCandidates.filter(isSecondPersonOnly) : [],
    input.characterName,
  );

  if (facts.length > 0 || counts.reassigned || counts.refused) {
    const dir = counts.reassigned || counts.refused
      ? ` | direction: ${counts.reassigned} reassigned, ${counts.refused} refused`
      : "";
    console.info(`[ME:ambient] found ${facts.length} ambient fact(s) from ${lines.length} candidate(s)${dir}`);
  }

  return facts;
}

// ── Scene fact extraction (1dn) ─────────────────────────────────────────────────
// classifyAmbient pre-filters to short candidate sentences — right for live
// throwaway lines, wrong for dense scene prose, where a durable fact spans
// fragments ("Warlock. Pact of the Tome. My patron is the Narrative.") and the
// candidate filter drops the load-bearing pieces. This reads the prose directly
// and assembles facts, reusing the same output shape, routing, and dedup.

export const SCENE_FACTS_SYSTEM_PROMPT = `You are reading a roleplay scene transcript and extracting DURABLE FACTS — things that stay true after the scene ends and are worth remembering long-term.

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

A SINGLE SENTENCE can carry two facts about DIFFERENT people. Split it and return
both; never drop the user's half to keep someone else's. "I was in the Army, and
Mari is Polish." is two facts: {subject "user", user_topics, "The user served in
the Army"} AND {subject "Mari", character_topics, "Mari is Polish"}. A first-person
clause standing next to third-person ones ("It was my fourth sapper stakes, and Sgt
Roger's 6th?") is the case most often lost — the user's fact matters as much as the
sergeant's.

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

  // 2tro: same net as the live path. Only the "User:" lines count as the user's
  // own words — a first-person clause in the "Scene:" lines is a character's.
  const userText = userSpokenLines(sceneText);
  const userForms = await declaredUserForms();

  for (const call of order) {
    const facts = parseFactsJson(await call());
    if (facts.length > 0) return keepUserClause(facts, { userText, userForms, thirdParties: roster });
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
export const JUDGE_SYSTEM_PROMPT = `You audit candidate facts pulled from a roleplay scene and keep ONLY the durable ones for long-term memory. Permanent memory must stay clean, so when in doubt, DROP.

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

// How many independent judge passes to run and combine by majority vote (8jw).
// A single judge pass is high-variance on borderline candidates — abstract
// durables get dropped and identity-masked transients survive, both flipping
// run-to-run. Voting over N passes and keeping only on a strict majority
// stabilizes recall AND precision at once. Default 1 (no consensus; behaviour and
// cost unchanged) — opt in via MARINARA_EXTENDER_JUDGE_PASSES for backfill/quality.
export function judgePasses(): number {
  const v = parseInt(process.env.MARINARA_EXTENDER_JUDGE_PASSES ?? "", 10);
  return Number.isFinite(v) && v >= 1 && v <= 5 ? v : 1;
}

// One judge pass over the candidate list → kept indices, or null if no model was
// reachable (so a dead pass ABSTAINS from the vote rather than voting everything
// down). Injectable so the consensus aggregation is testable offline.
export type JudgePass = (prompt: string) => Promise<number[] | null>;
const defaultJudgePass: JudgePass = async (prompt) => {
  const ext = () => callExternal(prompt, JUDGE_SYSTEM_PROMPT);
  const loc = () => callLocal(prompt, JUDGE_SYSTEM_PROMPT);
  const order = factsPreferExternal() ? [ext, loc] : [loc, ext];
  for (const call of order) {
    const keep = parseKeepIndices(await call());
    if (keep !== null) return keep;
  }
  return null;
};

export async function judgeDurableFacts(
  facts: AmbientFact[],
  opts?: { passes?: number; judgePass?: JudgePass },
): Promise<AmbientFact[]> {
  if (facts.length === 0) return facts;
  const list = facts.map((f, i) => `${i}. [about: ${f.subject ?? "?"}] ${f.fact}`).join("\n");
  const prompt = `Candidate facts:\n${list}`;
  const passes = Math.max(1, opts?.passes ?? judgePasses());
  const judgePass = opts?.judgePass ?? defaultJudgePass;

  // Run N independent passes; each REACHABLE pass votes its keep-set. A pass that
  // can't reach a model abstains (null) — it does not vote everything down.
  const votes = new Array(facts.length).fill(0);
  let okPasses = 0;
  for (let p = 0; p < passes; p++) {
    const keep = await judgePass(prompt);
    if (keep === null) continue;
    okPasses++;
    for (const i of keep) if (Number.isInteger(i) && i >= 0 && i < facts.length) votes[i]++;
  }

  if (okPasses === 0) {
    console.warn(`[ME:facts-judge] judge unavailable across ${passes} pass(es) — keeping all ${facts.length} (fail-open)`);
    return facts;
  }

  // Keep on a strict majority of the SUCCESSFUL passes (floor(ok/2)+1). okPasses=1
  // reduces to the old single-pass behaviour exactly. Majority — not unanimous —
  // is deliberate: an over-DROP is silent data loss (the fact never reaches the
  // ledger), an over-keep is caught by the apply-review gate, so we bias toward
  // recall. An abstract durable kept 2/3 survives; a transient kept 1/3 drops.
  const threshold = Math.floor(okPasses / 2) + 1;
  const kept = facts.filter((_, i) => votes[i] >= threshold);
  console.info(
    okPasses > 1
      ? `[ME:facts-judge] consensus kept ${kept.length}/${facts.length} (>=${threshold} of ${okPasses} passes)`
      : `[ME:facts-judge] kept ${kept.length}/${facts.length} as durable`,
  );
  return kept;
}
