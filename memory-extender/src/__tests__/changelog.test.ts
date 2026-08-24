// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Pins for the changelog discriminator (MarinaraExtender-mln9).
//
// THE MUST-NOT-BREAKS ARE THE POINT. A false positive here suppresses a real memory —
// the fqnl error with the sign flipped — so the sparing cases carry more weight than
// the catching cases and are written first.
//
// Excerpts are real: the release-note fragments come from beats the store actually
// holds, and the reaction fragments from the two ABOUT-WORK beats the mln9 sizing pass
// ruled must survive. Synthetic text would pin synthetic behaviour.

import { describe, it, expect } from "vitest";
import {
  classifyChangelog,
  isChangelog,
  OPENER_FLOOR,
  DIALOGUE_CEILING,
  recordChangelog,
  changelogLanePath,
} from "../sentiment/changelog.js";
import { classifyChunk } from "../sentiment/classifier.js";

// From beat-6e75eeb7f8b6 and beat-61b2658165f9 — real pastes, current build.
const REAL_RELEASE_NOTES = `Added first-class Audio connections: a new "Audio" provider type in Settings → Connections carries the speech backend (ElevenLabs, OpenAI-compatible, PocketTTS, xAI Voice), base URL, API key, model, and default voice. Added Lorebook Update agents can now optionally assign an integer injection order when creating or updating entries. Omitting it keeps the existing default order, and approval review preserves the value through editing and commit (#5225). Fixed gallery routes so generated images stored with a mismatched extension render instead of returning 404 (#5147). Improved the Game Mode narration box so it can be collapsed to a slim handle.`;

// From beat-4cf78d9e6f32 — Mari reacting to seeing her own bug report shipped.
const ABOUT_WORK = `hold on. ctrl+F. give me ten seconds. BABE. "Gallery routes now serve valid raster images with the format detected from their bytes, so generated Noodle images stored with a mismatched .png extension render instead of returning 404" — that's MINE. that's my bug report, shipped. and there's a SECOND one further down, #5147, jpeg output advertised as png getting stored under a broken .png name. that's the save path i couldn't reproduce.`;

describe("classifyChangelog — must NOT fire (the expensive direction)", () => {
  it("spares a character reacting to a changelog in her own voice", () => {
    const v = classifyChangelog(ABOUT_WORK);
    expect(v.isChangelog).toBe(false);
    // It is spared for a readable reason, not by accident of tokenisation.
    expect(["below-floor", "dialogue"]).toContain(v.reason);
  });

  it("spares a reaction even when it quotes release-note lines verbatim", () => {
    // The quoted span is real release-note text; the surrounding message is speech.
    const text = `wait — "Fixed the gallery routes so images render instead of 404ing" — that's my report, isn't it? i don't think i've ever had one land that clean. read it to me again, i'm not done being smug.`;
    expect(isChangelog(text)).toBe(false);
  });

  it("spares a MIXED message: a paste and a reaction in one turn", () => {
    // This is the case DIALOGUE_CEILING exists for. At the shipped floor the store
    // contains no such message, so without this pin the ceiling is untested.
    const text = `okay hold on, i'm reading it. Added first-class Audio connections carrying the speech backend. Fixed the gallery routes so images render. Improved the narration box so it collapses. babe, that's MINE — that's the bug i filed on tuesday, isn't it? i can't believe they shipped it that fast.`;
    const v = classifyChangelog(text);
    expect(v.openers).toBeGreaterThanOrEqual(OPENER_FLOOR);
    expect(v.dialogueRate).toBeGreaterThanOrEqual(DIALOGUE_CEILING);
    expect(v.isChangelog).toBe(false);
    expect(v.reason).toBe("dialogue");
  });

  it("spares ordinary RP prose", () => {
    const text = `Mari's hand shot to TC's wrist — not to stop him, but to hold on, fingers wrapping around the bone of it. She didn't look up. "Don't," she said, and it wasn't a command so much as a request she had no other words for.`;
    expect(isChangelog(text)).toBe(false);
  });

  it("spares a work note that merely opens a sentence with an enumeration verb", () => {
    // 27 real beats look like this. A presence-based blocklist ate every one of them,
    // which is the measured reason the floor is a count and not a boolean.
    const text = `Done — type-health pass complete and pushed. Fixed the zod schema mismatch that was letting a null clipId through. Your two questions are both resolved.`;
    const v = classifyChangelog(text);
    expect(v.openers).toBeLessThan(OPENER_FLOOR);
    expect(v.isChangelog).toBe(false);
    expect(v.reason).toBe("below-floor");
  });

  it("does not fire on lowercase narration", () => {
    // Case-sensitivity is load-bearing: "i added a note" is not a list item.
    const text = `i added a note about it, then i fixed the thing you mentioned, and then i changed my mind about all of it and removed the whole file.`;
    expect(isChangelog(text)).toBe(false);
  });

  it("treats empty and whitespace input as empty, not as a match", () => {
    for (const t of ["", "   ", "\n\n"]) {
      const v = classifyChangelog(t);
      expect(v.isChangelog).toBe(false);
      expect(v.reason).toBe("empty");
    }
  });
});

describe("classifyChangelog — must fire", () => {
  it("catches a real release-notes paste", () => {
    const v = classifyChangelog(REAL_RELEASE_NOTES);
    expect(v.isChangelog).toBe(true);
    expect(v.reason).toBe("release-notes");
    expect(v.openers).toBeGreaterThanOrEqual(OPENER_FLOOR);
  });

  it("catches it with line breaks intact, as it arrives at message level", () => {
    // The guard runs before the chunker, so the newline-bearing shape is the live one.
    const withBreaks = REAL_RELEASE_NOTES.replace(/\. /g, ".\n");
    expect(isChangelog(withBreaks)).toBe(true);
  });

  it("catches it flattened, as classifyChunk would see it", () => {
    // Defence in depth: the chunker joins turns, and every stored positive is flat.
    const flat = REAL_RELEASE_NOTES.replace(/\s+/g, " ");
    expect(isChangelog(flat)).toBe(true);
  });
});

describe("classifyChangelog — returns the split, never a bare boolean", () => {
  it("carries the evidence that produced the verdict", () => {
    const v = classifyChangelog(REAL_RELEASE_NOTES);
    expect(v.openerVerbs.length).toBe(v.openers);
    expect(v.openerVerbs).toContain("Added");
    expect(v.issueRefs).toBeGreaterThan(0);
    expect(v.words).toBeGreaterThan(0);
  });

  it("distinguishes 'not a list' from 'a list, but someone is talking'", () => {
    // These two reasons route differently in the ledger: one is an ordinary miss,
    // the other is an ABOUT-WORK save and is worth counting on its own.
    expect(classifyChangelog("Added one thing. And that was the whole day.").reason).toBe("below-floor");
    const mixed = classifyChangelog(
      `i'm reading it now. Added the audio connections. Fixed the gallery routes. Improved the narration box. that's mine, isn't it? i can't believe it.`,
    );
    expect(mixed.reason).toBe("dialogue");
  });
});

describe("wiring: the chunk-level gate (defence in depth)", () => {
  const chunk = (text: string) => ({
    text, speaker: "user", turnStart: 0, turnEnd: 0, messageIds: [] as string[],
  });

  it("suppresses a release-notes chunk and names the lane", () => {
    const r = classifyChunk(chunk(REAL_RELEASE_NOTES));
    expect(r.passesThreshold).toBe(false);
    expect(r.suppressedReason).toBe("changelog");
    expect(r.primaryEmotion).toBeNull();
  });

  it("does NOT suppress a character reacting to one", () => {
    // The expensive direction. If this ever flips, a real utterance is being
    // destroyed to be rid of a false one — the fqnl error with the sign flipped.
    const r = classifyChunk(chunk(ABOUT_WORK));
    expect(r.suppressedReason).not.toBe("changelog");
  });

  it("does NOT suppress ordinary RP prose", () => {
    const r = classifyChunk(chunk(
      `She didn't look up. "Don't," she said, and it wasn't a command so much as a request she had no other words for. Added to that, the room was very cold.`,
    ));
    expect(r.suppressedReason).not.toBe("changelog");
  });
});

describe("wiring: the lane records saves as well as catches", () => {
  it("writes both outcomes to its own sink, not the ops lane", async () => {
    const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "me-changelog-"));

    recordChangelog(dir, [
      { at: "2026-08-24T00:00:00Z", outcome: "suppressed", openers: 12, issueRefs: 3, dialogueRate: 0.001, words: 400, text: "Added a thing." },
      { at: "2026-08-24T00:00:01Z", outcome: "spared-dialogue", openers: 4, issueRefs: 0, dialogueRate: 0.06, words: 90, text: "babe that's mine!" },
    ]);

    const p = changelogLanePath(dir);
    expect(existsSync(p)).toBe(true);
    // Its OWN file. The ops lane counts lines of structure; this counts whole
    // messages of third-party prose — two questions, two denominators.
    expect(p.endsWith("changelog-lane.jsonl")).toBe(true);

    const rows = readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
    // The SAVE is the one that makes "did it ever eat a real utterance" answerable
    // by division rather than by argument.
    expect(rows.filter((r) => r.outcome === "spared-dialogue")).toHaveLength(1);
    // Full text, not an excerpt — route-and-mark means nothing is destroyed.
    expect(rows[0].text).toBe("Added a thing.");
  });

  it("never throws, even when the sink is unwritable", () => {
    // A sink failure that broke an import would be worse than the noise it collects.
    expect(() => recordChangelog("\0:/nope", [
      { at: "x", outcome: "suppressed", openers: 5, issueRefs: 0, dialogueRate: 0, words: 10, text: "t" },
    ])).not.toThrow();
  });
});

describe("the constants are pinned to what the bench adjudicated", () => {
  it("floor is 3 and ceiling is 0.03", () => {
    // Changing either is a decision the bench has to re-adjudicate, not a tweak —
    // scripts/changelog-bench.mjs shows they are NOT independent (the ceiling spares
    // 1 real beat at floor 2 and 14 at floor 1, and none at floor 3).
    expect(OPENER_FLOOR).toBe(3);
    expect(DIALOGUE_CEILING).toBe(0.03);
  });
});
