// BLIND LABELLING HARNESS for the ambient precision bench (cye6 slice 3).
//
// I am both the person who wired the change and the person judging whether it
// worked. Labelling with the arm visible would be worthless — so it is hidden.
// This shuffles every fact into one deterministic order, strips the arm and the
// cell, and prints numbered items. Verdicts go into a labels file keyed by the
// blind id; `join` re-attaches the arm afterwards and computes the cells.
//
//   node scripts/bench-label.mjs present [from] [count]   print blind items
//   node scripts/bench-label.mjs join                     score the labels
//
// LABEL VOCABULARY, one line per id in scratch/labels.tsv:
//   <id>\t<S|N>\t<A|M|?>\t[note]
//     S / N   SUPPORTED: is the fact stated or clearly implied by the sentence?
//     A / M   ATTRIBUTED / MISATTRIBUTED: is the subject the person the sentence
//             is actually about? "?" when the sentence cannot settle it.
//   precision = S && A. M is tracked separately as the dangerous class.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join as pjoin, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = pjoin(dirname(fileURLToPath(import.meta.url)), "..");
const BENCH = pjoin(PKG, "scratch", "precision-bench.jsonl");
const LABELS = pjoin(PKG, "scratch", "labels.tsv");

const rows = readFileSync(BENCH, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// Deterministic blind order — same seed as the bench, so re-running `present`
// gives the same ids and a partially-filled labels file stays valid.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const order = rows.map((_, i) => i);
const rand = rng(20260825);
for (let i = order.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}
const blind = order.map((idx, k) => ({ id: k + 1, idx, r: rows[idx] }));

const cmd = process.argv[2] ?? "present";

if (cmd === "present") {
  const from = Number(process.argv[3] ?? 1);
  const count = Number(process.argv[4] ?? 40);
  for (const b of blind.slice(from - 1, from - 1 + count)) {
    const r = b.r;
    // The block tag is KEPT — it is evidence the labeller legitimately has, and
    // the direction rule cannot be judged without knowing who spoke. The ARM and
    // the CELL are what stay hidden.
    const spokenBy = r.candidates.find((c) => c.slice(c.indexOf("] ") + 2) === r.text);
    const block = spokenBy ? spokenBy.slice(1, spokenBy.indexOf("]")) : "?";
    console.log(`#${b.id}`);
    console.log(`  said by : [${block}]  (character in scene: ${r.characterName})`);
    console.log(`  sentence: ${r.text}`);
    console.log(`  fact    : ${r.fact}`);
    console.log(`  subject : ${r.subject ?? "(none)"}   lane=${r.lane} scope=${r.scope}`);
    console.log();
  }
  console.error(`presented ${Math.min(count, blind.length - from + 1)} of ${blind.length}`);
} else if (cmd === "join") {
  if (!existsSync(LABELS)) throw new Error(`no labels at ${LABELS}`);
  const labels = new Map();
  for (const line of readFileSync(LABELS, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [id, sup, att, ...note] = t.split(/\t+/);
    labels.set(Number(id), { sup, att, note: note.join(" ") });
  }
  const cellsOut = {};
  const misattributed = [];
  let unlabelled = 0;
  for (const b of blind) {
    const l = labels.get(b.id);
    if (!l) { unlabelled++; continue; }
    const k = `${b.r.arm}/${b.r.cell}`;
    cellsOut[k] ??= { n: 0, supported: 0, attributed: 0, precise: 0, misattributed: 0, unresolvable: 0 };
    const c = cellsOut[k];
    c.n++;
    const S = l.sup === "S", A = l.att === "A", M = l.att === "M";
    if (S) c.supported++;
    if (A) c.attributed++;
    if (S && A) c.precise++;
    if (M) { c.misattributed++; misattributed.push({ id: b.id, ...b.r, note: l.note }); }
    if (l.att === "?") c.unresolvable++;
  }
  const pct = (a, b) => (b === 0 ? "n/a" : `${((a / b) * 100).toFixed(0)}%`);
  console.log(`labelled ${labels.size} / ${blind.length}  (unlabelled ${unlabelled})\n`);
  console.log("cell        n   supported   attributed   PRECISION   misattributed");
  for (const k of Object.keys(cellsOut).sort()) {
    const c = cellsOut[k];
    console.log(
      `${k.padEnd(8)} ${String(c.n).padStart(4)}   ${pct(c.supported, c.n).padStart(9)}   ` +
      `${pct(c.attributed, c.n).padStart(10)}   ${pct(c.precise, c.n).padStart(9)}   ` +
      `${pct(c.misattributed, c.n).padStart(13)}`,
    );
  }
  console.log(`\nMISATTRIBUTED, all of them, quoted in full (${misattributed.length}):`);
  for (const m of misattributed) {
    console.log(`\n  [${m.arm}/${m.cell}] #${m.id}`);
    console.log(`    sentence: ${m.text}`);
    console.log(`    fact    : ${m.fact}  -> subject "${m.subject ?? "(none)"}" lane=${m.lane}`);
    if (m.note) console.log(`    note    : ${m.note}`);
  }
  writeFileSync(pjoin(PKG, "scratch", "scored.json"), JSON.stringify({ cells: cellsOut, misattributed }, null, 2));
} else {
  throw new Error(`unknown command ${cmd}`);
}
