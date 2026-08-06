// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// DOES THIS CHUNK CONTAIN OUR OWN SYSTEM PROMPT? (pe4o)
//
// Measured 2026-08-06: 65 live records hold our own scaffolding as their SOURCE TEXT
// — 47 beats, 17 char-topics, one thread — and 47 of the 65 are dated 2026-08-05, the
// prompt-rewrite session. The channel is the review workflow itself: prompt text gets
// pasted into a Marinara chat, and the sidecar chunks, classifies, analyses and stores
// it as if it were conversation.
//
// This is also the ROOT of the bait rot (97z2). The boat example's probe became
// corroborable because the prompt CONTAINING it was ingested. Nobody discussed a boat.
//
// SIGNATURES ARE DERIVED FROM THE LIVE PROMPT, NEVER HAND-LISTED. A hand-maintained
// list of fragments rots the first time someone edits a prompt and forgets it — the
// same argument bait-warrant.test.ts makes for reading the built prompt rather than a
// curated array. Here it matters more, because the failure is silent: a stale
// signature does not error, it just stops catching.
//
// WHY LINE-LEVEL AND NOT PHRASE-LEVEL. The test is "does this chunk contain a whole
// line of our prompt", with a length floor. A person does not type 40 unbroken
// characters of our rule text by coincidence, but a person absolutely does say
// "reveals her vulnerability" — so short lines and quoted illustrations are excluded.
// Bait has its own detector (bait-tripwire.ts); this one is for scaffolding.

import { buildSystemPrompt } from "./analyzer.js";
import type { Emotion } from "./types.js";

const EMOTIONS: Emotion[] = [
  "fear", "shame", "hope", "desire", "relief",
  "vulnerability", "trust", "anger", "joy", "dysregulation",
];

/** Lines this long are structural prose; below it they are labels or examples. */
const MIN_SIGNATURE_LEN = 40;

const norm = (s: string): string => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

let cached: string[] | null = null;

/**
 * Distinctive lines of our own assembled prompts.
 *
 * Built from every emotion and both thread variants, so a chunk containing any
 * emotion's scaffolding is caught. Quoted illustration lines are dropped: they are
 * bait, they belong to the tripwire, and treating them as scaffolding would gate real
 * conversation that happens to quote a memory.
 */
export function ownPromptSignatures(): string[] {
  if (cached) return cached;
  const seen = new Set<string>();
  for (const e of EMOTIONS) {
    for (const hasThreads of [true, false]) {
      const prompt = buildSystemPrompt(e, e === "dysregulation" ? ["dissociation", "shutdown"] : [], hasThreads);
      for (const raw of prompt.split("\n")) {
        const line = norm(raw);
        if (line.length < MIN_SIGNATURE_LEN) continue;
        // A line that is only a quoted example is bait, not scaffolding.
        if (/^"[^"]*"(\s*\/\s*"[^"]*")*$/.test(line)) continue;
        seen.add(line);
      }
    }
  }
  // The user prompt's block headers are assembled elsewhere and are equally ours.
  for (const s of [
    "known characters (for the subject field):",
    "active threads (for the thread field):",
    "structural signals detected:",
  ]) seen.add(s);

  // docs/PROMPTS.md FURNITURE. The catalog is generated from these prompts and is the
  // artifact most likely to be pasted — it exists to be reviewed. A paste of it is
  // self-ingestion exactly like a paste of the prompt, but its per-section prose is
  // mostly CATALOG text rather than prompt text, so without these lines it scores
  // 7–17% and slips under the coverage threshold looking like conversation.
  // Templates, not content: they are stable strings in prompt-catalog.ts.
  for (const s of [
    "src/sentiment/analyzer.ts — buildsystemprompt()",
    "fires per salient chunk whose primary emotion is",
    "local model first, external api on failure.",
    "generated — do not edit by hand. regenerate with",
    "the prompts live as template literals across six files and are stitched together at",
  ]) seen.add(s);
  cached = [...seen];
  return cached;
}

/** Reset the memoised signatures. Tests only — the prompt does not change at runtime. */
export function resetSignatureCache(): void { cached = null; }

export interface SelfPromptHit {
  /** How many distinct prompt lines the chunk contained. */
  matches: number;
  /** Fraction of the chunk, by characters, that is our own prompt text. */
  coverage: number;
  /** The shortest match, for a human deciding whether the gate was right. */
  sample: string;
}

/**
 * Above this, the chunk IS our prompt. Below it, the chunk is something else that
 * quotes our prompt — which is ordinary shop talk and a real memory.
 *
 * SET FROM MEASUREMENT, not taste. Across the records the any-hit version caught:
 *   3%       "Read-only. Here's the smell, ranked — and the worst one is mine from
 *            today. I told an 8B model to do something it has no channel for. My
 *            prompt says..." — 2,242 characters of genuine analysis quoting one
 *            schema line. Real conversation. Killed outright by an any-hit gate.
 *   7–17%    docs/PROMPTS.md sections — our own generated catalog, pasted in.
 *   54–100%  the system prompt itself.
 *
 * The middle band is why the catalog's own furniture is registered as a signature
 * below: a PROMPTS.md paste is self-ingestion too, and without those lines it would
 * score like conversation and slip under the threshold.
 */
export const SELF_PROMPT_COVERAGE = 0.4;

/**
 * How much of this chunk is our own prompt scaffolding?
 *
 * ANY-HIT WAS THE WRONG PRIMITIVE (hjt9's ruling, applied). That ticket ruled the
 * routable unit is the partition and not the verdict, after a chunk scoring 0.64
 * ops-shaped turned out to be real conversation wrapped around a fenced code block:
 * "a chunk-level route would misfile all of it". The same is true here, and the first
 * version of this gate made exactly that mistake — it suppressed on a single matching
 * line, so 2kB of someone thinking out loud died for quoting a schema.
 *
 * Line-level partitioning is the eventual answer, but it does not apply yet: every
 * affected chunk in the store is a SINGLE LINE, so there is nothing to partition.
 * Coverage is the honest measure at this granularity.
 *
 * Deliberately requires a WHOLE normalised signature line. Substring matching would
 * creep toward gating ordinary sentences, and the cost of a false positive is a real
 * memory silently never recorded — strictly worse than the bug being fixed.
 */
export function detectSelfPrompt(text: string): SelfPromptHit | null {
  const hay = norm(text);
  if (hay.length < MIN_SIGNATURE_LEN) return null;

  const hits: string[] = [];
  const spans: [number, number][] = [];
  for (const sig of ownPromptSignatures()) {
    let from = 0;
    for (;;) {
      const at = hay.indexOf(sig, from);
      if (at < 0) break;
      spans.push([at, at + sig.length]);
      from = at + sig.length;
    }
    if (spans.length && hits[hits.length - 1] !== sig && hay.includes(sig)) hits.push(sig);
  }
  if (!hits.length) return null;

  // Merge overlapping spans so a doubled match cannot report >100%.
  spans.sort((a, b) => a[0] - b[0]);
  let covered = 0, end = -1;
  for (const [s, e] of spans) {
    if (s > end) { covered += e - s; end = e; }
    else if (e > end) { covered += e - end; end = e; }
  }

  hits.sort((a, b) => a.length - b.length);
  return { matches: hits.length, coverage: covered / hay.length, sample: hits[0]!.slice(0, 120) };
}
