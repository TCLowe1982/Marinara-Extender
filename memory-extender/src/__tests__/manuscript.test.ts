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

// A war story told to a character.
//
// CALIBRATED AGAINST THE CENSUS, NOT INVENTED. The first version of this fixture was
// worthless and a control experiment proved it: inflating every weight 1.7x left it
// at rawScore 0.200 with narrativeDistance 0.00 and thirdPersonRatio 0.00, so it
// passed no matter what the scorer did. It was written by the same hand as the
// scorer and shared its blind spot — a memoir that talks only about ITSELF.
//
// Real memoirs are full of other people in the third person. The worst real memoir
// in a 464-message census scores raw 0.437 and carries 1p 0.66, 3p 0.47, 26
// attributed-dialogue hits and 9 stranger names. This fixture reproduces that
// PROFILE — measured at raw 0.445, 1p 0.64, 3p 0.57 — so it sits where real
// testimony sits, close enough to the line that weight drift moves it across.
//
// NOTHING OF THE CENSUS TEXT IS REPRODUCED HERE, not even in illustration: it is
// the user's own life and this repository is public. The numbers are the whole
// point and they carry over without the words. Regenerate them any time with
// scripts/wosh-audit.mjs, which reads a gitignored local cache.
const MEMOIR = long(
  [
    "I have never told you this part, and I am telling it now because you asked.",
    "Alvarez was the one who noticed first, and he did not say anything to me about it for weeks.",
    '"You look like hell," he said, and I told him I was fine, which was a lie and he knew it.',
    "Ruiz kept his head down through all of it. He had a wife back home and he wrote to her every night.",
    "I remember the cold more than anything else, and I remember that my hands stopped working around two in the morning.",
    "Alvarez took my rifle from me and carried both of them the rest of the way back.",
    '"Don\'t make it a thing," he said. He never made anything a thing.',
    "My mother sent a package that month and I did not open it until March.",
    "Ruiz asked me once if I was going to stay in. I said I did not know.",
    "He said his wife wanted him out, and then he laughed, and then he did not say anything else about it.",
    "I have thought about that walk back more times than I have told anyone, and I never told my mother any of it.",
  ].join(" "),
  8,
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

  // ENGAGEMENT IS NOT EFFECT — measured, and the reason rawScore exists.
  //
  // Across 461 real messages the guard rescued NOTHING at 0.50 or above: 13 flagged
  // with it, 13 without. It only moves outcomes below 0.50, and the highest-scoring
  // memoir-shaped message in the whole corpus reaches raw 0.45-0.50 on the primary
  // signals alone. So the guard is presently INERT at any threshold we would run,
  // and its value is as a ceiling that bounds future weight-tuning error, NOT as
  // something protecting memories today. These assertions pin that distinction so
  // nobody reads "the guard engaged" as "the memoir was saved".
  it("exposes rawScore so the guard's effect is measurable, not asserted", () => {
    const ev = manuscriptEvidence(MEMOIR, ROSTER);
    expect(ev.rawScore).toBeGreaterThanOrEqual(ev.score);
  });

  it("the memoir separates on the primary signals, WITHOUT relying on the guard", () => {
    // THE FUSE. If this fails, the guard has become the only thing standing between
    // a real memory and the manuscript lane.
    //
    // VERIFIED TO ACTUALLY BLOW: with every weight inflated 1.7x this goes red, and
    // the real census memoir goes to rawScore 0.801 while the guard caps it at 0.35.
    // The previous fixture stayed green through that same experiment, which is how
    // we learned it was decorative. A fuse nobody has watched blow is not a fuse.
    const ev = manuscriptEvidence(MEMOIR, ROSTER);
    expect(ev.rawScore).toBeLessThan(MANUSCRIPT_THRESHOLD);
  });

  it("sits where real testimony sits — the profile, not just the verdict", () => {
    // Pins the fixture to the census profile it was calibrated against. Asserting
    // only "not flagged" would pass for a fixture nowhere near the boundary, which
    // is exactly the failure this replaced.
    const ev = manuscriptEvidence(MEMOIR, ROSTER);
    expect(ev.firstPersonRatio).toBeGreaterThan(0.55);
    expect(ev.firstPersonRatio).toBeLessThan(0.80);
    expect(ev.thirdPersonRatio).toBeGreaterThan(0.35);   // it talks about OTHER PEOPLE
    expect(ev.dialogueRatio).toBeGreaterThan(0);          // real accounts quote people
    expect(ev.strangerNames.length).toBeGreaterThanOrEqual(2);
    expect(ev.rosterMentions).toBe(0);                    // roster-silent, unaided
    // Close enough to the line that drift moves it. If this drops far below, the
    // fuse has gone slack again.
    expect(ev.rawScore).toBeGreaterThan(0.35);
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
      "narrativeDistance", "rawScore", "rosterMentions", "sceneMarkers", "score",
      "sentences", "signals", "strangerNames", "thirdPersonRatio",
    ]);
  });
});
