// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// MarinaraExtender-4z0h — the held lane has to be readable and settleable.
//
// Building the mockup found both gaps these cover: held.jsonl was append-only
// with no way to settle a record, and there was no restore for a discardedAt row.
// The guard tests matter most — three retirement reasons now share one cold index,
// and each restore must touch only its own.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, appendFile, mkdir, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { createEntry } from "../dedup.js";
import {
  readIndex,
  readColdIndex,
  discardLosingSwipe,
  softDeleteEntry,
  supersedeEntry,
  restoreDiscardedEntry,
} from "../storage.js";
import { appendHeld, readHeld, resolveHeld, heldFilePath } from "../reconcile-queue.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-held-"));
  process.env.MARINARA_EXTENDER_DATA = join(dir, "data");
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true });
});

const mk = (summary: string, over: Record<string, unknown> = {}) =>
  createEntry("chat", "c1", { lane: "user_topics", summary, content: summary, kind: "trait", ...over });

const hotIds = async () => ((await readIndex("chat", "c1"))?.entries ?? []).map((e) => e.id);

const held = (over: Record<string, unknown> = {}) => appendHeld({
  source: "live", scope: "chat", scopeId: "c1",
  summary: "Discarded re-roll left a derivative", reasons: ["discarded-swipe", "recited:1"],
  at: new Date().toISOString(), ...over,
} as never);

describe("held lane read + resolve", () => {
  it("assigns an id on append so a reader can act on one record", async () => {
    await held();
    const [rec] = await readHeld();
    expect(rec.id).toMatch(/^hl-/);
  });

  it("resolving stamps the record and drops it from the lane", async () => {
    await held();
    const [rec] = await readHeld();
    expect(await resolveHeld([rec.id!])).toBe(1);
    expect(await readHeld()).toEqual([]);
  });

  it("keeps the resolved record on disk — the lane empties, the record does not", async () => {
    // held.jsonl is the only evidence the withholding ever happened. Emptying the
    // lane must not erase that.
    await held();
    const [rec] = await readHeld();
    await resolveHeld([rec.id!]);
    const onDisk = (await readFile(heldFilePath(), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].resolvedAt).toBeTruthy();
  });

  it("resolving twice is a no-op, not a double count", async () => {
    await held();
    const [rec] = await readHeld();
    expect(await resolveHeld([rec.id!])).toBe(1);
    expect(await resolveHeld([rec.id!])).toBe(0);
  });

  it("survives a torn line rather than losing the whole lane", async () => {
    // Several producers append here. One truncated write must not take down the
    // records around it.
    await held();
    await mkdir(dirname(heldFilePath()), { recursive: true });
    await appendFile(heldFilePath(), '{"source":"live","reasons":["discarded-sw\n', "utf8");
    await held();
    expect(await readHeld()).toHaveLength(2);
  });

  it("returns newest first", async () => {
    await held({ at: "2026-08-01T10:00:00.000Z", summary: "older" });
    await held({ at: "2026-08-04T10:00:00.000Z", summary: "newer" });
    expect((await readHeld()).map((r) => r.summary)).toEqual(["newer", "older"]);
  });
});

describe("restoreDiscardedEntry", () => {
  it("brings a discarded entry back and clears the mark", async () => {
    const e = await mk("From the reply that was thrown away", { sourceMessageId: "m1", sourceSwipeIndex: 0 });
    await discardLosingSwipe("chat", "c1", "m1", 1);
    expect(await hotIds()).toEqual([]);

    expect(await restoreDiscardedEntry("chat", "c1", e!.id)).toBe(true);
    expect(await hotIds()).toEqual([e!.id]);
    const row = (await readIndex("chat", "c1"))!.entries[0];
    expect(row.discardedAt).toBeUndefined();
  });

  it("REFUSES a user-deleted entry — guards do not overlap", async () => {
    // Three retirement reasons now share one cold index. If this guard slipped,
    // "bring back a discarded memory" would silently undo a deliberate delete.
    const e = await mk("A memory the user removed by hand");
    await softDeleteEntry("chat", "c1", e!.id);
    expect(await restoreDiscardedEntry("chat", "c1", e!.id)).toBe(false);
    expect(await hotIds()).toEqual([]);
  });

  it("REFUSES a superseded entry — that is restoreSupersededEntry's row", async () => {
    const older = await mk("The older fact");
    const newer = await mk("The fact that replaced it");
    await supersedeEntry("chat", "c1", older!.id, newer!.id);
    expect(await restoreDiscardedEntry("chat", "c1", older!.id)).toBe(false);
  });

  it("returns false for an unknown id rather than throwing", async () => {
    expect(await restoreDiscardedEntry("chat", "c1", "utopic-nope")).toBe(false);
  });

  it("leaves a discarded entry retired when a DIFFERENT one is restored", async () => {
    const a = await mk("First from the discarded reply", { sourceMessageId: "m1", sourceSwipeIndex: 0 });
    const b = await mk("Second from the discarded reply", { sourceMessageId: "m1", sourceSwipeIndex: 0 });
    await discardLosingSwipe("chat", "c1", "m1", 1);

    await restoreDiscardedEntry("chat", "c1", a!.id);

    expect(await hotIds()).toEqual([a!.id]);
    const still = (await readColdIndex("chat", "c1"))!.entries.find((e) => e.id === b!.id);
    expect(still?.discardedAt).toBeTruthy();
  });
});
