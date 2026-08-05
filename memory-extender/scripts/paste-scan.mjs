// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Calibrate the paste prior (hjt9). READ-ONLY.
//
// THE QUESTION THIS HAS TO ANSWER, and it is not "does it find pastes". It is:
// DOES IT SPARE LONG ROLEPLAY PROSE. A 6KB scene is exactly what this system
// exists to remember, and a size prior that routes it into an ops lane would
// destroy the best memories in the store while looking like it was working.
//
// So the report leads with the false-positive surface: the LONGEST chunks the
// detector calls pastes, sorted so the most prose-like come first. Those get read
// by hand. Recall is secondary — an under-caught paste leaves junk that other
// layers still see, while a misrouted scene is hidden memory.
//
// Usage:
//   node scripts/paste-scan.mjs [--show=N] [--threshold=0.6]

import { readdir } from "fs/promises";
import { join } from "path";

const { getDataDir } = await import("../dist/storage.js");
const { readAllBeats } = await import("../dist/sentiment/encoder.js");
const { pasteEvidence, PASTE_THRESHOLD, SIZE_SOFT, SIZE_HARD } = await import("../dist/sentiment/paste-prior.js");

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=")[1] ?? d;
const SHOW = parseInt(arg("show", "10"), 10);
const THRESHOLD = parseFloat(arg("threshold", String(PASTE_THRESHOLD)));

const dataDir = getDataDir();
const rows = [];
for (const c of await readdir(join(dataDir, "characters")).catch(() => [])) {
  for (const b of await readAllBeats(c, { includeRetired: true }).catch(() => [])) {
    const text = String(b.text ?? "");
    if (!text) continue;
    rows.push({ c, text, ev: pasteEvidence(text), retired: !!b.retiredAt, emotion: b.emotion });
  }
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const flagged = rows.filter((r) => r.ev.score >= THRESHOLD);
const spared = rows.filter((r) => r.ev.score < THRESHOLD);

console.log(`chunks examined : ${rows.length}`);
console.log(`size prior      : soft ${SIZE_SOFT} → hard ${SIZE_HARD} chars`);
console.log(`threshold       : ${THRESHOLD}`);
console.log(`flagged as paste: ${flagged.length} (${pct(flagged.length / rows.length)})`);

// The honest cross-tab: what does size ALONE claim, versus the posterior? The gap
// is the number of real memories a naive size threshold would have taken.
const bigOnly = rows.filter((r) => r.chars >= SIZE_HARD || r.ev.chars >= SIZE_HARD);
const bigSpared = bigOnly.filter((r) => r.ev.score < THRESHOLD);
console.log(`\nchunks at or above ${SIZE_HARD} chars : ${bigOnly.length}`);
console.log(`  of those, SPARED by structure : ${bigSpared.length}  <- what a naive size rule would have taken`);

console.log("\nSIZE BUCKETS");
console.log("  chars            n   flagged   median-line   short-line%   structure%");
const EDGES = [0, 500, 1500, 3000, 6000, 12000, Infinity];
for (let i = 0; i < EDGES.length - 1; i++) {
  const lo = EDGES[i], hi = EDGES[i + 1];
  const b = rows.filter((r) => r.ev.chars >= lo && r.ev.chars < hi);
  if (!b.length) continue;
  const f = b.filter((r) => r.ev.score >= THRESHOLD).length;
  const avg = (sel) => b.reduce((a, r) => a + sel(r), 0) / b.length;
  console.log(
    `  ${(hi === Infinity ? `${lo}+` : `${lo}-${hi}`).padEnd(12)} ${String(b.length).padStart(5)}` +
    `   ${String(f).padStart(7)}   ${String(Math.round(avg((r) => r.ev.medianLineLen))).padStart(11)}` +
    `   ${pct(avg((r) => r.ev.shortLineRatio)).padStart(11)}   ${pct(avg((r) => r.ev.structureRatio)).padStart(10)}`,
  );
}

// ── The number that decides ───────────────────────────────────────────────────
// Longest flagged chunks with the LEAST structure — i.e. the ones most likely to
// be prose the detector got wrong.
const risky = [...flagged].sort((a, b) => a.ev.structureRatio - b.ev.structureRatio || b.ev.chars - a.ev.chars);
console.log(`\n\nFLAGGED WITH LEAST STRUCTURE — the false-positive surface, read these by hand`);
for (const r of risky.slice(0, SHOW)) {
  const e = r.ev;
  console.log(`\n── ${r.c}  ${e.chars}ch  lines=${e.lines}  medLine=${e.medianLineLen}  short=${pct(e.shortLineRatio)}  struct=${pct(e.structureRatio)}  score=${e.score.toFixed(2)}${e.fenced ? "  FENCED" : ""}${r.retired ? "  [retired]" : ""}`);
  console.log(`   ${JSON.stringify(r.text.slice(0, 230))}`);
}

// And the reverse: the biggest things it SPARED, to see whether real pastes slip.
const slipped = [...spared].sort((a, b) => b.ev.chars - a.ev.chars);
console.log(`\n\nLARGEST SPARED — where a real paste would slip through`);
for (const r of slipped.slice(0, Math.min(SHOW, 6))) {
  const e = r.ev;
  console.log(`\n── ${r.c}  ${e.chars}ch  lines=${e.lines}  medLine=${e.medianLineLen}  short=${pct(e.shortLineRatio)}  struct=${pct(e.structureRatio)}  score=${e.score.toFixed(2)}`);
  console.log(`   ${JSON.stringify(r.text.slice(0, 230))}`);
}

console.log("\n\nREAD-ONLY. Nothing was changed and nothing is wired in.");
console.log("Shipping criterion: long RP prose must be SPARED. An under-caught paste leaves");
console.log("junk other layers still see; a misrouted scene is memory nobody can find.");
