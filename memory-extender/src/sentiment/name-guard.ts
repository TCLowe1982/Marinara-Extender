// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// THE MODEL INVENTS A PARTNER WHEN THE CHUNK GIVES IT NONE (MarinaraExtender-epf4).
//
// Measured 2026-08-21 over the 62 live beats on the vikj build. Two of the 13
// intimate-source beats attribute the scene to a named third party who appears
// NOWHERE in their own source text:
//
//   "...reveals her vulnerability to Professor Alexei Kowalski after their
//    intimate encounter."
//   "...after being told so by Dr. Alexei Petrov."
//
// TWO DIFFERENT SURNAMES FOR ONE INVENTED PERSON is the tell. This is not a wrong
// inference the model is committed to — it is filler generated on demand, twice,
// with no memory of the first. The partner in those scenes is the USER.
//
// WHY THIS IS WORSE THAN A WRONG WORD. `motivation` becomes the companion entry's
// summary, which is what the loader ranks and injects. A fabricated person therefore
// becomes retrievable, and later reads as evidence that the character has an intimate
// relationship with someone who was never in the chat. Nothing downstream can tell it
// from a real one, because by then the source is gone.
//
// ── WHY NEUTRALISE RATHER THAN REJECT ────────────────────────────────────────
//
// Rejecting the beat would destroy a real emotional moment to remove one wrong noun,
// and this project's standing rule is that a false positive — a real memory never
// recorded — is silent, unrecoverable, and strictly worse than the bug being fixed.
// So the beat survives; only the unsupported name is replaced.
//
// The replacement is deliberately NON-COMMITTAL. It would be easy to substitute "the
// user", since the partner usually is — but inferring an identity is exactly the
// behaviour being fixed here, and a confident wrong answer is what got us the
// Kowalski/Petrov pair. 4ghy already ruled on this shape: an unrecognised label
// leaves the record UNATTRIBUTED rather than inventing a person.
//
// ── WHY THE EXEMPTION LIST IS LOADED HERE AND NOT PASSED IN ──────────────────
//
// A missing exemption list convicts REAL names — the dangerous direction, and a
// silent one. Threading it through every caller would make correctness depend on
// each of them remembering, which this project has ruled ADHD-hostile and which has
// already failed once (the bait warrant). So the guard loads its own exemptions, and
// when it cannot establish them it DECLINES TO ACT rather than guessing. Silence,
// not accusation — the same posture fact-support.ts takes.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { factSupport } from "../fact-support.js";
import { readAliasTable } from "../aliases.js";
import { readUserIdentity, userTokens } from "../user-identity.js";
import { buildSubjectRoster } from "../identity.js";
import { getDataDir } from "../storage.js";

/** Honorifics that ride in front of an invented name and must go with it. */
const HONORIFIC = /(?:Dr|Doctor|Prof|Professor|Mr|Mrs|Ms|Miss|Sir|Lady|Captain|Capt|Sgt|Lt)\.?/;

/**
 * A run of capitalised words, optionally behind an honorific.
 *
 * Matched as a SPAN rather than per token because "Alexei Kowalski" is two proper
 * nouns and replacing each independently yields "someone someone".
 */
const NAME_SPAN = new RegExp(
  `(?:${HONORIFIC.source}\\s+)?\\p{Lu}[\\p{L}'’-]{2,}(?:\\s+\\p{Lu}[\\p{L}'’-]{2,})*`,
  "gu",
);

const PLACEHOLDER = "someone";

function tokenize(s: string): string[] {
  return String(s ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// ── Exemptions ───────────────────────────────────────────────────────────────

let cache: { at: number; names: string[] | null } | null = null;
const CACHE_TTL_MS = 5 * 60_000;

/**
 * Every name the store already knows: alias canonicals and their aliases, the
 * identity-map roster, and the declared user identity.
 *
 * Returns null when the exemption sources could not be read at all. Null means "do
 * not convict" — an empty Set would mean "nothing is exempt", which is the same
 * value with the opposite and much more destructive meaning.
 */
export async function knownNames(): Promise<string[] | null> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.names;
  let names: string[] | null = null;
  try {
    const [table, identity, roster] = await Promise.all([
      readAliasTable(),
      readUserIdentity().catch(() => null),
      buildSubjectRoster().catch(() => [] as string[]),
    ]);
    const out = new Set<string>();
    for (const rec of Object.values(table ?? {})) {
      if (rec?.canonicalName) out.add(rec.canonicalName);
      for (const a of rec?.aliases ?? []) out.add(a);
    }
    for (const t of userTokens(identity)) out.add(t);
    for (const n of roster) out.add(n);
    names = [...out];
  } catch {
    names = null;   // could not establish exemptions — the guard stands down
  }
  cache = { at: Date.now(), names };
  return names;
}

/** Test seam: drop the memoised exemption list. */
export function resetKnownNamesCache(): void {
  cache = null;
}

// ── The guard ────────────────────────────────────────────────────────────────

export interface NameGuardResult {
  text: string;
  /** Names removed. Empty means the field was left byte-identical. */
  removed: string[];
}

/**
 * Replace proper nouns that appear in `field` but nowhere in `source` and nowhere in
 * the store's known names.
 *
 * `exempt` of null disables the guard entirely (see knownNames).
 */
export function stripInventedNames(
  field: string,
  source: string,
  exempt: string[] | null,
): NameGuardResult {
  const text = String(field ?? "");
  if (exempt === null || !text.trim()) return { text, removed: [] };

  // factSupport already owns the hard parts: the sentence-starter trap, possessive
  // stripping, the truncation-fragment rule, and the 3-char stem match that keeps
  // "Polish" from convicting "Poland". Reuse it rather than re-deriving it badly.
  const verdict = factSupport(text, source, exempt);
  if (verdict.unsupported.length === 0) return { text, removed: [] };

  const guilty = new Set(verdict.unsupported.map((n) => n.toLowerCase()));
  const removed: string[] = [];

  const out = text.replace(NAME_SPAN, (span) => {
    // Only collapse a span whose every capitalised token is unsupported. A span
    // mixing a real name with an invented one ("Mari and Alexei") must not take the
    // real name down with it, so it is left alone for the narrower pass below.
    const caps = span.match(/\p{Lu}[\p{L}'’-]{2,}/gu) ?? [];
    const names = caps.filter((c) => !HONORIFIC.test(`${c}.`) || caps.length === 1);
    const checkable = names.filter((n) => !new RegExp(`^${HONORIFIC.source}$`).test(n));
    if (checkable.length === 0) return span;
    if (!checkable.every((c) => guilty.has(c.replace(/['’]s$/u, "").toLowerCase()))) return span;
    removed.push(...checkable);
    return PLACEHOLDER;
  });

  // Tidy the seams a substitution leaves: "someone someone" from adjacent spans, and
  // a doubled space where an honorific was dropped.
  const tidied = out
    .replace(new RegExp(`\\b${PLACEHOLDER}(?:\\s+${PLACEHOLDER})+\\b`, "g"), PLACEHOLDER)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1");

  return { text: tidied, removed: [...new Set(removed)] };
}

// ── The sink ─────────────────────────────────────────────────────────────────
//
// COUNTABLE ON PURPOSE (5x5y, 2026-08-21). The subtext field taught this lesson at
// cost: an effect nobody can put a denominator under sat at 0.7% for months and read
// as working. A guard that fires silently is the same failure wearing a fix, so every
// substitution is written where it can be counted and read back.

export interface NameGuardEvent {
  at: string;
  field: string;
  removed: string[];
  before: string;
  after: string;
  chatId?: string;
}

export function nameGuardLogPath(dataDir: string): string {
  return join(dataDir, "name-guard.jsonl");
}

export function recordNameGuard(dataDir: string, ev: NameGuardEvent): void {
  try {
    const p = nameGuardLogPath(dataDir);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(ev) + "\n", "utf8");
  } catch {
    // Swallowed: a guard that can throw on its own bookkeeping is worse than one
    // that occasionally loses a log line.
  }
}

/** Apply the guard to one field and record it. Returns the cleaned text. */
export function guardField(
  field: string,
  source: string,
  exempt: string[] | null,
  meta: { field: string; chatId?: string },
): string {
  const r = stripInventedNames(field, source, exempt);
  if (r.removed.length === 0) return r.text;
  console.warn(
    `[ME:name-guard] removed ${r.removed.length} unsupported name(s) from ${meta.field}: ${r.removed.join(", ")}`,
  );
  recordNameGuard(getDataDir(), {
    at: new Date().toISOString(),
    field: meta.field,
    removed: r.removed,
    before: field,
    after: r.text,
    chatId: meta.chatId,
  });
  return r.text;
}
