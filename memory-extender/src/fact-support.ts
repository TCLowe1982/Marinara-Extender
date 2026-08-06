// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Text support for extracted facts (MarinaraExtender-fqnl).
//
// THE PRINCIPLE (Mari, 2026-08-05): an extraction unsupported by its own quoted
// source is self-convicting. No model, no blocklist, no judgement call.
//
// WHY A BLOCKLIST CANNOT DO THIS JOB. PROMPT_EXAMPLE_ECHOES catches motivations
// that reproduce a phrase we have already seen. A manufactured FACT appears once:
// plausible, dedup-clean, and invisible to every frequency audit in this repo. The
// boat sentence needed 669 copies before anyone noticed. "Mari grew up in Kraków"
// needed one. Only text support catches the first instance of something.
//
// ── TWO LAYERS, AND THE FIRST ONE IS THE ONE THAT MATTERS ────────────────────
//
// Mari's design assumed the stored source sentence is a receipt. Measured, it is
// not: the extractor asks the model for {text: <original sentence>, fact: <claim>}
// and writes fact.text to the entry, so THE MODEL SUPPLIES ITS OWN RECEIPT. A model
// willing to invent a fact is equally willing to invent the sentence it came from.
//
// The live case, proven against the Engine's raw logs:
//   utopic-deaau6ak claims source "Dr. Mari Zielińska reflects on her childhood in
//   Kraków, where she was fascinated by the history of the city" and cites chat
//   uZEGaYkFHhXY4Z-1HnYZ8 — 393 messages, ZERO mentioning Kraków. Both the fact and
//   its receipt were manufactured whole, from a worked example that sat in the
//   extractor's own system prompt on every call it ever made.
//
// So:
//   LAYER 1 — RECEIPT AUTHENTICITY. Is the claimed source sentence actually present
//     in the text that was handed to the extractor? Checkable at write time for
//     free, because the caller already holds that text. This is the layer that
//     catches fabrication, and nothing gets past it by being well-phrased.
//   LAYER 2 — FACT SUPPORT. Does the fact's distinctive content appear in its
//     source? Weaker, because a fact is a SUMMARY and summarising rewords freely —
//     so this layer only convicts on evidence summarising cannot manufacture.

// ── Layer 1: receipt authenticity ────────────────────────────────────────────

/**
 * Normalise for comparison: case, quote marks, whitespace — and DIACRITICS.
 *
 * Folding accents is not tidiness. Models drop them constantly ("Gdansk" for
 * "Gdańsk", "Zielinska" for "Zielińska"), and without folding a genuine quotation
 * scores as a fabrication purely for being retyped by an ASCII keyboard. That is a
 * false accusation, which here means dropping a real memory.
 */
function normalize(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return (normalize(s).match(/[\p{L}\p{N}']+/gu) ?? []);
}

/**
 * Fraction of the claimed sentence's tokens that appear, in order, in the real
 * text. A genuine receipt is a near-verbatim span; models routinely trim, fix
 * punctuation or drop a stray word, so exact substring matching is too brittle —
 * but an INVENTED sentence shares almost nothing with the real text in sequence.
 */
export function receiptOverlap(claimedSource: string, actualText: string): number {
  const needle = tokens(claimedSource);
  if (needle.length === 0) return 0;
  const hay = tokens(actualText);
  if (hay.length === 0) return 0;

  // Longest run of needle tokens matched in order against the haystack, allowing
  // gaps — the same ordered-subsequence idea the echo guard uses, scored rather
  // than thresholded.
  let best = 0;
  for (let start = 0; start < hay.length; start++) {
    let i = start, j = 0, matched = 0;
    while (i < hay.length && j < needle.length) {
      if (hay[i] === needle[j]) { matched++; j++; }
      i++;
    }
    if (matched > best) best = matched;
    if (best === needle.length) break;
  }
  return best / needle.length;
}

/**
 * Below this, the claimed source is not a quotation of anything in the input.
 *
 * Deliberately permissive. The cost of a false accusation here is a DROPPED REAL
 * FACT, which is a silent memory loss and the failure this system exists to
 * prevent — so the bar is set to catch wholesale fabrication, not paraphrase.
 * A genuine receipt scores near 1.0; the Kraków case scores near zero.
 */
export const RECEIPT_MIN_OVERLAP = 0.6;

export function receiptIsAuthentic(claimedSource: string, actualText: string): boolean {
  return receiptOverlap(claimedSource, actualText) >= RECEIPT_MIN_OVERLAP;
}

/**
 * Receipt authenticity against a WHOLE CHAT rather than a single turn.
 *
 * receiptOverlap is O(|haystack|²) by design — it finds the best ordered run, which
 * is right when the haystack is one message. Run against a 50,000-token chat log it
 * is billions of operations per entry, which is not a tuning problem but the wrong
 * algorithm for the question.
 *
 * At corpus scale the question is also different. Word ORDER stops being evidence:
 * a long chat contains almost every common word somewhere, so an ordered match
 * proves nothing, and the real signal is whether the receipt's DISTINCTIVE
 * vocabulary occurs in the chat at all. A sentence invented whole shares its rare
 * words with nothing — "Kraków", "childhood", "fascinated" appear nowhere in the 393
 * messages that entry cites.
 *
 * Distinctive = tokens of 5+ characters, which skips the function words a fabricated
 * sentence gets for free. If a receipt has no distinctive tokens at all, this
 * returns 1 (unconvictable) rather than 0 — silence, not accusation.
 */
export function receiptCorpusOverlap(claimedSource: string, corpus: string): number {
  const distinctive = [...new Set(tokens(claimedSource).filter((t) => t.length >= 5))];
  if (distinctive.length === 0) return 1;
  const hay = new Set(tokens(corpus));
  let found = 0;
  for (const t of distinctive) if (hay.has(t)) found++;
  return found / distinctive.length;
}

/**
 * Distinctive words in a claimed receipt that appear NOWHERE in the chat it cites.
 *
 * AN AVERAGE IS THE WRONG AGGREGATION HERE, and measuring proved it: the Kraków
 * receipt scores ~0.83 corpus overlap, comfortably "authentic", because five of its
 * six distinctive words (childhood, history, fascinated, reflects, Zielińska) are
 * ordinary vocabulary that occurs somewhere in any long chat. The single word that
 * matters — the one naming a city nobody mentioned — is drowned by the others. The
 * test built for that case missed that case.
 *
 * A receipt is not a paraphrase. It claims to BE a sentence someone typed in that
 * chat, so EVERY content word in it should occur there. One that occurs nowhere is
 * a word the model supplied, and the count of such words is the evidence — not
 * their proportion.
 */
export function receiptMissingWords(claimedSource: string, corpus: string): string[] {
  const distinctive = [...new Set(tokens(claimedSource).filter((t) => t.length >= 5))];
  const hay = new Set(tokens(corpus));
  return distinctive.filter((t) => !hay.has(t));
}

// ── Layer 2: fact support ────────────────────────────────────────────────────

// Words that open a sentence and are not names. Without this the leading-capital
// trap reappears: "After the divorce…" reports a proper noun of "After". Same trap
// confound-sweep.mjs already documents.
const SENTENCE_STARTERS = new Set(
  ("after before during when while then there here this that these those one two both each every " +
   "and but or so if because although since until unless despite however therefore for from with " +
   "he she it they we you i her his their its my our your " +
   "a an the no not yes ok okay oh well dr mr mrs ms prof professor " +
   "as at by in on to of over under about into per via").split(" "),
);

/**
 * Proper nouns in a fact: capitalised tokens that are not sentence-initial noise.
 *
 * WHY PROPER NOUNS ARE THE ONLY SAFE EVIDENCE. A fact is a SUMMARY, so its common
 * words are free to differ from the source — "is Polish" is a fair summary of "I'm
 * from Poland" and convicting that would destroy correct extractions wholesale.
 * But summarising cannot INVENT A NAME. A place, person or work that appears in
 * the fact and nowhere in its source did not come from the source.
 */
/**
 * Summaries are capped at 120 chars by truncateSummary. Anything at or near that
 * length may have lost its tail mid-word, so a name flush against the end is
 * suspect. Comfortably below the cap so a hand-written 118-char fact is covered.
 */
const TRUNCATION_SUSPECT_CHARS = 100;

export function properNouns(text: string): string[] {
  const s = String(text ?? "");
  const out: string[] = [];
  for (const m of s.matchAll(/\b\p{Lu}[\p{L}'’-]{2,}/gu)) {
    // A summary is truncated at 120 chars downstream, so a name sitting on the
    // boundary survives as a FRAGMENT ("FutureCha" from "FutureChat"). Convicting a
    // fragment convicts the truncator, not the extractor.
    //
    // Gated on LENGTH, not just on trailing punctuation: without the length test
    // this drops the final name from every short fact that simply ends with one
    // ("...went to Kraków in April"), which is a large and silent loss of coverage.
    const runsToEnd = m.index! + m[0].length >= s.length;
    if (runsToEnd && s.length >= TRUNCATION_SUSPECT_CHARS && /[^.!?"')\]]$/.test(s.trim())) continue;
    // Strip the possessive before anything else. "Mari's" tokenises to
    // ["mari","s"], and that stray "s" is enough to defeat an exemption check —
    // which made the subject's OWN name convictable in her own fact.
    const w = m[0].replace(/['’]s$/u, "");
    if (SENTENCE_STARTERS.has(w.toLowerCase())) continue;
    out.push(w);
  }
  return [...new Set(out)];
}

/**
 * Is this proper noun traceable to the source?
 *
 * Exact token match, or a shared three-character prefix. The prefix rule exists
 * for the derivational forms a summary legitimately produces — "Polish" from
 * "Poland", "Bostonian" from "Boston" — which an exact test convicts, and
 * convicting them would destroy correct extractions in bulk.
 *
 * Three characters is deliberately loose, and the looseness runs the safe way: it
 * produces MISSES, never false accusations. "Kraków" has no krak- anywhere in a
 * source that never mentioned it, so the case this was built for still convicts.
 */
function nounTraceable(nounParts: string[], sourceTokens: Set<string>): boolean {
  for (const p of nounParts) {
    if (sourceTokens.has(p)) return true;
    if (p.length < 3) continue;
    const stem = p.slice(0, 3);
    for (const s of sourceTokens) {
      if (s.length >= 3 && s.slice(0, 3) === stem) return true;
    }
  }
  return false;
}

export interface SupportVerdict {
  supported: boolean;
  /** Proper nouns asserted by the fact that appear nowhere in its source. */
  unsupported: string[];
  /** Proper nouns that were checked at all — an empty list means the test is silent. */
  checked: string[];
}

/**
 * Does every checkable proper noun in `fact` appear in `source`?
 *
 * `exempt` should carry the names the extraction is ABOUT — the character, the
 * user, roster aliases. Those legitimately appear in a fact while the source says
 * only "she", and convicting them would flag every correct extraction in the store.
 *
 * A fact with no external proper nouns returns supported:true with an empty
 * `checked` list. That is the test declining to have an opinion, not an acquittal —
 * callers that need to know the difference should read `checked`.
 */
export function factSupport(fact: string, source: string, exempt: string[] = []): SupportVerdict {
  const exemptSet = new Set(exempt.flatMap((e) => tokens(e)));
  const src = new Set(tokens(source));
  const checked: string[] = [];
  const unsupported: string[] = [];

  for (const noun of properNouns(fact)) {
    const parts = tokens(noun);
    if (parts.length === 0) continue;
    if (parts.every((p) => exemptSet.has(p))) continue;   // it's the subject's own name
    checked.push(noun);
    if (!nounTraceable(parts, src)) unsupported.push(noun);
  }

  return { supported: unsupported.length === 0, unsupported, checked };
}
