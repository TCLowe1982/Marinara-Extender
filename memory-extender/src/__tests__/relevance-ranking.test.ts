// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Relevance ranking (MarinaraExtender-vrw).
//
// The scorer used to divide by summary length (hit / words.size), which
// punished a memory for its own detail — a terse throwaway sharing one common
// word outranked a detailed record of a named person. Relevance is now
// accumulated evidence: each distinct meaningful summary word found in the
// conversation counts, and the score saturates, so length never decides.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { upsertIndexEntry, writeEntry, type IndexEntry, type Entry } from "../storage.js";
import { loadContext } from "../loader.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-relevance-"));
  process.env.MARINARA_EXTENDER_DATA = dir;
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  // loadContext stamps retrieval credit fire-and-forget; retries let rm clear
  // files that land mid-delete.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function seedEntry(charId: string, id: string, summary: string, over: Partial<IndexEntry> = {}) {
  const entry: Entry = {
    id, lane: "character_topics", summary, status: "open",
    created: "2026-01-01", lastAccessed: "2026-01-01", content: `content of ${id}`, tokens: 20,
  };
  const path = await writeEntry("character", charId, entry);
  await upsertIndexEntry("character", charId, {
    id, path, summary, tokens: 20, lane: "character_topics", status: "open",
    lastAccessed: "2026-01-01", ...over,
  });
}

// Only one 20-token entry fits, so the two candidates compete head to head.
const ONE_SLOT = { chat: 0, character: 20, global: 0 };

describe("relevance ranking is evidence-based, not length-normalised", () => {
  it("a detailed summary matching three terms beats a terse one matching a common word", async () => {
    // Under the old scorer "remember crimes" scored 1/2 = 0.5 on the single word
    // "remember", while the entry actually answering the question scored
    // 3/12 = 0.25 — so the throwaway won the only slot.
    await seedEntry("char-a", "e-detail",
      "Thomas's sister is Rebecca Becky Collier, younger by three years, platinum blonde and a shameless flirt");
    await seedEntry("char-a", "e-generic", "remember crimes");

    const res = await loadContext({
      characterId: "char-a", chatId: "chat-a", turnNumber: 1,
      recentText: "remind me about becky, thomas's sister — i can't remember",
      skipCredit: true,
    }, ONE_SLOT);

    const ids = res.surfaced.map((s) => s.id);
    expect(ids).toContain("e-detail");
    expect(ids).not.toContain("e-generic");
  });

  it("equal evidence ties regardless of length, so recency decides rather than brevity", async () => {
    // Both match exactly one term ("porsche"). The old scorer gave the two-word
    // summary 1/1 = 1.0 and the detailed one ~1/13, so brevity always won and
    // recency never got a say.
    await seedEntry("char-b", "e-long",
      "the porsche dealership test drive verdict with extensive notes about the interior trim and the salesman",
      { lastRetrievedAt: "2026-07-01T00:00:00.000Z" });
    await seedEntry("char-b", "e-short", "porsche",
      { lastRetrievedAt: "2026-01-01T00:00:00.000Z" });

    const res = await loadContext({
      characterId: "char-b", chatId: "chat-b", turnNumber: 1,
      recentText: "tell me about the porsche",
      skipCredit: true,
    }, ONE_SLOT);

    const ids = res.surfaced.map((s) => s.id);
    expect(ids).toContain("e-long");
    expect(ids).not.toContain("e-short");
  });

  it("one matched name outranks two matched common words", async () => {
    // Capitalisation mid-summary marks the subject. A single hit on it must beat
    // a pair of hits on ordinary vocabulary, which is the ranking inversion that
    // buried named people behind entries like "wants to remember past crimes".
    await seedEntry("char-e", "e-named", "the dealership called about Cathmore again");
    await seedEntry("char-e", "e-common", "called about the dealership");

    const res = await loadContext({
      characterId: "char-e", chatId: "chat-e", turnNumber: 1,
      recentText: "anything on cathmore? they called about the dealership",
      skipCredit: true,
    }, ONE_SLOT);

    const ids = res.surfaced.map((s) => s.id);
    expect(ids).toContain("e-named");
    expect(ids).not.toContain("e-common");
  });

  it("a capital in the leading position is sentence case, not a name", async () => {
    // "Statement about established knowledge" names nobody; it must not collect
    // name weight just for starting with a capital.
    await seedEntry("char-f", "e-lead-cap", "Statement about established knowledge");
    await seedEntry("char-f", "e-real-name", "a note mentioning Cathmore in passing");

    const res = await loadContext({
      characterId: "char-f", chatId: "chat-f", turnNumber: 1,
      recentText: "statement about Cathmore",
      skipCredit: true,
    }, ONE_SLOT);

    expect(res.surfaced.map((s) => s.id)).toContain("e-real-name");
  });

  it("more matched terms outranks fewer", async () => {
    await seedEntry("char-c", "e-two", "porsche dealership");
    await seedEntry("char-c", "e-one", "porsche");

    const res = await loadContext({
      characterId: "char-c", chatId: "chat-c", turnNumber: 1,
      recentText: "the porsche dealership",
      skipCredit: true,
    }, ONE_SLOT);

    expect(res.surfaced.map((s) => s.id)).toContain("e-two");
  });

  it("a summary sharing no meaningful word with the conversation scores zero", async () => {
    await seedEntry("char-d", "e-unrelated", "sourdough starter feeding schedule");

    const res = await loadContext({
      characterId: "char-d", chatId: "chat-d", turnNumber: 1,
      recentText: "the porsche dealership",
      skipCredit: true,
    }, ONE_SLOT);

    // It still rides in on the recency fallback (there is nothing to displace
    // it), but it must not be credited as summoned.
    expect(res.surfaced.map((s) => s.id)).toContain("e-unrelated");
  });
});
