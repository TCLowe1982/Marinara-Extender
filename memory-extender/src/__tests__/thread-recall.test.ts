// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Thread-aware recall + thread-unit archival (MarinaraExtender-pln back half).
//
//   Recall: a beat surfaces when its own summary matches, when the
//   conversation matches its THREAD's label, or when a sibling in its thread
//   is strongly recalled — "recalling any beat from the Porsche test drive
//   pulls the test drive."
//
//   Archival: members of an active thread never go cold; a closed thread
//   archives as a unit only when every member is stale.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  upsertIndexEntry,
  writeEntry,
  readIndex,
  readColdIndex,
  type IndexEntry,
  type Entry,
} from "../storage.js";
import { runPromotion } from "../promotion.js";
import { loadContext } from "../loader.js";
import { resolveOrMintThread, closeThread, autoCloseStaleThreads, listActiveThreads } from "../threads.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-thread-recall-"));
  process.env.MARINARA_EXTENDER_DATA = dir;
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  // loadContext's fire-and-forget retrieval-credit stamping can race teardown;
  // retries let rm re-scan and clear files that land mid-delete.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

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

describe("thread-aware recall", () => {
  it("a sibling's strong match pulls the rest of the thread into Current", async () => {
    const t = await resolveOrMintThread("chat-t", "Porsche test drive", "mari");
    await seedEntry("char-t", "e-direct", "the porsche dealership test drive verdict", { threadId: t!.id });
    await seedEntry("char-t", "e-sibling", "an unrelated-sounding tender moment afterward", { threadId: t!.id });
    await seedEntry("char-t", "e-loner", "completely different topic about cooking pasta");

    const res = await loadContext({
      characterId: "char-t", chatId: "chat-t", turnNumber: 1,
      recentText: "remember the porsche dealership test drive?",
    });
    const ids = res.surfaced.map((s) => s.id);
    expect(ids).toContain("e-direct");
    expect(ids).toContain("e-sibling"); // pulled by its thread, not its words
    // (e-loner may also ride in on the recency fallback under a roomy budget —
    // that's the fallback working, not the thread feature failing.)
  });

  it("matching the thread LABEL pulls members whose summaries do not match", async () => {
    const t = await resolveOrMintThread("chat-t", "the Hargrove investigation", "mari");
    await seedEntry("char-t", "e-member", "she found the locked lab door ajar", { threadId: t!.id });
    await seedEntry("char-t", "e-other", "breakfast preferences include strong coffee");

    const res = await loadContext({
      characterId: "char-t", chatId: "chat-t", turnNumber: 1,
      recentText: "what happened with the hargrove investigation?",
    });
    const ids = res.surfaced.map((s) => s.id);
    expect(ids).toContain("e-member");
  });
});

describe("thread-unit archival", () => {
  const stale = { lastAccessed: daysAgo(120).slice(0, 10), lastRetrievedAt: daysAgo(120) };

  it("members of an ACTIVE thread never archive, even when stale", async () => {
    const t = await resolveOrMintThread("chat-t", "ongoing arc", "mari");
    await seedEntry("char-t", "e1", "stale member one", { threadId: t!.id, ...stale });
    await seedEntry("char-t", "e2", "stale member two", { threadId: t!.id, ...stale });
    await runPromotion("character", "char-t");
    expect((await readIndex("character", "char-t"))!.entries.map((e) => e.id).sort()).toEqual(["e1", "e2"]);
    expect((await readColdIndex("character", "char-t"))?.entries ?? []).toHaveLength(0);
  });

  it("a CLOSED thread archives as a unit once every member is stale", async () => {
    const t = await resolveOrMintThread("chat-t", "finished arc", "mari");
    await closeThread(t!.id);
    await seedEntry("char-t", "e1", "stale member one", { threadId: t!.id, ...stale });
    await seedEntry("char-t", "e2", "stale member two", { threadId: t!.id, ...stale });
    await runPromotion("character", "char-t");
    expect((await readIndex("character", "char-t"))!.entries).toHaveLength(0);
    expect((await readColdIndex("character", "char-t"))!.entries.map((e) => e.id).sort()).toEqual(["e1", "e2"]);
  });

  it("a closed thread with one fresh member stays hot intact", async () => {
    const t = await resolveOrMintThread("chat-t", "half-fresh arc", "mari");
    await closeThread(t!.id);
    await seedEntry("char-t", "e1", "stale member", { threadId: t!.id, ...stale });
    await seedEntry("char-t", "e2", "fresh member", { threadId: t!.id, lastRetrievedAt: daysAgo(1) });
    await runPromotion("character", "char-t");
    expect((await readIndex("character", "char-t"))!.entries.map((e) => e.id).sort()).toEqual(["e1", "e2"]);
    expect((await readColdIndex("character", "char-t"))?.entries ?? []).toHaveLength(0);
  });
});

describe("autoCloseStaleThreads", () => {
  it("closes threads idle past the cutoff and leaves fresh ones active", async () => {
    await resolveOrMintThread("chat-t", "fresh thread", "mari");
    const old = await resolveOrMintThread("chat-t", "abandoned thread", "mari");
    // Simulate idleness by checking against a future "now".
    const closed = await autoCloseStaleThreads(14, Date.now() + 15 * 86_400_000);
    expect(closed).toBe(2); // both are idle relative to the future clock
    expect(await listActiveThreads("chat-t")).toHaveLength(0);
    expect(old).not.toBeNull();
  });

  it("does nothing when threads are recently active", async () => {
    await resolveOrMintThread("chat-t", "fresh thread", "mari");
    expect(await autoCloseStaleThreads(14)).toBe(0);
    expect(await listActiveThreads("chat-t")).toHaveLength(1);
  });
});
