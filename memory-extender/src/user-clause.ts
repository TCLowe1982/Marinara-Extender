// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Keep the user's half of a two-fact sentence (MarinaraExtender-2tro).
//
// When a sentence coordinates a first-person clause with a third-person one, the
// extractor reliably keeps the third-person clause and DROPS the user's. Both
// verified cases have the same shape:
//
//   "I was in the Army, and Mari is Polish."
//      -> "Mari is Polish"                      (the user's service is gone)
//   "It was my fourth sapper stakes, and Sgt Roger's 6th? 7th? ..."
//      -> both sergeants' counts, not the user's   (the user's fourth is gone)
//
// That is fact LOSS, not a phrasing complaint. Retrieval scores the SUMMARY, so
// the dropped clause is not merely mis-worded, it is unreachable — and tp5's
// bodyTerms cannot rescue it, because bodyTerms harvests NAMES and "my fourth
// sapper stakes" contains none.
//
// The real fix is the prompt (see ambient.ts), which now teaches the model to
// return BOTH facts. This module is the net under it: a deterministic,
// offline-testable pass that fires only when the model dropped the clause anyway.
//
// TWO DESIGN CHOICES WORTH THE WORDS:
//
// It QUOTES the clause instead of rewriting it. "I" -> "User" needs verb
// agreement ("I live" -> "User live") and there is no safe local rule for that.
// A verbatim bracket prefix carries every content word into the scored summary
// with no morphology at all, and matches the "[about: X]" convention already
// used for unresolved subjects in facts.ts.
//
// It PREFIXES rather than appends, because the summary is truncated at 120
// chars downstream. The clause being lost is the whole point; it goes first.

import type { AmbientFact } from "./ambient.js";

// Deliberately separate from ambient.ts's candidate-filter FIRST_PERSON_RE: that
// one gates which sentences are worth an LLM call and may be tuned for recall,
// this one decides an attribution. They should not drift into each other.
const FIRST_PERSON_RE = /\b(?:i|me|my|mine|myself|we|us|our|ours|ourselves)\b/i;

// Clause boundaries: sentence enders, semicolons/colons, and coordination.
// ", and" is the shape both verified cases use.
const CLAUSE_SPLIT_RE =
  /[.!?]+(?:\s+|$)|\s*[;:]\s*|\s*,\s*(?:and|but|so|yet|while|whereas|though|although)\s+|\s+(?:and|but|while|whereas)\s+/i;

/** Break a sentence into clauses. Empty pieces (a trailing full stop) are dropped. */
export function splitClauses(text: string): string[] {
  return text.split(CLAUSE_SPLIT_RE).map((c) => c.trim()).filter(Boolean);
}

// Function words carry no retrieval signal, so their absence from a summary is
// not evidence that anything was lost. Only content words are compared.
const STOPWORDS = new Set([
  "the", "and", "but", "was", "were", "been", "being", "have", "has", "had", "that", "this",
  "those", "these", "with", "from", "for", "not", "are", "its", "you", "your", "his", "her",
  "she", "him", "they", "them", "their", "there", "then", "than", "into", "over", "about",
  "just", "like", "very", "out", "all", "any", "some", "did", "does", "done", "get", "got",
  "would", "could", "should", "will", "shall", "can", "may", "might", "must", "when", "where",
  "what", "who", "whom", "how", "why", "which", "because", "also", "only", "too",
]);

function contentWords(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (w) => w.length >= 3 && !STOPWORDS.has(w),
  );
}

function hasWholeWord(haystack: string, needle: string): boolean {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}([^\\p{L}\\p{N}]|$)`, "u").test(haystack);
}

/**
 * Does this fact already carry the user? Any of: the extractor tagged it
 * subject "user", it says "user", it kept first-person phrasing, or it names a
 * DECLARED user form (egj3 — so "TC served in the Army" counts and we do not
 * double-report it).
 */
function mentionsUser(fact: AmbientFact, userForms: string[]): boolean {
  if ((fact.subject ?? "").trim().toLowerCase() === "user") return true;
  const f = fact.fact.toLowerCase();
  if (hasWholeWord(f, "user")) return true;
  if (FIRST_PERSON_RE.test(f)) return true;
  return userForms.some((form) => form && hasWholeWord(f, form.toLowerCase()));
}

export interface KeepUserClauseOptions {
  /**
   * Only the text the USER wrote.
   *
   * Load-bearing: a character's dialogue is first-person too, and tagging
   * "I grew up in Kraków" as the user's is precisely the mis-attribution this
   * is supposed to prevent. A clause is claimed for the user only if every
   * content word in it appears in what the user actually said.
   */
  userText: string;
  /** Declared user forms from user-identity.yaml (egj3). */
  userForms?: string[];
  /**
   * Known people who are NOT the user — the scene roster, or entity-index
   * persons. Used only to recognise a subject-less summary that is nonetheless
   * about someone else; see the third-party rule in keepUserClause.
   */
  thirdParties?: string[];
  /**
   * Total cap on the restored prefix, so it cannot eat the summary it is meant
   * to protect. Not per-clause: a scan over the live store turned up an entry
   * whose `content` was an entire transcript, and per-clause capping produced a
   * 2,000-character prefix out of forty capped clauses.
   */
  maxClauseChars?: number;
}

/** At most this many dropped clauses are restored; the rest are already noise. */
const MAX_RESTORED_CLAUSES = 2;

/**
 * Is this group of facts about someone OTHER than the user?
 *
 * MEASURED, not assumed. A first cut skipped this test and scanned the live
 * store: 169 hits, and by inspection most were summaries that already carried
 * the user perfectly well — they just never named them. "Speaks three
 * languages", "Was medicated through high school", "has a memory system to
 * stabilize". A user_topics summary routinely has an IMPLICIT subject, and
 * reading that as "the user is missing" adds a redundant prefix to a healthy
 * memory.
 *
 * So the clause is only restored when something positively indicates the
 * surviving fact belongs to someone else — never merely because the user is not
 * visible in it. Two forms of evidence, and no leading-capital guessing: a
 * capital tells you nothing here ("Was" opens a sentence, "Mari" is a person),
 * which is why this asks the extractor or the roster instead.
 */
function aboutSomeoneElse(group: AmbientFact[], userForms: string[], thirdParties: string[]): boolean {
  // 1. The extractor said so. Every fact carries an explicit subject and none is
  //    the user — the strongest signal, and what the live path actually emits.
  const subjects = group.map((f) => (f.subject ?? "").trim().toLowerCase());
  if (subjects.every(Boolean) && !subjects.some((s) => s === "user" || userForms.includes(s))) {
    return true;
  }
  // 2. No subjects (back-compat, or a stored entry): accept only if a summary
  //    OPENS with a known third party — subject position, not mere mention.
  //
  //    Measured too. Accepting a mention anywhere left 39 hits, and the survivors
  //    were still mostly the user's own facts that happened to name someone:
  //    "has difficulty remembering character names (specifically Hargrove)" is
  //    about the user, Hargrove notwithstanding. The confound sweep reached the
  //    same conclusion independently — only the subject position is evidence.
  //
  //    This is not the leading-capital guess that trap warns about: the leading
  //    token has to MATCH a name the corpus already corroborated, so "Was" and
  //    "Takes" cannot pass by virtue of being capitalised.
  return group.some((f) => thirdParties.some((p) => p && opensWith(f.fact, p)));
}

/** Does this summary begin with `name`, as its subject (possessive allowed)? */
function opensWith(summary: string, name: string): boolean {
  const f = summary.trim().toLowerCase();
  const n = name.trim().toLowerCase();
  if (!n || !f.startsWith(n)) return false;
  const rest = f.slice(n.length);
  return rest === "" || /^(?:['’]s)?(?:[^\p{L}\p{N}]|$)/u.test(rest);
}

/**
 * Restore the user's dropped clause to the summary that lost it.
 *
 * Conservative by construction — it fires only when ALL of these hold, because a
 * false positive writes a wrong attribution into permanent memory:
 *
 *   1. the source sentence actually coordinates (>= 2 clauses),
 *   2. one clause is first person AND every content word in it appears in the
 *      user's own text,
 *   3. the surviving facts are positively about someone ELSE (see
 *      aboutSomeoneElse — this is the condition that measurement added),
 *   4. NO fact extracted from that same sentence carries the user already —
 *      when the model does the right thing and returns the user's half as its
 *      own fact, amending would duplicate it,
 *   5. the clause has a content word that appears in no fact from that
 *      sentence. A reworded clause is not a lost one.
 */
export function keepUserClause(facts: AmbientFact[], opts: KeepUserClauseOptions): AmbientFact[] {
  if (facts.length === 0) return facts;
  const userWords = new Set(contentWords(opts.userText ?? ""));
  if (userWords.size === 0) return facts;
  const userForms = opts.userForms ?? [];
  const thirdParties = opts.thirdParties ?? [];
  const maxClause = opts.maxClauseChars ?? 90;

  // Group by source sentence: coverage is a property of everything the model
  // returned for that sentence, not of one fact in isolation.
  const groups = new Map<string, number[]>();
  facts.forEach((f, i) => {
    const key = (f.text ?? "").trim().toLowerCase();
    if (!key) return;
    const at = groups.get(key);
    if (at) at.push(i);
    else groups.set(key, [i]);
  });

  const out = facts.slice();
  for (const idxs of groups.values()) {
    const clauses = splitClauses(out[idxs[0]!]!.text);
    if (clauses.length < 2) continue;

    const mine = clauses.filter((c) => {
      if (!FIRST_PERSON_RE.test(c)) return false;
      const words = contentWords(c);
      return words.length > 0 && words.every((w) => userWords.has(w));
    });
    if (mine.length === 0) continue;

    const group = idxs.map((i) => out[i]!);
    if (!aboutSomeoneElse(group, userForms, thirdParties)) continue;
    if (group.some((f) => mentionsUser(f, userForms))) continue;

    const said = new Set(idxs.flatMap((i) => contentWords(out[i]!.fact)));
    const dropped = mine.filter((c) => contentWords(c).some((w) => !said.has(w)));
    if (dropped.length === 0) continue;

    const at = idxs[0]!;
    if (out[at]!.fact.startsWith("[user:")) continue; // already repaired
    const joined = dropped.slice(0, MAX_RESTORED_CLAUSES).join("; ");
    const clause = joined.length > maxClause ? joined.slice(0, maxClause - 1).trimEnd() + "…" : joined;
    out[at] = { ...out[at]!, fact: `[user: ${clause}] ${out[at]!.fact}` };
  }
  return out;
}

/**
 * The user-spoken half of a scene transcript.
 *
 * facts.ts labels every line "User:" or "Scene:" (it deliberately does NOT use
 * character names — see the comment there), so the split is reliable.
 */
export function userSpokenLines(sceneText: string): string {
  return sceneText
    .split("\n")
    .filter((l) => /^\s*user:/i.test(l))
    .map((l) => l.replace(/^\s*user:\s*/i, ""))
    .join("\n");
}
