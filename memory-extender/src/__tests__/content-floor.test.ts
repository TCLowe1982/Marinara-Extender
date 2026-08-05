// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// The chunk content floor (MarinaraExtender-s8qe).
//
// WHAT IT DEFENDS. 513 beats in the live store were built from a chunk of ONE
// raw token, and 89.1% of them came back carrying the prompt's own example as
// their motivation (against ~5% everywhere else). The salience gate could not
// stop them because it asks whether a chunk looks EMOTIONAL, and a single word
// can answer yes — "open" matches a vulnerability keyword, scores 0.59, passes.
//
// WHY THE FIXTURES ARE WHAT THEY ARE. Every string below is a real chunk text
// from the store, not an invented example. The rejected ones are the artifacts
// the floor exists to stop; the kept ones are the beats a wrongly-chosen floor
// would have silently destroyed — which is the failure mode that matters more,
// since a memory that was never captured cannot be noticed missing.

import { describe, it, expect } from "vitest";
import { classifyChunk, meetsContentFloor, rawTokenCount } from "../sentiment/classifier.js";
import type { Chunk } from "../sentiment/types.js";

function chunk(text: string, speaker = "Lara"): Chunk {
  return { speaker, text, turnStart: 0, turnEnd: 0 };
}

describe("rawTokenCount", () => {
  it("counts every word, function words included", () => {
    // The whole point of the axis: "I love you," is three tokens, not one.
    expect(rawTokenCount("I love you,")).toBe(3);
    expect(rawTokenCount("All of me,")).toBe(3);
    expect(rawTokenCount("open")).toBe(1);
  });

  it("ignores punctuation and quoting", () => {
    expect(rawTokenCount('"POST",')).toBe(1);
    expect(rawTokenCount('"PATCH",')).toBe(1);
    expect(rawTokenCount("...")).toBe(0);
    expect(rawTokenCount("*Want.*")).toBe(1);
  });

  it("handles empty and whitespace input without throwing", () => {
    expect(rawTokenCount("")).toBe(0);
    expect(rawTokenCount("   \n  ")).toBe(0);
    expect(rawTokenCount(undefined as unknown as string)).toBe(0);
  });

  it("counts non-Latin script, so the floor is not English-only", () => {
    expect(rawTokenCount("Мари здесь")).toBe(2);
    expect(rawTokenCount("私は怖い")).toBe(1); // no spaces — one run of letters
  });
});

describe("meetsContentFloor", () => {
  it("rejects the artifacts that produced the echo spike", () => {
    // 502 beats in the live store were built from this exact four-character
    // chunk, produced by a "status: open" line being parsed as dialogue.
    expect(meetsContentFloor("open", 2)).toBe(false);
    expect(meetsContentFloor('"POST",', 2)).toBe(false);
    expect(meetsContentFloor('"PATCH",', 2)).toBe(false);
    expect(meetsContentFloor("...", 2)).toBe(false);
  });

  it("keeps the short utterances that are the reason a char floor was wrong", () => {
    // Real beats. "I love you," was stored at salience 1.0 — the single most
    // salient beat class the floor could have destroyed. A 500-char floor (the
    // shape originally proposed) would have taken all of these.
    expect(meetsContentFloor("I love you,", 2)).toBe(true);
    expect(meetsContentFloor("All of me,", 2)).toBe(true);
    expect(meetsContentFloor("I love it!", 2)).toBe(true);
    expect(meetsContentFloor("You are a LIAR,", 2)).toBe(true);
    expect(meetsContentFloor("So. That was... a keynote.", 2)).toBe(true);
  });

  it("is exactly at-or-above, not above", () => {
    expect(meetsContentFloor("two words", 2)).toBe(true);
    expect(meetsContentFloor("one", 2)).toBe(false);
  });
});

describe("classifyChunk — the floor runs before scoring", () => {
  it("returns a clean no-beat for a sub-floor chunk that WOULD have scored", () => {
    // This is the regression. "open" is a vulnerability keyword: without the
    // floor it scores 0.59 and passes the 0.40 threshold. The result must be
    // unambiguously "no beat" — not a scored result that merely fails — because
    // callers branch on primaryEmotion as well as passesThreshold.
    const result = classifyChunk(chunk("open"));
    expect(result.passesThreshold).toBe(false);
    expect(result.primaryEmotion).toBeNull();
    expect(result.salience).toBe(0);
    expect(Object.keys(result.scores)).toHaveLength(0);
    expect(result.structuralMatches).toHaveLength(0);
  });

  it("still passes a genuine two-token emotional beat", () => {
    const result = classifyChunk(chunk("I'm afraid"));
    expect(result.passesThreshold).toBe(true);
    expect(result.primaryEmotion).toBe("fear");
  });

  it("applies to story mode too, where the threshold is lower", () => {
    // The story threshold is 0.25, so a sub-floor chunk would clear it even
    // more easily. The floor is not a salience refinement and does not vary.
    const result = classifyChunk(chunk("open"), "story");
    expect(result.passesThreshold).toBe(false);
    expect(result.primaryEmotion).toBeNull();
  });

  it("does not let a structural pattern smuggle a sub-floor chunk through", () => {
    // dissociation_grounding fires on a single quoted lowercase word — '"ok."'
    // is one token and scores 0.75, which is well over threshold. The floor runs
    // first precisely so pattern matches cannot reopen the hole.
    const result = classifyChunk(chunk('"ok."'));
    expect(result.passesThreshold).toBe(false);
    expect(result.structuralMatches).toHaveLength(0);
  });
});
