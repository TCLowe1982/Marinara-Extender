// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Unplayed-outline provenance stratum.
//
// Outline is canon the author has established out of character for an arc that
// has NOT been played. It is stored at full fidelity so it can be built on, and
// it must never reach a recall path — a character able to "remember" an unplayed
// scene is the confabulation machine the Erica Test exists to detect. These
// tests pin the exclusion on both paths: the hot working set and cold recall.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  upsertIndexEntry,
  writeEntry,
  moveToCold,
  type IndexEntry,
  type Entry,
} from "../storage.js";
import { awaitPendingCredit, loadContext } from "../loader.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-unplayed-"));
  process.env.MARINARA_EXTENDER_DATA = dir;
});
afterEach(async () => {
  // Join the background exposure-credit writes before deleting the data dir —
  // see awaitPendingCredit. Without it, an index write can land mid-rm.
  await awaitPendingCredit();
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function seedEntry(charId: string, id: string, summary: string, over: Partial<IndexEntry> = {}) {
  const entry: Entry = {
    id, lane: "character_topics", summary, status: "open",
    created: "2026-01-01", lastAccessed: "2026-01-01", content: `content of ${id}`, tokens: 20,
    ...(over.provenance && { provenance: over.provenance }),
  };
  const path = await writeEntry("character", charId, entry);
  await upsertIndexEntry("character", charId, {
    id, path, summary, tokens: 20, lane: "character_topics", status: "open",
    lastAccessed: "2026-01-01", ...over,
  });
}

const BUDGET = { chat: 0, character: 2000, global: 0 };

describe("unplayed outline never surfaces as recall", () => {
  it("is excluded from Current even as the only entry and a perfect match", async () => {
    await seedEntry("char-u", "e-outline", "the KCI pickup with Erica Cathmore in Kansas",
      { provenance: "unplayed" });

    const res = await loadContext({
      characterId: "char-u", chatId: "chat-u", turnNumber: 1,
      recentText: "tell me about the KCI pickup with Cathmore in Kansas",
      skipCredit: true,
    }, BUDGET);

    expect(res.surfaced.map((s) => s.id)).not.toContain("e-outline");
  });

  it("is not resurrected by cold recall on a miss", async () => {
    // Hot set holds something unrelated, so the conversation registers a
    // relevance MISS and cold recall runs — the path that rehydrates archived
    // memories. Outline must stay buried even then.
    await seedEntry("char-v", "e-hot", "sourdough starter feeding schedule");
    await seedEntry("char-v", "e-cold-outline", "the KCI pickup with Erica Cathmore in Kansas",
      { provenance: "unplayed" });
    await moveToCold("character", "char-v", ["e-cold-outline"]);

    const res = await loadContext({
      characterId: "char-v", chatId: "chat-v", turnNumber: 1,
      recentText: "cathmore kansas pickup",
      skipCredit: true,
    }, BUDGET);

    expect(res.surfaced.map((s) => s.id)).not.toContain("e-cold-outline");
  });

  it("played entries are unaffected — absent provenance still recalls", async () => {
    await seedEntry("char-w", "e-played", "Erica Cathmore is a Marine buddy of Thomas's");

    const res = await loadContext({
      characterId: "char-w", chatId: "chat-w", turnNumber: 1,
      recentText: "remind me about Cathmore",
      skipCredit: true,
    }, BUDGET);

    expect(res.surfaced.map((s) => s.id)).toContain("e-played");
  });

  it("an explicit played stamp recalls the same as an absent one", async () => {
    await seedEntry("char-x", "e-explicit", "Erica Cathmore is a Marine buddy of Thomas's",
      { provenance: "played" });

    const res = await loadContext({
      characterId: "char-x", chatId: "chat-x", turnNumber: 1,
      recentText: "remind me about Cathmore",
      skipCredit: true,
    }, BUDGET);

    expect(res.surfaced.map((s) => s.id)).toContain("e-explicit");
  });
});
