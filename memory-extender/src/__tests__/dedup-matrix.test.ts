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
import { readIndex, readColdIndex, readEntry } from "../storage.js";

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

  it("a near-identical recapture from the SAME moment (chat + turn) is skipped", async () => {
    expect(await createEntryIfUnique("character", "mari", {
      lane: "character_topics", summary: "[fear] Priya fears her request for intimacy will be rejected tonight",
      content: "", kind: "incident", sourceChatId: "chat-1", turnStart: 40,
    })).not.toBeNull();
    const recapture = await createEntryIfUnique("character", "mari", {
      lane: "character_topics", summary: "[fear] Priya fears her request for intimacy will be rejected",
      content: "", kind: "incident", sourceChatId: "chat-1", turnStart: 41, // a swipe of the same turn
    });
    expect(recapture).toBeNull();
  });

  it("IDENTICAL boilerplate summaries from DIFFERENT moments both persist", async () => {
    // The measured failure: the analyzer emitted byte-identical genre labels
    // for distinct moments; similarity alone must never collapse them.
    const boiler = "[vulnerability] Dr. Mari Zielińska exposes her personal fear";
    const a = await createEntryIfUnique("character", "mari", {
      lane: "character_topics", summary: boiler, content: "", kind: "incident", sourceChatId: "chat-1", turnStart: 160,
    });
    const b = await createEntryIfUnique("character", "mari", {
      lane: "character_topics", summary: boiler, content: "", kind: "incident", sourceChatId: "chat-1", turnStart: 190, // 30 turns later
    });
    const c = await createEntryIfUnique("character", "mari", {
      lane: "character_topics", summary: boiler, content: "", kind: "incident", sourceChatId: "chat-2", turnStart: 160, // different chat
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).not.toBeNull();
  });

  it("without moment provenance, similar incidents persist (accumulate bias)", async () => {
    expect(await ctopic("[fear] Priya fears her request for intimacy will be rejected tonight", "incident")).not.toBeNull();
    const second = await ctopic("[fear] Priya fears her request for intimacy will be rejected", "incident");
    expect(second).not.toBeNull(); // no proof of same-moment — keep both
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
  it("a correction is CREATED, recorded, and the old fact is SUPERSEDED (FR2)", async () => {
    const original = await utopic("the user's sister is named Mei");
    expect(original).not.toBeNull();
    const correction = await utopic("the user's sister is named Lin");
    expect(correction).not.toBeNull(); // old behavior: silently dropped
    const candidates = await readSupersessionCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.existingId).toBe(original!.id);
    expect(candidates[0]!.newId).toBe(correction!.id);
    expect(candidates[0]!.applied).toBe(true);

    // The old fact: pointered, out of the hot index, retained in cold.
    const hot = (await readIndex("character", "mari"))!;
    expect(hot.entries.map((e) => e.id)).not.toContain(original!.id);
    expect(hot.entries.map((e) => e.id)).toContain(correction!.id);
    const cold = (await readColdIndex("character", "mari"))!;
    const oldRow = cold.entries.find((e) => e.id === original!.id)!;
    expect(oldRow.supersededBy).toBe(correction!.id);
    // Entry file carries its own history too.
    const oldEntry = await readEntry("character", "mari", oldRow.path);
    expect(oldEntry?.supersededBy).toBe(correction!.id);
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
