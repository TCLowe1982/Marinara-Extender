// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// SUBJECT — who a memory is ABOUT (4g9w slice 1, ticket qlib).
//
// Scope answers "who can RECALL this". It has never answered "who is this
// ABOUT", so aboutness was forced onto the LANE axis, which offers exactly two
// subjects: the human player (user_topics) or the scope owner (character_topics).
// A fact about a third person has no correct home — that is the Becky Collier
// misfiling, the Texas rows, and the referent bleed, all at once.
//
// The field already existed as PROSE: resolveFactTarget writes "[about: X] …"
// into the summary text when it cannot resolve a subject. 3,380 entries carry
// one. This module gives that data a field to live in, and refuses the values
// that should never have been accepted as names in the first place.

// ── Shape ────────────────────────────────────────────────────────────────────

// What KIND of referent this is. The distinction that put TC in Texas: a fact
// about the persona "Thomas" is not a fact about the human, and user_topics
// cannot currently tell them apart (qhej). Optional — populate only when known.
export type SubjectKind = "user" | "persona" | "character" | "third-party";

// NAME and KEY are deliberately separate fields, never one string.
//
// Mixing "a resolved canonical key" and "a raw observed name" in one field is
// 'cannot tell which', which is the shape this codebase keeps getting hurt by.
// It is also the card-pointer discipline applied again: keep what was OBSERVED
// apart from what it RESOLVED TO. It matters in practice because entities.yaml
// has no refresh trigger (89l3), so resolution legitimately fails for entities
// that are simply new — and that must stay distinguishable from "never tried".
export interface SubjectRef {
  name: string;        // as observed in the source
  key?: string;        // canonical entity / identity key, when resolvable
  kind?: SubjectKind;
}

// ── Validity ─────────────────────────────────────────────────────────────────
//
// q5pk: 2,768 of 3,380 demoted facts are tagged "[about: character]" or
// "[about: [character]]" — the prompt's own placeholder emitted as a subject
// name — plus ~160 bare pronouns. The old code DEMOTED these, which is the right
// response to an unknown NAME and the wrong response to a value that is not a
// name at all. Per the house law (close it structurally, do not add a sweep),
// they stop being representable rather than being cleaned up afterwards.

// The literal placeholder tokens seen in the store, plus the card-templating
// tokens that would produce the same failure from a different direction.
const PLACEHOLDERS = new Set([
  "character", "the character", "a character", "some character", "this character",
  "char", "{{char}}", "{{user}}", "<char>", "<user>",
  "person", "the person", "a person", "someone", "somebody", "anyone", "everyone",
  "unknown", "unknown character", "unknown person", "n/a", "na", "none", "null",
  "undefined", "narrator", "speaker", "the speaker", "user_topics", "character_topics",
]);

// Bare pronouns are never a subject. 62 "she", 40 "him", 19 "I", 13 "he", 9 "i",
// 6 "we", 6 "himself" are live in the store today.
const PRONOUNS = new Set([
  "i", "me", "my", "myself", "mine",
  "you", "your", "yourself", "yours",
  "he", "him", "his", "himself",
  "she", "her", "hers", "herself",
  "it", "its", "itself",
  "we", "us", "our", "ourselves", "ours",
  "they", "them", "their", "themselves", "theirs",
]);

// "user" is NOT a placeholder — it is the sentinel the extractor uses for the
// human player, and resolveFactTarget keys on it. Kept out of PLACEHOLDERS on
// purpose; see subjectKindFor().
export const USER_SENTINEL = "user";

export type SubjectRejection =
  | "empty"
  | "placeholder"
  | "pronoun"
  | "bracketed"
  | "too-long"
  // qs67: the subject named the SPEAKER of a second-person sentence. "You" never
  // refers to the person saying it, so this one is refused on grammar rather than
  // on the shape of the name — the name is usually perfectly valid.
  | "speaker";

// A subject name is a NAME. Returns the reason it is not, or null if it is fine.
// Checked against the normalized (lowercased, trimmed, punctuation-stripped)
// form so "Character", "character." and "[character]" all land on one verdict —
// the sentence-case trap's lesson applied to the boundary rather than the body.
export function rejectSubjectName(raw: string | undefined | null): SubjectRejection | null {
  const s = (raw ?? "").trim();
  if (!s) return "empty";

  // A value that is ENTIRELY a bracketed/braced token is a template artifact,
  // never a name — "[character]", "{{char}}", "<user>". Note this deliberately
  // does not reject a name that merely CONTAINS brackets.
  if (/^[[{<(].*[\]}>)]$/.test(s)) return "bracketed";

  // A summary-length string is a sentence that leaked into the subject slot.
  if (s.length > 80) return "too-long";

  const norm = s.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/\s+/g, " ");
  if (!norm) return "empty";
  if (norm === USER_SENTINEL) return null;      // the human-player sentinel is valid
  if (PLACEHOLDERS.has(norm)) return "placeholder";
  if (PRONOUNS.has(norm)) return "pronoun";
  return null;
}

export function isValidSubjectName(raw: string | undefined | null): boolean {
  return rejectSubjectName(raw) === null;
}

// ── Counters ─────────────────────────────────────────────────────────────────
//
// advisory-guards-do-no-work: a guard that silently drops is a guard nobody can
// audit. Refusals are counted by reason and readable, so the rate is a number
// rather than a feeling.

const rejections = new Map<SubjectRejection, number>();

export function noteSubjectRejection(reason: SubjectRejection): void {
  rejections.set(reason, (rejections.get(reason) ?? 0) + 1);
}

export function subjectRejectionCounts(): Record<string, number> {
  return Object.fromEntries(rejections);
}

export function resetSubjectRejectionCounts(): void {
  rejections.clear();
}

// ── Construction ─────────────────────────────────────────────────────────────

// Build a SubjectRef, or null if the name is not a name. Counts the refusal.
export function makeSubject(
  name: string | undefined | null,
  opts?: { key?: string; kind?: SubjectKind },
): SubjectRef | null {
  const reason = rejectSubjectName(name);
  if (reason) {
    noteSubjectRejection(reason);
    return null;
  }
  const trimmed = (name ?? "").trim();
  return {
    name: trimmed,
    ...(opts?.key ? { key: opts.key } : {}),
    ...(opts?.kind ? { kind: opts.kind } : {}),
  };
}

// The one kind we can assert without a roster: the extractor's user sentinel.
// Everything else needs identity resolution and is left undefined rather than
// guessed — "absent means unknown, never means none".
export function subjectKindFor(name: string): SubjectKind | undefined {
  return name.trim().toLowerCase() === USER_SENTINEL ? "user" : undefined;
}

// Normalize a list, dropping invalid entries and de-duplicating by name. Returns
// undefined (not []) when nothing survives, so the field stays ABSENT rather
// than asserting "about nobody" — the bodyTerms rule.
export function normalizeSubjects(subjects: Array<SubjectRef | null | undefined> | undefined): SubjectRef[] | undefined {
  if (!subjects?.length) return undefined;
  const out: SubjectRef[] = [];
  const seen = new Set<string>();
  for (const s of subjects) {
    if (!s || !isValidSubjectName(s.name)) continue;
    const k = s.name.trim().toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out.length ? out : undefined;
}

// ── The prose prefix, absorbed at the boundary ───────────────────────────────
//
// Aboutness used to be written into the summary TEXT as "[about: X] …" because
// there was no field for it. There is now — but a prefix reaching the store is
// not a formatting nit, it is the tell that some caller is routing subjects on
// its own instead of going through resolveFactTarget. That is exactly how oc4w
// happened: an inline COPY of the router in api.ts kept minting prefixes for a
// day after the field shipped, across 1,552 entries, and nothing noticed
// because the only guard was that both copies would be edited together.
//
// So the prefix stops being writable. Rung 3, not rung 5: this does not refuse
// the entry — it ABSORBS the claim into the field where it belongs, keeps the
// memory, and counts the event so a re-inlined router shows up as a number
// instead of as archaeology in October. Route and mark, never drop.
//
// One level of nesting is matched on purpose: "[about: [character]]" is 373
// live entries, and a naive [^\]]* would leave a stray "]" welded to the prose.
const ABOUT_PREFIX_RE = /^\s*\[about:\s*(\[[^\]]*\]|[^\]]*)\]\s*/i;

let aboutPrefixesAbsorbed = 0;

export function aboutPrefixAbsorptions(): number {
  return aboutPrefixesAbsorbed;
}

export function resetAboutPrefixAbsorptions(): void {
  aboutPrefixesAbsorbed = 0;
}

/**
 * Strip a legacy "[about: X]" prefix off a summary and move X into subjects[].
 *
 * An EXPLICIT subjects[] always wins — the field is the assertion, the prefix is
 * a symptom — so a caller that supplies both keeps its own and only loses the
 * prose. When no subject was supplied, X goes through makeSubject, which refuses
 * a non-name and counts the refusal; a refused X leaves the field absent rather
 * than recording "[character]" as a person, which is q5pk closing from the other
 * end.
 */
export function absorbAboutPrefix(
  summary: string,
  subjects?: Array<SubjectRef | null | undefined>,
): { summary: string; subjects?: SubjectRef[] } {
  const m = ABOUT_PREFIX_RE.exec(summary);
  if (!m) return { summary, ...(subjects ? { subjects: normalizeSubjects(subjects) } : {}) };

  aboutPrefixesAbsorbed++;
  const stripped = summary.slice(m[0].length).trim();
  const existing = normalizeSubjects(subjects);
  if (existing) return { summary: stripped, subjects: existing };

  const recovered = makeSubject(m[1]);
  return { summary: stripped, ...(recovered ? { subjects: [recovered] } : {}) };
}
