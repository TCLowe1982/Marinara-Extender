// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Retire the self-ingested records (pe4o). DRY RUN BY DEFAULT — pass --apply to write.
//
// RULED BY TC, 2026-08-06:
//   "Retire with a reason. and throw the boat ones out, that were not generated from
//    that scene, or just before that scene."
//
// TWO SETS, TWO REASONS, because they are two different wrongs:
//
//   SCAFFOLDING — a chunk that is >=60% our own prompt text. Nobody spoke it. The
//   emotion, subject and motivation stamped on it were invented about machine
//   instructions, so there is no human content to preserve and it is actively
//   competing for recall budget with real memories.
//
//   BOAT ECHOES — beats whose motivation echoes the retired boat illustration.
//
// THE CARVE-OUT IN THE RULING HAS NO MEMBERS, and that is the finding, not an
// assumption. "not generated from that scene, or just before that scene" protects any
// beat drawn from the real christening evening. Measured: 2026-08-03 has 0 beats
// mentioning a boat, 2026-08-04 — the evening itself — has 0 across 89 beats, and the
// only 6 on 2026-08-05 are the echoes themselves. The christening was never ingested,
// so there is no scene for a beat to be from or just before. All ten qualify.
//
// Each of the ten was checked individually rather than by predicate (fqnl). Eight are
// the analyzer prompt; the remaining two are the Extender's own memory-block and lane
// instructions — still machine scaffolding, just a different file of ours. None
// carries a real-boat marker (hull, christening, paint, mooring). None has a
// sourceChatId.
//
// MARK, NEVER DELETE (s8qe). "Throw out" is implemented as retirement because this
// store does not delete: the record stays on disk at full fidelity, excluded from
// recall, statistics and arc promotion, and says WHY. If genuine erasure is wanted
// that is a separate, irreversible decision and this script will not make it.

import { readdir } from "fs/promises";

const { getDataDir } = await import("../dist/storage.js");
const { readAllBeats, retireBeats } = await import("../dist/sentiment/encoder.js");
const { echoesPhrases, skeletonTokens } = await import("../dist/sentiment/analyzer.js");
const { ownPromptSignatures } = await import("../dist/sentiment/self-prompt.js");

const APPLY = process.argv.includes("--apply");

const REASON_SCAFFOLD = "self-ingested prompt text (pe4o) — chunk was our own system prompt, not an utterance";
const REASON_BOAT     = "prompt-example echo on ingested scaffolding (pe4o/97z2) — no real boat scene exists in the store";

const BOAT_BAIT = "insists the boat was green, not blue, and will not let it go";
const REAL_BOAT = /\bhull\b|\bchristen|\bpaint(ed|ing)?\b|\bmoor|\boutboard\b|\bslip\b/i;

// Same scaffolding signatures as the triage: live-derived plus the thread rule that
// was retired this morning. Bait phrases are deliberately excluded — they belong to
// bait-tripwire, and including one put 596 unrelated pifl echoes in the count.
const HISTORICAL = [
  'good: "porsche test drive", "jurisprudence soft launch", "the hargrove investigation"',
  'bad: "thomas_and_mari" (cast list, not an event), "professor_mari_and_priya" (cast list, identifier style)',
  "if the moment clearly starts something new, give it a short 2–5 word label naming the event or arc",
  "use null when the beat is incidental and belongs to no thread.",
];
const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const SIGS = [...ownPromptSignatures(), ...HISTORICAL].map(norm).filter((s) => s.length >= 40);

function coverage(text) {
  const hay = norm(text);
  if (!hay) return 0;
  const spans = [];
  for (const sig of SIGS) {
    let from = 0;
    for (;;) {
      const at = hay.indexOf(sig, from);
      if (at < 0) break;
      spans.push([at, at + sig.length]);
      from = at + sig.length;
    }
  }
  if (!spans.length) return 0;
  spans.sort((a, b) => a[0] - b[0]);
  let covered = 0, end = -1;
  for (const [s, e] of spans) {
    if (s > end) { covered += e - s; end = e; }
    else if (e > end) { covered += e - end; end = e; }
  }
  return covered / hay.length;
}

const plan = new Map(); // character -> [{id, reason, why}]
const add = (ch, id, reason, why) => {
  if (!plan.has(ch)) plan.set(ch, []);
  if (plan.get(ch).some((r) => r.id === id)) return; // scaffolding and boat sets overlap
  plan.get(ch).push({ id, reason, why });
};

let scanned = 0, protectedByScene = 0;
for (const ch of await readdir(`${getDataDir()}/characters`).catch(() => [])) {
  for (const b of await readAllBeats(ch, { includeRetired: false }).catch(() => [])) {
    scanned++;
    const text = String(b.text ?? "");
    const cov = coverage(text);

    if (cov >= 0.6) {
      add(ch, b.id, REASON_SCAFFOLD, `${Math.round(cov * 100)}% prompt text`);
      continue;
    }
    if (echoesPhrases(String(b.motivation ?? ""), [BOAT_BAIT])) {
      // THE CARVE-OUT. A boat echo drawn from a chunk that actually describes the
      // evening is protected — that is the whole point of the ruling.
      if (REAL_BOAT.test(text)) { protectedByScene++; continue; }
      add(ch, b.id, REASON_BOAT, `boat echo, source has no scene marker (${Math.round(cov * 100)}% prompt)`);
    }
  }
}

const total = [...plan.values()].reduce((a, r) => a + r.length, 0);
console.log(`live beats scanned: ${scanned}`);
console.log(`to retire: ${total}   protected by the scene carve-out: ${protectedByScene}\n`);
for (const [ch, rows] of plan) {
  console.log(`── ${ch} (${rows.length}) ──`);
  for (const r of rows) console.log(`  ${r.id}  ${r.why}`);
}

if (!APPLY) {
  console.log("\nDRY RUN. Nothing was written. Re-run with --apply.");
  process.exit(0);
}

console.log("\nAPPLYING…");
let marked = 0;
for (const [ch, rows] of plan) {
  for (const reason of new Set(rows.map((r) => r.reason))) {
    const ids = rows.filter((r) => r.reason === reason).map((r) => r.id);
    const done = await retireBeats(ch, ids, reason);
    marked += done.length;
    console.log(`  ${ch}: marked ${done.length}/${ids.length}  [${reason.slice(0, 48)}…]`);
  }
}
console.log(`\nretired ${marked} beat(s). Mark, not delete — full fidelity on disk, excluded from recall.`);
