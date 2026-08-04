// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// MarinaraExtender-s2lw — a re-roll must retire what the discarded reply taught.
//
// 4kbt fixed DETECTION: the sidecar knows a re-roll happened. It did not fix the
// RESPONSE, so the thrown-away reply's facts stayed in the ledger beside the kept
// reply's, and both surfaced as recall.
//
// The retirement is a THIRD reason, distinct from the two that already exist, and
// most of these tests exist to hold that line: it must not masquerade as a user
// delete (the user deleted nothing) and must not claim a replacing entry (a re-roll
// is not 1:1 and often replaces with nothing at all). Over real storage in a tmp dir.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createEntry } from "../dedup.js";
import {
  readIndex,
  readColdIndex,
  discardLosingSwipe,
  listDeleted,
  softDeleteEntry,
} from "../storage.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-swipe-"));
  process.env.MARINARA_EXTENDER_DATA = join(dir, "data");
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true });
});

const fromSwipe = (summary: string, msg: string, swipe?: number) =>
  createEntry("chat", "c1", {
    lane: "user_topics", summary, content: summary, kind: "trait",
    sourceChatId: "c1", sourceMessageId: msg,
    ...(typeof swipe === "number" ? { sourceSwipeIndex: swipe } : {}),
  });

const hotIds = async () => ((await readIndex("chat", "c1"))?.entries ?? []).map((e) => e.id);
const coldRow = async (id: string) =>
  ((await readColdIndex("chat", "c1"))?.entries ?? []).find((e) => e.id === id);

describe("discardLosingSwipe", () => {
  it("retires the losing swipe's entries and keeps the kept swipe's", async () => {
    const discarded = await fromSwipe("Character claims she grew up in Gdansk", "m1", 0);
    const kept = await fromSwipe("Character claims she grew up in Krakow", "m1", 1);

    const retired = await discardLosingSwipe("chat", "c1", "m1", 1);

    expect(retired).toEqual([discarded!.id]);
    expect(await hotIds()).toEqual([kept!.id]);
    expect((await coldRow(discarded!.id))?.discardedAt).toBeTruthy();
  });

  it("never touches entries from a DIFFERENT message", async () => {
    const other = await fromSwipe("An unrelated fact from an earlier turn", "m0", 0);
    await fromSwipe("Something the discarded reply said", "m1", 0);

    await discardLosingSwipe("chat", "c1", "m1", 1);

    expect(await hotIds()).toContain(other!.id);
  });

  it("leaves an entry with NO recorded swipe alone — absent means unknown", async () => {
    // Every entry written before this field existed. Retiring them on a message-id
    // match alone would delete history we cannot prove is stale.
    const legacy = await fromSwipe("A fact captured before swipe provenance existed", "m1");
    await discardLosingSwipe("chat", "c1", "m1", 1);
    expect(await hotIds()).toContain(legacy!.id);
  });

  it("does NOT appear in Recently deleted — the user deleted nothing", async () => {
    // The whole reason discardedAt is its own field. Attributing this to the user
    // would put an act in their history they never performed.
    const discarded = await fromSwipe("From the reply that was thrown away", "m1", 0);
    const reallyDeleted = await fromSwipe("A fact the user removed by hand", "m2", 0);
    await softDeleteEntry("chat", "c1", reallyDeleted!.id);

    await discardLosingSwipe("chat", "c1", "m1", 1);

    const listed = (await listDeleted("chat", "c1")).map((r) => r.id);
    expect(listed).toEqual([reallyDeleted!.id]);
    expect(listed).not.toContain(discarded!.id);
  });

  it("claims no replacing entry — supersededBy stays unset", async () => {
    // A re-roll is not 1:1 and often replaces with nothing. supersededBy is
    // documented as "id of the replacing entry"; a lie there would corrupt the
    // supersession trail and the restore path that reads it.
    const discarded = await fromSwipe("From the discarded reply", "m1", 0);
    await discardLosingSwipe("chat", "c1", "m1", 1);
    expect((await coldRow(discarded!.id))?.supersededBy).toBeUndefined();
  });

  it("retires even when the new swipe produced NOTHING to replace it", async () => {
    // The common case, and the one option C would have skipped: the re-rolled
    // text need not trip the same thresholds, so there may be no new entry at all.
    const discarded = await fromSwipe("From the discarded reply", "m1", 0);
    const retired = await discardLosingSwipe("chat", "c1", "m1", 1);
    expect(retired).toEqual([discarded!.id]);
    expect(await hotIds()).toEqual([]);
  });

  it("is idempotent across repeated re-rolls of the same message", async () => {
    await fromSwipe("From swipe 0", "m1", 0);
    const first = await discardLosingSwipe("chat", "c1", "m1", 2);
    const second = await discardLosingSwipe("chat", "c1", "m1", 2);
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it("returns nothing for an unknown message id", async () => {
    await fromSwipe("A fact", "m1", 0);
    expect(await discardLosingSwipe("chat", "c1", "m-nope", 1)).toEqual([]);
  });
});
