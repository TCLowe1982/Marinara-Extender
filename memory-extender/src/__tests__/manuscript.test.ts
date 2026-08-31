// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Memoir vs manuscript (wosh).
//
// THE FIXTURES ARE THE SPEC. The memoir case is not a happy-path test — it is the
// FAILURE THIS GATE MUST NEVER COMMIT, so it is written first and asserted hardest.
// A long first-person account of something that happened to the user is the most
// valuable thing this system captures; routing one into a work-artifact lane would
// destroy the best memories in the store while looking like it was working.

import { describe, it, expect } from "vitest";
import {
  manuscriptEvidence,
  MANUSCRIPT_THRESHOLD,
  SIZE_FLOOR,
} from "../sentiment/manuscript.js";

const ROSTER = ["Mari", "Zielinska", "Thomas"];

/** Repeat to clear SIZE_FLOOR without changing the shape of the prose. */
function long(unit: string, times = 12): string {
  return Array.from({ length: times }, () => unit).join("\n\n");
}

// A war story told to a character: first person throughout, full of people who are
// NOT in the roster, addressed to the listener. Every corroborating signal a naive
// gate would convict on is present here on purpose.
const MEMOIR = long(
  "I have never told you this part. We had been out on the range since before dawn, " +
    "and by the time we got back I could not feel my hands. Sergeant Alvarez did not " +
    "say anything about it, and neither did Ruiz. I kept thinking about my mother's " +
    "kitchen and how far away it seemed. I did not talk about any of it for years, " +
    "and I am telling you now because you asked me what that winter was like.",
);

// Third-person narration about invented people. No dialogue attribution at all —
// this is the shape that scored 0.47 and was SPARED before thirdPersonRatio existed.
const MANUSCRIPT = long(
  "Terrill awoke from his bed and set about his morning devotions. He dressed in the " +
    "body stocking he wore beneath his armor, and one of the attendants stood at post " +
    "outside his door. Terrill took the stairs slowly. The Prince had summoned him, and " +
    "he knew what the summons meant. Elara watched him go, and she said nothing.",
);

describe("the memoir guard — the failure this must never commit", () => {
  it("spares a long first-person account full of strangers", () => {
    const ev = manuscriptEvidence(MEMOIR, ROSTER);
    expect(ev.chars).toBeGreaterThanOrEqual(SIZE_FLOOR);
    expect(ev.isManuscript).toBe(false);
    expect(ev.score).toBeLessThan(MANUSCRIPT_THRESHOLD);
  });

  it("engages a named guard rather than merely scoring low by luck", () => {
    const ev = manuscriptEvidence(MEMOIR, ROSTER);
    expect(ev.signals.some((s) => s.startsWith("memoir-guard"))).toBe(true);
  });

  it("still spares it when the roster is empty — no chat cast to lean on", () => {
    // Corroboration is unavailable; first-person testimony alone must carry it.
    expect(manuscriptEvidence(MEMOIR, []).isManuscript).toBe(false);
  });

  it("the guard is a CAP, so piling on weak signals cannot climb past it", () => {
    const withMarkers = MEMOIR + "\n\n* * *\n\n* * *\n\nChapter Two\n\n" + MEMOIR;
    expect(manuscriptEvidence(withMarkers, ROSTER).isManuscript).toBe(false);
  });
});

describe("manuscript detection", () => {
  it("flags third-person narration about invented people", () => {
    const ev = manuscriptEvidence(MANUSCRIPT, ROSTER);
    expect(ev.isManuscript).toBe(true);
    expect(ev.score).toBeGreaterThanOrEqual(MANUSCRIPT_THRESHOLD);
  });

  it("scores narration WITHOUT dialogue — the regression that cost the first pass", () => {
    // 10 attributions across 39k chars contributed 0.03 and the draft was spared.
    // Narration is the common case; dialogue is a bonus when present.
    const ev = manuscriptEvidence(MANUSCRIPT, ROSTER);
    expect(ev.dialogueRatio).toBeLessThan(0.2);
    expect(ev.thirdPersonRatio).toBeGreaterThan(0.5);
    expect(ev.isManuscript).toBe(true);
  });

  it("counts a recurring actor as a stranger", () => {
    expect(manuscriptEvidence(MANUSCRIPT, ROSTER).strangerNames).toContain("Terrill");
  });

  it("does NOT count a capitalised technical noun as a person", () => {
    // The measured false positive: "Tracker", "Roleplay", "Game" and "Experience"
    // were called strangers in a changelog because a frequency count cannot tell a
    // product feature from a protagonist.
    const changelog = long(
      "Added Lorebook Update so the Tracker can assign an integer injection order. " +
        "The Tracker keeps the existing order when omitted. Roleplay and Game modes " +
        "preserve the value through editing. The Experience setting is unchanged, and " +
        "the Tracker reports it. Game mode and Roleplay mode share the Experience flag.",
    );
    const ev = manuscriptEvidence(changelog, ROSTER);
    for (const noun of ["Tracker", "Roleplay", "Game", "Experience"]) {
      expect(ev.strangerNames).not.toContain(noun);
    }
  });
});

describe("boundaries", () => {
  it("never calls a short message a manuscript, whatever it scores", () => {
    const short = "Terrill awoke. He took the stairs. The Prince had summoned him.";
    const ev = manuscriptEvidence(short, ROSTER);
    expect(ev.chars).toBeLessThan(SIZE_FLOOR);
    expect(ev.isManuscript).toBe(false);
  });

  it("mentioning the chat's cast protects a first-person message", () => {
    const aboutUs = long(
      "I wanted to tell you what happened after we spoke, Mari. I went back to the " +
        "house and I sat in the car for a while before I went in. I kept thinking about " +
        "what you said to me. I am still not sure you were right, but I did it anyway.",
    );
    const ev = manuscriptEvidence(aboutUs, ROSTER);
    expect(ev.rosterMentions).toBeGreaterThan(0);
    expect(ev.isManuscript).toBe(false);
  });

  it("is total on empty input rather than throwing", () => {
    const ev = manuscriptEvidence("", ROSTER);
    expect(ev.isManuscript).toBe(false);
    expect(ev.score).toBe(0);
    expect(ev.sentences).toBe(0);
  });

  it("classifies only — it exposes no way to drop anything", () => {
    // Documents the contract the module header states. If this ever fails, the
    // module grew a side effect and the ticket's disposition rules were bypassed.
    const ev = manuscriptEvidence(MANUSCRIPT, ROSTER);
    expect(Object.keys(ev).sort()).toEqual([
      "addressRatio", "chars", "dialogueRatio", "firstPersonRatio", "isManuscript",
      "narrativeDistance", "rosterMentions", "sceneMarkers", "score", "sentences",
      "signals", "strangerNames", "thirdPersonRatio",
    ]);
  });
});
