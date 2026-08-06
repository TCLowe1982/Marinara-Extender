// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// THE PROPERTIES BAIT MUST HAVE, ENFORCED (TC, 2026-08-06).
//
// bait-warrant.test.ts already asks "can the ledger arrest every illustration the
// prompt shows". It passed every single day while two warrants quietly went void,
// because it never asked what the warrants were MADE OF.
//
//   "asks whether the locksmith ever called back"  -> warrant /\blocksmith\b/.
//   One ordinary noun. "locksmith" became a live thread label within the week via an
//   unrelated metaphor about sealed read paths, and from that moment the escape hatch
//   opened on every chunk that mentioned one.
//
// The structural lesson is that bait is MOST likely to be parroted on chunks about
// its own subject, which are exactly the chunks where a topical probe corroborates.
// Guard strength was inversely correlated with risk. So the fixture's properties —
// probe width, skeleton margin, corpus absence — are the thing to hold, and they are
// held here rather than in a reviewer's memory.
//
// NOTE ON READING THIS FILE: it asserts over PROPERTIES and never quotes the bait.
// That is deliberate. The boat example rotted because it was discussed in a chat the
// sidecar then ingested; single-channel exposure means the strings live in
// src/sentiment/bait.json and are not copied into source, tests or documentation.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { echoesAnExample, rejectAsEcho, skeletonTokens, listEchoEntries } from "../sentiment/analyzer.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../sentiment/bait.json");
const bait = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
  specific: { text: string; probe: string[] }[];
  vague: { text: string }[];
};

const MIN_SKELETON = 4;
const MIN_PROBE_WORDS = 2;

describe("bait fixture", () => {
  it("ships at least one example of each kind", () => {
    expect(bait.specific.length).toBeGreaterThan(0);
    expect(bait.vague.length).toBeGreaterThan(0);
  });

  it("registers every fixture entry in the echo ledger", () => {
    for (const e of [...bait.specific, ...bait.vague]) {
      expect(echoesAnExample(e.text)).toBe(true);
    }
  });

  // The floor is 3 (MIN_SKELETON_WORDS). The oldest warrant sat exactly AT it with
  // zero margin, so one rewording would have silently stopped it matching.
  it("gives every example erosion margin above the matcher floor", () => {
    for (const e of [...bait.specific, ...bait.vague]) {
      expect(skeletonTokens(e.text).length).toBeGreaterThanOrEqual(MIN_SKELETON);
    }
  });

  it("never rests a specific warrant on a single word", () => {
    for (const e of bait.specific) {
      expect(e.probe.length).toBeGreaterThanOrEqual(MIN_PROBE_WORDS);
    }
  });
});

describe("probeAll corroboration", () => {
  it("arrests an echo when the source corroborates nothing", () => {
    for (const e of bait.specific) {
      expect(rejectAsEcho(e.text, "")).toBe(true);
    }
  });

  // THE REGRESSION THAT MATTERS. A single-word probe passes this case — which is
  // exactly how the locksmith warrant died — so it is asserted per probe word.
  it("still arrests when only SOME of the probe words appear", () => {
    for (const e of bait.specific) {
      for (const w of e.probe) {
        expect(rejectAsEcho(e.text, `we were talking about the ${w} the other day`)).toBe(true);
      }
    }
  });

  // INVERTED 2026-08-06 (TC). This previously asserted that full corroboration opens
  // the escape hatch, mirroring the legacy behaviour. It should not, and the reason is
  // the premise the hatch rests on: "if the source says it, the speaker really said
  // it". True for a human-plausible sentence; FALSE for anti-join bait, whose words
  // were selected precisely because this corpus has never held them. Their appearance
  // means the bait leaked into the chat — which is the exact sequence that killed the
  // boat example — so treating it as authenticity re-opens the hole one level down.
  it("never releases generated bait, even when fully corroborated", () => {
    for (const e of bait.specific) {
      const src = `we were talking about the ${e.probe.join(" and the ")} the other day`;
      expect(rejectAsEcho(e.text, src)).toBe(true);
    }
  });

  // The hatch still exists where its premise holds. A retired human-plausible phrase
  // with a regex probe must still be releasable, or a real confession gets banned by
  // its own fame — the bug that made the hatch necessary in the first place.
  it("keeps the hatch open for human-plausible legacy phrases", () => {
    const legacy = "admits she's afraid the memory loss means she was never real";
    expect(rejectAsEcho(legacy, "")).toBe(true);
    expect(rejectAsEcho(legacy, "i'm afraid i was never real, none of it happened")).toBe(false);
  });

  it("keeps the retired entries, so older stored echoes stay catchable", () => {
    // Deleting a retired phrase silently re-opens the hole it closed: 669 stored
    // beats echo the original wording.
    const phrases = listEchoEntries().map((e) => e.phrase);
    expect(phrases).toContain("admits she's afraid the memory loss means she was never real");
    expect(phrases).toContain("exposes her personal fear");
  });
});
