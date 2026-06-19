// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Supersession history + rollback (MarinaraExtender-3pl / FR4) — the backend the
// ledger UI's "Retired" section calls. Restore (undo) and flip semantics, over
// real storage in a temp dir.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createEntry } from "../dedup.js";
import { readIndex, supersedeEntry, restoreSupersededEntry } from "../storage.js";
import { factHistory, listRetired, rollback } from "../rollback.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "me-rollback-")); process.env.MARINARA_EXTENDER_DATA = join(dir, "data"); });
afterEach(async () => { delete process.env.MARINARA_EXTENDER_DATA; await rm(dir, { recursive: true, force: true }); });

// A retired by B (B is the canonical that replaced A).
const seed = async () => {
  const a = await createEntry("character", "mari", { lane: "character_topics", summary: "Mari sold a fix to someone", content: "Mari sold a fix to someone", kind: "trait" });
  const b = await createEntry("character", "mari", { lane: "character_topics", summary: "Mari sold a solution to someone", content: "Mari sold a solution to someone", kind: "trait" });
  await supersedeEntry("character", "mari", a.id, b.id);
  return { a, b };
};
const activeIds = async () => ((await readIndex("character", "mari"))?.entries ?? []).filter((e) => !e.supersededBy).map((e) => e.id);

describe("restoreSupersededEntry", () => {
  it("brings a retired entry back to active, clears its link, reports the replacement", async () => {
    const { a, b } = await seed();
    expect(await activeIds()).toEqual([b.id]); // a is retired
    const res = await restoreSupersededEntry("character", "mari", a.id);
    expect(res).toEqual({ replacedBy: b.id });
    expect(await activeIds()).toContain(a.id);
    const h = await factHistory("character", "mari", a.id);
    expect(h.status).toBe("active");
    expect(h.supersededBy).toBeUndefined();
  });

  it("returns null for an id that isn't superseded", async () => {
    const { b } = await seed();
    expect(await restoreSupersededEntry("character", "mari", b.id)).toBeNull();
  });
});

describe("factHistory + listRetired", () => {
  it("shows the chain both directions", async () => {
    const { a, b } = await seed();
    const ha = await factHistory("character", "mari", a.id);
    expect(ha).toMatchObject({ status: "superseded", supersededBy: b.id });
    const hb = await factHistory("character", "mari", b.id);
    expect(hb.status).toBe("active");
    expect(hb.superseded.map((s) => s.id)).toEqual([a.id]);
  });

  it("listRetired returns the retired entry with its replacement", async () => {
    const { a, b } = await seed();
    const r = await listRetired("character", "mari");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: a.id, replacedBy: { id: b.id } });
  });
});

describe("rollback", () => {
  it("undo: restores the retired fact, replacement stays active (both live)", async () => {
    const { a, b } = await seed();
    const res = await rollback("character", "mari", a.id);
    expect(res).toMatchObject({ restored: a.id, replacement: b.id, flipped: false });
    const active = await activeIds();
    expect(active).toContain(a.id);
    expect(active).toContain(b.id);
  });

  it("flip: restored fact becomes canonical, replacement is re-superseded by it", async () => {
    const { a, b } = await seed();
    const res = await rollback("character", "mari", a.id, { flip: true });
    expect(res).toMatchObject({ restored: a.id, replacement: b.id, flipped: true });
    const active = await activeIds();
    expect(active).toContain(a.id);
    expect(active).not.toContain(b.id); // b now retired
    expect(await factHistory("character", "mari", b.id)).toMatchObject({ status: "superseded", supersededBy: a.id });
  });

  it("returns null when the id isn't a superseded entry", async () => {
    const { b } = await seed();
    expect(await rollback("character", "mari", b.id)).toBeNull();
  });
});
