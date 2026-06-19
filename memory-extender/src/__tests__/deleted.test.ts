// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Recoverable delete: deleting a memory routes it to cold (restorable), and
// permanent purge is a separate, deliberate step. Over real storage in a tmp dir.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createEntry } from "../dedup.js";
import {
  readIndex,
  readColdIndex,
  softDeleteEntry,
  listDeleted,
  restoreDeletedEntry,
  purgeColdEntry,
  supersedeEntry,
} from "../storage.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "me-deleted-")); process.env.MARINARA_EXTENDER_DATA = join(dir, "data"); });
afterEach(async () => { delete process.env.MARINARA_EXTENDER_DATA; await rm(dir, { recursive: true, force: true }); });

const mk = (summary: string) => createEntry("chat", "c1", { lane: "user_topics", summary, content: summary, kind: "trait" });
const hotIds = async () => ((await readIndex("chat", "c1"))?.entries ?? []).map((e) => e.id);
const coldIds = async () => ((await readColdIndex("chat", "c1"))?.entries ?? []).map((e) => e.id);

describe("softDeleteEntry + listDeleted", () => {
  it("moves the entry to cold marked deletedAt, out of hot, and lists it", async () => {
    const a = await mk("Mari likes tea");
    expect(await hotIds()).toContain(a.id);
    expect(await softDeleteEntry("chat", "c1", a.id)).toBe(true);
    expect(await hotIds()).not.toContain(a.id);
    expect(await coldIds()).toContain(a.id);
    const list = await listDeleted("chat", "c1");
    expect(list.map((d) => d.id)).toEqual([a.id]);
    expect(list[0].deletedAt).toBeTruthy();
  });

  it("returns false for an unknown id", async () => {
    expect(await softDeleteEntry("chat", "c1", "nope")).toBe(false);
  });

  it("does not list superseded entries as deleted", async () => {
    const a = await mk("fact A");
    const b = await mk("fact B");
    await supersedeEntry("chat", "c1", a.id, b.id); // a -> cold via supersede, not delete
    expect(await listDeleted("chat", "c1")).toHaveLength(0);
  });
});

describe("restoreDeletedEntry", () => {
  it("brings a deleted entry back to hot and clears deletedAt", async () => {
    const a = await mk("restore me");
    await softDeleteEntry("chat", "c1", a.id);
    expect(await restoreDeletedEntry("chat", "c1", a.id)).toBe(true);
    expect(await hotIds()).toContain(a.id);
    expect(await coldIds()).not.toContain(a.id);
    expect(await listDeleted("chat", "c1")).toHaveLength(0);
    const row = (await readIndex("chat", "c1"))?.entries.find((e) => e.id === a.id);
    expect(row?.deletedAt).toBeUndefined();
  });

  it("refuses to restore a superseded (non-deleted) cold entry", async () => {
    const a = await mk("fact A");
    const b = await mk("fact B");
    await supersedeEntry("chat", "c1", a.id, b.id);
    expect(await restoreDeletedEntry("chat", "c1", a.id)).toBe(false);
    expect(await hotIds()).not.toContain(a.id); // still cold, untouched
  });
});

describe("purgeColdEntry (the dig)", () => {
  it("permanently removes a cold entry (cold row + file)", async () => {
    const a = await mk("erase me");
    await softDeleteEntry("chat", "c1", a.id);
    expect(await purgeColdEntry("chat", "c1", a.id)).toBe(true);
    expect(await coldIds()).not.toContain(a.id);
    expect(await listDeleted("chat", "c1")).toHaveLength(0);
  });

  it("returns false when the id is not in cold (e.g. still hot)", async () => {
    const a = await mk("hot one");
    expect(await purgeColdEntry("chat", "c1", a.id)).toBe(false);
    expect(await hotIds()).toContain(a.id); // untouched
  });
});
