// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// SIZE THE CHANGELOG-DERIVED BEAT POPULATION (MarinaraExtender-mln9). READ-ONLY.
//
// mln9 found nine beats built from Marinara ENGINE release notes by grepping three
// specific changelog openers. Nine is what that grep found; the true count is unknown
// and the search was not systematic. This makes it systematic, and it deliberately
// stops at a MEASUREMENT — no retirement, no --apply, and no verdict.
//
// WHY THIS IS NOT A KEYWORD BLOCKLIST, per mln9's standing instruction. The ranking
// axis is the COUNT of sentence-initial enumeration verbs in one chunk, not their
// presence. One sentence opening with "Added" is a sentence; the true positives carry
// 4 to 53 of them. That is enumerated LIST STRUCTURE — structural evidence that
// happens to be carried by a word, not vocabulary matching. Measured on this store:
// 33 beats contain at least one opener and would trip a presence rule, while only 6
// carry three or more. The other 27 are real RP dialogue and genuine work notes, and
// a blocklist would have eaten every one of them. That gap is the whole difference
// between this and the rule mln9 forbids.
//
// WHAT THE FIRST PASS OF THIS SCRIPT GOT WRONG, kept because it cost a run and the
// next person will otherwise repeat it. mln9 hypothesised that release notes are
// identifiable by the ABSENCE of first/second person and dialogue plus dense proper
// nouns. Scored that way, the fourteen top-ranked beats contained ZERO changelogs —
// they were code, logs, CLI transcripts and bd output (the hjt9 / 4ghy populations,
// already tracked elsewhere) — while a plain Engine release-notes paste ranked 1666th.
// The reason is that user-facing release notes ADDRESS THE READER ("customize your
// experience"), so their person-rate runs higher than ordinary chat, exactly inverting
// the predicted signal. The hypothesis was not merely imprecise, it was backwards, and
// only a measured calibration set showed it.
//
// THE FALSE-POSITIVE TRAP, learned three times in one session and written down in
// self-ingest-triage.mjs: when you measure contamination, the contamination's own
// artifacts are the largest false-positive source, and the inflated number always
// looks like a scarier version of the true finding. The guard here is that the
// candidate set is SMALL ENOUGH TO READ IN FULL — eight beats — so no threshold gets
// to decide anything on its own, and every component is printed beside every verdict.
// A number nobody read is the thing this project keeps getting burned by.
//
// AND THE THREE GENERA STILL APPLY (self-ingest-triage.mjs). A chunk that is a
// changelog end to end is SCAFFOLDING with a third-party author. A chunk where a
// character REACTS to a changelog is ABOUT-WORK — a real utterance about a real event,
// and retiring it would be the fqnl error with the sign flipped. The topic is
// identical in both, so topic cannot separate them; measured here, DIALOGUE RATE does,
// by a factor of four (pastes 0.003-0.016, reactions 0.063-0.076). That is the one
// place mln9's predicted signals earn their keep — not at finding changelogs, but at
// telling a paste from a person talking about one.
//
//   node scripts/changelog-scan.mjs                 # counts, net agreement, all candidates
//   node scripts/changelog-scan.mjs --show=25       # rank the whole store instead
//   node scripts/changelog-scan.mjs --band="net B"  # one bucket: both nets / net A only / net B only
//   node scripts/changelog-scan.mjs --live          # exclude already-retired beats
//   node scripts/changelog-scan.mjs --openers-only  # all 33 opener-bearing beats, the blocklist's would-be catch
//   node scripts/changelog-scan.mjs --jsonl=out.jsonl   # dump features for calibration

import { readdirSync, readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";

const { parse } = await import("yaml");
const { getDataDir } = await import("../dist/storage.js");
const { classifyChangelog } = await import("../dist/sentiment/changelog.js");

const args = process.argv.slice(2);
const flag = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=")[1] : d; };
const SHOW = parseInt(flag("show", "0"), 10);
const BAND = flag("band", "");
const JSONL = flag("jsonl", "");
const LIVE_ONLY = args.includes("--live");
const OPENERS_ONLY = args.includes("--openers-only");

// ---------------------------------------------------------------------------
// FEATURES. All computed on the beat's own source text — the same evidence the
// analyzer saw when it scored the beat. The two that drive the nets (openers,
// issueRefs) are ABSOLUTE COUNTS; see the note on score() for why a rate is wrong
// here. The rest are rates, retained for reading and for the genus split, and no
// longer decisive.
// ---------------------------------------------------------------------------

// openers, issueRefs and dialogueRate are NOT recomputed in this file — they come
// from classifyChangelog(), the shipped detector. prompt-bench-v2's "ONE INSTRUMENT,
// SHARED" rule applies to scans as much as to benches: a scan carrying its own copy
// of the rule drifts from the guard, and then reports a store clean that production
// would still fire on. What is defined below is only the reporting extras.

const PERSON = /\b(i|me|my|mine|myself|you|your|yours|we|us|our|ours)\b/gi;
// Product/reference tokens: issue refs, versions, macros, tags, paths, file extensions.
// Wider than the detector's own issue-ref rule on purpose — this one is a reading aid
// in the report, not part of any verdict.
const REFTOK = /(#\d{2,6})|(\bv?\d+\.\d+\.\d+\b)|(%[a-z_0-9]+%)|(\[[a-z]+:)|(\b[a-z0-9_-]+\.(?:png|jpe?g|js|ts|mjs|json|yaml|md)\b)|(\s(?:->|→)\s)/gi;

const words = (s) => s.match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];
const count = (s, re) => (s.match(re) ?? []).length;

/** Capitalized tokens that are NOT sentence-initial — the proper-noun / product-term density. */
function midCapDensity(text) {
  const toks = text.split(/\s+/).filter(Boolean);
  if (toks.length < 2) return 0;
  let mid = 0, eligible = 0;
  let afterStop = true;
  for (const t of toks) {
    const bare = t.replace(/^[^A-Za-z]+/, "");
    if (/^[A-Za-z]/.test(bare)) {
      if (!afterStop) { eligible++; if (/^[A-Z]/.test(bare)) mid++; }
      else eligible++;
    }
    afterStop = /[.!?:]$/.test(t);
  }
  return eligible ? mid / eligible : 0;
}

function features(text) {
  const w = words(text);
  const n = w.length;
  if (!n) return null;
  const sentences = text.split(/[.!?]+\s/).filter((s) => s.trim().length > 0);
  // The three signals any verdict rests on come FROM the shipped detector, so this
  // scan and the guard cannot drift. `shipped` is what production would actually do.
  const v = classifyChangelog(text);
  return {
    words: n,
    sentences: sentences.length,
    openers: v.openers,
    issueRefs: v.issueRefs,                         // NET B, independent of the verbs.
    dialogueRate: v.dialogueRate,
    shipped: v.isChangelog,
    shippedReason: v.reason,
    openerPer100w: (100 * v.openers) / n,
    openerPerSent: v.openers / Math.max(1, sentences.length),
    // Retained and printed, but no longer decisive — see the header. These are the
    // features mln9 predicted would work; they are kept so the falsification stays
    // visible in the output rather than only in this comment.
    personRate: count(text, PERSON) / n,
    midCap: midCapDensity(text),
    refRate: count(text, REFTOK) / n,
    avgSentLen: n / Math.max(1, sentences.length),
  };
}

// TWO INDEPENDENT NETS, because one net cannot demonstrate its own coverage.
//
// A single detector keyed on enumeration verbs would find what enumeration verbs find,
// and mln9's whole complaint about the original grep is that it could not know what it
// missed. So the population is measured twice, by signals that do not share a failure
// mode, and the report prints the OVERLAP:
//
//   NET A — enumeration structure.  >= ABS_FLOOR sentence-initial changelog verbs.
//           Blind to: bullet-list changelogs, and any release note that narrates
//           rather than enumerates.
//   NET B — issue-reference density. >= REF_FLOOR "(#1234)" style refs. This is the
//           one token class near-exclusive to release notes in this store; ordinary
//           speech and RP do not cite issue numbers.
//           Blind to: changelogs published without issue numbers.
//
// A beat caught by B alone is precisely the kind of miss net A cannot see, so the
// B-only count is the honest estimate of net A's blind spot. If B-only is empty, the
// verb list is doing better than it has any right to; if it is large, the verb list is
// not the discriminator and the finding needs a different shape.
//
// ABSOLUTE COUNT, NOT DENSITY, deliberately. A per-100-word rate penalises exactly the
// clearest positives: a 3,544-word release-notes dump carries 20 openers and scores
// 0.56/100w, BELOW a 224-word work note with a single "Added" at 0.45. Length dilutes
// the signal it should confirm. Absolute count separates the calibration set cleanly
// (positives 4,6,20,36,53 against negatives 1,0,0) and needs no length term at all.
const ABS_FLOOR = 3;
const REF_FLOOR = 3;
const netA = (f) => f.openers >= ABS_FLOOR;
const netB = (f) => f.issueRefs >= REF_FLOOR;

// Ordering only — the larger net-A count first, then references. Nothing is classified
// by this number; the bands below exist to make the population readable, and every
// candidate is meant to be read rather than trusted to a threshold.
function score(f) {
  return f.openers + Math.min(10, f.issueRefs) / 100;
}

// ---------------------------------------------------------------------------

const charsDir = join(getDataDir(), "characters");
if (!existsSync(charsDir)) { console.error("no characters dir"); process.exit(1); }

const rows = [];
let scanned = 0, unparsed = 0, empty = 0, retiredSkipped = 0;

for (const c of readdirSync(charsDir)) {
  const beatsDir = join(charsDir, c, "beats");
  if (!existsSync(beatsDir)) continue;
  for (const fn of readdirSync(beatsDir)) {
    // NOTE: both filename conventions are live in this store — 'beat-<hex>.yaml' and
    // a bare '<id>.yaml'. Filtering on the 'beat-' prefix (as intimacy-scan.mjs does)
    // silently drops 568 beats including every one of lara/lara_2/lara_3. Do not.
    if (!fn.endsWith(".yaml")) continue;
    let rec;
    try { rec = parse(readFileSync(join(beatsDir, fn), "utf8")); }
    catch { unparsed++; continue; }
    if (!rec || typeof rec !== "object" || !rec.text) { empty++; continue; }
    scanned++;
    if (LIVE_ONLY && rec.retiredAt) { retiredSkipped++; continue; }
    const f = features(String(rec.text));
    if (!f) { empty++; continue; }
    rows.push({
      char: c, id: rec.id ?? fn.replace(/\.yaml$/, ""),
      speaker: rec.speaker ?? "", emotion: rec.emotion ?? "",
      created: rec.created ?? "", sourceType: rec.sourceType ?? "",
      retired: !!rec.retiredAt,
      ...f, score: score(f),
      excerpt: String(rec.text).replace(/\s+/g, " ").slice(0, 150),
    });
  }
}

rows.sort((a, b) => b.score - a.score);

const inA = rows.filter(netA);
const inB = rows.filter(netB);
const inBoth = rows.filter((r) => netA(r) && netB(r));
const aOnly = rows.filter((r) => netA(r) && !netB(r));
const bOnly = rows.filter((r) => !netA(r) && netB(r));
const candidates = rows.filter((r) => netA(r) || netB(r));
const strong = candidates;

const BANDS = [
  ["both nets", (r) => netA(r) && netB(r)],
  ["net A only (verbs)", (r) => netA(r) && !netB(r)],
  ["net B only (refs)", (r) => !netA(r) && netB(r)],
  ["neither", (r) => !netA(r) && !netB(r)],
];

console.log(`beats scanned              ${scanned}   (${unparsed} unparsed, ${empty} textless)`);
if (LIVE_ONLY) console.log(`retired, excluded          ${retiredSkipped}`);
console.log(`beats ranked               ${rows.length}`);
console.log("");
console.log(`CANDIDATE POPULATION       ${candidates.length}   (in either net — the number to hand-read)`);
for (const [label, pred] of BANDS) {
  const n = rows.filter(pred).length;
  console.log(`  ${label.padEnd(22)} ${String(n).padStart(5)}`);
}
console.log("");
console.log("NET AGREEMENT  (neither net can demonstrate its own coverage; the overlap can)");
console.log(`  net A  >=${ABS_FLOOR} enumeration verbs   ${inA.length}`);
console.log(`  net B  >=${REF_FLOOR} issue refs          ${inB.length}`);
console.log(`  caught by BOTH                ${inBoth.length}`);
console.log(`  net B ONLY                    ${bOnly.length}   <- net A's measured blind spot`);
console.log(`  net A ONLY                    ${aOnly.length}   <- net B's measured blind spot`);

// THE PRESENCE-VS-DENSITY GAP — the number that justifies using the opener token at
// all without becoming the blocklist mln9 forbids.
const withOpener = rows.filter((r) => r.openers > 0);
console.log("");
console.log("PRESENCE vs DENSITY  (why the blocklist ban is right and this is not one)");
console.log(`  beats containing >=1 opener   ${withOpener.length}   <- a presence blocklist fires on all of these`);
console.log(`  beats carrying >=${ABS_FLOOR} openers     ${inA.length}   <- enumerated structure`);
console.log(`  spared by density             ${withOpener.length - inA.length}   <- real sentences that merely open with one`);

// Live-path check: mln9's core claim is that this is not legacy residue.
const byYearMonth = {};
for (const r of strong) {
  const ym = String(r.created).slice(0, 7) || "unknown";
  byYearMonth[ym] = (byYearMonth[ym] ?? 0) + 1;
}
console.log("");
console.log("STRONG CANDIDATES BY MONTH  (is it still happening?)");
for (const ym of Object.keys(byYearMonth).sort()) {
  console.log(`  ${ym}   ${String(byYearMonth[ym]).padStart(4)}`);
}

const speakers = {};
for (const r of strong) speakers[r.speaker] = (speakers[r.speaker] ?? 0) + 1;
console.log("");
console.log("STRONG CANDIDATES BY SPEAKER  (mln9 predicts 'the user pasting')");
for (const [s, n] of Object.entries(speakers).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(n).padStart(4)}  ${JSON.stringify(s)}`);
}

function print(list, label) {
  console.log("");
  console.log(`===== ${label} =====`);
  for (const r of list) {
    console.log("");
    console.log(`[${r.score.toFixed(2)}] ${r.char}/${r.id}  ${r.created}  emotion=${r.emotion}  speaker=${JSON.stringify(r.speaker)}${r.retired ? "  RETIRED" : ""}`);
    console.log(`   nets=${netA(r) ? "A" : "-"}${netB(r) ? "B" : "-"} openers=${r.openers} issueRefs=${r.issueRefs} per100w=${r.openerPer100w.toFixed(2)} perSent=${r.openerPerSent.toFixed(2)} words=${r.words}`);
    console.log(`   shipped verdict: ${r.shipped ? "FIRES" : "spared"} (${r.shippedReason})`);
    console.log(`   [mln9's predicted signals, kept visible] person=${r.personRate.toFixed(4)} midCap=${r.midCap.toFixed(3)}`);
    console.log(`   ${r.excerpt}`);
  }
}

if (OPENERS_ONLY) print(withOpener, `ALL BEATS CONTAINING AN OPENER (${withOpener.length})`);
else if (BAND) {
  const found = BANDS.find(([l]) => l.startsWith(BAND));
  if (found) print(rows.filter(found[1]).slice(0, SHOW || 25), found[0]);
  else console.error(`unknown band: ${BAND}`);
} else if (SHOW) print(rows.slice(0, SHOW), `TOP ${SHOW}`);
else print(candidates, `ALL CANDIDATES (${candidates.length}) — hand-read every one`);

if (JSONL) {
  writeFileSync(JSONL, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log("");
  console.log(`features written to ${JSONL}  (${rows.length} rows)`);
}
