// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// TRIAGE THE SELF-INGESTED RECORDS (pe4o). READ-ONLY. No --apply, by design.
//
// A PROVENANCE FAILURE IS TRIAGE AND NOT A VERDICT (fqnl). That rule was paid for:
// of 8 entries flagged on stale sourceChatId, 7 had true content, and a predicate
// sweep would have destroyed them. So this script sorts and reports. It does not
// retire anything, and it deliberately has no flag to make it.
//
// It also exists because the same mistake nearly happened again today. Mari ruled
// "do not retire the boat beats, they're real utterances about a real evening" — a
// correct principle applied to the wrong records, because every one of those ten came
// from a chunk that was the prompt itself. The way to avoid ruling on a wrong premise
// is to make the premise measurable first, per record.
//
// THREE GENERA, and they want different answers:
//
//   SCAFFOLDING  the chunk is our prompt, near enough end to end. No human said this.
//                Nothing is lost by retiring it, and it is actively poisoning: it
//                carries an emotion, a motivation and a subject, all invented about
//                text nobody spoke.
//
//   MIXED        prompt text AND human speech in one chunk. The beat may be a real
//                reading of the human half, or a reading of the scaffolding, or both.
//                Cannot be decided by predicate — needs eyes.
//
//   ABOUT-WORK   mostly human, quoting or discussing the prompt. THIS IS A REAL
//                UTTERANCE. Someone genuinely said it, about their own work, and it
//                is exactly what Mari's heritage rule protects. Retiring these would
//                be the fqnl error with the sign flipped.

import { readdir, readFile } from "fs/promises";
import { join } from "path";

const { parse } = await import("yaml");
const { getDataDir } = await import("../dist/storage.js");
const { ownPromptSignatures } = await import("../dist/sentiment/self-prompt.js");

// HISTORICAL SIGNATURES CANNOT BE DERIVED, because they are gone from the code.
// self-prompt.ts builds its list from the LIVE prompt, which is correct for a forward
// gate and blind to anything ingested from an older revision — it finds 34 where the
// full sweep finds 65. These are the retired fragments, listed once, with the commit
// that removed them, so nobody mistakes them for current prompt text.
// NO BAIT PHRASES IN THIS LIST, and the reason is a mistake made three times today.
//
// An earlier revision included the retired illustrations here. One of them — "admits
// she's afraid the memory loss means she was never real" — matched 596 records on its
// own, and the triage reported 636 self-ingested records when the real scaffolding
// population is tens. Those 596 are the pifl ECHO population: documented in June,
// counted at 669, and already handled by scripts/retire-echo-entries.mjs. They are a
// different finding with a different remedy, and folding them in buries this one.
//
// The general lesson, having now hit it three times in one session: when measuring
// contamination, the contamination's own artifacts are the largest false-positive
// source. Whole-YAML scanning counted stored field values (1,100 -> 65). Short bait
// fragments counted quotations (683). This counted a known echo population (636).
// Each time the inflated number looked like a bigger, scarier version of the true
// finding, which is exactly what makes it hard to catch.
//
// So: SCAFFOLDING ONLY — rule text, schema, structure. Bait belongs to
// bait-tripwire.ts and to the pifl retirement, and asking one detector to answer two
// questions is how a number stops meaning anything.
const HISTORICAL = [
  // Thread rule, retired 2026-08-06 with Mari's rewrite (39f0143).
  "good: \"porsche test drive\", \"jurisprudence soft launch\", \"the hargrove investigation\"",
  "bad: \"thomas_and_mari\" (cast list, not an event), \"professor_mari_and_priya\" (cast list, identifier style)",
  "if the moment clearly starts something new, give it a short 2–5 word label naming the event or arc",
  "use null when the beat is incidental and belongs to no thread.",
];

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

// SAME 40-CHAR FLOOR AS THE GATE, applied to the historical list too.
//
// Without it this counted short bait fragments — "green, not blue", "exposes her
// personal fear" — as evidence of scaffolding, and reported 683 records where the
// scaffolding sweep finds tens. Those short phrases ARE contamination, but they are
// bait, and bait has its own detector; folding them in here buries the 32 records
// that are wholly our prompt under hundreds that merely quote a sentence. Two
// detectors, two questions, and the ratio only means something when the signatures
// are all long enough that a human would not type one by accident.
const MIN_SIG = 40;
const SIGNATURES = [...ownPromptSignatures(), ...HISTORICAL]
  .map(norm)
  .filter((s) => s.length >= MIN_SIG);

/** Fraction of the chunk covered by prompt text, by characters, without double-count. */
function coverage(text) {
  const hay = norm(text);
  if (!hay) return { ratio: 0, hits: 0 };
  const spans = [];
  for (const sig of SIGNATURES) {
    let from = 0;
    for (;;) {
      const at = hay.indexOf(sig, from);
      if (at < 0) break;
      spans.push([at, at + sig.length]);
      from = at + sig.length;
    }
  }
  if (!spans.length) return { ratio: 0, hits: 0 };
  spans.sort((a, b) => a[0] - b[0]);
  let covered = 0, end = -1;
  for (const [s, e] of spans) {
    if (s > end) { covered += e - s; end = e; }
    else if (e > end) { covered += e - end; end = e; }
  }
  return { ratio: covered / hay.length, hits: spans.length };
}

const files = [];
async function walk(d) {
  for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
    const p = join(d, e.name);
    if (e.isDirectory()) { await walk(p); continue; }
    if (p.endsWith(".yaml")) files.push(p);
  }
}
await walk(getDataDir());

const rows = [];
for (const p of files) {
  const raw = await readFile(p, "utf8").catch(() => "");
  if (!raw) continue;
  let doc = null;
  try { doc = parse(raw); } catch { continue; }
  if (!doc || typeof doc !== "object") continue;
  const src = String(doc.text ?? doc.content ?? "");
  if (!src) continue;
  const { ratio, hits } = coverage(src);
  if (!hits) continue;
  const genus = ratio >= 0.6 ? "SCAFFOLDING" : ratio >= 0.2 ? "MIXED" : "ABOUT-WORK";
  rows.push({
    id: doc.id ?? p.split(/[\\/]/).pop(),
    lane: doc.lane ?? (p.includes("beats") ? "beat" : "?"),
    character: (p.replace(/\\/g, "/").match(/characters\/([^/]+)\//) ?? [])[1] ?? "-",
    created: String(doc.created ?? "").slice(0, 10),
    retired: !!doc.retiredAt,
    len: src.length,
    ratio: Math.round(ratio * 100),
    genus,
    emotion: doc.emotion ?? "",
    motivation: String(doc.motivation ?? "").slice(0, 90),
  });
}

const order = { SCAFFOLDING: 0, MIXED: 1, "ABOUT-WORK": 2 };
rows.sort((a, b) => order[a.genus] - order[b.genus] || b.ratio - a.ratio);

console.log(`self-ingested records: ${rows.length}   (live ${rows.filter((r) => !r.retired).length}, retired ${rows.filter((r) => r.retired).length})\n`);
for (const g of ["SCAFFOLDING", "MIXED", "ABOUT-WORK"]) {
  const set = rows.filter((r) => r.genus === g);
  console.log(`── ${g}: ${set.length} ──`);
  for (const r of set) {
    console.log(`  ${String(r.ratio).padStart(3)}% ${r.lane.padEnd(16)} ${r.created}  ${r.character.slice(0, 16).padEnd(16)} ${r.id}`);
    if (r.motivation) console.log(`        motivation: ${JSON.stringify(r.motivation)}`);
  }
  console.log();
}

console.log("FOR A RULING — this script will not act on it:");
console.log("  SCAFFOLDING  >=60% of the chunk is our own prompt. Nobody said it, and the");
console.log("               emotion, subject and motivation on it are invented about text");
console.log("               that was never spoken.");
console.log("  MIXED        prompt text and something else in one chunk. Needs eyes.");
console.log("  ABOUT-WORK   low coverage. THE LABEL IS A HYPOTHESIS AND THE DATA DOES NOT");
console.log("               CONFIRM IT. It was meant to catch a human quoting the prompt");
console.log("               while talking — a real utterance, protected by Mari's heritage");
console.log("               rule. Inspection shows the low-coverage records are mostly");
console.log("               prompt-adjacent too, with confabulated motivations, not people");
console.log("               talking. The coverage ratio measures how much of a chunk is");
console.log("               prompt; it cannot tell whether the REMAINDER is a real");
console.log("               utterance. Do not read this bucket as 'safe'.");
console.log("\nEvery record here is dated to a prompt-work session. That is the signal to");
console.log("trust; the genus boundaries (0.6 / 0.2) are this script's invention and are");
console.log("the part a human should overrule.");
console.log("\nREAD-ONLY. Nothing was changed. There is no --apply, deliberately: a");
console.log("provenance failure is triage and not a verdict (fqnl).");
