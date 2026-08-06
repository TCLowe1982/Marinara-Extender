// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// MESSAGE-LEVEL calibration of the paste prior (hjt9). READ-ONLY.
//
// THE QUESTION THE CHUNK-LEVEL SCAN COULD NOT ANSWER. paste-scan.mjs measured over
// CHUNKS, and concluded the size prior "is not currently doing decisive work". That
// conclusion was suspect by construction, and the ticket says so: a 6KB message
// arriving in one tick is already split before pasteEvidence ever sees it, so the
// message-level size signal is partly destroyed before measurement.
//
// The chunker makes this concrete. parseTurns splits a message on /\n+/ into turns;
// mergeByEmbedding/mergeByTurnOnly then group at most `max_turns_per_chunk` (6) of
// them. So a 60-line paste becomes ~10 chunks of six lines each — none of them large,
// none of them triggering a size prior calibrated on 1500/6000 characters. The signal
// is not weak. It is shredded.
//
// So this measures the SAME text both ways: as one message, and as the chunks the
// pipeline would actually hand to the detector. If message-level separates paste from
// prose better than chunk-level does, the prior earns its place at message level —
// where LONG_USER_MSG_CHARS (api.ts:142) already lives — and nowhere else.
//
// FALSE POSITIVES LEAD THE REPORT, as in the chunk-level scan. A 40KB roleplay scene
// is exactly what this system exists to remember; a size rule that routes it to an
// ops lane destroys the best material in the store while looking like it works.
//
// Usage: node scripts/paste-scan-message.mjs [--show=N]

import { readdir } from "fs/promises";
import { join } from "path";

const { getDataDir } = await import("../dist/storage.js");
const { readAllBeats } = await import("../dist/sentiment/encoder.js");
const { chunkMessages } = await import("../dist/sentiment/chunker.js");
const { pasteEvidence, PASTE_THRESHOLD } = await import("../dist/sentiment/paste-prior.js");
const { classifyShape } = await import("../dist/sentiment/code-filter.js");

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=")[1] ?? d;
const SHOW = parseInt(arg("show", "8"), 10);

// ── Corpus: the biggest stored chunks, which stand in for whole messages ──────
// Beats store the chunk text, so a large multi-line beat is the closest thing the
// store has to a preserved message. Reconstructing true messages is not possible —
// non-passing chunks never became beats — and that limit is stated rather than
// papered over: this is a controlled comparison of the SAME text at two granularities,
// not a census of real traffic.

const rows = [];
for (const c of await readdir(join(getDataDir(), "characters")).catch(() => [])) {
  for (const b of await readAllBeats(c, { includeRetired: true }).catch(() => [])) {
    const text = String(b.text ?? "");
    if (text.length < 800) continue;                 // too small for size to say anything
    if (!/\n/.test(text)) continue;                  // single-line: chunking cannot split it
    rows.push({ id: b.id, character: c, text });
  }
}

console.log(`multi-line stored texts >=800 chars: ${rows.length}\n`);

let shredded = 0;
const report = [];
for (const r of rows) {
  const whole = pasteEvidence(r.text);
  const chunks = await chunkMessages(
    [{ role: "user", content: r.text }],
    r.character,
  );
  const perChunk = chunks.map((c) => pasteEvidence(c.text).score);
  const maxChunk = perChunk.length ? Math.max(...perChunk) : 0;
  const meanChunk = perChunk.length ? perChunk.reduce((a, b) => a + b, 0) / perChunk.length : 0;
  const shape = classifyShape(r.text);

  // The prior is "shredded" when the whole message reads as a paste but no single
  // chunk does — i.e. chunking destroyed the evidence.
  const lost = whole.score >= PASTE_THRESHOLD && maxChunk < PASTE_THRESHOLD;
  if (lost) shredded++;

  report.push({
    id: r.id, chars: r.text.length, chunks: chunks.length,
    whole: whole.score, maxChunk, meanChunk, lost,
    opsShaped: shape.opsShaped, lineRatio: shape.lineRatio,
    head: r.text.replace(/\s+/g, " ").slice(0, 90),
  });
}

const pastesWhole = report.filter((r) => r.whole >= PASTE_THRESHOLD);
const pastesChunk = report.filter((r) => r.maxChunk >= PASTE_THRESHOLD);

console.log("DETECTION AT EACH GRANULARITY");
console.log(`  flagged as paste, whole message : ${pastesWhole.length}`);
console.log(`  flagged as paste, any chunk     : ${pastesChunk.length}`);
console.log(`  SHREDDED (whole yes, no chunk)  : ${shredded}   <- signal destroyed by chunking\n`);

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
console.log("MEAN SCORE, same text, two granularities");
console.log(`  whole message : ${avg(report.map((r) => r.whole)).toFixed(3)}`);
console.log(`  best chunk    : ${avg(report.map((r) => r.maxChunk)).toFixed(3)}`);
console.log(`  mean chunk    : ${avg(report.map((r) => r.meanChunk)).toFixed(3)}\n`);

console.log(`FALSE-POSITIVE SURFACE — longest texts the WHOLE-MESSAGE prior calls a paste`);
console.log("These must be read by hand. A misrouted scene is hidden memory.\n");
const risky = pastesWhole.filter((r) => !r.opsShaped).sort((a, b) => b.chars - a.chars);
if (!risky.length) console.log("  none — every whole-message flag is also structurally ops-shaped.\n");
for (const r of risky.slice(0, SHOW)) {
  console.log(`  ${r.id} chars=${r.chars} chunks=${r.chunks} whole=${r.whole.toFixed(2)} lineRatio=${r.lineRatio.toFixed(2)}`);
  console.log(`     ${JSON.stringify(r.head)}`);
}

console.log(`\nSHREDDED CASES — the prior's argument for existing at message level`);
for (const r of report.filter((r) => r.lost).sort((a, b) => b.chars - a.chars).slice(0, SHOW)) {
  console.log(`  ${r.id} chars=${r.chars} chunks=${r.chunks} whole=${r.whole.toFixed(2)} bestChunk=${r.maxChunk.toFixed(2)} ops=${r.opsShaped}`);
  console.log(`     ${JSON.stringify(r.head)}`);
}

console.log("\nREAD-ONLY. Nothing was changed.");
