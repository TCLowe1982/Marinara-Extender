// Tiered cold storage: archival (not deletion) of stale entries + rehydration.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  upsertIndexEntry,
  readIndex,
  readColdIndex,
  moveToCold,
  promoteFromCold,
  type IndexEntry,
} from "../storage.js";
import { runPromotion, recordRecitation } from "../promotion.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-cold-"));
  process.env.MARINARA_EXTENDER_DATA = dir;
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true });
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function row(id: string, over: Partial<IndexEntry> = {}): IndexEntry {
  return {
    id, path: `char-topics/${id}.yaml`, summary: `summary for ${id}`,
    tokens: 20, lane: "character_topics", lastAccessed: daysAgo(0).slice(0, 10),
    ...over,
  };
}

describe("cold index move/promote", () => {
  it("moves rows hot → cold and back, leaving the other rows alone", async () => {
    await upsertIndexEntry("character", "c", row("e1"));
    await upsertIndexEntry("character", "c", row("e2"));
    expect((await readIndex("character", "c"))!.entries).toHaveLength(2);

    expect(await moveToCold("character", "c", ["e1"])).toBe(1);
    expect((await readIndex("character", "c"))!.entries.map((e) => e.id)).toEqual(["e2"]);
    expect((await readColdIndex("character", "c"))!.entries.map((e) => e.id)).toEqual(["e1"]);

    const back = await promoteFromCold("character", "c", "e1");
    expect(back?.id).toBe("e1");
    expect((await readIndex("character", "c"))!.entries.map((e) => e.id).sort()).toEqual(["e1", "e2"]);
    expect((await readColdIndex("character", "c"))!.entries).toHaveLength(0);
  });
});

describe("runPromotion archival", () => {
  it("archives stale non-core entries to cold (not delete) and keeps core hot", async () => {
    await upsertIndexEntry("character", "c2", row("stale", { tier: "short", retrievalCount: 1, lastRetrievedAt: daysAgo(100), lastAccessed: daysAgo(100).slice(0, 10) }));
    await upsertIndexEntry("character", "c2", row("permanent", { tier: "core", retrievalCount: 30, lastRetrievedAt: daysAgo(100), lastAccessed: daysAgo(100).slice(0, 10) }));

    await runPromotion("character", "c2");

    const hot = (await readIndex("character", "c2"))!.entries.map((e) => e.id);
    const cold = (await readColdIndex("character", "c2"))?.entries.map((e) => e.id) ?? [];
    expect(cold).toContain("stale");        // retained, not deleted
    expect(hot).not.toContain("stale");     // out of the hot scan
    expect(hot).toContain("permanent");     // core never leaves hot
  });

  it("leaves recently-used entries in the hot index", async () => {
    await upsertIndexEntry("character", "c2b", row("fresh", { tier: "short", retrievalCount: 1, lastRetrievedAt: daysAgo(2) }));
    await runPromotion("character", "c2b");
    expect((await readIndex("character", "c2b"))!.entries.map((e) => e.id)).toContain("fresh");
    expect((await readColdIndex("character", "c2b"))?.entries ?? []).toHaveLength(0);
  });
});

describe("recordRecitation rehydration", () => {
  it("brings a recited cold entry back to hot and stamps it", async () => {
    await upsertIndexEntry("character", "c3", row("x"));
    await moveToCold("character", "c3", ["x"]);
    expect((await readIndex("character", "c3"))!.entries).toHaveLength(0);

    await recordRecitation("character", "c3", "x");

    const hot = (await readIndex("character", "c3"))!.entries;
    expect(hot.map((e) => e.id)).toContain("x");
    expect(hot.find((e) => e.id === "x")?.recitationCount).toBe(1);
    expect((await readColdIndex("character", "c3"))?.entries ?? []).toHaveLength(0);
  });
});
