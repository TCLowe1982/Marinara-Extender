// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// MarinaraExtender-oknn — a thread label must name a SCENE, never a person.
//
// The measured failure: turn-bridge passes the CHAT'S name as `sceneTitle`, and the
// analyzer was told to prefer the scene title as a new thread's label. Marinara
// defaults a chat to its character's name, so every beat in a default-named chat
// landed on a "thread" that was really just the chat. Live registry, 205 threads:
// "Dr. Mari Zielińska" held 66% of one chat's beats, "Dr Z" 79% of another's, and
// several chats had a single thread holding 100%.
//
// TC's ruling: threads are worth keeping, the CHAT name must not become a thread
// label, and an RP SCENE name is fine. So this is a discrimination problem, and the
// negative cases below matter as much as the positive ones — over-suppressing would
// delete the feature TC deliberately designed.

import { describe, it, expect } from "vitest";
import { looksCastList, titleNamesAPerson } from "../threads.js";

const ROSTER = [
  "Dr. Mari Zielińska",
  "Priya",
  "Dr. Priya Chandrasekaran",
  "Aurora",
  "Thomas Collier",
];

describe("titleNamesAPerson — rejects", () => {
  it("the Marinara default chat name (the character)", () => {
    expect(titleNamesAPerson("Dr. Mari Zielińska", ROSTER)).toBe(true);
  });

  it("THE ONE looksCastList MISSES: an honorific plus an initial", () => {
    // "Dr Z" held 290 beats. looksCastList drops tokens shorter than 3 chars, so
    // this reduces to an EMPTY token list and comes back false — the exact label
    // that caused the bug slipped through the guard written to catch it.
    expect(looksCastList("Dr Z", ROSTER)).toBe(false);
    expect(titleNamesAPerson("Dr Z", ROSTER)).toBe(true);
    expect(titleNamesAPerson("Dr. Z", ROSTER)).toBe(true);
  });

  it("a bare first name, and a full name with honorific", () => {
    expect(titleNamesAPerson("Priya", ROSTER)).toBe(true);
    expect(titleNamesAPerson("Dr. Priya Chandrasekaran", ROSTER)).toBe(true);
  });

  it("a name not on the roster but shaped like one", () => {
    expect(titleNamesAPerson("Prof. K", ROSTER)).toBe(true);
  });
});

describe("titleNamesAPerson — keeps", () => {
  it("a scene name the user actually chose", () => {
    // "Porsche test drive" appears four times in the live registry. It is exactly
    // what the sceneTitle hint is for, and suppressing it would remove the feature.
    expect(titleNamesAPerson("Porsche test drive", ROSTER)).toBe(false);
  });

  it("descriptively named work chats", () => {
    expect(titleNamesAPerson("proxy integration fix", ROSTER)).toBe(false);
    expect(titleNamesAPerson("fable extender development", ROSTER)).toBe(false);
  });

  it("a scene that MENTIONS a character but describes an event", () => {
    // The discrimination that matters most: naming a participant is fine as long as
    // the label is about something happening. Only an all-name label is a cast list.
    expect(titleNamesAPerson("Mari's exploration of her own identity", ROSTER)).toBe(false);
    expect(titleNamesAPerson("the argument about the Hargrove papers", ROSTER)).toBe(false);
    expect(titleNamesAPerson("Priya confesses the trial was rigged", ROSTER)).toBe(false);
  });

  it("an odd chat title that is still not a person", () => {
    expect(titleNamesAPerson("good noon technically", ROSTER)).toBe(false);
  });

  it("an empty or whitespace label, without throwing", () => {
    expect(titleNamesAPerson("", ROSTER)).toBe(false);
    expect(titleNamesAPerson("   ", ROSTER)).toBe(false);
  });

  it("anything at all when the roster is empty — no names, no evidence", () => {
    expect(titleNamesAPerson("Dr. Mari Zielińska", [])).toBe(false);
  });
});
