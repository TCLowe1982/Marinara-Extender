// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// DOCUMENT HEADINGS MUST NOT MINT SPEAKERS — the pinned half (hjt9/pe4o).
//
// The pe4o census read all 13 live self-ingested records and found every phantom
// speaker was a document HEADING: 9x "Format" (the PROMPTS.md per-emotion catalog),
// 1x "SOFT SIGNALS", 1x "BAD". Those records predate the ops lane. Measured today
// (scripts/heading-mint-scan.mjs), the live intake — routeOps at Stage -1, then the
// chunker's noun-phrase rule and recurrence floor — DISARMS the catalog paste
// completely: PROMPTS.md pasted whole mints zero speakers.
//
// That victory is exactly the kind that rots silently: it emerges from the
// interaction of code-filter rules, the fence handling, and the chunker, and no
// one of them owns it. So this test pins the SYSTEM property on stable fixtures
// shaped like the real documents, alongside the two must-not-break cases that
// bound any future fix from the other side.
//
// KNOWN STILL-OPEN, deliberately NOT pinned here: a heading whose payload is
// PROSE on the same line ("Format: Respond only with JSON in this exact shape.")
// still mints when it recurs — the line is not code-shaped, so Stage -1 keeps it,
// and it clears the noun-phrase rule and the recurrence floor. That covers the
// analyzer.ts source paste ("Format:" x18) and a small heading paste inline in
// real dialogue. Measured, recorded in hjt9, awaiting a calibration ruling — a
// test asserting the desired behavior would just sit red. When the fix lands,
// move those cases up here.
//
// The disarm below is SPECIFIC, and worth stating so this test is not read as
// broader than it is: the census's Format lines die because docs/PROMPTS.md
// renders every prompt inside a ```text fence, and fenced content routes to the
// ops sink wholesale (verified: all 11 Format lines drop under the code-fence
// rule; the same line pasted OUTSIDE a fence survives and mints). The heading is
// dead because the document fences it, not because the system knows what a
// heading is. An UNfenced heading with a prose payload is the open residue.

import { describe, it, expect } from "vitest";
import { routeOps } from "../sentiment/ops-lane.js";
import { parseTurns } from "../sentiment/chunker.js";

// The live path: Stage -1 reduces the message, then the chunker parses turns.
function mintedSpeakers(content: string, characterName = "Mari"): Map<string, number> {
  const routed = content.includes("\n") ? routeOps(content) : { prose: content, dropped: [] as unknown[] };
  const turns = parseTurns([{ role: "user", content: String(routed.prose) }], characterName);
  const by = new Map<string, number>();
  for (const t of turns) by.set(t.speaker, (by.get(t.speaker) ?? 0) + 1);
  by.delete("user");
  by.delete("Narrator");
  return by;
}

describe("document headings must not mint speakers", () => {
  it("a PROMPTS.md-shaped catalog paste mints nothing — the pe4o census case", () => {
    // Shaped like the real document: fenced JSON blocks, repeated "Format:"
    // headings (once per emotion — ten in one paste is how it cleared the
    // recurrence floor), section furniture. The 9-of-13 census bucket.
    // The real document's shape, verified against docs/PROMPTS.md: every prompt
    // is rendered inside a ```text fence, Format heading and all, once per
    // emotion. The fence is what does the killing.
    const sections = ["joy", "trust", "fear", "anger", "shame", "hope", "relief", "desire", "vulnerability", "dysregulation"];
    const paste = sections.map((emotion) => [
      `## Tier 2 analyzer — ${emotion}`,
      ``,
      "```text",
      `You are analyzing a roleplay conversation for emotional beats of ${emotion}.`,
      `- Respond with raw JSON only — no explanation, no markdown.`,
      ``,
      `Format: {"motivation":"...","relational_dynamics":"...","outcome":"...","emotions":[{"emotion":"${emotion}","weight":0.0}],"salience":0.0}`,
      "```",
    ].join("\n")).join("\n\n");

    expect([...mintedSpeakers(paste).keys()]).toEqual([]);
  });

  it("a bookmark-block paste does not mint 'SOFT SIGNALS' — the tenth census record", () => {
    const paste = [
      `The memory system accepts explicit commands in brackets.`,
      `SOFT SIGNALS: phrases that imply importance without a command.`,
      `- "I'll never forget this"`,
      `- "this matters to me"`,
      `[remember: the user's sister is called Lin]`,
      `[bookmark: the christening evening]`,
    ].join("\n");

    expect(mintedSpeakers(paste).has("SOFT SIGNALS")).toBe(false);
  });

  it("MUST NOT BREAK: a pasted transcript keeps minting every recurring speaker", () => {
    // The primary import path — one big message of interleaved dialogue.
    const lines = [
      ["Mari", "so tell me again what the reactor log showed, from the top."],
      ["Thomas", "the same spike as last week, but this time it held for nine minutes."],
      ["Mari", "nine? that's not a transient, that's a mode."],
      ["Priya", "the record shows the valve was replaced in March, so it isn't wear."],
      ["Thomas", "which puts us back to the controller, doesn't it."],
      ["Mari", "I hate being back to the controller."],
    ];
    const paste = Array.from({ length: 12 }, () => lines.map(([s, t]) => `${s}: ${t}`).join("\n")).join("\n");

    const minted = mintedSpeakers(paste);
    expect(minted.get("Mari")).toBeGreaterThan(0);
    expect(minted.get("Thomas")).toBeGreaterThan(0);
    expect(minted.get("Priya")).toBeGreaterThan(0);
  });

  it("MUST NOT BREAK: long unbroken RP prose mints nothing and loses nothing", () => {
    const prose = "She held the letter for a long time before opening it, because opening it made the thing inside true. ".repeat(60);
    const routed = routeOps(prose);
    expect(routed.dropped).toHaveLength(0);        // nothing routed away
    expect([...mintedSpeakers(prose).keys()]).toEqual([]);
  });
});
