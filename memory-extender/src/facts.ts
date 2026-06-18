// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Durable-fact capture (MarinaraExtender-1dn).
//
// The capture pipeline is tuned for emotional SALIENCE: a chunk only becomes a
// beat if it passes the sentiment threshold, and the scene recap compresses to
// the emotional arc. A flat identity/lore fact ("Mari's D&D class is a Pact of
// the Tome Warlock", "I've DMed since 2nd edition") carries almost no emotion,
// so it falls through every net and is never stored — then months later the
// character confabulates it. This module captures those facts regardless of
// salience, reusing the tier-3 ambient classifier, and routes each one to the
// right subject's ledger through the same dedup matrix the live path uses.

import type { AmbientFact } from "./ambient.js";
import { classifySceneFacts, judgeDurableFacts } from "./ambient.js";
import type { Chunk } from "./sentiment/types.js";
import type { Entry } from "./storage.js";
import { createEntryIfUnique } from "./dedup.js";
import { resolveNameToKey, matchesSessionName } from "./identity.js";
import { normalizeLabel, readAliasTable, USER_IDENTITY_KEY } from "./aliases.js";

// Scope the subject roster to characters actually MENTIONED in the scene, not
// the whole cast. With the global cast in the prompt the model attributed a
// present character's lines to an absent one (it tagged Priya's lines "Aurora").
// A character counts as present if any of its alias labels (len >= 3, to avoid
// 1-2 char false hits) appears in the transcript. Falls back to the caller's
// roster if nothing matches (e.g. an empty alias table in tests).
async function scopeRosterToScene(chunks: Chunk[], fallback: string[]): Promise<string[]> {
  const text = chunks.map((c) => c.text).join("\n").toLowerCase();
  let table;
  try { table = await readAliasTable(); } catch { return fallback; }
  // Whole-word match (letter boundaries, unicode-aware) so a name doesn't match
  // as a substring of another word — "Lara" must not match "exhiLARAtion".
  const mentioned = (label: string): boolean => {
    const esc = label.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}])${esc}([^\\p{L}]|$)`, "u").test(text);
  };
  const present: string[] = [];
  for (const [key, rec] of Object.entries(table)) {
    if (key === USER_IDENTITY_KEY) continue;
    const labels = [rec.canonicalName, ...(rec.aliases ?? [])].filter((l) => l.trim().length >= 3);
    if (labels.some(mentioned)) present.push(rec.canonicalName);
  }
  return present.length > 0 ? present : fallback;
}

// Local copies of the summary/content sizers (kept small and identical to the
// live path in api.ts; a future cleanup can hoist both into one util).
function truncateSummary(s: string, maxLen = 120): string {
  const t = s.trim();
  return t.length <= maxLen ? t : t.slice(0, maxLen - 1).trimEnd() + "…";
}
function capContent(s: string, maxChars = 600): string {
  const t = s.trim();
  return t.length <= maxChars ? t : t.slice(0, maxChars);
}

export interface FactContext {
  identityKey: string;     // ledger that owns self/user facts (the session/bucket character)
  fallbackChatId: string;  // where chat-scope facts (and unresolved subjects) land
  personaName?: string;    // live player persona — its facts belong to the session ledger, not a character's
  characterName?: string;  // session character's display name
}

// Decide where a fact lives, applying the subject-routing rules. A fact about a
// named character goes to THAT character's ledger; a fact whose subject can't be
// resolved is demoted to chat scope (tagged with who it's about) rather than
// guessed into a permanent ledger. Mirrors the live tier-3 routing in api.ts.
export async function resolveFactTarget(
  fact: AmbientFact,
  ctx: FactContext,
): Promise<{ scope: "character" | "chat"; scopeId: string; summary: string } | null> {
  let summary = truncateSummary(fact.fact);
  if (!summary) return null;

  let scope: "character" | "chat" = fact.scope === "chat" ? "chat" : "character";
  let scopeId = scope === "character" ? ctx.identityKey : ctx.fallbackChatId;

  const subject = fact.subject;
  const aboutSomeoneElse =
    scope === "character" &&
    !!subject &&
    normalizeLabel(subject) !== "user" &&
    !(ctx.personaName && matchesSessionName(subject, ctx.personaName)) &&
    !matchesSessionName(subject, ctx.characterName ?? ctx.identityKey);

  if (aboutSomeoneElse) {
    const key = await resolveNameToKey(subject!);
    if (key) {
      scopeId = key;
    } else {
      // Unknown subject: facts have no holding-pool lane, so keep the data
      // without polluting a permanent ledger — demote to chat scope, tagged.
      scope = "chat";
      scopeId = ctx.fallbackChatId;
      summary = truncateSummary(`[about: ${subject}] ${fact.fact}`);
    }
  }

  return { scope, scopeId, summary };
}

// Persist one fact: resolve its home, then create it (deduped). character_topics
// facts are TRAITS — the dedup matrix keeps them from collapsing into incident
// beats and vice versa.
export async function saveFact(
  fact: AmbientFact,
  ctx: FactContext,
  sourceChatId?: string,
): Promise<Entry | null> {
  const target = await resolveFactTarget(fact, ctx);
  if (!target) return null;
  return createEntryIfUnique(target.scope, target.scopeId, {
    lane: fact.lane,
    summary: target.summary,
    content: capContent(fact.text),
    ...(sourceChatId ? { sourceChatId } : {}),
    ...(fact.lane === "character_topics" ? { kind: "trait" as const } : {}),
  });
}

// ── Scene-wide fact pass ───────────────────────────────────────────────────────

// (sceneText, roster) — prose-aware, unlike the live candidate classifier.
export type FactClassifier = (sceneText: string, roster: string[]) => Promise<AmbientFact[]>;
// Verify-before-assemble: filters candidates to durable-only before they hit
// permanent memory. Injectable so tests stay offline.
export type FactJudge = (facts: AmbientFact[]) => Promise<AmbientFact[]>;

// Off by default? No — on by default (like the live ambient pass), with an env
// kill switch, because silent feature degradation is worse than the cost. It
// adds LLM calls during import; batched so each call stays bounded.
export function sceneFactsEnabled(): boolean {
  const v = process.env.MARINARA_EXTENDER_SCENE_FACTS?.trim();
  return !(v === "0" || v?.toLowerCase() === "off");
}

// Chunks of PROSE per classify call. Kept SMALL: in a large window the model
// triages to a few salient facts and crowds out the quiet ones (a 10-chunk
// window dropped "Mari is a Pact of the Tome Warlock" that the same model
// extracted cleanly from a focused window). Smaller windows = more attention
// per fact = higher recall, at the cost of more (still bounded) calls.
const SCENE_FACTS_BATCH = 5;

export interface IngestSceneFactsInput {
  characterId: string;
  characterName: string;
  chunks: Chunk[];          // the FULL chunk set, before the salience threshold
  roster: string[];         // known character names, for subject attribution
  sourceChatId?: string;    // so a re-import cleanly replaces these facts
  classify?: FactClassifier; // injectable for tests
  judge?: FactJudge;         // injectable for tests; default = durability judge
  dryRun?: boolean;          // resolve + plan, but never write (backfill preview)
}

// What a fact WOULD become — surfaced for dry-run previews (the backfill script).
export interface PlannedFact {
  subject?: string;
  lane: AmbientFact["lane"];
  scope: "character" | "chat";
  scopeId: string;
  summary: string;
}

export async function ingestSceneFacts(
  input: IngestSceneFactsInput,
): Promise<{ saved: number; facts: number; planned: PlannedFact[] }> {
  if (!sceneFactsEnabled() || input.chunks.length === 0) return { saved: 0, facts: 0, planned: [] };
  const classify = input.classify ?? classifySceneFacts;
  const judge = input.judge ?? judgeDurableFacts;
  const ctx: FactContext = {
    identityKey: input.characterId,
    fallbackChatId: input.sourceChatId ?? input.characterId,
    characterName: input.characterName,
  };

  // Only the characters present in this scene, so the model can't attribute a
  // fact to an absent cast member.
  const roster = await scopeRosterToScene(input.chunks, input.roster);

  // Pass 1 — collect candidates across windows (high recall, some noise).
  const candidates: AmbientFact[] = [];
  const seen = new Set<string>(); // de-dupe identical facts across batches before any work
  for (let i = 0; i < input.chunks.length; i += SCENE_FACTS_BATCH) {
    const batch = input.chunks.slice(i, i + SCENE_FACTS_BATCH);
    // Label by ROLE, not character name. In a chat-imported scene every
    // assistant message is tagged with the ONE session character, so prefixing
    // the speaker name lies — it labels another character's dialogue with the
    // bucket name and the model mis-attributes (it called Mari's Warlock class
    // "Priya's"). The user/scene split is reliable; specific characters are
    // attributed from in-text cues ("…Mari says…") + the roster.
    const sceneText = batch
      .map((c) => `${normalizeLabel(c.speaker) === "user" ? "User" : "Scene"}: ${c.text}`)
      .join("\n\n")
      .trim();
    if (!sceneText) continue;
    let facts: AmbientFact[];
    try {
      facts = await classify(sceneText, roster);
    } catch {
      continue; // one bad window never aborts the pass
    }
    for (const fact of facts) {
      const key = `${fact.lane}|${fact.fact.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(fact);
    }
  }

  // Pass 2 — verify-before-assemble: filter candidates to durable-only over the
  // FULL set in one judgment, before anything is written to permanent memory.
  const durable = await judge(candidates);

  // Pass 3 — route + persist the survivors.
  let saved = 0;
  const planned: PlannedFact[] = [];
  for (const fact of durable) {
    const target = await resolveFactTarget(fact, ctx);
    if (!target) continue;
    planned.push({ subject: fact.subject, lane: fact.lane, ...target });
    if (input.dryRun) continue;
    const entry = await saveFact(fact, ctx, input.sourceChatId);
    if (entry) saved++;
  }

  if (saved > 0) {
    console.info(`[ME:scene-facts] ${input.characterName}: saved ${saved} durable fact(s) (${candidates.length} candidates) from ${input.chunks.length} chunks`);
  }
  return { saved, facts: candidates.length, planned };
}
