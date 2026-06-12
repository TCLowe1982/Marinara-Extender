// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Lane/kind-aware dedup matrix (MarinaraExtender-ef6 + 4eu/FR1).
//
//   character_topics: incidents never collapse into traits (feelings
//   accumulate); incident-vs-incident dedups only near-identical recaptures;
//   traits keep the aggressive default.
//
//   user_topics: corrections ("sister is Mei" -> "sister is Lin") are created
//   and recorded as supersession candidates; restatements still dedup.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  createEntryIfUnique,
  readSupersessionCandidates,
  correctionSignature,
  looksIncident,
} from "../dedup.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-dedup-"));
  process.env.MARINARA_EXTENDER_DATA = join(dir, "data");
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true });
});

const ctopic = (summary: string, kind?: "incident" | "trait") =>
  createEntryIfUnique("character", "mari", { lane: "character_topics", summary, content: "", ...(kind ? { kind } : {}) });
const utopic = (summary: string) =>
  createEntryIfUnique("character", "mari", { lane: "user_topics", summary, content: "" });

describe("character_topics matrix", () => {
  it("an incident similar to a standing trait is CREATED — the arc accumulates", async () => {
    expect(await ctopic("fears intimacy being rejected by partners", "trait")).not.toBeNull();
    // Old behavior: 0.35 Jaccard would eat this moment as a "duplicate" of the trait.
    const incident = await ctopic("[fear] Priya fears intimacy being rejected tonight at dinner", "incident");
    expect(incident).not.toBeNull();
  });

  it("a near-identical incident recapture (swipe/regen) is still skipped", async () => {
    expect(await ctopic("[fear] Priya fears her request for intimacy will be rejected tonight", "incident")).not.toBeNull();
    const recapture = await ctopic("[fear] Priya fears her request for intimacy will be rejected", "incident");
    expect(recapture).toBeNull();
  });

  it("merely-similar incidents in the same emotional territory BOTH persist", async () => {
    expect(await ctopic("[fear] Priya fears rejection when asking Mari for intimacy", "incident")).not.toBeNull();
    const second = await ctopic("[fear] fear of rejection surfaces as Priya undresses for Thomas", "incident");
    expect(second).not.toBeNull();
  });

  it("traits keep the aggressive default against other traits", async () => {
    expect(await ctopic("copes with stress by deflecting with humor", "trait")).not.toBeNull();
    expect(await ctopic("copes with stress by deflecting with jokes and humor", "trait")).toBeNull();
  });

  it("legacy kind-less entries keep the old aggressive behavior", async () => {
    expect(await ctopic("loves expensive coffee from the corner cafe")).not.toBeNull();
    expect(await ctopic("loves expensive coffee from the cafe")).toBeNull();
  });
});

describe("user_topics corrections (FR1)", () => {
  it("a correction is CREATED and recorded as a supersession candidate", async () => {
    const original = await utopic("the user's sister is named Mei");
    expect(original).not.toBeNull();
    const correction = await utopic("the user's sister is named Lin");
    expect(correction).not.toBeNull(); // old behavior: silently dropped
    const candidates = await readSupersessionCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.existingId).toBe(original!.id);
    expect(candidates[0]!.newId).toBe(correction!.id);
  });

  it("a plain restatement is still deduped, with no candidate recorded", async () => {
    expect(await utopic("the user's sister is named Mei")).not.toBeNull();
    expect(await utopic("user's sister is named Mei")).toBeNull();
    expect(await readSupersessionCandidates()).toHaveLength(0);
  });

  it("a different fact that shares few words is just created (no hit at all)", async () => {
    expect(await utopic("the user's sister is named Mei")).not.toBeNull();
    expect(await utopic("the user owns a candy thermometer for caramel")).not.toBeNull();
    expect(await readSupersessionCandidates()).toHaveLength(0);
  });
});

describe("signals", () => {
  it("looksIncident keys on the [emotion] prefix", () => {
    expect(looksIncident("[fear] Priya fears rejection")).toBe(true);
    expect(looksIncident("copes with stress by deflecting")).toBe(false);
  });

  it("correctionSignature requires high overlap and a small content diff", () => {
    expect(correctionSignature("the user's sister is named Mei", "the user's sister is named Lin")).toBe(true);
    expect(correctionSignature("the user's sister is named Mei", "the user owns a candy thermometer")).toBe(false);
  });
});
