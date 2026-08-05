// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Calibrate the chunk FLOOR (MarinaraExtender-s8qe). READ-ONLY — reports, never
// mutates.
//
// WHY THIS EXISTS. The 2026-08-05 sweep measured echo rate against chunk length
// and found it U-shaped: 21% under 500 chars, 3-4% in the middle, 14% over 6000.
// The short end dominates by volume (~567 echoes against ~16), so the floor is
// the bigger win. But that sweep bucketed 0-500 as ONE lump, and the floor lands
// inside that lump — so the number it would be set from does not exist yet.
// This script subdivides it.
//
// WHAT A FLOOR COSTS. Dropping every chunk under 500 chars would discard ~31% of
// all beats. Some of those are the store's most intense moments: "I'm leaving."
// is 12 characters. So the histogram alone cannot pick the number — the decision
// needs the COST CURVE below it, which separates, at each candidate floor:
//
//   echoes killed        prompt-example motivations, pure win
//   repeats killed       non-echo but motivation not unique — junk of the other kind
//   UNIQUE LOST         non-echo, unique motivation. The real bill.
//
// A floor is worth paying for while echoes+repeats killed dominates unique lost.
// Where those curves cross is the answer, and it is an empirical question.
//
// SCORING USES THE SHIPPED MATCHER. echoesAnExample() from the analyzer, not a
// substring test. The first guard compared characters and missed "insists THAT
// the boat was green" in production; any referee that grades echo with a weaker
// matcher undercounts in exactly that direction.
//
// Usage:
//   node scripts/chunk-floor-scan.mjs [--json] [--character=<id>]
//                                     [--edges=0,25,50,...] [--floors=10,20,30,...]

import { readdir } from "fs/promises";
import { join } from "path";

const { getDataDir } = await import("../dist/storage.js");
const { readAllBeats } = await import("../dist/sentiment/encoder.js");
const { echoesAnExample, skeleton, skeletonTokens } = await import("../dist/sentiment/analyzer.js");

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const ONLY = (args.find((a) => a.startsWith("--character=")) ?? "").split("=")[1] ?? null;

const numList = (flag, fallback) => {
  const raw = (args.find((a) => a.startsWith(`--${flag}=`)) ?? "").split("=")[1];
  if (!raw) return fallback;
  return raw.split(",").map((s) => (s.trim() === "inf" ? Infinity : Number(s.trim())));
};

// Fine at the short end, where the floor lands; coarse above it, where the prior
// sweep already resolved the shape. Overridable so the contested region can be
// re-zoomed without editing the script.
const EDGES = numList("edges", [0, 50, 100, 150, 200, 300, 400, 500, 750, 1000, 2000, 4000, 6000, Infinity]);

// Candidate floors to price. Deliberately dense through the contested region.
const CANDIDATES = numList("floors", [50, 100, 150, 200, 250, 300, 400, 500, 750, 1000]);

// ── Collect ───────────────────────────────────────────────────────────────────

const dataDir = getDataDir();
let characterIds = [];
try {
  characterIds = await readdir(join(dataDir, "characters"));
} catch {
  console.error(`No characters directory under ${dataDir}. Nothing to scan.`);
  process.exit(1);
}
if (ONLY) characterIds = characterIds.filter((id) => id === ONLY);

const beats = [];
for (const characterId of characterIds) {
  let rows = [];
  try {
    rows = await readAllBeats(characterId);
  } catch (err) {
    console.error(`[skip] ${characterId}: ${err?.message ?? err}`);
    continue;
  }
  for (const b of rows) {
    const motivation = String(b.motivation ?? "");
    const text = String(b.text ?? "");
    beats.push({
      characterId,
      chars: text.length,
      // Second candidate axis: content words, the guard's own tokenizer.
      // MEASURED AND REJECTED as the floor axis — see `tokens` below.
      words: skeletonTokens(text).length,
      // Third axis, and the one that works. For a very short utterance the
      // FUNCTION WORDS ARE THE CONTENT: "I love you," has one content word
      // ("love") and so does the junk token "open", but three raw tokens
      // against one. Every genuine one-content-word beat in this store is a
      // real utterance ("All of me,", "You are a LIAR,") and every artifact is
      // a bare identifier (open, "POST", "PATCH"). Raw tokens separate them;
      // skeleton tokens cannot, because they strip exactly the pronouns and
      // copulas that make a short line a sentence.
      tokens: (text.match(/[\p{L}\p{N}]+/gu) ?? []).length,
      echo: echoesAnExample(motivation),
      // Skeleton, not the raw string: two motivations that differ only in
      // grammatical dressing are the same sentence for this purpose, which is
      // the same reason the guard matches on skeletons.
      shape: skeleton(motivation),
      sourceType: b.sourceType ?? "chat",
    });
  }
}

if (beats.length === 0) {
  console.error("No beats found. Is MARINARA_EXTENDER_DATA_DIR pointing at the live store?");
  process.exit(1);
}

// A motivation is a REPEAT if its skeleton occurs more than once anywhere in the
// corpus. Counted globally, not per bucket: a short chunk echoing a sentence that
// also appears in a long one is still the short chunk failing to be specific.
const shapeCounts = new Map();
for (const b of beats) {
  if (!b.shape) continue;
  shapeCounts.set(b.shape, (shapeCounts.get(b.shape) ?? 0) + 1);
}
for (const b of beats) {
  b.repeat = !b.echo && !!b.shape && shapeCounts.get(b.shape) > 1;
  b.unique = !b.echo && !b.repeat;
}

// Content-word axis: its own edges/floors, since the scales differ by ~5x.
const WORD_EDGES = numList("word-edges", [0, 1, 2, 3, 4, 6, 8, 12, 20, 40, Infinity]);
const WORD_CANDIDATES = numList("word-floors", [1, 2, 3, 4, 5, 6, 8, 10]);

// Raw-token axis — the shipped one.
const TOKEN_EDGES = numList("token-edges", [0, 1, 2, 3, 4, 5, 6, 8, 12, 20, Infinity]);
const TOKEN_CANDIDATES = numList("token-floors", [1, 2, 3, 4, 5, 6, 8]);

// ── Histogram ─────────────────────────────────────────────────────────────────

const buckets = [];
for (let i = 0; i < EDGES.length - 1; i++) {
  const lo = EDGES[i], hi = EDGES[i + 1];
  const rows = beats.filter((b) => b.chars >= lo && b.chars < hi);
  const distinct = new Set(rows.filter((r) => r.shape).map((r) => r.shape)).size;
  const withShape = rows.filter((r) => r.shape).length;
  buckets.push({
    lo, hi,
    n: rows.length,
    echoes: rows.filter((r) => r.echo).length,
    repeats: rows.filter((r) => r.repeat).length,
    distinctPct: withShape ? distinct / withShape : 0,
    echoPct: rows.length ? rows.filter((r) => r.echo).length / rows.length : 0,
  });
}

// ── Cost curve ────────────────────────────────────────────────────────────────

const totalEchoes = beats.filter((b) => b.echo).length;
const costCurve = (axis, floors) => floors.map((floor) => {
  const below = beats.filter((b) => b[axis] < floor);
  const echoes = below.filter((b) => b.echo).length;
  const repeats = below.filter((b) => b.repeat).length;
  const unique = below.filter((b) => b.unique).length;
  return {
    floor,
    dropped: below.length,
    droppedPct: below.length / beats.length,
    echoesKilled: echoes,
    echoesKilledPct: totalEchoes ? echoes / totalEchoes : 0,
    repeatsKilled: repeats,
    uniqueLost: unique,
    // Junk removed per real beat sacrificed. Above 1.0 the floor is still paying.
    ratio: unique ? (echoes + repeats) / unique : Infinity,
  };
});

const curve = costCurve("chars", CANDIDATES);
const wordCurve = costCurve("words", WORD_CANDIDATES);

const histogram = (axis, edges) => {
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const rows = beats.filter((b) => b[axis] >= lo && b[axis] < hi);
    const withShape = rows.filter((r) => r.shape).length;
    const distinct = new Set(rows.filter((r) => r.shape).map((r) => r.shape)).size;
    out.push({
      lo, hi,
      n: rows.length,
      echoes: rows.filter((r) => r.echo).length,
      repeats: rows.filter((r) => r.repeat).length,
      distinctPct: withShape ? distinct / withShape : 0,
      echoPct: rows.length ? rows.filter((r) => r.echo).length / rows.length : 0,
    });
  }
  return out;
};

const wordBuckets = histogram("words", WORD_EDGES);
const tokenBuckets = histogram("tokens", TOKEN_EDGES);
const tokenCurve = costCurve("tokens", TOKEN_CANDIDATES);

// ── Report ────────────────────────────────────────────────────────────────────

if (JSON_OUT) {
  console.log(JSON.stringify({ total: beats.length, totalEchoes, buckets, curve, wordBuckets, wordCurve, tokenBuckets, tokenCurve }, null, 2));
} else {
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const label = (lo, hi) => (hi === Infinity ? `${lo}+` : `${lo}-${hi}`);

  console.log(`beats scanned: ${beats.length} across ${characterIds.length} character store(s)`);
  console.log(`prompt-example echoes: ${totalEchoes} (${pct(totalEchoes / beats.length)})\n`);

  console.log("CHUNK LENGTH HISTOGRAM");
  console.log("  chunk chars        n     echo%   repeats   distinct-motivation%");
  for (const b of buckets) {
    if (b.n === 0) continue;
    console.log(
      `  ${label(b.lo, b.hi).padEnd(14)} ${String(b.n).padStart(5)}   ${pct(b.echoPct).padStart(6)}` +
      `   ${String(b.repeats).padStart(7)}   ${pct(b.distinctPct).padStart(8)}`,
    );
  }

  console.log("\nFLOOR COST CURVE  (what each candidate floor buys and bills)");
  console.log("  floor   dropped         echoes killed    repeats   UNIQUE LOST   junk:real");
  for (const c of curve) {
    console.log(
      `  ${String(c.floor).padStart(5)}   ${String(c.dropped).padStart(5)} (${pct(c.droppedPct).padStart(6)})` +
      `   ${String(c.echoesKilled).padStart(4)} (${pct(c.echoesKilledPct).padStart(6)})` +
      `   ${String(c.repeatsKilled).padStart(7)}   ${String(c.uniqueLost).padStart(11)}` +
      `   ${c.ratio === Infinity ? "     inf" : c.ratio.toFixed(2).padStart(8)}`,
    );
  }

  console.log("\nCONTENT-WORD HISTOGRAM  (skeleton tokens — function words stripped)");
  console.log("  words              n     echo%   repeats   distinct-motivation%");
  for (const b of wordBuckets) {
    if (b.n === 0) continue;
    console.log(
      `  ${label(b.lo, b.hi).padEnd(14)} ${String(b.n).padStart(5)}   ${pct(b.echoPct).padStart(6)}` +
      `   ${String(b.repeats).padStart(7)}   ${pct(b.distinctPct).padStart(8)}`,
    );
  }

  console.log("\nCONTENT-WORD FLOOR COST CURVE");
  console.log("  floor   dropped         echoes killed    repeats   UNIQUE LOST   junk:real");
  for (const c of wordCurve) {
    console.log(
      `  ${String(c.floor).padStart(5)}   ${String(c.dropped).padStart(5)} (${pct(c.droppedPct).padStart(6)})` +
      `   ${String(c.echoesKilled).padStart(4)} (${pct(c.echoesKilledPct).padStart(6)})` +
      `   ${String(c.repeatsKilled).padStart(7)}   ${String(c.uniqueLost).padStart(11)}` +
      `   ${c.ratio === Infinity ? "     inf" : c.ratio.toFixed(2).padStart(8)}`,
    );
  }

  console.log("\nRAW-TOKEN HISTOGRAM  (every word, function words KEPT — the shipped axis)");
  console.log("  tokens             n     echo%   repeats   distinct-motivation%");
  for (const b of tokenBuckets) {
    if (b.n === 0) continue;
    console.log(
      `  ${label(b.lo, b.hi).padEnd(14)} ${String(b.n).padStart(5)}   ${pct(b.echoPct).padStart(6)}` +
      `   ${String(b.repeats).padStart(7)}   ${pct(b.distinctPct).padStart(8)}`,
    );
  }

  console.log("\nRAW-TOKEN FLOOR COST CURVE");
  console.log("  floor   dropped         echoes killed    repeats   UNIQUE LOST   junk:real");
  for (const c of tokenCurve) {
    console.log(
      `  ${String(c.floor).padStart(5)}   ${String(c.dropped).padStart(5)} (${pct(c.droppedPct).padStart(6)})` +
      `   ${String(c.echoesKilled).padStart(4)} (${pct(c.echoesKilledPct).padStart(6)})` +
      `   ${String(c.repeatsKilled).padStart(7)}   ${String(c.uniqueLost).padStart(11)}` +
      `   ${c.ratio === Infinity ? "     inf" : c.ratio.toFixed(2).padStart(8)}`,
    );
  }

  console.log("\nREAD-ONLY. Nothing was changed.");
  console.log("Pick the floor where junk:real stops paying — that is the knee, measured.");
}
