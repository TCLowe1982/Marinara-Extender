// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// MarinaraExtender-a90l — entangled discarded swipes go to a human lane.
//
// s2lw retires what a discarded re-roll taught. That settles a CLEAN case and
// nothing more: retracting a source does not unwind what the source already
// caused. These pin which cases are genuinely entangled, and — just as important —
// which are not, because a lane that queues every discard is a lane nobody reads.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { IndexEntry } from "../storage.js";
import { entanglementReasons, reviewDiscardedEntries } from "../discard-review.js";
import { heldFilePath } from "../reconcile-queue.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-review-"));
  process.env.MARINARA_EXTENDER_DATA = join(dir, "data");
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true });
});

const row = (over: Partial<IndexEntry> = {}): IndexEntry => ({
  id: "utopic-aaa",
  path: "user-topics/utopic-aaa.yaml",
  summary: "A fact the discarded reply taught",
  tokens: 10,
  lane: "user_topics",
  status: "open",
  lastAccessed: "2026-08-04",
  sourceMessageId: "m1",
  sourceSwipeIndex: 0,
  discardedAt: "2026-08-04T12:00:00.000Z",
  ...over,
});

describe("entanglementReasons", () => {
  it("a clean discard has none — retirement is the whole fix", () => {
    expect(entanglementReasons(row(), [])).toEqual([]);
  });

  it("recitation outranks retrieval and is reported alone", () => {
    // Both are true of a recited entry (you cannot recite what was never
    // retrieved). Reporting both would pad every record with a weaker restatement
    // of the stronger signal.
    const reasons = entanglementReasons(row({ recitationCount: 2, retrievalCount: 7 }), []);
    expect(reasons).toEqual(["recited:2"]);
  });

  it("retrieval alone still counts — it reached the prompt", () => {
    expect(entanglementReasons(row({ retrievalCount: 3 }), [])).toEqual(["retrieved:3"]);
  });

  it("thread membership outlives the turn that seeded it", () => {
    expect(entanglementReasons(row({ threadId: "nthr-x1" }), [])).toContain("thread:nthr-x1");
  });

  it("THE ORPHAN: retiring a fact that displaced an older one leaves a dead chain", () => {
    // The concrete case the design note is about. utopic-old was superseded by
    // this entry; retire this one and utopic-old stays dead in cold, superseded by
    // something that is itself retired — no live fact at the end of the chain.
    const displaced = row({ id: "utopic-old", supersededBy: "utopic-aaa" });
    expect(entanglementReasons(row(), [displaced])).toContain("orphans:utopic-old");
  });

  it("ignores unrelated superseded entries in cold", () => {
    const unrelated = row({ id: "utopic-other", supersededBy: "utopic-zzz" });
    expect(entanglementReasons(row(), [unrelated])).toEqual([]);
  });

  it("reports every signal when a case is entangled several ways", () => {
    const displaced = row({ id: "utopic-old", supersededBy: "utopic-aaa" });
    const reasons = entanglementReasons(row({ recitationCount: 1, threadId: "nthr-x1" }), [displaced]);
    expect(reasons).toEqual(["recited:1", "thread:nthr-x1", "orphans:utopic-old"]);
  });
});

describe("reviewDiscardedEntries", () => {
  const held = async () => {
    try {
      return (await readFile(heldFilePath(), "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };

  it("queues nothing for a clean discard", async () => {
    expect(await reviewDiscardedEntries("chat", "c1", [row()], [])).toBe(0);
    expect(await held()).toEqual([]);
  });

  it("records an entangled discard with its reasons and enough detail to act on", async () => {
    const queued = await reviewDiscardedEntries("chat", "c1", [row({ recitationCount: 1 })], []);
    expect(queued).toBe(1);

    const [rec] = await held();
    expect(rec.reasons).toEqual(["discarded-swipe", "recited:1"]);
    expect(rec.detail.entryId).toBe("utopic-aaa");
    expect(rec.detail.sourceMessageId).toBe("m1");
    expect(rec.detail.sourceSwipeIndex).toBe(0);
    expect(rec.scopeId).toBe("c1");
  });

  it("does not widen HeldRecord.source — it stays 'live'", async () => {
    // source is a serialized union; this codebase has been bitten twice by
    // widening those. The specifics belong in reasons/detail, which are free-form.
    await reviewDiscardedEntries("chat", "c1", [row({ recitationCount: 1 })], []);
    expect((await held())[0].source).toBe("live");
  });

  it("queues only the entangled ones out of a mixed batch", async () => {
    const queued = await reviewDiscardedEntries(
      "chat",
      "c1",
      [row({ id: "utopic-clean" }), row({ id: "utopic-recited", recitationCount: 4 })],
      [],
    );
    expect(queued).toBe(1);
    expect((await held()).map((r) => r.detail.entryId)).toEqual(["utopic-recited"]);
  });
});
