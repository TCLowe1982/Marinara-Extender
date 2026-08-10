// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Retire the companion entries the s8qe beat retirement left recallable (41uo).
// DRY RUN BY DEFAULT — pass --apply to write.
//
// THE WOUND: retireBeats marked the beat and nothing else, and the loader never
// reads the beat store for recall — it ranks over the ENTRY index, whose
// exclusions are deletedAt / discardedAt / supersededBy / unplayed. retiredAt is
// not among them and cannot be: it lives on the beat. So the s8qe sub-floor
// cleanup (517 beats whose whole chunk was a bare token like "open", parsed out
// of a `status: open` line) removed those records from statistics and arc
// promotion and left 366 recallable copies in place — entries whose summary is
// "[emotion] <motivation invented about the word 'open'>". The half that reaches
// the model is the half that stayed.
//
// THE STRUCTURAL FIX SHIPPED FIRST: retireBeats now retires the companion
// itself, veto included, so the two halves cannot drift apart again. This script
// is the REPAIR for the population retired before that fix existed.
//
// THE VETO IS THE HARD PART, and pe4o's run is the template. The join is a
// summary match and sub-floor motivations are formulaic by construction, so the
// entry named by a retired beat's summary may equally be the only recallable
// copy of a beat nobody retired. A companion is retired ONLY when no live beat
// produces the same summary; anything ambiguous is reported and left alone.
// Machine text left in recall is recoverable; a real memory removed is not.
//
// Usage:
//   node scripts/retire-s8qe-companions.mjs                    # dry run, whole store
//   node scripts/retire-s8qe-companions.mjs --only <character> # canary
//   node scripts/retire-s8qe-companions.mjs --apply            # snapshot, then write

import { readdir } from "fs/promises";

const { getDataDir, readIndex, readColdIndex, retireEntries } = await import("../dist/storage.js");
const { snapshotScope } = await import("../dist/backup.js");
const { readAllBeats, companionEntryFromBeat } = await import("../dist/sentiment/encoder.js");
const { recordStatsEvent } = await import("../dist/stats-events.js");

const APPLY = process.argv.includes("--apply");
const ONLY = (() => { const i = process.argv.indexOf("--only"); return i > 0 ? process.argv[i + 1] : null; })();

const S8QE = "s8qe";
const REASON = "companion of an s8qe sub-floor beat (41uo) — the beat retired, the recallable half did not";

const collapse = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

const allChars = await readdir(`${getDataDir()}/characters`).catch(() => []);
const chars = ONLY ? allChars.filter((c) => c === ONLY) : allChars;

const plan = new Map();       // ch -> [{entryId, beatId, summary}]
const vetoed = [];            // {ch, beatId, want, keptCount}
let s8qeBeats = 0, noCompanion = 0, alreadyCold = 0;

for (const ch of chars) {
  const all = await readAllBeats(ch, { includeRetired: true }).catch(() => []);

  // Every summary a LIVE beat produces — the veto set. Rendered through
  // companionEntryFromBeat at read time, same as the join itself, so the two
  // sides cannot disagree about rendering.
  const kept = new Map(); // summary -> count
  for (const b of all) {
    if (b.retiredAt) continue;
    const k = collapse(companionEntryFromBeat(b).summary);
    if (k) kept.set(k, (kept.get(k) ?? 0) + 1);
  }

  const index = await readIndex("character", ch).catch(() => null);
  const cold = await readColdIndex("character", ch).catch(() => null);
  const liveBySummary = new Map(); // summary -> [rows]
  for (const e of index?.entries ?? []) {
    if (e.discardedAt || e.deletedAt) continue;
    const k = collapse(e.summary);
    if (!liveBySummary.has(k)) liveBySummary.set(k, []);
    liveBySummary.get(k).push(e);
  }
  const coldSummaries = new Set((cold?.entries ?? []).map((e) => collapse(e.summary)));

  const seenEntry = new Set();
  for (const b of all) {
    if (!b.retiredAt || !String(b.retiredReason ?? "").includes(S8QE)) continue;
    s8qeBeats++;
    const want = collapse(companionEntryFromBeat(b).summary);
    if (!want) { noCompanion++; continue; }
    const keptCount = kept.get(want) ?? 0;
    if (keptCount > 0) { vetoed.push({ ch, beatId: b.id, want, keptCount }); continue; }
    const rows = liveBySummary.get(want) ?? [];
    if (rows.length === 0) {
      if (coldSummaries.has(want)) alreadyCold++; else noCompanion++;
      continue;
    }
    for (const e of rows) {
      if (seenEntry.has(e.id)) continue;
      seenEntry.add(e.id);
      if (!plan.has(ch)) plan.set(ch, []);
      plan.get(ch).push({ entryId: e.id, beatId: b.id, summary: want });
    }
  }
}

const total = [...plan.values()].reduce((a, r) => a + r.length, 0);
console.log(`s8qe-retired beats scanned : ${s8qeBeats}`);
console.log(`companion entries LIVE     : ${total}   <- these still reach the model`);
console.log(`already cold               : ${alreadyCold}`);
console.log(`no companion found         : ${noCompanion}`);
console.log(`VETOED (shared summary)    : ${vetoed.length}\n`);

for (const [ch, rows] of plan) {
  console.log(`── ${ch} (${rows.length}) ──`);
  for (const r of rows.slice(0, 8)) console.log(`  ${r.entryId}  ${JSON.stringify(r.summary.slice(0, 80))}`);
  if (rows.length > 8) console.log(`  … and ${rows.length - 8} more`);
}

if (vetoed.length) {
  const byText = new Map();
  for (const v of vetoed) {
    if (!byText.has(v.want)) byText.set(v.want, { n: 0, kept: 0 });
    const g = byText.get(v.want); g.n++; g.kept = Math.max(g.kept, v.keptCount);
  }
  console.log(`\n── VETOED: left alone, summary shared with live beat(s) ──`);
  for (const [text, g] of [...byText].sort((a, b) => b[1].n - a[1].n).slice(0, 10)) {
    console.log(`  ${String(g.n).padStart(4)} retired beat(s), ${String(g.kept).padStart(3)} live: ${JSON.stringify(text.slice(0, 70))}`);
  }
}

if (!APPLY) {
  console.log("\nDRY RUN. Nothing was written. Re-run with --apply.");
  process.exit(0);
}

console.log("\nSNAPSHOTTING…");
for (const ch of plan.keys()) {
  await snapshotScope("character", ch);
  console.log(`  snapshot: character:${ch}`);
}

console.log("\nAPPLYING…");
let retired = 0;
for (const [ch, rows] of plan) {
  const done = await retireEntries("character", ch, rows.map((r) => r.entryId), REASON);
  retired += done.length;
  console.log(`  ${ch}: retired ${done.length}/${rows.length}`);
}

const event = await recordStatsEvent({
  kind: "retirement",
  issue: "MarinaraExtender-41uo",
  reason:
    "Retired the companion entries the s8qe sub-floor cleanup left recallable. " +
    "retireBeats marked only the beat; the loader ranks over the entry index, " +
    "where retiredAt does not and cannot exist. The structural fix (retireBeats " +
    "now retires the companion, veto included) shipped first; this is the repair " +
    "for the population retired before it.",
  selector: `beat.retiredReason includes "s8qe" && no live beat shares companionEntryFromBeat(beat).summary`,
  counts: { entries: retired, vetoed: vetoed.length },
  spared: `${vetoed.length} entries whose summary a live beat also produces — cannot be attributed to the retired beat alone.`,
  affectsHistoricalCurves: false,
});

console.log(`\nretired ${retired} companion entr${retired === 1 ? "y" : "ies"}.  stats event: ${event.id}`);
console.log("Mark, not delete — full fidelity in cold, reason recorded, restorable.");
