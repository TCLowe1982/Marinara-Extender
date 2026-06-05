// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Unit tests for pre-attribution detection.
//
// The risk this guards against: prose with incidental colons (date headers,
// "The one that meant the most:", chat metadata) being misread as a dialogue
// log, which skips the LLM attribution pass and produces garbage speakers.

import { describe, it, expect } from "vitest";
import { isPreAttributed } from "../story-parser.js";

describe("isPreAttributed", () => {
  it("accepts a real dialogue log with recurring speakers", () => {
    const log = [
      "Mari: Good morning. Did you sleep at all?",
      "User: Not really. Too much on my mind.",
      "Mari: Tell me. I'm here.",
      "User: It's the paper again.",
      "Mari: We'll get through it together.",
    ].join("\n");
    expect(isPreAttributed(log)).toBe(true);
  });

  it("rejects prose with stray colons (the Chat/Date/'The one that meant' case)", () => {
    const prose = [
      "Date: June 2nd, 2026",
      "Chat: exported session",
      "",
      "The one that meant the most to her was the quiet one.",
      "She walked through the door and looked around the empty room.",
      "Everything felt heavier than it should have, and she knew why.",
      "There was no going back to the way things were before that night.",
      "The rain kept falling against the glass as she waited.",
    ].join("\n");
    expect(isPreAttributed(prose)).toBe(false);
  });

  it("rejects prose where a single speaker colon appears only once", () => {
    const prose = [
      "Mari: she said, turning away from the window.",
      "The afternoon dragged on without any sign of change.",
      "He had promised to call, but the phone stayed silent.",
      "By evening she had stopped checking it altogether.",
    ].join("\n");
    expect(isPreAttributed(prose)).toBe(false);
  });

  it("rejects empty input", () => {
    expect(isPreAttributed("")).toBe(false);
  });
});
