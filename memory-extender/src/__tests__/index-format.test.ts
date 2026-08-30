// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// hdq1: the index moved from YAML to JSON. These cover the parts the rest of the
// suite cannot see, because every other test starts from an empty store and so
// only ever exercises the post-migration path.
//
// What is actually at risk here is not the format — it is the two moments where
// a store holds one format and the code expects the other.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { stringify } from "yaml";
import {
  upsertIndexEntry,
  readIndex,
  indexPath,
  legacyIndexPath,
  type IndexEntry,
  type ScopeIndex,
} from "../storage.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-idxfmt-"));
  process.env.MARINARA_EXTENDER_DATA = dir;
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true });
});

const exists = (p: string) => access(p).then(() => true).catch(() => false);

function row(id: string, over: Partial<IndexEntry> = {}): IndexEntry {
  return {
    id,
    path: `entries/${id}.yaml`,
    summary: `summary for ${id}`,
    lane: "fact",
    tier: "short",
    createdAt: new Date().toISOString(),
    lastAccessed: new Date().toISOString(),
    ...over,
  } as IndexEntry;
}

/** Write a pre-hdq1 YAML index directly, as an unmigrated store would have. */
async function seedLegacyIndex(scopeId: string, rows: IndexEntry[]): Promise<string> {
  const p = legacyIndexPath("character", scopeId);
  await mkdir(join(dir, "characters", scopeId), { recursive: true });
  const index: ScopeIndex = {
    scope: "character",
    scopeId,
    lastUpdated: new Date().toISOString(),
    entries: rows,
  };
  await writeFile(p, stringify(index), "utf8");
  return p;
}

describe("index format migration (hdq1)", () => {
  it("reads a legacy YAML index when no JSON index exists", async () => {
    await seedLegacyIndex("legacy_reader", [row("a"), row("b")]);

    const index = await readIndex("character", "legacy_reader");

    expect(index?.entries.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("converts to JSON on first write and retires the YAML it replaced", async () => {
    const yamlPath = await seedLegacyIndex("converts", [row("a"), row("b")]);

    await upsertIndexEntry("character", "converts", row("c"));

    // The JSON is now the index, and it carries the rows that were only ever
    // in the YAML — a conversion that dropped the existing rows and kept the
    // new one would still leave a valid-looking index behind.
    const jsonPath = indexPath("character", "converts");
    expect(await exists(jsonPath)).toBe(true);
    const written = JSON.parse(await readFile(jsonPath, "utf8")) as ScopeIndex;
    expect(written.entries.map((e) => e.id).sort()).toEqual(["a", "b", "c"]);

    // And the YAML is gone from the name any reader looks under. Two live
    // copies of one index is worse than either format on its own: the audit
    // scripts and index-health read by filename and would report the frozen one.
    expect(await exists(yamlPath)).toBe(false);
    expect(await exists(`${yamlPath}.superseded`)).toBe(true);
  });

  it("refuses to overwrite an unreadable LEGACY index instead of rebuilding it", async () => {
    // The guard that matters. Before hdq1 it asked "is there a file at the index
    // path?" — which, once the index path meant .json, answers NO for an
    // unconverted store. An unreadable YAML would then look like a fresh scope
    // and 9,000 rows would be replaced by the single entry being upserted.
    const yamlPath = legacyIndexPath("character", "corrupt_legacy");
    await mkdir(join(dir, "characters", "corrupt_legacy"), { recursive: true });
    await writeFile(yamlPath, "entries:\n  - id: a\n   bad indent: [\n", "utf8");

    await expect(upsertIndexEntry("character", "corrupt_legacy", row("new"))).rejects.toThrow(
      /refusing to overwrite unreadable index/,
    );

    // The damaged file is still there for the repair script, untouched.
    expect(await exists(yamlPath)).toBe(true);
    expect(await exists(indexPath("character", "corrupt_legacy"))).toBe(false);
  });

  it("does not read a stale YAML out from under a corrupt JSON", async () => {
    // Both formats present, JSON corrupt. Falling back would resurrect the old
    // index and present it as a clean load — the guard must see "unreadable",
    // not "absent", so the caller refuses rather than silently reverting.
    await seedLegacyIndex("both_present", [row("old")]);
    await writeFile(indexPath("character", "both_present"), "{ not json", "utf8");

    expect(await readIndex("character", "both_present")).toBeNull();
    await expect(upsertIndexEntry("character", "both_present", row("new"))).rejects.toThrow(
      /refusing to overwrite unreadable index/,
    );
  });

  it("round-trips every field, including the ones only some rows carry", async () => {
    const rich = row("rich", {
      created: "2026-01-02T03:04:05.000Z",
      supersededBy: "other",
      recitationCount: 7,
      subject: { kind: "character", id: "mari" },
    } as Partial<IndexEntry>);
    await upsertIndexEntry("character", "roundtrip", rich);

    const back = await readIndex("character", "roundtrip");

    expect(back?.entries[0]).toEqual(rich);
  });
});
