// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Measure the structural shape classifier before anyone wires it in. READ-ONLY.
//
// WHAT THIS IS FOR. classifyShape() would route chunks to the ops lane. Routing
// is reversible, but misrouting real memory still hides it from recall, so the
// number that decides whether it ships is PRECISION — of the chunks it calls
// code-shaped, how many actually are.
//
// The floor work is the precedent: the first two candidate axes both looked
// obviously right and were both wrong, and only a read-only pass over the real
// store caught it. Same discipline here.
//
// Usage:
//   node scripts/code-shape-scan.mjs [--limit=N] [--show=N] [--prose]
//     --prose  also sample chunks it calls PROSE that contain code signals,
//              which is where a router silently under-catches.

import { readdir } from "fs/promises";
import { join } from "path";

const { getDataDir } = await import("../dist/storage.js");
const { readAllBeats } = await import("../dist/sentiment/encoder.js");
const { classifyShape, OPS_LINE_RATIO } = await import("../dist/sentiment/code-filter.js");
const { echoesAnExample } = await import("../dist/sentiment/analyzer.js");

const args = process.argv.slice(2);
const SHOW = parseInt((args.find((a) => a.startsWith("--show=")) ?? "").split("=")[1] ?? "12", 10);
const SHOW_PROSE = args.includes("--prose");

const dataDir = getDataDir();
const characterIds = await readdir(join(dataDir, "characters")).catch(() => []);

const rows = [];
for (const characterId of characterIds) {
  // includeRetired: the sub-floor stratum is exactly the population this filter
  // is meant to have caught upstream, so excluding it would flatter the result.
  for (const b of await readAllBeats(characterId, { includeRetired: true }).catch(() => [])) {
    const text = String(b.text ?? "");
    const v = classifyShape(text);
    rows.push({
      characterId, text, verdict: v,
      retired: !!b.retiredAt,
      echo: echoesAnExample(String(b.motivation ?? "")),
      motivation: String(b.motivation ?? ""),
    });
  }
}

const ops = rows.filter((r) => r.verdict.opsShaped);
const prose = rows.filter((r) => !r.verdict.opsShaped);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

console.log(`beats examined            : ${rows.length}`);
console.log(`ops-shaped (ratio >= ${OPS_LINE_RATIO}) : ${ops.length} (${pct(ops.length / rows.length)})`);
console.log(`  of those, already retired: ${ops.filter((r) => r.retired).length}`);
console.log(`  of those, carried an echo: ${ops.filter((r) => r.echo).length}`);
console.log(`prose                     : ${prose.length}`);
console.log(`  carrying an echo        : ${prose.filter((r) => r.echo).length}`);

const bySignal = new Map();
for (const r of ops) for (const s of r.verdict.signals) bySignal.set(s, (bySignal.get(s) ?? 0) + 1);
console.log("\nSIGNALS FIRING (chunks in which each rule appears)");
for (const [s, n] of [...bySignal.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${s}`);
}

// THE PRECISION SAMPLE. Read these by hand — this is the number that decides.
// Sorted by how much prose survived, so the most dangerous calls (chunks with
// real sentences in them) come FIRST rather than being buried under obvious yaml.
const risky = [...ops].sort((a, b) =>
  b.verdict.prose.filter((l) => l.trim()).length - a.verdict.prose.filter((l) => l.trim()).length);

console.log(`\nOPS-SHAPED CALLS, most surviving prose first — the false-positive risk`);
for (const r of risky.slice(0, SHOW)) {
  const kept = r.verdict.prose.filter((l) => l.trim());
  console.log(`\n── ${r.characterId}  ratio=${r.verdict.lineRatio.toFixed(2)}  signals=${r.verdict.signals.join(",")}${r.retired ? "  [already retired]" : ""}`);
  console.log(`   chunk : ${JSON.stringify(r.text.slice(0, 160))}`);
  console.log(`   prose kept (${kept.length}): ${kept.slice(0, 3).map((l) => JSON.stringify(l.slice(0, 90))).join(" | ") || "(none)"}`);
}

if (SHOW_PROSE) {
  const underCaught = prose
    .filter((r) => r.verdict.dropped.length > 0)
    .sort((a, b) => b.verdict.lineRatio - a.verdict.lineRatio);
  console.log(`\n\nCALLED PROSE BUT CARRYING STRUCTURE — where a router under-catches (${underCaught.length})`);
  for (const r of underCaught.slice(0, SHOW)) {
    console.log(`\n── ${r.characterId}  ratio=${r.verdict.lineRatio.toFixed(2)}  signals=${r.verdict.signals.join(",")}`);
    console.log(`   chunk : ${JSON.stringify(r.text.slice(0, 160))}`);
  }
}

console.log("\n\nREAD-ONLY. Nothing was changed and nothing is wired in.");
console.log("PRECISION is the shipping criterion, not recall: routing hides real memory");
console.log("from recall, and under-catching only leaves junk that other layers still see.");
