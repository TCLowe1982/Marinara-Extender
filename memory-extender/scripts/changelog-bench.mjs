// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// BENCH THE CHANGELOG DISCRIMINATOR BEFORE WIRING IT (MarinaraExtender-mln9).
// READ-ONLY. No writes, no model calls, no store mutation.
//
// WHY A BENCH AT ALL, for a rule this simple. The sizing pass produced SIX positives.
// Six is enough to falsify a hypothesis and nowhere near enough to fit a threshold
// that will run on the live path — a rule tuned to six examples is tuned to six
// examples. So the floor is adjudicated against release notes the store has never
// seen, and the store's own six are reported separately and never as the headline.
//
// ── ONE INSTRUMENT, SHARED ───────────────────────────────────────────────────
//
// The referee is classifyChangelog() from dist — literally the function that would
// ship, not a copy of its logic. prompt-bench-v2 learned this the hard way: a bench
// that reimplements the guard grades a prompt clean that production would reject.
//
// ── THE ARMS, AND WHY A BASELINE EXISTS ──────────────────────────────────────
//
//   A0  PRESENCE   >=1 enumeration verb. The keyword blocklist mln9 forbids.
//   A1  DENSITY    >=3 enumeration verbs. The floor, with no genus test.
//   A2  SHIPPED    >=3 verbs AND dialogue rate under the ceiling. classifyChangelog.
//
// A0 is not a straw man, it is the rent A1 and A2 must pay. If density buys nothing
// over presence, the honest finding is that the simpler rule wins and the elaborate
// one should not ship. A1 exists to isolate what the DIALOGUE CEILING is worth on its
// own, because a guard clause nobody measured is a guard clause nobody can defend.
//
// ── THE PRE-REGISTERED RULE, WRITTEN BEFORE THE FIRST RUN ────────────────────
//
// Stated here, in the file, so it cannot be reverse-fitted to a number that came out
// badly. s6cu's pilot could not be adjudicated because its rule was written after its
// results; that is the mistake this paragraph exists to prevent.
//
//   MUST-1  ZERO false positives on the ABOUT-WORK set. A character reacting to a
//           changelog in her own voice is a real utterance; suppressing one is the
//           fqnl error with the sign flipped. This is a veto, not a score — an arm
//           that fails it cannot ship at any recall.
//   MUST-2  ZERO false positives on ordinary RP prose (the bulk store minus the
//           known positives). Same asymmetry: a miss costs today's behaviour, a
//           false positive destroys a true record.
//   MUST-3  Recall >= 0.80 on HELD-OUT release notes the store has never seen. Below
//           that the rule is fitted to the six and should not be trusted forward.
//   RENT    The shipped arm must not be beaten by A0 on precision at equal recall.
//           If presence matches density on both, ship presence and delete the rest.
//
// Any arm failing a MUST is DISQUALIFIED regardless of its other numbers. The verdict
// is computed mechanically at the bottom of this file; nothing here is a judgement
// call made while reading the output.
//
// ── HELD-OUT MEANS HELD OUT, AND IT IS VERIFIED, NOT ASSUMED ─────────────────
//
// Positives are rendered from the Engine's own CHANGELOG.md into the form a user
// actually pastes (see toPasteForm). Any release sharing a meaningful shingle with a
// stored positive is EXCLUDED and reported, because a "held-out" example that is
// secretly in the training set is worse than no held-out set at all.
//
//   node scripts/changelog-bench.mjs             # the bench + verdict
//   node scripts/changelog-bench.mjs --show      # per-case detail
//   node scripts/changelog-bench.mjs --engine=<path to Marinara-Engine>

import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const { parse } = await import("yaml");
const { getDataDir } = await import("../dist/storage.js");
const { classifyChangelog, OPENER_FLOOR, DIALOGUE_CEILING } = await import("../dist/sentiment/changelog.js");

const args = process.argv.slice(2);
const SHOW = args.includes("--show");
const ENGINE = (args.find((a) => a.startsWith("--engine=")) ?? "").split("=")[1]
  ?? "d:/Entertainment/Wip/Projects/Marinara-Engine";

// The six the sizing pass confirmed by hand, and the two ABOUT-WORK beats it ruled
// must survive. Listed by id rather than re-derived, so the bench cannot quietly
// relabel its own ground truth when the detector changes.
const STORE_POSITIVES = new Set([
  "beat-37faa0d37ec5", "beat-d7d767b27166", "beat-2b6ff6f8480d",
  "beat-a39cf0d43085", "beat-6e75eeb7f8b6", "beat-61b2658165f9",
]);
const ABOUT_WORK = new Set(["beat-4cf78d9e6f32", "beat-e45fb60631d1"]);

// ── Arms ─────────────────────────────────────────────────────────────────────
// Each returns a boolean "would suppress". A0/A1 read the SAME verdict object the
// shipped arm does, so the only thing varying between arms is the decision rule.
const ARMS = [
  { key: "A0 presence", fire: (v) => v.openers >= 1 },
  { key: "A1 density", fire: (v) => v.openers >= OPENER_FLOOR },
  { key: "A2 shipped", fire: (v) => v.isChangelog },
];

// ── Held-out positives from the Engine's CHANGELOG ───────────────────────────

/**
 * Render a CHANGELOG section into the form that actually reaches a chat.
 *
 * NOT the markdown. The stored positives are plainly copied from a RENDERED release
 * page — no bullets, no backticks, and the section heading flattened into the text
 * ahead of it, which is why one of them literally reads "Added Added optional image
 * generation...". Reproducing that faithfully matters: benching against raw markdown
 * would be benching against a document nobody pastes.
 */
function toPasteForm(section) {
  const out = [];
  for (const raw of section.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) { out.push(line.replace(/^#{1,6}\s*/, "")); continue; }
    if (/^>/.test(line)) continue;                      // callouts aren't pasted as prose
    line = line.replace(/^[-*+]\s+/, "");               // bullet markers
    line = line.replace(/`([^`]*)`/g, "$1");            // code spans
    line = line.replace(/\*\*([^*]*)\*\*/g, "$1");      // bold
    line = line.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"); // links -> label
    if (!/[.!?]$/.test(line)) line += ".";              // rendered items read as sentences
    out.push(line);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function shingles(s, n = 8) {
  const w = String(s).toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const out = new Set();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}

// ── Load the store ───────────────────────────────────────────────────────────

const charsDir = join(getDataDir(), "characters");
if (!existsSync(charsDir)) { console.error("no characters dir"); process.exit(1); }

const beats = [];
for (const c of readdirSync(charsDir)) {
  const beatsDir = join(charsDir, c, "beats");
  if (!existsSync(beatsDir)) continue;
  for (const fn of readdirSync(beatsDir)) {
    if (!fn.endsWith(".yaml")) continue;               // both id conventions — see mjqe
    let rec;
    try { rec = parse(readFileSync(join(beatsDir, fn), "utf8")); } catch { continue; }
    if (!rec || typeof rec !== "object" || !rec.text) continue;
    beats.push({ id: rec.id ?? fn.replace(/\.yaml$/, ""), char: c, text: String(rec.text) });
  }
}

// ── Build the held-out positive set ──────────────────────────────────────────

const changelogPath = join(ENGINE, "CHANGELOG.md");
if (!existsSync(changelogPath)) {
  console.error(`no CHANGELOG.md at ${changelogPath} — pass --engine=<path>`);
  process.exit(1);
}
const changelog = readFileSync(changelogPath, "utf8");

const releases = [];
{
  const lines = changelog.split(/\r?\n/);
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) { if (cur) releases.push(cur); cur = { name: m[1].trim(), body: [] }; continue; }
    if (cur) cur.body.push(line);
  }
  if (cur) releases.push(cur);
}

// LEAKAGE CHECK. A release that overlaps a stored positive is not held out.
const storePosText = beats.filter((b) => STORE_POSITIVES.has(b.id)).map((b) => b.text);
const storeShingles = new Set();
for (const t of storePosText) for (const s of shingles(t)) storeShingles.add(s);

const heldOut = [], leaked = [];
for (const r of releases) {
  const text = toPasteForm(r.body.join("\n"));
  if (countWordsish(text) < 60) continue;              // too short to be a realistic paste
  let overlap = 0;
  for (const s of shingles(text)) if (storeShingles.has(s)) overlap++;
  (overlap > 0 ? leaked : heldOut).push({ name: r.name, text, overlap });
}
function countWordsish(s) { return (s.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []).length; }

// ── Corpora ──────────────────────────────────────────────────────────────────

const aboutWork = beats.filter((b) => ABOUT_WORK.has(b.id));
const storePos = beats.filter((b) => STORE_POSITIVES.has(b.id));
const bulkNeg = beats.filter((b) => !STORE_POSITIVES.has(b.id) && !ABOUT_WORK.has(b.id));

console.log("CHANGELOG DISCRIMINATOR BENCH — mln9");
console.log(`  shipped constants: OPENER_FLOOR=${OPENER_FLOOR}  DIALOGUE_CEILING=${DIALOGUE_CEILING}`);
console.log("");
console.log("CORPORA");
console.log(`  held-out positives (Engine CHANGELOG)   ${heldOut.length}   releases, never in the store`);
console.log(`  ...excluded for leakage                 ${leaked.length}   ${leaked.length ? "(" + leaked.map((l) => l.name).join(", ") + ")" : ""}`);
console.log(`  store positives (calibration, not headline)  ${storePos.length}`);
console.log(`  ABOUT-WORK must-not-fire                ${aboutWork.length}`);
console.log(`  bulk negatives (rest of store)          ${bulkNeg.length}`);

// EACH HELD-OUT POSITIVE IS TESTED IN BOTH SHAPES. The guard runs at message level
// where newlines survive, but classifyChunk keeps a chunk-level gate as defence in
// depth for paths that reach it intact — and the stored positives are all flattened,
// so the flattened form is the one the store proves is reachable.
const shapes = [
  ["as-pasted (newlines)", (t) => t.replace(/\. /g, ".\n")],
  ["as-chunked (flat)", (t) => t],
];

const results = [];
for (const arm of ARMS) {
  const row = { arm: arm.key, heldOut: {}, storePos: 0, aboutWorkFP: 0, bulkFP: 0 };
  for (const [shapeName, shape] of shapes) {
    let hit = 0;
    for (const p of heldOut) if (arm.fire(classifyChangelog(shape(p.text)))) hit++;
    row.heldOut[shapeName] = heldOut.length ? hit / heldOut.length : 0;
  }
  for (const b of storePos) if (arm.fire(classifyChangelog(b.text))) row.storePos++;
  for (const b of aboutWork) if (arm.fire(classifyChangelog(b.text))) row.aboutWorkFP++;
  for (const b of bulkNeg) if (arm.fire(classifyChangelog(b.text))) row.bulkFP++;
  results.push(row);
}

console.log("");
console.log("RESULTS");
console.log("  arm           held-out recall            store   ABOUT-WORK   bulk");
console.log("                pasted    flat             6        FP (veto)    FP");
for (const r of results) {
  console.log(
    `  ${r.arm.padEnd(12)}  ${(100 * r.heldOut["as-pasted (newlines)"]).toFixed(0).padStart(3)}%     ` +
    `${(100 * r.heldOut["as-chunked (flat)"]).toFixed(0).padStart(3)}%            ` +
    `${String(r.storePos).padStart(1)}/6      ${String(r.aboutWorkFP).padStart(2)}          ${String(r.bulkFP).padStart(4)}`,
  );
}

// PRECISION, on the only population where it is meaningful: the whole store. A
// positive here is a suppression, so precision = known-true / everything-it-fires-on.
console.log("");
console.log("STORE PRECISION  (fires on the 6 known / fires on anything)");
for (const r of results) {
  const fired = r.storePos + r.aboutWorkFP + r.bulkFP;
  const prec = fired ? r.storePos / fired : 0;
  console.log(`  ${r.arm.padEnd(12)}  ${String(fired).padStart(4)} fired   precision ${(100 * prec).toFixed(1)}%`);
}

// ── Mechanical verdict against the pre-registered rule ───────────────────────

console.log("");
console.log("VERDICT  (pre-registered; see header)");
const A0 = results.find((r) => r.arm.startsWith("A0"));
for (const r of results) {
  const recall = Math.min(r.heldOut["as-pasted (newlines)"], r.heldOut["as-chunked (flat)"]);
  const fails = [];
  if (r.aboutWorkFP > 0) fails.push(`MUST-1 (ABOUT-WORK FP=${r.aboutWorkFP})`);
  if (r.bulkFP > 0) fails.push(`MUST-2 (bulk FP=${r.bulkFP})`);
  if (recall < 0.8) fails.push(`MUST-3 (held-out recall ${(100 * recall).toFixed(0)}% < 80%)`);
  const firedR = r.storePos + r.aboutWorkFP + r.bulkFP;
  const firedA0 = A0.storePos + A0.aboutWorkFP + A0.bulkFP;
  const a0Recall = Math.min(A0.heldOut["as-pasted (newlines)"], A0.heldOut["as-chunked (flat)"]);
  if (r !== A0 && a0Recall >= recall && firedA0 <= firedR) fails.push("RENT (A0 matches it — ship the simpler rule)");
  console.log(`  ${r.arm.padEnd(12)}  ${fails.length ? "DISQUALIFIED — " + fails.join("; ") : "PASSES"}`);
}

// ── Is 3 the right floor? Answer with a number, not an assertion ─────────────
//
// The floor was read off a calibration set of six. This sweeps it against the
// held-out releases and the whole store so the choice is defended by the shape of the
// trade rather than by the six examples that suggested it.
// BOTH COLUMNS, because the floor alone is not the shipped rule. An earlier version
// of this sweep varied the floor with no ceiling and reported 1 false positive at
// floor 2 — which then read as an argument for floor 3. With the ceiling applied, as
// production would, that FP is spared and the trade looks entirely different. Sweeping
// a parameter through anything other than the real decision path answers a question
// nobody asked.
console.log("");
console.log("FLOOR SENSITIVITY  (held-out recall vs store false positives)");
console.log("  floor    FLOOR ONLY (A1)          FLOOR + CEILING (A2, shipped path)");
console.log("           recall   bulkFP  awFP    recall   bulkFP  awFP");
for (const floor of [1, 2, 3, 4, 5, 6]) {
  const bare = (t) => classifyChangelog(t).openers >= floor;
  const full = (t) => { const v = classifyChangelog(t); return v.openers >= floor && v.dialogueRate < DIALOGUE_CEILING; };
  const row = (fire) => [
    (100 * heldOut.filter((p) => fire(p.text)).length / Math.max(1, heldOut.length)).toFixed(0) + "%",
    String(bulkNeg.filter((b) => fire(b.text)).length),
    String(aboutWork.filter((b) => fire(b.text)).length),
  ];
  const [r1, b1, a1c] = row(bare);
  const [r2, b2, a2c] = row(full);
  const mark = floor === OPENER_FLOOR ? "  <- shipped" : "";
  console.log(`  ${String(floor).padStart(5)}    ${r1.padStart(6)}  ${b1.padStart(6)}  ${a1c.padStart(4)}    ${r2.padStart(6)}  ${b2.padStart(6)}  ${a2c.padStart(4)}${mark}`);
}

// ── Does the DIALOGUE CEILING earn its place? ────────────────────────────────
//
// AT THE SHIPPED FLOOR OF 3, NO — and that nearly got it deleted. Both ABOUT-WORK
// beats carry zero enumeration verbs, so the floor already spares them and the
// ceiling never runs; A1 and A2 come out identical on every number in the arms table.
//
// THE SWEEP ABOVE IS WHAT SAVED IT. At floor 1 the ceiling removes 14 false positives
// (27 -> 13) and at floor 2 it removes the last one, taking the store to zero. So it
// is not decoration, it is load-bearing everywhere except the exact floor that happens
// to be shipped — which means it is doing real work the moment the floor moves, and
// deleting it would have silently coupled two constants that look independent.
//
// The case it exists for is a MIXED message — one where a paste and a reaction share
// a single message, so the enumeration count is high AND somebody is talking. The
// store contains no such message today (beat-4cf78d9e6f32 is mixed but quotes prose
// rather than list items, so it scores 0 openers). That is a gap in the corpus, not
// evidence the case cannot happen: at message level the reaction and the paste are
// usually separate messages, but one quoted reply puts them in the same one.
//
// SYNTHETIC, AND LABELLED AS SUCH. These are constructed, so they prove the mechanism
// works and prove nothing about frequency. heading-mint-scan.mjs uses the same device
// for the same reason. If the ceiling cannot spare even a constructed mixed message,
// it should be deleted outright rather than kept as decoration.
const realItems = heldOut.length
  ? heldOut[0].text.split(/(?<=\.)\s+/).filter((s) => /^(Added|Fixed|Changed|Improved|Updated)\b/.test(s)).slice(0, 6).join(" ")
  : "";
const SYNTHETIC = [
  {
    name: "mixed: paste + reaction (must be SPARED)",
    expectFire: false,
    text: `okay hold on, i'm reading it. ${realItems} babe, that's MINE — that's the bug i filed on tuesday, isn't it? i can't believe they shipped it that fast. i'm not crying, you're crying.`,
  },
  {
    name: "pure paste, no reaction (must FIRE)",
    expectFire: true,
    text: realItems,
  },
  {
    name: "reaction only, quoting one line (must be SPARED)",
    expectFire: false,
    text: `wait. "Fixed the gallery routes so images render instead of 404ing" — that's my report, isn't it? i don't think i've ever had one land that clean. read it to me again.`,
  },
];
console.log("");
console.log("DIALOGUE-CEILING CONTROLS  (SYNTHETIC — proves the mechanism, not the frequency)");
let synthFail = 0;
for (const c of SYNTHETIC) {
  const v = classifyChangelog(c.text);
  const ok = v.isChangelog === c.expectFire;
  if (!ok) synthFail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${c.name.padEnd(46)} openers=${String(v.openers).padStart(2)} dlg=${v.dialogueRate.toFixed(4)} reason=${v.reason}`);
}
console.log(`  ${synthFail ? `${synthFail} control(s) FAILED — the ceiling does not do what it claims` : "all controls behave as specified"}`);

// The rent question the arms table cannot answer, stated explicitly.
const a1 = results.find((r) => r.arm.startsWith("A1"));
const a2 = results.find((r) => r.arm.startsWith("A2"));
const identical = JSON.stringify({ ...a1, arm: "" }) === JSON.stringify({ ...a2, arm: "" });
const ceilingAtTwo = bulkNeg.filter((b) => {
  const v = classifyChangelog(b.text);
  return v.openers >= 2 && v.dialogueRate >= DIALOGUE_CEILING;
}).length;
console.log("");
console.log(`CEILING RENT: at the shipped floor A1 and A2 are ${identical ? "IDENTICAL" : "different"}.`);
console.log(`  But the sweep shows it spares ${ceilingAtTwo} real beat(s) at floor 2 and 14 at floor 1.`);
console.log(`  ${identical
  ? "So it pays no rent at floor 3 and full rent at floor 2 — it is load-bearing the\n  moment the floor moves. Keep it, and do not treat the two constants as independent."
  : "The ceiling changes real outcomes at the shipped floor — keep it."}`);

if (SHOW) {
  console.log("");
  console.log("===== HELD-OUT CASES (shipped arm, flat shape) =====");
  for (const p of heldOut) {
    const v = classifyChangelog(p.text);
    console.log(`  ${v.isChangelog ? "FIRE" : "miss"}  ${p.name.padEnd(16)} openers=${String(v.openers).padStart(3)} refs=${String(v.issueRefs).padStart(3)} dlg=${v.dialogueRate.toFixed(4)} words=${v.words}  reason=${v.reason}`);
  }
  console.log("");
  console.log("===== ABOUT-WORK (must never fire) =====");
  for (const b of aboutWork) {
    const v = classifyChangelog(b.text);
    console.log(`  ${v.isChangelog ? "FIRE  <-- VETO" : "spared"}  ${b.id}  openers=${v.openers} dlg=${v.dialogueRate.toFixed(4)} reason=${v.reason}`);
  }
  const bulkFires = bulkNeg.filter((b) => classifyChangelog(b.text).isChangelog);
  if (bulkFires.length) {
    console.log("");
    console.log("===== BULK FALSE POSITIVES (must be empty) =====");
    for (const b of bulkFires) {
      const v = classifyChangelog(b.text);
      console.log(`  ${b.char}/${b.id}  openers=${v.openers} dlg=${v.dialogueRate.toFixed(4)}`);
      console.log(`     ${b.text.replace(/\s+/g, " ").slice(0, 140)}`);
    }
  }
}
