// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Durable-fact capture (MarinaraExtender-1dn): facts stated in scenes that are
// below the beat salience threshold still get captured, routed to the right
// subject's ledger, and stored as TRAITS (never colliding with incident beats).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { AmbientFact } from "../ambient.js";
import type { Chunk } from "../sentiment/types.js";
import { resolveFactTarget, saveFact, ingestSceneFacts } from "../facts.js";
import { readIndex, readEntry } from "../storage.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-facts-"));
  process.env.MARINARA_EXTENDER_DATA = join(dir, "data");
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  delete process.env.MARINARA_EXTENDER_SCENE_FACTS;
  await rm(dir, { recursive: true, force: true });
});

const ctx = { identityKey: "mari", fallbackChatId: "chat-1", characterName: "Mari" };

describe("resolveFactTarget routing", () => {
  it("a user fact stays on the session ledger in the user_topics lane", async () => {
    const t = await resolveFactTarget(
      { text: "I've DMed since 2nd edition", fact: "User has DMed since D&D 2e", lane: "user_topics", scope: "character", subject: "user" },
      ctx,
    );
    expect(t).toEqual({ scope: "character", scopeId: "mari", summary: "User has DMed since D&D 2e" });
  });

  it("a fact about the session character itself stays on its own ledger (no misroute)", async () => {
    const t = await resolveFactTarget(
      { text: "Warlock. Pact of the Tome.", fact: "Mari's D&D class is a Pact of the Tome Warlock", lane: "character_topics", scope: "character", subject: "Mari" },
      ctx,
    );
    expect(t?.scope).toBe("character");
    expect(t?.scopeId).toBe("mari");
  });

  it("a fact about an UNRESOLVABLE subject is demoted to chat scope, tagged with who it's about", async () => {
    const t = await resolveFactTarget(
      { text: "Cole mains a blood elf warlock", fact: "Cole mains a blood elf affliction warlock", lane: "character_topics", scope: "character", subject: "Cole" },
      ctx,
    );
    expect(t?.scope).toBe("chat");
    expect(t?.scopeId).toBe("chat-1");
    expect(t?.summary).toMatch(/^\[about: Cole\]/);
  });

  it("drops a fact with an empty extracted summary", async () => {
    const t = await resolveFactTarget(
      { text: "x", fact: "   ", lane: "character_topics", scope: "character", subject: "user" },
      ctx,
    );
    expect(t).toBeNull();
  });
});

describe("saveFact persistence", () => {
  it("stores a character_topics fact as a TRAIT under the right ledger", async () => {
    const entry = await saveFact(
      { text: "Warlock. Pact of the Tome.", fact: "Mari's class is a Pact of the Tome Warlock", lane: "character_topics", scope: "character", subject: "Mari" },
      ctx,
      "scene-7",
    );
    expect(entry).not.toBeNull();
    const idx = await readIndex("character", "mari");
    const row = idx?.entries.find((e) => e.id === entry!.id);
    expect(row?.lane).toBe("character_topics");
    expect(row?.sourceChatId).toBe("scene-7"); // re-import can clean it
  });
});

describe("ingestSceneFacts", () => {
  const chunks: Chunk[] = [
    { speaker: "user", text: "I've had a soft spot for paladins since I was 13.", turnStart: 0, turnEnd: 0 },
    { speaker: "Mari", text: "Warlock. Pact of the Tome. My patron is the Narrative itself.", turnStart: 1, turnEnd: 1 },
  ];

  it("captures facts over the full chunk set and routes them (user fact + self fact)", async () => {
    const classify = async (): Promise<AmbientFact[]> => [
      { text: "soft spot for paladins since 13", fact: "User has played a paladin since age 13", lane: "user_topics", scope: "character", subject: "user" },
      { text: "Warlock. Pact of the Tome.", fact: "Mari's D&D class is a Pact of the Tome Warlock", lane: "character_topics", scope: "character", subject: "Mari" },
    ];
    const res = await ingestSceneFacts({ characterId: "mari", characterName: "Mari", chunks, roster: ["Mari"], sourceChatId: "scene-9", classify, judge: async (f) => f });
    expect(res.saved).toBe(2);

    const idx = await readIndex("character", "mari");
    const lanes = (idx?.entries ?? []).map((e) => e.lane).sort();
    expect(lanes).toEqual(["character_topics", "user_topics"]);
  });

  it("de-dupes an identical fact emitted in two batches before touching disk", async () => {
    const many: Chunk[] = Array.from({ length: 30 }, (_, i) => ({ speaker: "Mari", text: `line ${i}`, turnStart: i, turnEnd: i }));
    const classify = async (): Promise<AmbientFact[]> => [
      { text: "Warlock", fact: "Mari is a Warlock", lane: "character_topics", scope: "character", subject: "Mari" },
    ];
    // 30 chunks / batch 5 = 6 batches, each returns the same fact.
    const res = await ingestSceneFacts({ characterId: "mari", characterName: "Mari", chunks: many, roster: ["Mari"], classify, judge: async (f) => f });
    expect(res.facts).toBe(1); // counted once despite two batches
    expect(res.saved).toBe(1);
  });

  it("honors the MARINARA_EXTENDER_SCENE_FACTS=0 kill switch", async () => {
    process.env.MARINARA_EXTENDER_SCENE_FACTS = "0";
    const classify = async (): Promise<AmbientFact[]> => [
      { text: "x", fact: "should not be saved", lane: "character_topics", scope: "character", subject: "Mari" },
    ];
    const res = await ingestSceneFacts({ characterId: "mari", characterName: "Mari", chunks, roster: ["Mari"], classify, judge: async (f) => f });
    expect(res).toEqual({ saved: 0, facts: 0, planned: [], durable: [] });
  });
});
