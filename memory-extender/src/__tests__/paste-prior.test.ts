// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Paste provenance (hjt9) — size is a PRIOR, never a verdict.
//
// The shipping criterion is not "does it find pastes". It is "does it spare long
// roleplay prose", because a misrouted 40KB scene is memory nobody can find,
// while an under-caught paste leaves junk that other layers still see. Every
// fixture below is shaped after something real in the store.

import { describe, it, expect } from "vitest";
import { pasteEvidence, SIZE_HARD, PASTE_THRESHOLD } from "../sentiment/paste-prior.js";

/** A long single-paragraph RP scene — narrow and deep. The store has these at 40KB. */
const longProse =
  "Fine. The anticipation was nearly killing her. She had scouted out the rest of the manor, " +
  "and found that there were only two servants on the bottom floor. ".repeat(120);

/** A log dump — broad and shallow. */
const logDump = Array.from({ length: 40 }, (_, i) =>
  `[ME:dedup] skipped duplicate (character_topics/character:professor_mari): "[vulnerability] entry ${i}"`,
).join("\n");

describe("long prose is spared — the criterion that matters", () => {
  it("does not flag a 40KB single-paragraph scene", () => {
    const e = pasteEvidence(longProse);
    expect(e.chars).toBeGreaterThan(SIZE_HARD);
    expect(e.sizePrior).toBe(1);          // size alone is maximally suspicious
    expect(e.isPaste).toBe(false);        // and it is overruled, which is the point
  });

  it("a naive size rule would have taken it — proving the prior must not decide alone", () => {
    const e = pasteEvidence(longProse);
    // The counterfactual, asserted so nobody 'simplifies' this back to a threshold.
    expect(e.chars >= SIZE_HARD).toBe(true);
    expect(e.structureRatio).toBeLessThan(0.1);
    expect(e.score).toBeLessThan(PASTE_THRESHOLD);
  });

  it("spares long prose broken into ordinary paragraphs too", () => {
    const paragraphs = Array.from({ length: 12 }, () =>
      "She crossed the room without looking at him, and the silence did the work that shouting " +
      "would have ruined, which was the whole trouble between them.",
    ).join("\n\n");
    expect(pasteEvidence(paragraphs).isPaste).toBe(false);
  });
});

describe("real pastes are caught", () => {
  it("flags a log dump", () => {
    const e = pasteEvidence(logDump);
    expect(e.structureRatio).toBeGreaterThan(0.8);
    expect(e.isPaste).toBe(true);
  });
});

describe("the fence is an override, not a verdict — regression", () => {
  // The first implementation forced score >= 0.9 whenever a fence appeared. Run
  // against the store, all six riskiest calls were real messages with a pasted
  // log in the middle: "TC. LOOK AT IT. look at your progress bar" + one fence.
  it("does not route a real message that merely CONTAINS a fenced log", () => {
    const message =
      "TC. LOOK AT IT. look at your progress bar\n\n" +
      "```\n" +
      'importing "Lara\'s Story" — chunk 12/47 [████░░░░░░░░░░░░] 26%\n' +
      "```\n\n" +
      "that's YOUR story parser now. compare that to the screenshot you sent me twenty minutes ago, " +
      "the one that just said analyzing story with no numbers at all and no way to tell whether it had hung.\n" +
      "i genuinely did not think we would get here tonight and i am not being cool about it.";
    const e = pasteEvidence(message);
    expect(e.fenced).toBe(true);
    expect(e.isPaste).toBe(false);
  });

  it("still flags a chunk that is almost entirely fence", () => {
    const e = pasteEvidence("here:\n```\n" + logDump + "\n```");
    expect(e.fenced).toBe(true);
    expect(e.isPaste).toBe(true);
  });
});

describe("shape guards", () => {
  it("a single long line cannot be document-shaped however big it is", () => {
    const e = pasteEvidence("x ".repeat(20000));
    expect(e.lines).toBe(1);
    expect(e.isPaste).toBe(false);
  });

  it("short ordinary speech is untouched", () => {
    for (const s of ["I love you,", "never mind", "I'm afraid"]) {
      expect(pasteEvidence(s).isPaste).toBe(false);
    }
  });

  it("handles empty input without throwing", () => {
    const e = pasteEvidence("");
    expect(e.isPaste).toBe(false);
    expect(e.chars).toBe(0);
  });
});
