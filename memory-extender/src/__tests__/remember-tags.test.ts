// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// [remember:] / <remember> tag parsing (MarinaraExtender-c0b7).
//
// The behaviour pinned hardest here is scope resolution, because that is where
// a defect is INVISIBLE. A mis-parsed lane or a dropped tag shows up promptly;
// a memory filed one scope too narrow looks perfectly healthy in the store and
// only surfaces months later as "she forgot something I told her to remember
// forever". The tag values are emitted by a MODEL, so the cases below are the
// defects a model actually produces — casing, whitespace, near-miss synonyms —
// not hypothetical ones.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractRememberTags, stripRememberTags } from "../writer.js";

// Collected rather than asserted through the spy object: the warning's VALUE is
// what these tests care about, and a plain string list keeps the assertions
// readable without depending on vitest's mock-instance generics.
let warnings: string[];

beforeEach(() => {
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scope resolution", () => {
  it("defaults to character when scope is omitted", () => {
    const [bracket] = extractRememberTags(`[remember: lane="user_topics", content="User's sister is called Lin."]`);
    expect(bracket?.scope).toBe("character");

    const [xml] = extractRememberTags(`<remember lane="user_topics">User's sister is called Lin.</remember>`);
    expect(xml?.scope).toBe("character");
  });

  it("honours each valid scope verbatim", () => {
    for (const scope of ["chat", "character", "global"] as const) {
      const [tag] = extractRememberTags(`[remember: scope="${scope}", content="Something worth keeping."]`);
      expect(tag?.scope).toBe(scope);
    }
  });

  // The regression. An unrecognised value used to fall to "chat" — the NARROWEST
  // scope — so a typo did not degrade to the default, it buried the memory in the
  // conversation that produced it.
  it("falls back to the default, not to chat, when the scope is unrecognised", () => {
    for (const bad of ["charcter", "world", "char", "globals", "permanent", ""]) {
      const [tag] = extractRememberTags(`[remember: scope="${bad}", content="A durable fact about the user."]`);
      expect(tag?.scope).toBe("character");
    }
  });

  it("applies the same fallback on the legacy XML branch", () => {
    const [tag] = extractRememberTags(`<remember scope="charcter">A durable fact about the user.</remember>`);
    expect(tag?.scope).toBe("character");
  });

  it("normalises casing and surrounding whitespace rather than rejecting it", () => {
    // Unambiguous in intent — "Global" can only mean global.
    expect(extractRememberTags(`[remember: scope="Global", content="Everyone knows this."]`)[0]?.scope).toBe("global");
    expect(extractRememberTags(`[remember: scope="CHAT", content="Just for this conversation."]`)[0]?.scope).toBe("chat");
    expect(extractRememberTags(`<remember scope=" Character ">A durable fact.</remember>`)[0]?.scope).toBe("character");
  });

  it("warns once per distinct bad value, not once per occurrence", () => {
    extractRememberTags(`[remember: scope="wat", content="First occurrence of the bad value."]`);
    extractRememberTags(`[remember: scope="wat", content="Second occurrence of the bad value."]`);
    const forWat = warnings.filter((w) => w.includes("wat"));
    expect(forWat).toHaveLength(1);
    // The warning must name where the entry actually went, not just that it was bad.
    expect(forWat[0]).toContain("character");
  });

  it("does not warn for a scope it accepted", () => {
    extractRememberTags(`[remember: scope="Global", content="Everyone knows this."]`);
    extractRememberTags(`[remember: content="No scope named at all."]`);
    expect(warnings).toEqual([]);
  });
});

describe("lane resolution", () => {
  it("defaults to user_topics when omitted or unrecognised", () => {
    expect(extractRememberTags(`[remember: content="A fact with no lane."]`)[0]?.lane).toBe("user_topics");
    expect(extractRememberTags(`[remember: lane="feelings", content="A fact with a bad lane."]`)[0]?.lane)
      .toBe("user_topics");
  });

  it("honours each valid lane", () => {
    for (const lane of ["open_threads", "user_topics", "character_topics"] as const) {
      expect(extractRememberTags(`[remember: lane="${lane}", content="Something worth keeping."]`)[0]?.lane)
        .toBe(lane);
    }
  });
});

describe("extraction", () => {
  it("reads both formats out of one message, in order", () => {
    const text = [
      "She nods.",
      `<remember lane="open_threads" scope="chat">Still editing the cover letter.</remember>`,
      "Then, later:",
      `[remember: lane="user_topics", content="User's daughter Emma just turned 8."]`,
    ].join("\n");
    const tags = extractRememberTags(text);
    // XML tags are collected first, then bracket tags — both branches run to completion.
    expect(tags.map((t) => t.lane)).toEqual(["open_threads", "user_topics"]);
    expect(tags[0]?.scope).toBe("chat");
    expect(tags[1]?.scope).toBe("character");
  });

  it("drops tags with empty or whitespace-only content", () => {
    expect(extractRememberTags(`[remember: lane="user_topics", content=""]`)).toHaveLength(0);
    expect(extractRememberTags(`[remember: lane="user_topics", content="   "]`)).toHaveLength(0);
    expect(extractRememberTags(`<remember lane="user_topics">   </remember>`)).toHaveLength(0);
  });

  it("strips every tag from the visible text", () => {
    const text = `She nods.\n[remember: content="A fact."]\n<remember>Another fact.</remember>\nAnd smiles.`;
    const stripped = stripRememberTags(text);
    expect(stripped).not.toContain("remember");
    expect(stripped).toContain("She nods.");
    expect(stripped).toContain("And smiles.");
  });
});
