// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Re-attribute timestamp-mangled speakers (5dqr). DRY RUN BY DEFAULT — --apply to write.
//
// RE-ATTRIBUTE, NOT RETIRE. These beats are real memories about real people; only the
// name has a clock stuck to it. "Thomas Today at 8:04 PM" really was Thomas talking.
// Retiring them would delete 157 genuine moments to fix a parsing bug, which is the
// fqnl error — a provenance failure is triage, not a verdict.
//
// THE GUARD, and it is what keeps this from inventing people: a beat is only
// re-attributed when the recovered name ALREADY EXISTS as a speaker elsewhere in the
// store. "Thomas08" -> "Thomas" is safe because Thomas has beats of his own; a label
// that unmangles to a name nobody has ever spoken under is left exactly where it is
// and reported instead. Existence in the census is the evidence; the regex alone is
// not.
//
// BEAT IDS ARE NOT RECOMPUTED. beatIdForChunk hashes the speaker, so the id no longer
// derives from its own content after this runs. That is deliberate: changing ids would
// break resume and dedup for every already-imported chat, and orphan every companion
// entry that points at one. The id is a stable handle, not a checksum.

import { readdir } from "fs/promises";

const { getDataDir } = await import("../dist/storage.js");
const { readAllBeats, writeBeat } = await import("../dist/sentiment/encoder.js");
const { unmangleSpeaker } = await import("../dist/sentiment/chunker.js");

const APPLY = process.argv.includes("--apply");

// Only labels bearing the timestamp signature are candidates: trailing digits, or a
// "Today at"/doubled-name form. unmangleSpeaker strips trailing digits from anything,
// so restricting the candidate set here stops it reaching labels like "TC06" that are
// not mangled names at all.
const MANGLED_RE = /\d$|(?:Today|Yesterday)\s*at\s*\d*$/i;

const characters = await readdir(`${getDataDir()}/characters`).catch(() => []);

// Census first — the guard needs to know which names are real.
const known = new Set();
const beatsByChar = new Map();
for (const c of characters) {
  const beats = await readAllBeats(c, { includeRetired: true }).catch(() => []);
  beatsByChar.set(c, beats);
  for (const b of beats) {
    const s = String(b.speaker ?? "").trim();
    if (s && !MANGLED_RE.test(s)) known.add(s);
  }
}
console.log(`known (unmangled) speaker labels: ${known.size}\n`);

const plan = [];
const orphans = new Map();
for (const [c, beats] of beatsByChar) {
  for (const b of beats) {
    const s = String(b.speaker ?? "").trim();
    if (!s || !MANGLED_RE.test(s)) continue;
    const recovered = unmangleSpeaker(s);
    if (!recovered || recovered === s) continue;
    if (!known.has(recovered)) {
      orphans.set(s, (orphans.get(s) ?? 0) + 1);
      continue;
    }
    plan.push({ character: c, id: b.id, from: s, to: recovered, beat: b });
  }
}

const byPair = new Map();
for (const p of plan) {
  const k = `${p.from} -> ${p.to}`;
  byPair.set(k, (byPair.get(k) ?? 0) + 1);
}

console.log(`TO RE-ATTRIBUTE: ${plan.length} beat(s)`);
for (const [k, n] of [...byPair].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);

if (orphans.size) {
  console.log(`\nLEFT ALONE — unmangles to a name nobody speaks under (${orphans.size}):`);
  for (const [s, n] of [...orphans].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${JSON.stringify(s)} -> ${JSON.stringify(unmangleSpeaker(s))}`);
  }
  console.log("  These are reported, never guessed. If one is a real person, add the");
  console.log("  canonical name to their ledger first and re-run.");
}

if (!APPLY) {
  console.log("\nDRY RUN. Nothing was written. Re-run with --apply.");
  process.exit(0);
}

console.log("\nAPPLYING…");
let n = 0;
for (const p of plan) {
  await writeBeat(p.character, { ...p.beat, speaker: p.to });
  n++;
}
console.log(`re-attributed ${n} beat(s). Beat ids unchanged — see the header for why.`);
