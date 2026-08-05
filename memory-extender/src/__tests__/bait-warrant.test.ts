// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// EVERY EXAMPLE SHIPS WITH ITS ARREST WARRANT (Mari, 2026-08-05).
//
// The rule: an illustration must be concrete enough to teach format, absurd enough
// to self-flag, and its skeleton pre-registered in the echo ledger IN THE SAME
// COMMIT as the prompt. Bait that glows in the dark.
//
// WHY THIS IS A TEST AND NOT A CONVENTION. "Remember to add the skeleton when you
// change an example" is precisely the kind of net that depends on somebody
// remembering, which this project has ruled ADHD-hostile and which failed once
// already: pifl ran for 35 days and produced 669 stored echoes of a single
// sentence, because nothing in the pipeline could recognise the prompt's own words
// coming back. House law is PROMPT ASKS, CODE ENFORCES — so the enforcement is here.
//
// It reads the ACTUAL built prompt rather than a hand-maintained list, because a
// hand-maintained list rots the first time someone edits a prompt and forgets it.
// Add an uncovered illustration anywhere in the suite and this test fails.

import { describe, it, expect } from "vitest";
import { buildSystemPrompt, echoesAnExample } from "../sentiment/analyzer.js";

/** Quoted illustrations of 3+ words. Shorter quotes are schema tokens, not bait. */
function illustrationsIn(prompt: string): string[] {
  return [...new Set(
    [...prompt.matchAll(/"([^"\n]{10,120})"/g)]
      .map((m) => m[1]!.trim())
      .filter((s) => (s.match(/\s+/g) ?? []).length >= 2),
  )];
}

/**
 * KNOWN-UNCOVERED, and each entry is a live bug rather than an exemption.
 *
 * These are the THREAD rule's illustrations. The motivation rule was moved
 * off-planet on 2026-08-04; the thread rule was not, and still illustrates with
 * this store's own material. Measured 2026-08-05 (scripts/bait-audit.mjs):
 *   "jurisprudence soft launch"  -> 1 thread, 26 member beats, 0 corroborated
 *   "the Hargrove investigation" -> 1 thread,  7 member beats, 0 corroborated
 *   "Porsche test drive"         -> 4 threads, genuinely mixed; some real
 *
 * They are NOT simply added to PROMPT_EXAMPLE_ECHOES, and that restraint is the
 * point: that ledger gates MOTIVATIONS, so registering "Porsche test drive" there
 * would reject a real beat about a real Porsche — banning a true event from its own
 * store, which is the exact failure the escape hatch exists to prevent. Thread bait
 * needs its own ledger and its own guard at the thread-resolution site.
 *
 * This list must only ever SHRINK. Adding to it is filing a bug, not silencing one.
 */
const KNOWN_UNCOVERED = new Set([
  "Porsche test drive",
  "jurisprudence soft launch",
  "the Hargrove investigation",
]);

const EMOTIONS = [
  "fear", "shame", "hope", "desire", "relief",
  "vulnerability", "trust", "anger", "joy", "dysregulation",
] as const;

describe("every prompt illustration has an arrest warrant", () => {
  for (const emotion of EMOTIONS) {
    it(`${emotion}: no illustration ships uncovered by the echo ledger`, () => {
      const found = illustrationsIn(buildSystemPrompt(emotion, []));
      const uncovered = found.filter((ex) => !echoesAnExample(ex) && !KNOWN_UNCOVERED.has(ex));
      expect(uncovered, `uncovered bait in the ${emotion} prompt — register the skeleton in PROMPT_EXAMPLE_ECHOES in THIS commit`).toEqual([]);
    });
  }

  it("finds illustrations at all — a vacuous guard is worse than none", () => {
    // If a prompt refactor changes the quoting style, the extractor silently
    // matches nothing and every assertion above passes while guarding air.
    expect(illustrationsIn(buildSystemPrompt("fear", [])).length).toBeGreaterThanOrEqual(4);
  });

  it("the known-uncovered list contains nothing already covered", () => {
    // Once thread bait gets its own guard, its entries must leave this list rather
    // than linger and mask a future regression.
    const stale = [...KNOWN_UNCOVERED].filter((ex) => echoesAnExample(ex));
    expect(stale, "these are now covered — remove them from KNOWN_UNCOVERED").toEqual([]);
  });

  it("still recognises the sentence that caused all of this", () => {
    expect(echoesAnExample("admits she's afraid the memory loss means she was never real")).toBe(true);
  });
});
