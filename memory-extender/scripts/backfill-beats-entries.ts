// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// One-time backfill: create retrievable character_topics ledger entries from
// every character's stored beats. Needed for beats imported before the pipeline
// wrote companion entries — the loader reads entries, not beats, so those beats
// were analyzed but never recallable. Deduped + idempotent; safe to re-run.
//
// Run from the memory-extender directory (sidecar can be stopped):
//   npx tsx scripts/backfill-beats-entries.ts

import { readdir } from "fs/promises";
import { join } from "path";
import { readAllBeats, companionEntryFromBeat } from "../src/sentiment/encoder.js";
import { createEntryIfUnique } from "../src/dedup.js";

const DATA = process.env.MARINARA_EXTENDER_DATA ?? "./data";

async function main() {
  const charsDir = join(DATA, "characters");
  const keys = (await readdir(charsDir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  let totalCreated = 0;
  for (const key of keys) {
    const beats = await readAllBeats(key);
    if (beats.length === 0) continue;
    let created = 0;
    for (const beat of beats) {
      const { summary, content } = companionEntryFromBeat(beat);
      if (!summary) continue;
      const entry = await createEntryIfUnique("character", key, { lane: "character_topics", summary, content });
      if (entry) created++;
    }
    totalCreated += created;
    console.log(`  ${key}: ${created} entries created from ${beats.length} beats`);
  }
  console.log(`\nDone — ${totalCreated} retrievable entries created.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
