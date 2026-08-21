// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// DOES THIS CHUNK CONTAIN PHYSICALLY INTIMATE CONTENT? (MarinaraExtender-5x5y)
//
// WHY THIS EXISTS. The analyzer prompt has asked for a `subtext` field since May,
// "only if the chunk contains sexual or physically intimate content". Measured across
// the whole 8,843-beat store against the only denominator that means anything — beats
// whose own source IS intimate — it has been emitted 11 times out of 1,574. 0.7%,
// peaking at 0.8% in June and never higher. It never worked.
//
// It never worked because NOTHING CHECKED. An optional field an 8b model emits at
// 0.7% is an advisory instruction, and house law is PROMPT ASKS, CODE ENFORCES. You
// cannot enforce "emit it when the content warrants" without a machine-readable
// answer to "does the content warrant it", and no such answer existed anywhere in the
// sentiment layer. The emotion lexicons are not a proxy: `desire` is about WANTING
// ("want", "crave", "longing", "hold me") and fires happily on a chunk about a
// sleep-debt ledger.
//
// ── THE ERRORS ARE NOT SYMMETRIC, AND THE DESIGN FOLLOWS FROM THAT ───────────
//
// FALSE POSITIVE — we declare a chunk intimate when it is not, enforcement demands a
//   subtext, and the model invents one. That is new pollution of exactly the kind
//   epf4 just cleaned up, filed as fact and retrievable forever.
// FALSE NEGATIVE — we miss one, no subtext is required, and we get today's behaviour.
//   Which is 0.7%. A miss costs nothing that is not already being lost.
//
// So this detector is deliberately HIGH PRECISION AND LOW RECALL. When it is unsure
// it says no. That is not timidity — it is the only setting where being wrong is
// cheap. Anything it misses, the prompt may still volunteer a subtext for; the
// detector governs where the field is REQUIRED, never where it is allowed.
//
// ── WHY TWO TIERS ────────────────────────────────────────────────────────────
//
// A single word list cannot do this. "kiss", "bare", "moan" and "naked" are genuinely
// intimate in one chat and entirely innocent in the next — a kiss on the forehead, a
// bare wire, a moan of frustration at a build failure. Convicting on any one of them
// is how a detector ends up firing on a debugging session.
//
// STRONG markers are terms with essentially no non-sexual reading in prose of this
// kind; one is enough. WEAK markers are individually ambiguous, so two must co-occur.
// This mirrors the coverage-over-any-hit ruling from the self-prompt gate (pe4o) and
// the chunk-vs-line family generally: one signal is an accident, a cluster is a fact.

/** Essentially unambiguous in prose. Any single hit convicts. */
const STRONG = [
  "nipple", "nipples", "clit", "clitoris", "cock", "pussy", "cunt",
  "penis", "vagina", "labia", "testicles", "balls deep",
  "orgasm", "orgasms", "orgasmed", "climaxed",
  "fucking me", "fucking you", "fucked me", "fucked you", "fuck me", "fuck you into",
  "penetrate", "penetration", "penetrated",
  "thrust", "thrusting", "thrusts",
  "blowjob", "going down on", "eating me out", "eating her out",
  "cum", "cumming", "came inside", "come inside me",
  "jerk off", "jerking off", "masturbat",
  "horny",
  "inside me", "inside you", "in me to the root",
];

/**
 * Individually ambiguous. TWO must co-occur before this convicts.
 *
 * Every one of these has an innocent reading and several have bitten a naive scan:
 * "bare" (a bare wire), "moan" (a build failure), "hard" (a hard problem), "wet"
 * (weather), "kiss" (a forehead).
 */
const WEAK = [
  // "aroused"/"arousal" were STRONG in the first cut and demoted after measuring:
  // they fire on clinical and analytical prose ("...folded Mari's physics into the
  // chore rotation..."), which is discussion, not intimacy. "horny" has no such
  // reading and stayed.
  "aroused", "arousal",
  "kiss", "kissed", "kissing", "kisses",
  "naked", "bare", "undress", "undressed", "stripped off",
  "moan", "moaned", "moaning", "whimper", "whimpered", "gasp", "gasped",
  "straddle", "straddled", "grind", "grinding", "writhe",
  "nipple",  // also strong; harmless duplication keeps the lists independently readable
  "breast", "breasts", "thigh", "thighs", "hips",
  "tongue", "lips", "mouth on", "teeth on",
  "shudder", "shuddered", "trembling", "panting",
  "skin against", "against my skin", "body against",
  "in bed", "on the bed", "sheets",
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary match, except for markers already ending in a stem (e.g. "masturbat")
 * where a trailing boundary would defeat the point.
 */
function hits(haystack: string, needles: string[]): string[] {
  const found: string[] = [];
  for (const n of needles) {
    const stem = /[a-z]$/.test(n) && n.length >= 8 && !n.includes(" ");
    const re = new RegExp(stem ? `\\b${escapeRe(n)}` : `\\b${escapeRe(n)}\\b`, "i");
    if (re.test(haystack)) found.push(n);
  }
  return found;
}

export interface IntimacyVerdict {
  intimate: boolean;
  /** Which markers fired — the evidence, so a wrong call is diagnosable. */
  strong: string[];
  weak: string[];
}

/**
 * THE WEAK TIER DOES NOT VOTE, AND THAT IS A MEASURED DECISION — not a stub.
 *
 * The first cut convicted on two weak markers. Measured across all 8,859 stored
 * beats, that tier added **298 hits** on top of the 1,361 strong ones, and reading a
 * sample of them put its precision near **40%**: it fired on "we've been in bed
 * talking about polyamory and memory systems and GDPR", on a pasted telemetry line
 * (`cache write 16,717 · 12.4s`), on a director's stage note, and on "pulling her
 * knees up to make space".
 *
 * What it bought: **3** additional beats out of the 17 the model itself thought
 * warranted a subtext. Three true catches for roughly 180 false demands, on the side
 * of the asymmetry where being wrong manufactures a fabricated subtext.
 *
 * So weak markers are still COLLECTED — they are useful evidence when a call has to
 * be explained, and they are what a future recall push would tune — but they do not
 * decide. Anyone raising the tier back into the verdict should re-run
 * `scripts/intimacy-scan.mjs --weak-only` and read the hits first; the numbers above
 * are the bar to beat, not folklore.
 */
export function classifyIntimacy(text: string): IntimacyVerdict {
  const s = String(text ?? "");
  if (!s.trim()) return { intimate: false, strong: [], weak: [] };
  const strong = hits(s, STRONG);
  const weak = [...new Set(hits(s, WEAK))];
  return { intimate: strong.length >= 1, strong, weak };
}

/** Convenience for call sites that only need the boolean. */
export function isIntimate(text: string): boolean {
  return classifyIntimacy(text).intimate;
}
