// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// 5dqr — the chunker absorbed clock timestamps into speaker names.
//
// SPEAKER_PREFIX_RE allows digits and spaces in a label, so "Thomas Today at 8:04 PM"
// matched with label "Thomas Today at 8": the regex split on the TIME's colon. 157
// beats across 20 aliases, including Thomas01..12 and NarratorNarrator05..12. "Thomas"
// proper held 8 beats while his mangled variants held ~40 — the real character was
// more fragmented than intact.
//
// WORSE THAN 4ghy's FAKE SPEAKERS, which is why it went first. A minted speaker like
// "BAD" produces beats that are visibly junk. A mangled real speaker produces beats
// that look entirely correct and route to a person-shaped stranger, and subject
// attribution then compounds the error downstream.

import { describe, it, expect } from "vitest";
import { parseTurns, unmangleSpeaker } from "../sentiment/chunker.js";

const msg = (content: string) => [{ role: "user" as const, content }];

describe("unmangleSpeaker", () => {
  it("recovers the name from every mangled form in the census", () => {
    // Exactly the variants measured in the store, so the fix is pinned to real data.
    expect(unmangleSpeaker("Thomas Today at 8")).toBe("Thomas");
    expect(unmangleSpeaker("ThomasToday at 8")).toBe("Thomas");
    expect(unmangleSpeaker("Thomas08")).toBe("Thomas");
    expect(unmangleSpeaker("Professor Mari01")).toBe("Professor Mari");
    expect(unmangleSpeaker("NarratorNarrator07")).toBe("Narrator");
  });

  it("leaves ordinary names untouched", () => {
    for (const n of ["Thomas", "Dr. Mari Zielińska", "Priya Chandrasekaran", "Narrator", "Dr. Z"]) {
      expect(unmangleSpeaker(n)).toBe(n);
    }
  });

  // The doubling rule is an EXACT repeat only, or it would eat real names.
  it("does not collapse a name that merely repeats a word", () => {
    expect(unmangleSpeaker("Anna Annabel")).toBe("Anna Annabel");
    expect(unmangleSpeaker("Mari Mariposa")).toBe("Mari Mariposa");
  });
});

describe("parseTurns with timestamped exports", () => {
  it("attributes a timestamped line to the real speaker", () => {
    const turns = parseTurns(msg("Thomas Today at 8:04 PM\nstay. please."), "Mari");
    expect(turns.map((t) => t.speaker)).toContain("Thomas");
    expect(turns.some((t) => /Today at|8:04|04 PM/.test(t.speaker))).toBe(false);
  });

  it("keeps the utterance and drops only the clock", () => {
    const turns = parseTurns(msg("Thomas08:15 AM I am not going to explain myself again."), "Mari");
    const t = turns.find((x) => x.speaker === "Thomas");
    expect(t).toBeDefined();
    expect(t!.text).toContain("not going to explain myself");
    expect(t!.text).not.toMatch(/^15\b/);
    expect(t!.text).not.toMatch(/\bAM\b/);
  });

  // THE REGRESSION GUARD. A colon after a real name must still split, and a time
  // INSIDE an utterance must not be mistaken for the speaker colon.
  it("still splits an ordinary speaker line", () => {
    const turns = parseTurns(msg("Mari: I can not do this any more."), "Mari");
    expect(turns[0]!.speaker).toBe("Mari");
    expect(turns[0]!.text).toBe("I can not do this any more.");
  });

  it("does not mangle a speaker whose line mentions a time", () => {
    const turns = parseTurns(msg("Mari: it was 8:04 when he finally called back."), "Mari");
    expect(turns[0]!.speaker).toBe("Mari");
    expect(turns[0]!.text).toContain("8:04");
  });
});
