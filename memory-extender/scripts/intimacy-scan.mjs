// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// MEASURE THE INTIMACY DETECTOR BEFORE WIRING IT (MarinaraExtender-5x5y). READ-ONLY.
//
// The detector decides where `subtext` becomes REQUIRED. A false positive forces the
// model to invent a subtext for a chunk that has none — new pollution of exactly the
// kind epf4 just finished cleaning out — so precision is the number that matters and
// recall is nearly free to sacrifice.
//
// This prints what it would fire on across the whole beat store, plus the evidence
// for each hit, so precision can be judged by reading rather than assumed.
//
//   node scripts/intimacy-scan.mjs                # summary
//   node scripts/intimacy-scan.mjs --show=25      # sample hits with their markers
//   node scripts/intimacy-scan.mjs --weak-only    # the risky class: weak-pair hits
//   node scripts/intimacy-scan.mjs --near-miss    # single-weak chunks it DECLINED

import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const SHOW = parseInt((args.find((a) => a.startsWith("--show=")) ?? "").split("=")[1] ?? "0", 10);
const WEAK_ONLY = args.includes("--weak-only");
const NEAR_MISS = args.includes("--near-miss");

const { classifyIntimacy } = await import("../dist/sentiment/intimacy.js");
const { getDataDir } = await import("../dist/storage.js");

const charsDir = join(getDataDir(), "characters");
if (!existsSync(charsDir)) { console.error("no characters dir"); process.exit(1); }

let total = 0, intimate = 0, byStrong = 0, byWeakPair = 0, singleWeak = 0;
let withSubtext = 0, intimateWithSubtext = 0;
const samples = [];
const weakPairSamples = [];
const nearMisses = [];

for (const c of readdirSync(charsDir)) {
  const beatsDir = join(charsDir, c, "beats");
  if (!existsSync(beatsDir)) continue;
  for (const f of readdirSync(beatsDir)) {
    if (!f.startsWith("beat-") || !f.endsWith(".yaml")) continue;
    let raw;
    try { raw = readFileSync(join(beatsDir, f), "utf8"); } catch { continue; }
    total++;

    // The beat's own source text — the same evidence the analyzer saw.
    const m = raw.match(/(?:^|\n)text: (?:>-|\|-|>|\|)?\n?([\s\S]*?)(?=\n[a-zA-Z]+:)/);
    const text = m ? m[1] : "";
    const hasSubtext = /(?:^|\n)subtext:/.test(raw);
    if (hasSubtext) withSubtext++;

    const v = classifyIntimacy(text);
    if (v.intimate) {
      intimate++;
      if (hasSubtext) intimateWithSubtext++;
      if (v.strong.length) byStrong++; else byWeakPair++;
      const row = { char: c, id: f.replace(/\.yaml$/, ""), strong: v.strong, weak: v.weak,
                    excerpt: text.replace(/\s+/g, " ").slice(0, 130) };
      samples.push(row);
      if (!v.strong.length) weakPairSamples.push(row);
    } else if (v.weak.length === 1) {
      singleWeak++;
      nearMisses.push({ char: c, id: f.replace(/\.yaml$/, ""), weak: v.weak,
                        excerpt: text.replace(/\s+/g, " ").slice(0, 130) });
    }
  }
}

console.log(`beats scanned              ${total}`);
console.log(`would fire (intimate)      ${intimate}  (${(100 * intimate / total).toFixed(1)}%)`);
console.log(`  by a STRONG marker       ${byStrong}`);
console.log(`  by a WEAK PAIR           ${byWeakPair}   <- the risky class`);
console.log(`declined on a single weak  ${singleWeak}   <- deliberate misses`);
console.log("");
console.log(`beats carrying subtext     ${withSubtext}`);
console.log(`  ...that we call intimate ${intimateWithSubtext}`);
console.log(`  ...that we would MISS    ${withSubtext - intimateWithSubtext}  <- recall check: the model`);
console.log(`                                 itself judged these intimate enough to emit a subtext,`);
console.log(`                                 so a miss here is the detector disagreeing with it.`);
if (intimate > 0) {
  console.log("");
  console.log(`subtext rate on what we call intimate: ${(100 * intimateWithSubtext / intimate).toFixed(1)}%  <- today's baseline`);
}

const pick = (arr, n) => arr.slice(0, n);
if (WEAK_ONLY) {
  console.log(`\n── weak-pair hits (judge these hardest — no unambiguous marker fired) ──`);
  for (const r of pick(weakPairSamples, SHOW || 25)) {
    console.log(`  [${r.weak.join(" + ")}] ${r.char}/${r.id}`);
    console.log(`     ${r.excerpt}`);
  }
} else if (NEAR_MISS) {
  console.log(`\n── declined on a single weak marker (what recall costs) ──`);
  for (const r of pick(nearMisses, SHOW || 25)) {
    console.log(`  [${r.weak.join(" + ")}] ${r.char}/${r.id}`);
    console.log(`     ${r.excerpt}`);
  }
} else if (SHOW) {
  console.log(`\n── sample hits ──`);
  for (const r of pick(samples, SHOW)) {
    console.log(`  [${[...r.strong, ...r.weak].slice(0, 4).join(" + ")}] ${r.char}/${r.id}`);
    console.log(`     ${r.excerpt}`);
  }
}
