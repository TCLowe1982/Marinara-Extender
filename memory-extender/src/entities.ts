// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// The mention-entity index (MarinaraExtender-76aw, slice 1).
//
// Retrieval matches tokens, so "Erica" and "Cathmore" are unrelated strings and
// a surname cue reaches none of the entries that only ever say the first name.
// Measured on the live store: roughly half the retrievable material about one
// person is invisible to a surname-only cue, and the same in reverse.
//
// This is NOT the speaker-alias table (aliases.ts). That one routes who is
// TALKING and only ever learns characters who speak; Erica is mentioned
// constantly and never speaks, so she could never acquire a record there. This
// indexes who is MENTIONED, which is a different population and a different job.
//
// ── Why it indexes everything, not just people ──────────────────────────────
//
// An earlier draft tried to filter multi-word proper nouns down to person names
// and throw the rest away. TC's correction: Marinara Engine, Elysium Grand and
// Porsche Taycan are things a character should be able to recall too. They are
// entities of a different TYPE, not noise. So nothing is filtered out, and the
// person/thing question stops being a gate on indexing at all.
//
// ── The safety property is per-PART, not per-entity ─────────────────────────
//
// The dangerous operation is not indexing "Elden Ring", it is concluding that
// "Ring" means it. A false alias is worse than a missing one: it does not merely
// fail to find, it drags unrelated memories in under a name. So a part becomes
// an alias only if people demonstrably USE it alone to mean the whole, measured
// as its independent-use rate. On the live store that cleanly separates the two
// cases, and does so regardless of type:
//
//     link      Cole 0.72 · Cathmore 0.38 · Taycan 0.33
//     do not    Ring 0.12 · Grand 0.07 · Zielińska 0.06
//
// "Zielińska" not linking is correct and costs nothing — the full form still
// matches, and nobody says it alone anyway.

import { join } from "path";
import { stringify } from "yaml";
import { atomicWriteFile_UNLOCKED_takeSerializedWriteYourself, getDataDir, readYamlFile } from "./storage.js";
import { excludedForms, userCueLinks, type UserIdentity } from "./user-identity.js";

// ── Extraction ───────────────────────────────────────────────────────────────

// Sentence-initial capitals and function words are not names. Kept separate from
// the relevance stopword list because that one exists to drop low-signal QUERY
// terms, while this one exists to stop a run being glued together across an
// ordinary capitalised word.
const RUN_STOPWORDS = new Set(
  ("The A An And But For From With Was Were Are Is It He She They This That When Then There Here " +
   "Her His Their I You We Not No Of On In To Up Us My Me If As At Be By Or Our So Do Did Had Has " +
   "Have Will Would What Which Who Outcome Note Summary Status Content Result").split(" "),
);

/**
 * Runs of two or more capitalised tokens.
 *
 * Deliberately applied PER FIELD. Run it over an entry's concatenated text and a
 * name butts against the next YAML key — "Priya Chandrasekaran Outcome" showed
 * up 90 times that way, and "Professor Mari Outcome" 14 more.
 */
const RUN = /\b(\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)+)\b/gu;

/** Personal pronouns only. Mixing in verbs like is/was/has drowns the signal —
 *  measured, an earlier attempt scored a software product above a person. */
const PRONOUN = /\b(he|she|they|him|her|them|his|hers|their|theirs|himself|herself|themselves)\b/i;

/** How far after a mention a pronoun still counts as referring to it. */
const PRONOUN_WINDOW = 60;

export interface EntityRecord {
  /** The full surface form, e.g. "Erica Cathmore". */
  canonical: string;
  /** Lowercased parts that qualified as aliases for the whole. */
  aliases: string[];
  /** Times the full form was seen. */
  count: number;
  /** Times a personal pronoun followed within PRONOUN_WINDOW characters. */
  pronounHits: number;
  /** Whether this reads as a person — see personLikelihood. */
  person: boolean;
}

export interface EntityIndex {
  version: 1;
  updated: string;
  entities: EntityRecord[];
}

/** Raw counts gathered during a scan, before thresholds are applied. */
export interface EntityObservations {
  /** full form → times seen */
  runs: Map<string, number>;
  /** full form → times a pronoun followed */
  pronouns: Map<string, number>;
  /** token → times seen anywhere (including inside a run) */
  tokens: Map<string, number>;
}

export function emptyObservations(): EntityObservations {
  return { runs: new Map(), pronouns: new Map(), tokens: new Map() };
}

const bump = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

/**
 * Fold the possessive into the base form.
 *
 * Without this, "Mari Zielińska's" is a separate entity from "Mari Zielińska" —
 * measured, that split 332 sightings away from 4975 and then offered "mari's" as
 * an alias, which is a token no cue will ever contain. The possessive is
 * grammar, not a different name.
 */
const stripPossessive = (token: string): string => token.replace(/['’]s$|['’]$/u, "");

/** Accumulate one field's worth of evidence. Call once per field, never on a join. */
export function observeField(text: string, into: EntityObservations): void {
  if (!text) return;
  for (const m of text.matchAll(RUN)) {
    const parts = m[1]!.split(/\s+/)
      .filter((t) => !RUN_STOPWORDS.has(t))
      .map(stripPossessive)
      .filter(Boolean);
    if (parts.length < 2) continue;
    const canonical = parts.join(" ");
    bump(into.runs, canonical);
    const after = text.slice(m.index! + m[0]!.length, m.index! + m[0]!.length + PRONOUN_WINDOW);
    if (PRONOUN.test(after)) bump(into.pronouns, canonical);
  }
  // Solo tokens are counted in the same normalised form the runs use, or the
  // independence subtraction compares "Mari" against a bound count that lives
  // under "Mari's" and never cancels.
  for (const m of text.matchAll(/\b(\p{Lu}[\p{L}'’-]{2,})\b/gu)) {
    const t = stripPossessive(m[1]!);
    if (t.length >= 3) bump(into.tokens, t);
  }
}

// ── Thresholds ───────────────────────────────────────────────────────────────
// Every number here was read off the live store rather than guessed. Changing
// one means re-running scripts/build-entity-index.mjs --dry-run and looking at
// what crosses the line, not reasoning about it.

/** Below this many sightings a full form is a coincidence, not an entity. */
export const MIN_ENTITY_COUNT = 3;

/**
 * Independent-use rate at which a part earns alias status.
 *
 * 0.25 sits in the gap the measurements left: linked at 0.72/0.38/0.33 (Cole,
 * Cathmore, Taycan), excluded at 0.12/0.07/0.06 (Ring, Grand, Zielińska).
 */
export const ALIAS_MIN_INDEPENDENCE = 0.25;

/**
 * Person thresholds, applied as OR because the two signals fail in OPPOSITE
 * directions and either alone loses one of the store's most important entities:
 *
 *   Erica Cathmore   pronoun 0.22 ✗   independent 0.38 ✓
 *   Mari Zielińska   pronoun 0.54 ✓   independent 0.06 ✗
 *
 * Erica reads low on pronouns because she is discussed ANALYTICALLY — the Erica
 * Test is the failure this whole issue exists to fix. That signature is produced
 * by the bug, so tuning the detector to fit it would encode the failure.
 *
 * Noise is accepted here by explicit ruling (TC): some things will be tagged
 * people. It costs little, because the tag gates only person-specific behaviour
 * and never gates indexing or alias safety.
 */
export const PERSON_MIN_PRONOUN_RATE = 0.30;
export const PERSON_MIN_INDEPENDENCE = 0.30;

/**
 * How many entities an alias may point at before it stops expanding.
 *
 * Independent use answers "does this part mean the whole". It does NOT answer
 * "which whole" — and a surname is shared. Erica Cathmore and Gunnery Sergeant
 * Cathmore are her and her FATHER, two people; Thomas Collier and Thomas Lowe
 * are a character and the user. Linking through a shared surname is the
 * one-name-two-entities half of 76aw's doctrine amendment, and it is the more
 * dangerous half: collapsing two entities into one is referent bleed across the
 * membrane, which is what produced the ctopic-4mke2qmh corruption.
 *
 * Measured on the live store, 23% of aliases point at more than one entity, and
 * degree tracks the danger closely: "cathmore" collides 2 ways (a family),
 * "thomas" collides 11 (a character, the user, and extraction noise).
 *
 * At 2 the recall win survives essentially intact — "tell me about Cathmore"
 * reaches 91 of 108 versus 91 uncapped and 25 with no expansion at all — while
 * the 11-way collision stops expanding entirely. One entry is the whole cost.
 *
 * This is a fail-closed bound, not a resolution: two people sharing a surname
 * still link. Telling them apart needs the entity resolution in slice 2, which
 * is also the only thing that can carry the world tag.
 */
export const ALIAS_MAX_AMBIGUITY = 2;

/**
 * How often a token appears OUTSIDE any multi-word run.
 *
 * The subtraction is the whole point. Counting raw appearances makes every part
 * of every compound look independently used, because the occurrences inside the
 * compound dominate — that error made "Elysium Grand" read as a first/last pair.
 */
export function independence(token: string, obs: EntityObservations, boundCounts: Map<string, number>): number {
  const total = obs.tokens.get(token) ?? 0;
  if (total <= 0) return 0;
  const bound = boundCounts.get(token) ?? 0;
  return Math.max(0, total - bound) / total;
}

/** Times each token appeared inside some run — the amount to subtract. */
export function boundTokenCounts(obs: EntityObservations): Map<string, number> {
  const bound = new Map<string, number>();
  for (const [canonical, n] of obs.runs) for (const part of canonical.split(" ")) bump(bound, part, n);
  return bound;
}

/** Turn raw observations into the index, applying every threshold above. */
export function buildIndex(obs: EntityObservations): EntityIndex {
  const bound = boundTokenCounts(obs);
  const entities: EntityRecord[] = [];

  for (const [canonical, count] of obs.runs) {
    if (count < MIN_ENTITY_COUNT) continue;
    const parts = canonical.split(" ");
    const rates = parts.map((p) => independence(p, obs, bound));
    const pronounHits = obs.pronouns.get(canonical) ?? 0;
    const pronounRate = pronounHits / count;

    const aliases = parts
      .filter((_, i) => rates[i]! >= ALIAS_MIN_INDEPENDENCE)
      .map((p) => p.toLowerCase())
      // A part identical to the whole is not an alias, and a one-word alias that
      // is itself another entity's canonical form is left to that entity.
      .filter((p) => p !== canonical.toLowerCase());

    entities.push({
      canonical,
      aliases,
      count,
      pronounHits,
      person: pronounRate >= PERSON_MIN_PRONOUN_RATE
           || Math.max(...rates) >= PERSON_MIN_INDEPENDENCE,
    });
  }

  entities.sort((a, b) => b.count - a.count);
  return { version: 1, updated: new Date().toISOString(), entities };
}

// ── Storage ──────────────────────────────────────────────────────────────────
// One file for the whole store, not per scope: an entity is a property of the
// world, and the same person is mentioned across many characters' chats.

export function entityIndexPath(): string {
  return join(getDataDir(), "entities.yaml");
}

export async function readEntityIndex(): Promise<EntityIndex | null> {
  return readYamlFile<EntityIndex>(entityIndexPath());
}

export async function writeEntityIndex(index: EntityIndex): Promise<void> {
  await atomicWriteFile_UNLOCKED_takeSerializedWriteYourself(entityIndexPath(), stringify(index));
}

// ── Cue expansion ────────────────────────────────────────────────────────────

/**
 * alias → the other forms it should also match.
 *
 * Built once per turn. Both directions are registered: a cue of "Cathmore"
 * has to reach entries that say "Erica", and a cue of "Erica" has to reach
 * entries that say "Cathmore".
 */
export function buildCueMap(
  index: EntityIndex | null,
  identity?: UserIdentity | null,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!index && !identity) return map;

  const add = (from: string, to: string) => {
    if (from === to) return;
    const existing = map.get(from);
    if (existing) { if (!existing.includes(to)) existing.push(to); }
    else map.set(from, [to]);
  };

  // How many distinct entities each alias points at. An alias over the limit is
  // dropped entirely rather than expanded to a guess — see ALIAS_MAX_AMBIGUITY.
  const degree = new Map<string, number>();
  for (const e of index?.entities ?? []) {
    for (const a of e.aliases) degree.set(a, (degree.get(a) ?? 0) + 1);
  }

  // Forms the user has DISCLAIMED never carry an inferred link. Without this,
  // a declared "thomas lowe" and an inferred "Thomas Collier" still meet through
  // the token they share, and the exclusion the user just wrote down is undone
  // by the corpus.
  const disclaimed = excludedForms(identity ?? null);

  for (const e of index?.entities ?? []) {
    if (disclaimed.has(e.canonical.toLowerCase())) continue;
    // ONLY an alias may be a cue. Linking every canonical part to every other
    // would defeat the gate entirely — "Ring" would reach "Elden Ring", which is
    // precisely the false coreference the independence test exists to refuse.
    // The gate is computed in buildIndex; it has to be honoured HERE, at the one
    // place the links are actually consumed.
    if (!e.aliases.length) continue;
    const targets = [...new Set([...e.canonical.toLowerCase().split(" "), ...e.aliases])];
    for (const from of e.aliases) {
      if ((degree.get(from) ?? 0) > ALIAS_MAX_AMBIGUITY) continue;
      for (const to of targets) add(from, to);
    }
  }

  // The declaration goes LAST and is exempt from the ambiguity bound. That bound
  // exists to stop a GUESS spreading; a declared identity is not a guess, and
  // suppressing it is what left the user unreachable by their own name.
  for (const [from, targets] of userCueLinks(identity ?? null)) {
    for (const to of targets) add(from, to);
  }
  return map;
}

/**
 * Widen the conversation text with linked surface forms.
 *
 * Deliberately expands the CUE, not the stored rows. Expanding rows would mean
 * rewriting the index whenever an alias is learned and growing it again after
 * tp5 already cost 23%; expanding the cue is one pass per turn and leaves the
 * store untouched. It also means a corrected alias takes effect immediately,
 * with no backfill.
 *
 * Returns the original text plus the added forms, so the caller can hand it
 * straight to the existing scorer with no signature change.
 */
export function expandCues(recentText: string, cues: Map<string, string[]>): string {
  if (!recentText || cues.size === 0) return recentText;
  const seen = new Set<string>();
  const additions: string[] = [];
  for (const raw of recentText.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    for (const linked of cues.get(raw) ?? []) {
      if (seen.has(linked)) continue;
      seen.add(linked);
      additions.push(linked);
    }
  }
  return additions.length ? `${recentText} ${additions.join(" ")}` : recentText;
}
