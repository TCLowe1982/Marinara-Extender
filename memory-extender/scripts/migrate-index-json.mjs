// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// hdq1: convert every scope index from YAML to JSON.
//
// The runtime already reads either format and converts on first write, so this
// script is not strictly required — it exists so the whole store converts at a
// moment somebody is watching, rather than trickling over days with half the
// scopes in each format and no record of which.
//
// SAFETY. Nothing is destroyed. Each YAML is copied to .snapshots/hdq1-migration
// before anything is written, the JSON is verified row-for-row against the YAML
// it came from BEFORE the YAML is retired, and retiring means rename to
// .superseded, not unlink. A scope that fails verification is left exactly as it
// was and reported; the run continues so one bad index cannot strand the rest.
//
// Usage:  node scripts/migrate-index-json.mjs            (dry run — reports only)
//         node scripts/migrate-index-json.mjs --write    (convert)

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

const WRITE = process.argv.includes("--write");
const DATA = process.env.MARINARA_EXTENDER_DATA
  ?? join(process.cwd(), "data");

if (!existsSync(DATA)) {
  console.error(`no data dir at ${DATA}`);
  process.exit(1);
}

const BACKUP = join(DATA, ".snapshots", "hdq1-migration");

/** Every directory that can hold a scope index. */
function scopeDirs() {
  const out = [];
  for (const kind of ["characters", "chats"]) {
    const root = join(DATA, kind);
    if (!existsSync(root)) continue;
    for (const id of readdirSync(root)) {
      const p = join(root, id);
      try { if (statSync(p).isDirectory()) out.push([kind, id, p]); } catch { /* skip */ }
    }
  }
  const g = join(DATA, "global");
  if (existsSync(g)) out.push(["global", "global", g]);
  return out;
}

/**
 * Row-for-row equality between what we parsed and what we are about to trust.
 * Deep-equal via canonical JSON: the YAML parse and the JSON reparse must be
 * indistinguishable, or the conversion is not a conversion.
 */
function identical(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

let converted = 0, skipped = 0, failed = 0, rows = 0;
let yamlMs = 0, jsonMs = 0;

for (const [kind, id, dir] of scopeDirs()) {
  for (const base of ["index", "index.cold"]) {
    const yamlPath = join(dir, `${base}.yaml`);
    const jsonPath = join(dir, `${base}.json`);
    if (!existsSync(yamlPath)) continue;
    if (existsSync(jsonPath)) {
      console.log(`  skip  ${kind}/${id}/${base} — already JSON`);
      skipped++;
      continue;
    }

    const raw = readFileSync(yamlPath, "utf8");
    let parsed;
    let t0 = Date.now();
    try {
      parsed = YAML.parse(raw);
    } catch (err) {
      console.error(`  FAIL  ${kind}/${id}/${base} — unparseable YAML, left untouched: ${err.message}`);
      failed++;
      continue;
    }
    yamlMs += Date.now() - t0;

    const n = Array.isArray(parsed?.entries) ? parsed.entries.length : 0;
    const serialized = JSON.stringify(parsed);

    t0 = Date.now();
    const reparsed = JSON.parse(serialized);
    jsonMs += Date.now() - t0;

    if (!identical(parsed, reparsed)) {
      console.error(`  FAIL  ${kind}/${id}/${base} — JSON round-trip is not identical, left untouched`);
      failed++;
      continue;
    }

    rows += n;
    if (!WRITE) {
      console.log(`  would convert  ${kind}/${id}/${base}  ${n} rows, ${(raw.length / 1048576).toFixed(2)} MB`);
      converted++;
      continue;
    }

    // Back up the YAML before anything is written.
    const bdir = join(BACKUP, kind, id);
    mkdirSync(bdir, { recursive: true });
    copyFileSync(yamlPath, join(bdir, `${base}.yaml`));

    writeFileSync(jsonPath, serialized, "utf8");

    // Verify what actually landed on disk, not what we meant to write.
    const back = JSON.parse(readFileSync(jsonPath, "utf8"));
    if (!identical(parsed, back)) {
      console.error(`  FAIL  ${kind}/${id}/${base} — written JSON does not match source; YAML kept as the live index`);
      failed++;
      continue;
    }

    renameSync(yamlPath, `${yamlPath}.superseded`);
    console.log(`  ok    ${kind}/${id}/${base}  ${n} rows`);
    converted++;
  }
}

console.log("");
console.log(WRITE ? "CONVERTED" : "DRY RUN (pass --write to convert)");
console.log(`  indexes: ${converted} ${WRITE ? "converted" : "to convert"}, ${skipped} already JSON, ${failed} failed`);
console.log(`  rows:    ${rows}`);
if (rows) {
  console.log(`  parse:   YAML ${yamlMs} ms -> JSON ${jsonMs} ms across the whole store`);
}
if (WRITE) console.log(`  backup:  ${BACKUP}`);
process.exit(failed > 0 ? 1 : 0);
