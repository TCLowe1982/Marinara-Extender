// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Build data/entities.yaml from the whole store (MarinaraExtender-76aw slice 1).
//
// The index is derived, never authored: it is a pure function of the corpus, so
// it can be deleted and rebuilt at any time, and rebuilding after the store
// grows is how new entities and new aliases get learned.
//
// Imports the extractor from the built output rather than reimplementing it —
// the same discipline as the tp5 backfill, and for the same reason: a builder
// that tokenised differently from the reader would produce an index that never
// matches, and fail silently.
//
// Usage:
//   node scripts/build-entity-index.mjs [--dry-run] [--min=3] [--show=40]

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { parse } from "yaml";

const {
  emptyObservations, observeField, buildIndex, writeEntityIndex,
  ALIAS_MIN_INDEPENDENCE, boundTokenCounts, independence,
} = await import("../dist/entities.js");
const { getDataDir, readIndex } = await import("../dist/storage.js");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const SHOW = parseInt((args.find((a) => a.startsWith("--show=")) ?? "").split("=")[1] ?? "40", 10);

const dataDir = getDataDir();
console.log(`data dir: ${dataDir}${DRY ? "  (DRY RUN — nothing will be written)" : ""}`);

async function scopes() {
  const out = [];
  for (const [kind, sub] of [["character", "characters"], ["chat", "chats"]]) {
    try {
      for (const id of await readdir(join(dataDir, sub))) out.push({ scope: kind, scopeId: id, dir: join(dataDir, sub, id) });
    } catch { /* no such scope on this install */ }
  }
  try { await readdir(join(dataDir, "global")); out.push({ scope: "global", scopeId: "global", dir: join(dataDir, "global") }); } catch {}
  return out;
}

const obs = emptyObservations();
let files = 0, unreadable = 0;

for (const { scope, scopeId, dir } of await scopes()) {
  const index = await readIndex(scope, scopeId).catch(() => null);
  if (!index?.entries?.length) continue;
  for (const row of index.entries) {
    // Summary and body are observed SEPARATELY. Scanning them joined lets a name
    // run into the next field and mints entities like "Priya Chandrasekaran
    // Outcome" — 90 of those existed before this was split.
    observeField(row.summary ?? "", obs);
    if (!row.path) continue;
    try {
      const entry = parse(await readFile(join(dir, row.path), "utf8"));
      observeField(entry?.content ?? "", obs);
      files++;
    } catch { unreadable++; }
  }
}

const index = buildIndex(obs);
const people = index.entities.filter((e) => e.person).length;
const withAlias = index.entities.filter((e) => e.aliases.length).length;

console.log(`\nentry files read      : ${files}${unreadable ? `  (${unreadable} unreadable, skipped)` : ""}`);
console.log(`distinct full forms   : ${obs.runs.size}`);
console.log(`entities kept         : ${index.entities.length}  (seen >= ${index.entities.length ? "min" : "?"} times)`);
console.log(`  tagged person       : ${people}`);
console.log(`  with >=1 alias      : ${withAlias}`);

const bound = boundTokenCounts(obs);
console.log(`\ntop ${SHOW} by frequency — alias links shown with each part's independent-use rate:`);
for (const e of index.entities.slice(0, SHOW)) {
  const parts = e.canonical.split(" ")
    .map((p) => `${p}:${independence(p, obs, bound).toFixed(2)}${e.aliases.includes(p.toLowerCase()) ? "*" : ""}`)
    .join("  ");
  console.log(`  ${String(e.count).padStart(5)}  ${e.person ? "person" : "thing "}  ${e.canonical.padEnd(28)} ${parts}`);
}
console.log(`\n  * = linked as an alias (independent use >= ${ALIAS_MIN_INDEPENDENCE})`);

if (DRY) {
  console.log("\nDRY RUN — re-run without --dry-run to write data/entities.yaml.");
} else {
  await writeEntityIndex(index);
  console.log(`\nwrote ${join(dataDir, "entities.yaml")}`);
}
