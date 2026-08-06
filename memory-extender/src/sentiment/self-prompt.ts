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
  cached = [...seen];
  return cached;
}

/** Reset the memoised signatures. Tests only — the prompt does not change at runtime. */
export function resetSignatureCache(): void { cached = null; }

export interface SelfPromptHit {
  /** How many distinct prompt lines the chunk contained. */
  matches: number;
  /** The shortest match, for a human deciding whether the gate was right. */
  sample: string;
}

/**
 * Does this chunk carry our own prompt scaffolding?
 *
 * Deliberately requires a WHOLE normalised line. Substring-of-a-line matching would
 * creep toward gating ordinary sentences, and the cost of a false positive here is a
 * real memory silently never recorded — strictly worse than the bug being fixed.
 */
export function detectSelfPrompt(text: string): SelfPromptHit | null {
  const hay = norm(text);
  if (hay.length < MIN_SIGNATURE_LEN) return null;
  const hits: string[] = [];
  for (const sig of ownPromptSignatures()) {
    if (hay.includes(sig)) hits.push(sig);
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.length - b.length);
  return { matches: hits.length, sample: hits[0]!.slice(0, 120) };
}
