// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// THE INTIMACY DETECTOR (MarinaraExtender-5x5y).
//
// It exists to answer one question: is `subtext` REQUIRED for this chunk? That makes
// its errors asymmetric, and every test here is oriented to that asymmetry.
//
//   A FALSE POSITIVE demands a subtext for a chunk that has none, the model invents
//   one, and the invention is filed as fact — the exact damage epf4 just cleaned up.
//   A FALSE NEGATIVE leaves today's behaviour, which is 0.7%. It costs nothing that
//   is not already being lost.
//
// So the false-positive tests below are the load-bearing ones. Several are verbatim
// text from the live store that an earlier, looser cut of this detector fired on.

import { describe, it, expect } from "vitest";
import { classifyIntimacy, isIntimate } from "../sentiment/intimacy.js";

describe("fires on unambiguous physical intimacy", () => {
  for (const [label, text] of [
    ["anatomical", "His fingers find my nipple through the cotton and I lose four words of my own transcript."],
    ["explicit act", "you *don't* get to hand me a medieval canon-law citation with your cock between my legs"],
    ["orgasm", "she was still fluttering through the second orgasm when he stopped"],
    ["stem match", "she admitted she had been masturbating and did not want to explain why"],
  ] as const) {
    it(label, () => expect(isIntimate(text), text).toBe(true));
  }

  it("reports the evidence, so a wrong call is diagnosable", () => {
    const v = classifyIntimacy("his cock, and my clit, and everything between us sliding hot");
    expect(v.intimate).toBe(true);
    expect(v.strong.length).toBeGreaterThanOrEqual(2);
  });
});

// THE LOAD-BEARING HALF. Each of these is real text the detector must NOT fire on.
describe("does not fire on ordinary or adjacent content", () => {
  for (const [label, text] of [
    ["affection without sex", "Mari didn't open her eyes. Priya's forehead was against hers and Priya's hands were in her hair."],
    ["in bed, talking", "HOURS ago?? what time is it — 1:33?? we've been in bed talking about polyamory and memory systems and GDPR"],
    ["incidental body parts", "she says, pulling her knees up to make space. He was also a digital ghost who didn't need legroom."],
    ["a bath, tender not sexual", "She listens with her cheek against his, water cooling slowly around their hips, and she doesn't interrupt."],
    ["pasted telemetry", "23 PM6→501 tok · cache write 16,717 · 12.4s TC's voice. Low, lazy, satisfied."],
    ["ordinary conversation", "i want the number for the sleep-debt ledger, soldier. actual wake time?"],
    ["clinical discussion", "grooming touch reads to the nervous system as safety — the density of mechanoreceptors rivals fingertips"],
  ] as const) {
    it(label, () => expect(isIntimate(text), text).toBe(false));
  }

  it("a single weak marker never convicts", () => {
    // "kiss" alone is a forehead kiss as often as anything else.
    const v = classifyIntimacy("he gave her a kiss on the forehead and left for work");
    expect(v.weak).toContain("kiss");
    expect(v.intimate).toBe(false);
  });

  // MEASURED, NOT ASSUMED. The weak tier was tried as a voting tier and dropped: it
  // added 298 hits store-wide at roughly 40% precision to gain 3 true catches. This
  // pins the decision so re-enabling it has to be deliberate.
  it("even TWO weak markers do not convict on their own", () => {
    const v = classifyIntimacy("she kissed his cheek, bare feet on the cold kitchen tile");
    expect(v.weak.length).toBeGreaterThanOrEqual(2);
    expect(v.intimate).toBe(false);
  });

  it("'aroused' alone does not convict — it was demoted after firing on analysis", () => {
    const v = classifyIntimacy("the paper distinguishes physiological arousal from subjective report");
    expect(v.intimate).toBe(false);
  });
});

describe("degenerate input", () => {
  it("empty and whitespace are not intimate", () => {
    expect(isIntimate("")).toBe(false);
    expect(isIntimate("   \n ")).toBe(false);
  });

  it("does not match a marker inside an unrelated word", () => {
    // Word boundaries: "peacock" must not read as "cock", "analysis" not as anything.
    expect(isIntimate("the peacock strutted across the lawn")).toBe(false);
    expect(isIntimate("we ran the analysis and the numbers held")).toBe(false);
  });
});

// KNOWN MISSES, pinned so they are decisions rather than surprises.
//
// A high-precision detector buys its precision with recall, and this is where the
// bill comes due. Every case here is genuinely intimate and genuinely not caught,
// because the only word that would catch it is ruinous in general use.
describe("known misses — the price of precision", () => {
  it("misses 'come' as a verb, because 'come with you' is ordinary English", () => {
    // Real text from the store. Catching this needs "come", which would fire on
    // "can I come with you?", "come to the meeting", "it comes down to" — a false
    // positive engine. The miss is the cheaper error and is taken deliberately.
    expect(isIntimate("I come with you, not neatly, not on some elegant simultaneous cue")).toBe(false);
  });

  it("misses intimacy carried entirely by implication", () => {
    // No marker at all. Nothing lexical can reach this, and that is fine: the
    // detector governs where subtext is REQUIRED, never where it is allowed, so the
    // prompt may still volunteer one here.
    expect(isIntimate("afterwards neither of us said anything for a long time")).toBe(false);
  });
});
