// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Lexical relevance — the shared vocabulary for "does this memory match what is
// being said right now".
//
// It lives in its own module because the SAME tokenisation now runs on two sides
// of a persistence boundary: terms are harvested from an entry's body when it is
// written, and compared against the conversation when it is ranked. If those two
// ever disagreed about what counts as a word, a stopword, or a name, the stored
// terms would simply never match and the feature would fail silently while every
// test that exercised one side alone still passed. One definition, imported by
// both, makes that class of bug unrepresentable.
//
// Scored as ACCUMULATED EVIDENCE, not as a fraction of the summary (vrw). The old
// form divided by summary length and so punished a memory for its own detail: one
// proper noun matched out of a fifteen-word summary scored 0.067, while a
// four-word throwaway sharing a common verb scored 0.250. Measured on the live
// stores, "wants to remember past crimes" outranked every substantive record of a
// named person, and a memory noting that the author had FORGOTTEN a name
// outranked the memory containing it. Density is what a summary should have, so
// normalising it away is backwards.

export const RELEVANCE_STOPWORDS = new Set(
  ("a an and are as at be been but by for from had has have he her his i if in into is it its me my " +
   "no not of on or our she that the their them then they this to up us was we were what when which " +
   "who will with would you your").split(" "),
);

// Tuned so one ordinary matched term ≈ 0.30, two ≈ 0.51, three ≈ 0.66.
// Keeps every score inside [0,1) so the thread-sibling discount and the
// existing threshold comparisons keep their meaning.
export const RELEVANCE_SATURATION = 0.357;

// A matched NAME is worth more than a matched common word. Length was only ever
// a crude proxy for this: terse summaries looked "focused" because they carried
// little but their subject. Weighting the subject directly is what we actually
// meant, and capitalisation already marks it — we were lowercasing that signal
// away before scoring. At 2.5 a single matched name (≈0.59) outranks two matched
// common words (≈0.51), so "wants to remember past crimes" can no longer beat
// the record of a person the conversation just named.
export const PROPER_NOUN_WEIGHT = 2.5;

/**
 * A name found only in the BODY is worth less than one in the summary.
 *
 * The summary is curated — it is what the entry claims to be about. The body is
 * incidental: a person can be mentioned in passing in a memory that is really
 * about something else. Body evidence should be enough to make an entry
 * REACHABLE by that name, which is the entire point of tp5, without letting a
 * passing mention outrank an entry whose subject the name actually is.
 *
 * At 1.0 a body name is worth exactly one ordinary matched summary word: real
 * evidence, clearly subordinate to a summary name at 2.5.
 */
export const BODY_TERM_WEIGHT = 1.0;

/**
 * How many body-derived terms are kept per entry.
 *
 * Measured on the live professor_mari store (7441 entries, 2.5 MB index that is
 * re-read every turn): body-only names average 3.7 per entry and 99%+ of entries
 * have 9 or fewer, so 12 keeps essentially everything while bounding the worst
 * case. Cost is ~30 bytes/entry against a ~348 byte/entry baseline — about 9%
 * index growth. On the Erica corpus the cap costs 2 entries out of 96.
 */
export const MAX_BODY_TERMS = 12;

export const tokenize = (s: string): string[] =>
  s.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);

/**
 * Meaningful terms and their match weights.
 *
 * `skipFirstCapital` exists because a capital on the leading token of a SUMMARY
 * is just sentence case — "Statement about established knowledge" names nobody.
 * Bodies are prose that may open on a real name, so they do not skip it.
 */
export function weightedTerms(text: string, skipFirstCapital: boolean): Map<string, number> {
  const terms = new Map<string, number>();
  let seenWord = false;
  for (const rawToken of text.split(/\s+/)) {
    const bare = rawToken.replace(/[^\p{L}\p{N}]/gu, "");
    if (!bare) continue;
    const lower = bare.toLowerCase();
    const isName = (!skipFirstCapital || seenWord) && /^\p{Lu}/u.test(bare);
    seenWord = true;
    if (lower.length <= 2 || RELEVANCE_STOPWORDS.has(lower)) continue;
    const weight = isName ? PROPER_NOUN_WEIGHT : 1;
    terms.set(lower, Math.max(terms.get(lower) ?? 0, weight));
  }
  return terms;
}

export function summaryTerms(summary: string): Map<string, number> {
  return weightedTerms(summary, true);
}

/**
 * Names that appear in the body but NOT in the summary — the searchable residue
 * of an entry, stored on its index row so ranking can reach it without opening
 * the file.
 *
 * WHY NAMES ONLY. The loader ranks over the index precisely so it never has to
 * read 7441 entry files per turn, so whatever goes on the row has to stay small.
 * The measured failure is entity-shaped: of 96 entries whose bodies name
 * Erica/Cathmore, 59 were unreachable, and capitalisation is already the signal
 * the scorer privileges. Harvesting names recovers 42 of those 59. It is a
 * deliberate 80% fix, not a complete one — 15 remain unreachable because the
 * mention is never capitalised anywhere in the body, and those need the entity
 * and alias work (76aw), not a bigger term list.
 *
 * Terms already carried by the summary are dropped: they are matched from the
 * summary anyway, at the higher weight, and storing them twice would inflate
 * every row for nothing.
 */
export function harvestBodyTerms(content: string | undefined | null, summary: string): string[] {
  if (!content) return [];
  const inSummary = summaryTerms(summary);
  const found: string[] = [];
  for (const [term, weight] of weightedTerms(content, false)) {
    if (weight !== PROPER_NOUN_WEIGHT) continue; // names only — see above
    // A term the summary already scores AS A NAME is dropped: it matches from
    // the summary anyway, at the higher weight.
    //
    // But one the summary holds only as an ORDINARY word is kept, and that case
    // is not rare — it is the sentence-case blind spot. "Lara has borderline
    // personality disorder" puts the subject's own name in the leading position,
    // where the scorer must assume sentence case and demote it to weight 1.
    // Measured on the live store: 20% of character summaries open on a
    // capitalised token, and the samples are overwhelmingly the subject's name.
    // The body settles it — a capital MID-sentence there is a real name — so
    // keeping the term lets scoring restore the weight the summary could not.
    if (inSummary.get(term) === PROPER_NOUN_WEIGHT) continue;
    found.push(term);
    if (found.length >= MAX_BODY_TERMS) break;
  }
  return found;
}

/**
 * How much of a memory shows up in the recent conversation.
 *
 * Body terms are additive evidence at a lower weight, so an entry can now be
 * SUMMONED by a name it only ever mentions in passing — the miss-path that a
 * summary-only scorer structurally cannot serve.
 */
export function relevanceScore(
  summary: string,
  recentText: string,
  bodyTerms?: readonly string[],
): number {
  if (!recentText) return 0;
  const terms = summaryTerms(summary);
  if (terms.size === 0 && !bodyTerms?.length) return 0;
  const hay = new Set(tokenize(recentText));
  const confirmedNames = new Set(bodyTerms ?? []);
  let evidence = 0;
  for (const [term, weight] of terms) {
    if (!hay.has(term)) continue;
    // The body confirms a name the summary could only see as sentence case, so
    // the subject of "Lara has borderline personality disorder" is scored as the
    // name it is. Counted ONCE, at the name weight - not summed with the body
    // contribution, which would make a term in both sources beat a term the
    // summary is unambiguously about.
    evidence += confirmedNames.has(term) ? Math.max(weight, PROPER_NOUN_WEIGHT) : weight;
  }
  for (const term of confirmedNames) {
    // Body-only names: real evidence, deliberately subordinate to the summary,
    // so a passing mention becomes reachable without outranking the entry the
    // name is actually about.
    if (!terms.has(term) && hay.has(term)) evidence += BODY_TERM_WEIGHT;
  }
  if (evidence === 0) return 0;
  return 1 - Math.exp(-RELEVANCE_SATURATION * evidence);
}
