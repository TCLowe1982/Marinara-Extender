// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Backfill IndexEntry.bodyTerms across every scope (MarinaraExtender-tp5).
//
// New entries harvest their body names at write time, but the fix is worthless
// without this: the whole complaint is that memories captured MONTHS ago cannot
// be reached by a name they only mention in their body. On the live store that
// is ~19k character entries and ~3.5k chat entries written before the field
// existed.
//
// Deliberately imports harvestBodyTerms from the built output rather than
// reimplementing it. A backfill that tokenised even slightly differently from
// the loader would write terms that never match at read time, and the failure
// would be invisible — exactly the silent-divergence trap that put the scoring
// vocabulary in its own module in the first place.
//
// Safe to re-run: it is a pure function of (content, summary), so a second pass
// rewrites the same values. Only indexes whose rows actually changed are
// written, and writes go through the same atomic path the server uses.
//
// Usage:
//   node scripts/backfill-body-terms.mjs [--dry-run] [--scope=character|chat|global]

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { parse } from "yaml";

const { harvestBodyTerms } = await import("../dist/relevance.js");
const { getDataDir, readIndex, writeIndex } = await import("../dist/storage.js");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const onlyScope = (args.find((a) => a.startsWith("--scope=")) ?? "").split("=")[1] || null;

const dataDir = getDataDir();
console.log(`data dir: ${dataDir}${DRY ? "  (DRY RUN — nothing will be written)" : ""}`);

async function listScopes() {
  const out = [];
  const dirsFor = async (kind, sub) => {
    try {
      for (const id of await readdir(join(dataDir, sub))) out.push({ scope: kind, scopeId: id });
    } catch { /* directory absent — that scope simply has no data */ }
  };
  if (!onlyScope || onlyScope === "character") await dirsFor("character", "characters");
  if (!onlyScope || onlyScope === "chat") await dirsFor("chat", "chats");
  if (!onlyScope || onlyScope === "global") {
    try { await readdir(join(dataDir, "global")); out.push({ scope: "global", scopeId: "global" }); } catch {}
  }
  return out;
}

const totals = { scopes: 0, rows: 0, harvested: 0, gained: 0, unchanged: 0, missing: 0, unreadable: 0 };

for (const { scope, scopeId } of await listScopes()) {
  const index = await readIndex(scope, scopeId).catch(() => null);
  if (!index?.entries?.length) continue;
  totals.scopes++;

  let changed = 0;
  for (const row of index.entries) {
    totals.rows++;
    if (!row.path) { totals.missing++; continue; }

    let content;
    try {
      const raw = await readFile(join(dataDir, scope === "global" ? "global" : scope === "character" ? `characters/${scopeId}` : `chats/${scopeId}`, row.path), "utf8");
      content = parse(raw)?.content;
    } catch {
      // A row pointing at a file that is gone or torn. Skipped, counted, and
      // NOT written as an empty term list — "we could not look" must never be
      // recorded as "this entry has no names".
      totals.unreadable++;
      continue;
    }

    const terms = harvestBodyTerms(content, row.summary ?? "");
    const before = JSON.stringify(row.bodyTerms ?? null);
    const after = JSON.stringify(terms.length ? terms : null);
    if (before === after) { totals.unchanged++; continue; }

    if (terms.length) { row.bodyTerms = terms; totals.gained++; }
    else delete row.bodyTerms;
    totals.harvested++;
    changed++;
  }

  if (changed && !DRY) await writeIndex(index);
  if (changed) console.log(`  ${scope}/${scopeId}: ${changed} row(s) updated of ${index.entries.length}`);
}

console.log("");
console.log(`scopes touched      : ${totals.scopes}`);
console.log(`rows examined       : ${totals.rows}`);
console.log(`rows updated        : ${totals.harvested}  (${totals.gained} now carry body names)`);
console.log(`already correct     : ${totals.unchanged}`);
console.log(`no path on row      : ${totals.missing}`);
console.log(`entry file unreadable: ${totals.unreadable}`);
if (DRY) console.log("\nDRY RUN — re-run without --dry-run to write.");
