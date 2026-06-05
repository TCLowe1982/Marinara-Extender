// Backup & snapshot — full data-dir copy and pre-destructive index snapshots.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readdir, access } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { backupDataDir, snapshotScope } from "../backup.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-backup-"));
  process.env.MARINARA_EXTENDER_DATA = join(dir, "data");
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true });
});

const data = () => process.env.MARINARA_EXTENDER_DATA!;
const exists = (p: string) => access(p).then(() => true).catch(() => false);

async function seedScope() {
  await mkdir(join(data(), "characters", "c", "beats"), { recursive: true });
  await writeFile(join(data(), "characters", "c", "index.yaml"), "scope: character\nentries: []\n");
  await writeFile(join(data(), "characters", "c", "beats", "index.yaml"), "entries: []\n");
}

describe("backupDataDir", () => {
  it("copies the data dir to a timestamped sibling, excluding .snapshots", async () => {
    await seedScope();
    await mkdir(join(data(), ".snapshots", "old"), { recursive: true });
    await writeFile(join(data(), ".snapshots", "old", "junk.yaml"), "x: 1\n");

    const { dir: dest, files } = await backupDataDir();

    expect(await exists(join(dest, "characters", "c", "index.yaml"))).toBe(true);
    expect(await exists(join(dest, ".snapshots"))).toBe(false); // excluded
    expect(files).toBeGreaterThanOrEqual(2);
    // Backup lives outside the data dir (a sibling), not nested inside it.
    expect(dest.includes(join("marinara-extender-backups"))).toBe(true);
  });
});

describe("snapshotScope", () => {
  it("snapshots a scope's index files and keeps only the last 5", async () => {
    await seedScope();
    for (let i = 0; i < 7; i++) await snapshotScope("character", "c");

    const root = join(data(), ".snapshots", "character__c");
    const snaps = await readdir(root);
    expect(snaps.length).toBe(5); // retention
    // each snapshot captured the index map file
    expect(await exists(join(root, snaps[0]!, "index.yaml"))).toBe(true);
    expect(await exists(join(root, snaps[0]!, "beats", "index.yaml"))).toBe(true);
  });

  it("is a no-op (creates nothing) when the scope has no index files", async () => {
    await mkdir(data(), { recursive: true });
    await snapshotScope("character", "empty");
    expect(await exists(join(data(), ".snapshots", "character__empty"))).toBe(false);
  });
});
