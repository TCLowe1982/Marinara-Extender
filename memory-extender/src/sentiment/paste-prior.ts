// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Paste provenance — the half of ops/meta routing that regex cannot do (hjt9).
//
// ⚠ NOT WIRED IN, AND IT CLASSIFIES ONLY. Nothing here deletes or drops. The
// answer routes to the ops lane, marked and greppable forever.
//
// WHY PROVENANCE AND NOT CONTENT. code-filter.ts takes the code-SHAPED half at
// high precision, and measurement confirmed it: 1.0% of the store, 8/8 genuine.
// But it caught 3 echoes against 864 still in the prose bucket. "insists the boat
// was green" has no braces to detect — it is grammatical English wearing a lab
// coat, and content-wise it IS conversation. No content-level test will ever
// separate it from speech, because there is nothing to separate.
//
// The only honest signal left is HOW IT ARRIVED. A 6KB message landing in one
// tick is a paste; no human types that in a breath.
//
// SIZE IS A PRIOR, NOT A VERDICT, and the word is load-bearing. Long roleplay
// prose is also 6KB — a novel-length scene is exactly what this system exists to
// remember, and a naive size threshold would route the best memories in the store
// into an ops lane. So size only raises suspicion, and structure has to
// corroborate it. A prior times a likelihood, never a prior alone.
//
// The discriminator, stated plainly: a paste is BROAD AND SHALLOW — many lines,
// most of them short, structure everywhere. RP prose is NARROW AND DEEP — few
// lines, each long, structure nowhere. Both are big. Only one is shaped like a
// document.
//
// HOUSE LAW — A NET THAT DEPENDS ON REMEMBERING TO TAG IS ADHD-HOSTILE. The fence
// is an OVERRIDE that raises confidence when present, never the dependency. Every
// threshold below does its work on unmarked text.

import { classifyShape } from "./code-filter.js";

export interface PasteEvidence {
  /** An explicit ``` fence was present — the override, not the requirement. */
  fenced: boolean;
  chars: number;
  lines: number;
  medianLineLen: number;
  /** Lines under SHORT_LINE chars, as a fraction. Documents are full of them; prose is not. */
  shortLineRatio: number;
  /** Fraction of lines that are structurally non-prose (code-filter). */
  structureRatio: number;
  /** 0–1 suspicion from size alone. Never decides anything by itself. */
  sizePrior: number;
  /** 0–1 posterior. */
  score: number;
  isPaste: boolean;
  signals: string[];
}

// ── Calibration ───────────────────────────────────────────────────────────────
// Set from the store, not from intuition — see scripts/paste-scan.mjs.

/** Below this, size contributes nothing. Matches LONG_USER_MSG_CHARS, the existing long-form trip. */
export const SIZE_SOFT = 1500;
/** At/above this, the size prior is saturated. Mari's "6KB in one tick". */
export const SIZE_HARD = 6000;
/** A line shorter than this reads as a row, not a sentence. */
export const SHORT_LINE = 40;
/** Posterior at/above which a chunk routes to the ops lane. */
export const PASTE_THRESHOLD = 0.6;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Weigh the evidence that this chunk arrived as a paste rather than as speech.
 *
 * The three terms are deliberately unequal. STRUCTURE carries the most weight
 * because it is the only one that a long, sincere, hand-written message cannot
 * accidentally satisfy. SIZE carries least, because on its own it describes the
 * best memories in the store as well as the worst.
 */
export function pasteEvidence(text: string): PasteEvidence {
  const s = String(text ?? "");
  const rawLines = s.split(/\r?\n/);
  const nonEmpty = rawLines.filter((l) => l.trim());
  const lens = nonEmpty.map((l) => l.trim().length);

  const fenced = /^\s*(?:```|~~~)/m.test(s);
  const shape = classifyShape(s);

  const chars = s.length;
  const sizePrior = chars <= SIZE_SOFT
    ? 0
    : Math.min(1, (chars - SIZE_SOFT) / (SIZE_HARD - SIZE_SOFT));

  const shortLineRatio = nonEmpty.length === 0
    ? 0
    : nonEmpty.filter((l) => l.trim().length < SHORT_LINE).length / nonEmpty.length;

  // A single-line chunk cannot be broad-and-shallow no matter how long it is;
  // it is one paragraph, which is what prose looks like. Without this guard a
  // 6KB unbroken RP monologue scores on size alone.
  const documentShaped = nonEmpty.length >= 4;

  const signals: string[] = [];
  if (fenced) signals.push("fence");
  if (sizePrior > 0) signals.push(`size:${chars}`);
  if (documentShaped && shortLineRatio >= 0.5) signals.push("short-lines");
  if (shape.lineRatio >= 0.25) signals.push(...shape.signals.slice(0, 3));

  let score = 0;
  if (documentShaped) {
    score = 0.45 * shape.lineRatio + 0.35 * sizePrior + 0.20 * shortLineRatio;
  } else {
    // Not document-shaped: only hard structural evidence counts.
    score = 0.45 * shape.lineRatio;
  }
  // NO BLANKET FENCE OVERRIDE — and this was a real bug, caught by measurement.
  //
  // The first version did `if (fenced) score = max(score, 0.9)`, on the reasoning
  // that a fence is the author declaring a paste. Run against the store, all six
  // of the riskiest calls were Mari's own messages: "TC. LOOK AT IT. look at your
  // progress bar" wrapped around a pasted log, scored 0.90 and routed whole.
  //
  // A fence says THESE LINES are a paste. It says nothing about the message
  // around them, and "Thomas pasted the bench and Mari amended her ruling live"
  // is a true event that lives in that surrounding prose. partitionProse already
  // marks fenced lines as dropped, so their weight reaches the score through
  // shape.lineRatio — IN PROPORTION to how much of the chunk they are, which is
  // the honest contribution. A chunk that is nearly all fence still scores high;
  // a paragraph with three lines of log in it no longer does.

  return {
    fenced,
    chars,
    lines: nonEmpty.length,
    medianLineLen: median(lens),
    shortLineRatio,
    structureRatio: shape.lineRatio,
    sizePrior,
    score,
    isPaste: score >= PASTE_THRESHOLD,
    signals,
  };
}
