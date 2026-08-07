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
//
// ─────────────────────────────────────────────────────────────────────────────
// SECOND PASS 2026-08-06 — RETIRING THE BEAT DID NOT TAKE IT OUT OF RECALL.
//
// The first run marked 24 beats and stopped there. But the loader never reads the
// beat store for recall: it ranks over the ENTRY index and injects entries, and
// its exclusion checks are deletedAt / discardedAt / supersededBy / unplayed —
// retiredAt is not among them, because retiredAt lives on the BEAT.
//
// MEASURED, all 541 retired beats in the store:
//     24 of 24  pe4o retirements  — companion entry STILL LIVE
//    366 of 517 s8qe sub-floor    — companion entry STILL LIVE
// So the pe4o cleanup removed those records from statistics and arc promotion and
// left the recallable copy exactly where it was. The ticket's third harm — "it
// feeds recall" — was the one the remedy did not touch.
//
// This pass therefore retires the COMPANION ENTRY alongside the beat, and repairs
// the 24 from the first run. retireEntries (0y2i) is the matching tier move on
// the entry side: cold, full fidelity, out of recall, reason recorded, and never
// listed as something the user deleted.
//
// THE 12 BELOW ARE AN EXPLICIT LIST, NOT A THRESHOLD, and that is deliberate.
// They score 26-46% coverage, under the 0.6 SCAFFOLDING bar — but reading them
// shows every one is machine text end to end. The ratio undercounts because the
// PROMPTS.md furniture BETWEEN the quoted prompt spans ("Tier 2 analyzer — joy",
// the JSON fragment, "its 'motivation' rules are shared across all ten") is not
// in the signature set, so it counts as "not prompt". Lowering the threshold to
// catch them would be tuning a number until it produces the answer I already
// reached by reading, which is the opposite of measuring. Each id carries what
// was found in it (fqnl: triage by inspection, never by predicate).

import { readdir } from "fs/promises";

const { getDataDir, retireEntries } = await import("../dist/storage.js");
const { snapshotScope } = await import("../dist/backup.js");
const { readAllBeats, readBeat, retireBeats, companionEntryFromBeat } = await import("../dist/sentiment/encoder.js");
const { echoesPhrases, skeletonTokens } = await import("../dist/sentiment/analyzer.js");
const { ownPromptSignatures } = await import("../dist/sentiment/self-prompt.js");

const APPLY = process.argv.includes("--apply");
// --only <character>  restrict to one scope. A live-store mutation gets a canary
// first, and the script is idempotent (both retire helpers skip rows that already
// carry the mark), so the narrow run and the full run compose safely.
const ONLY = (() => { const i = process.argv.indexOf("--only"); return i > 0 ? process.argv[i + 1] : null; })();
const scopes = async () => {
  const all = await readdir(`${getDataDir()}/characters`).catch(() => []);
  return ONLY ? all.filter((c) => c === ONLY) : all;
};

const REASON_SCAFFOLD = "self-ingested prompt text (pe4o) — chunk was our own system prompt, not an utterance";
const REASON_BOAT     = "prompt-example echo on ingested scaffolding (pe4o/97z2) — no real boat scene exists in the store";
const REASON_CATALOG  = "self-ingested PROMPTS.md catalog section (pe4o) — documentation of our own prompt, read and confirmed individually";

// The MIXED bucket, read one at a time. Speaker labels in quotes are PHANTOMS the
// chunker minted from document HEADINGS ("Format:", "SOFT SIGNALS:", "BAD:") — no
// such person exists, which is corroboration on its own that this is a document.
const INSPECTED = [
  ["beat-a083df7fffdb", `"Format" — PROMPTS.md dysregulation section: JSON schema tail + "Tier 2 analyzer" + the emotion's system prompt`],
  ["beat-4bba5908b5f6", `"Format" — same section, trust`],
  ["beat-a7859642cdfc", `"Format" — same section, joy`],
  ["beat-f8fe2689d88a", `"Format" — same section, desire`],
  ["beat-0925137cd333", `"Format" — same section, shame`],
  ["beat-2819890b0ed9", `"Format" — same section, hope`],
  ["beat-8048a81c76aa", `"Format" — same section, vulnerability`],
  ["beat-ce62cca46237", `"Format" — same section, anger`],
  ["beat-e5849c0d7718", `"Format" — same section, relief`],
  ["beat-6a4415fa10a4", `"SOFT SIGNALS" — the bookmark-command block from the memory-system prompt, then the fear section`],
  ["beat-294970359caa", `"BAD" — analyzer.ts source: the thread-rule bad examples and two const json_format declarations`],
  ["beat-d0efc99b91cb", `"Lara" — a debugging transcript: dumped sample beats, a bash command, its grep output, analyzer.ts source`],
];

// KEPT, and the one record the ABOUT-WORK bucket was built to protect:
//   beat-53e28a042395 (3%, speaker "user") — 2,242 chars of real, ranked technical
//   self-criticism ("here's the smell, ranked — and the worst one is mine from
//   today"), which quotes ONE prompt line while making its point. A person said
//   this. Mari's heritage rule holds: a real utterance is not retired for being
//   about work rather than about feelings. Routing it to the ops lane is hjt9's
//   question, not a reason to retire it here.
const KEPT = "beat-53e28a042395";

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

const inspected = new Map(INSPECTED);
let scanned = 0, protectedByScene = 0;
for (const ch of await scopes()) {
  for (const b of await readAllBeats(ch, { includeRetired: false }).catch(() => [])) {
    scanned++;
    if (b.id === KEPT) continue;
    const text = String(b.text ?? "");
    const cov = coverage(text);

    if (inspected.has(b.id)) {
      add(ch, b.id, REASON_CATALOG, `${Math.round(cov * 100)}% by ratio, 100% by reading — ${inspected.get(b.id)}`);
      continue;
    }
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

// ── Companion entries ────────────────────────────────────────────────────────
//
// Includes beats retired by the FIRST run, whose companions are all still live.
// The join is the summary companionEntryFromBeat builds — an exact match on the
// collapsed string, never a prefix. Several of these motivations share their
// first sixty characters, so a prefix test would retire a neighbour's entry.
const companionPlan = new Map();  // character -> [{entryId, beatId, reason, repair}]
const seenEntry = new Set();      // one entry can be several beats' companion
const vetoed = [];
const indexOf = new Map();
const { readIndex } = await import("../dist/storage.js");
for (const ch of await scopes()) {
  indexOf.set(ch, (await readIndex("character", ch).catch(() => null))?.entries ?? []);
}
const collapse = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// EVERY SUMMARY A BEAT WE ARE KEEPING WOULD PRODUCE.
//
// THE VETO, and it stopped 32 wrong retirements on the first dry run. The join to
// a companion is a summary match, and summaries are emphatically NOT unique: the
// pifl illustration "admits she's afraid the memory loss means she was never
// real" is byte-identical across dozens of live beats, because the model copied
// it. So the entry named by a retired beat's summary may equally be the only
// recallable copy of a beat nobody is retiring. Same shape as the lobster rider —
// one string, many records — except here it deletes instead of miscounting.
//
// So a companion is retired ONLY when no beat we are keeping would produce its
// summary. Anything ambiguous is reported and left alone: leaving machine text in
// recall is recoverable, removing a real memory is not.
const keepSummaries = new Map();  // "char|summary" -> [beatId]
{
  const targeted = new Set(INSPECTED.map(([id]) => id));
  for (const ch of await scopes()) {
    for (const b of await readAllBeats(ch, { includeRetired: false }).catch(() => [])) {
      if (targeted.has(b.id)) continue;              // being retired in this run
      const k = `${ch}|${collapse(companionEntryFromBeat(b).summary)}`;
      if (!keepSummaries.has(k)) keepSummaries.set(k, []);
      keepSummaries.get(k).push(b.id);
    }
  }
}

async function planCompanion(ch, beatId, reason, repair) {
  const beat = await readBeat(ch, beatId).catch(() => null);
  if (!beat) return;
  const want = collapse(companionEntryFromBeat(beat).summary);
  if (!want) return;
  const alsoKept = keepSummaries.get(`${ch}|${want}`);
  if (alsoKept?.length) {
    vetoed.push({ ch, beatId, want, alsoKept });
    return;
  }
  for (const e of indexOf.get(ch) ?? []) {
    if (e.discardedAt || e.deletedAt) continue;
    if (collapse(e.summary) !== want) continue;
    if (seenEntry.has(e.id)) continue;
    seenEntry.add(e.id);
    if (!companionPlan.has(ch)) companionPlan.set(ch, []);
    companionPlan.get(ch).push({ entryId: e.id, beatId, reason, repair });
  }
}

for (const [ch, rows] of plan) for (const r of rows) await planCompanion(ch, r.id, r.reason, false);

// REPAIR: already-retired beats whose recallable copy was left behind.
let repaired = 0;
for (const ch of await scopes()) {
  for (const b of await readAllBeats(ch, { includeRetired: true }).catch(() => [])) {
    if (!b.retiredAt || b.id === KEPT) continue;
    if (!String(b.retiredReason ?? "").includes("pe4o")) continue;   // this ticket's own only
    const before = (companionPlan.get(ch) ?? []).length;
    await planCompanion(ch, b.id, String(b.retiredReason), true);
    repaired += ((companionPlan.get(ch) ?? []).length - before);
  }
}

const total = [...plan.values()].reduce((a, r) => a + r.length, 0);
const compTotal = [...companionPlan.values()].reduce((a, r) => a + r.length, 0);
console.log(`live beats scanned: ${scanned}`);
console.log(`beats to retire: ${total}   protected by the scene carve-out: ${protectedByScene}`);
console.log(`companion entries to retire: ${compTotal}   (${repaired} repairing the first run)`);
console.log(`kept: ${KEPT} — a real utterance, see the header\n`);

for (const [ch, rows] of plan) {
  console.log(`── beats · ${ch} (${rows.length}) ──`);
  for (const r of rows) console.log(`  ${r.id}  ${r.why}`);
}
console.log();
for (const [ch, rows] of companionPlan) {
  console.log(`── companion entries · ${ch} (${rows.length}) ──`);
  for (const r of rows) console.log(`  ${r.entryId}  <- ${r.beatId}${r.repair ? "   [REPAIR: beat was already retired, entry was not]" : ""}`);
}

if (vetoed.length) {
  console.log(`\n── VETOED: ${vetoed.length} companion(s) LEFT ALONE ──`);
  console.log("  Their summary is shared with a beat nobody is retiring, so the entry");
  console.log("  cannot be attributed to the self-ingested one. Machine text left in");
  console.log("  recall is recoverable; a real memory removed is not.");
  const byText = new Map();
  for (const v of vetoed) {
    if (!byText.has(v.want)) byText.set(v.want, { n: 0, keep: new Set() });
    const g = byText.get(v.want);
    g.n++; for (const k of v.alsoKept) g.keep.add(k);
  }
  for (const [text, g] of [...byText].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${String(g.n).padStart(3)} retiring beat(s) share this with ${g.keep.size} kept beat(s):`);
    console.log(`      ${JSON.stringify(text.slice(0, 100))}`);
  }
  console.log("  These are pifl echoes — the model copying a prompt illustration. They");
  console.log("  belong to the bait cleanup, not to pe4o. Do not fold the two together.");
}

if (!APPLY) {
  console.log("\nDRY RUN. Nothing was written. Re-run with --apply.");
  process.exit(0);
}

// A live-store mutation gets a recover point first, per house law. snapshotScope
// is the same call the re-import path makes before it purges by chat.
console.log("\nSNAPSHOTTING…");
for (const ch of new Set([...plan.keys(), ...companionPlan.keys()])) {
  await snapshotScope("character", ch);
  console.log(`  snapshot: character:${ch}`);
}

console.log("\nAPPLYING…");
let marked = 0;
for (const [ch, rows] of plan) {
  for (const reason of new Set(rows.map((r) => r.reason))) {
    const ids = rows.filter((r) => r.reason === reason).map((r) => r.id);
    const done = await retireBeats(ch, ids, reason);
    marked += done.length;
    console.log(`  beats     ${ch}: marked ${done.length}/${ids.length}  [${reason.slice(0, 44)}…]`);
  }
}
let markedEntries = 0;
for (const [ch, rows] of companionPlan) {
  for (const reason of new Set(rows.map((r) => r.reason))) {
    const ids = rows.filter((r) => r.reason === reason).map((r) => r.entryId);
    const done = await retireEntries("character", ch, ids, reason);
    markedEntries += done.length;
    console.log(`  companions ${ch}: retired ${done.length}/${ids.length}  [${reason.slice(0, 44)}…]`);
  }
}
console.log(`\nretired ${marked} beat(s) and ${markedEntries} companion entr${markedEntries === 1 ? "y" : "ies"}.`);
console.log("Mark, not delete — full fidelity in cold, out of recall, reason recorded.");
console.log("The entry is the half that was recallable; the beat alone never was.");
