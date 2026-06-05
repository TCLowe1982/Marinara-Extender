// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Backup & snapshot — protect the one thing that can't be regenerated: the YAML
// memory store. Two layers:
//   1. backupDataDir() — a full, on-demand copy of the data dir to a timestamped
//      sibling folder ("back up my memories").
//   2. snapshotScope() — a cheap automatic copy of a scope's INDEX/map files
//      before a destructive op (clear, re-import). The index is the map; losing
//      or clobbering it orphans everything (it has happened), so it's snapshotted
//      first and the last few are kept.
// Dependency-free (fs.cp / copyFile). No archive lib.

import { cp, mkdir, copyFile, readdir, rm, stat } from "fs/promises";
import { join, dirname, relative } from "path";
import { getDataDir, scopeDir, type Scope } from "./storage.js";

const SNAPSHOT_KEEP = 5;

function timestamp(): string {
  // ISO prefix keeps names chronologically sortable; the random suffix prevents
  // collisions between snapshots taken within the same millisecond.
  return new Date().toISOString().replace(/[:.]/g, "-") + "-" + Math.random().toString(36).slice(2, 6);
}

async function countFiles(dir: string): Promise<number> {
  let n = 0;
  let entries: import("fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) n += await countFiles(p);
    else n += 1;
  }
  return n;
}

// Full copy of the data dir to <data>/../marinara-extender-backups/backup-<ts>.
// Excludes our own snapshot dir so backups don't nest/bloat.
export async function backupDataDir(): Promise<{ dir: string; files: number }> {
  const data = getDataDir();
  const dest = join(data, "..", "marinara-extender-backups", `backup-${timestamp()}`);
  await mkdir(dirname(dest), { recursive: true });
  await cp(data, dest, {
    recursive: true,
    filter: (src) => {
      const rel = relative(data, src);
      return !rel.startsWith(".snapshots"); // don't copy snapshots into the backup
    },
  });
  return { dir: dest, files: await countFiles(dest) };
}

// Snapshot a scope's small index/map files before a destructive change. Keeps the
// last SNAPSHOT_KEEP per scope. Best-effort — never throws into the caller.
export async function snapshotScope(scope: Scope, scopeId: string): Promise<void> {
  try {
    const dir = scopeDir(scope, scopeId); // also validates scopeId (throws on unsafe)
    const safeId = scopeId.replace(/[^A-Za-z0-9_-]/g, "_");
    const root = join(getDataDir(), ".snapshots", `${scope}__${safeId}`);
    const dest = join(root, timestamp());

    const mapFiles = ["index.yaml", "index.cold.yaml", "bookmarks.yaml", join("beats", "index.yaml")];
    let copied = 0;
    for (const f of mapFiles) {
      try {
        await stat(join(dir, f)); // skip absent files
        await mkdir(dirname(join(dest, f)), { recursive: true });
        await copyFile(join(dir, f), join(dest, f));
        copied++;
      } catch { /* file not present — fine */ }
    }
    if (copied === 0) {
      await rm(dest, { recursive: true, force: true }).catch(() => {});
      return;
    }
    // Retention: keep only the most recent SNAPSHOT_KEEP.
    const snaps = (await readdir(root).catch(() => [])).sort();
    for (let i = 0; i < snaps.length - SNAPSHOT_KEEP; i++) {
      await rm(join(root, snaps[i]!), { recursive: true, force: true }).catch(() => {});
    }
  } catch {
    // Snapshotting must never block or fail the operation it's protecting.
  }
}
