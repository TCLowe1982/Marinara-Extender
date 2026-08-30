// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// BACKFILL `created` ONTO INDEX ROWS (dqs1).
//
// IndexEntry gained a `created` field because its absence was silent and
// expensive: the identity fork read `row.created ?? row.lastAccessed`, and with
// no row carrying `created` the shared-childhood test became "has not been READ
// since the split". The entry FILES have always carried the real date; only the
// index did not. This copies it across.
//
// A row whose entry file is missing or unreadable is LEFT ALONE rather than
// given a guessed date. Absent means unknown, and a wrong date here is worse
// than no date: the consumer falls through to chat ownership, which is recorded
// truthfully, whereas a fabricated date would silently re-parent the memory.
//
//   node scripts/backfill-created.mjs            report only, writes nothing
//   node scripts/backfill-created.mjs --write    apply

import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(PKG, "data", "characters");
const WRITE = process.argv.includes("--write");

// hdq1 GUARD. This script writes index.yaml, and the store's indexes are JSON as
// of the hdq1 migration. It has already served its purpose and is kept for the
// record, so rather than teach it a second format it refuses to run against a
// migrated store — a rewrite here would put a stale YAML back alongside the live
// JSON, and the reader prefers whichever it finds first.
{
  const { existsSync: _ex, readdirSync: _rd } = await import("node:fs");
  const { join: _j } = await import("node:path");
  const _migrated = _rd(ROOT).some((s) => {
    try { return _ex(_j(ROOT, s, "index.json")); } catch { return false; }
  });
  if (_migrated) {
    console.error("REFUSING TO RUN: this store's indexes are JSON (hdq1). This script writes index.yaml and would create a stale second copy.");
    console.error("If you genuinely need it, port it to scripts/read-index.mjs first.");
    process.exit(1);
  }
}


let scopes = 0, rows = 0, filled = 0, already = 0, noFile = 0, noDate = 0;

for (const scope of readdirSync(ROOT)) {
  const dir = join(ROOT, scope);
  for (const file of ["index.yaml", "index.cold.yaml"]) {
    const p = join(dir, file);
    if (!existsSync(p)) continue;
    let y;
    try { y = YAML.parse(readFileSync(p, "utf8")); } catch { continue; }
    const entries = y?.entries;
    if (!Array.isArray(entries) || !entries.length) continue;
    scopes++;
    let touched = 0;
    for (const e of entries) {
      rows++;
      if (e.created) { already++; continue; }
      if (!e.path) { noFile++; continue; }
      const ep = join(dir, e.path);
      if (!existsSync(ep)) { noFile++; continue; }
      let created;
      try { created = YAML.parse(readFileSync(ep, "utf8"))?.created; } catch { created = undefined; }
      if (!created) { noDate++; continue; }
      e.created = String(created);
      filled++; touched++;
    }
    if (WRITE && touched) {
      // Belt and braces: the index is the map to every memory in the scope, and
      // data/ is gitignored, so a bad write here has no other copy to fall back
      // on. The .bak sits next to it and is overwritten on each run.
      copyFileSync(p, p + ".bak-dqs1");
      writeFileSync(p, YAML.stringify(y), "utf8");
    }
  }
}

console.log(`scopes with an index : ${scopes}`);
console.log(`rows seen            : ${rows}`);
console.log(`already had created  : ${already}`);
console.log(`FILLED from the file : ${filled}`);
console.log(`entry file missing   : ${noFile}   (left alone - unknown, never guessed)`);
console.log(`file had no created  : ${noDate}   (left alone)`);
console.log(WRITE ? "\nWRITTEN. Each touched index has a .bak-dqs1 beside it." : "\nDRY RUN — pass --write to apply.");
