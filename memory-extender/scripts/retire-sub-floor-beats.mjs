// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Retire the beats the content floor would never have created (s8qe).
//
// DRY RUN BY DEFAULT. Pass --apply to write.
//
// SCOPE, and how it differs from 0y2i. That cleanup retired ENTRIES and KEPT
// BEATS, because the beat still held real emotion/dynamics/outcome tracking real
// text — only the motivation field had collapsed. TC ruled that precedent does
// not extend here, and the distinction is exact: those beats had real text under
// the boilerplate. THESE HAVE NOTHING UNDER THEM. The chunk IS the artifact —
// 502 beats whose entire source text is the token "open", a `status: open` line
// parsed as dialogue, plus "POST", "PATCH", README.md. There is no salvageable
// layer, so entries AND beats both retire.
//
// THE SELECTOR IS THE SHIPPED FLOOR, not a hand-written list. A beat is targeted
// iff its text fails meetsContentFloor() at the configured min_chunk_tokens.
// That makes this exactly "retire what the current code would never have made",
// which is reproducible by anyone re-running it and cannot drift from the floor.
//
// MARK, NEVER DELETE. retireBeats() and retireEntries() both stamp a reason and
// leave the row at full fidelity. Nothing here removes a file.
//
// THE 06-12 CARVE-OUT IS A HARD GATE, NOT A CHECK. On 2026-06-12, three beats in
// professor_mari's ledger record the DECISION to use that sentence as the
// prompt's one-shot ("the model needed to be SHOWN what specificity looks like
// in MY voice"). They are the origin record of the entire pifl finding and are
// irreplaceable. Both June chats in the target population are dated around them,
// so this script REFUSES TO APPLY if any targeted beat is one of them, rather
// than trusting that the text selector happens to exclude them.
//
// Usage:
//   node scripts/retire-sub-floor-beats.mjs              # dry run
//   node scripts/retire-sub-floor-beats.mjs --apply      # backup, then write

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { parse } from "yaml";

const { getDataDir, readIndex, readColdIndex, retireEntries } = await import("../dist/storage.js");
const { readAllBeats, retireBeats } = await import("../dist/sentiment/encoder.js");
const { meetsContentFloor } = await import("../dist/sentiment/classifier.js");
const { loadSentimentConfig } = await import("../dist/sentiment/config.js");
const { recordStatsEvent } = await import("../dist/stats-events.js");
const { backupDataDir } = await import("../dist/backup.js");
const { companionEntryFromBeat } = await import("../dist/sentiment/encoder.js");

const APPLY = process.argv.includes("--apply");
const REASON = "sub-floor chunk — no analysable content (s8qe)";
const ISSUE = "MarinaraExtender-s8qe";

const MIN_TOKENS = loadSentimentConfig().min_chunk_tokens ?? 2;
const dataDir = getDataDir();

// ── The heritage gate ─────────────────────────────────────────────────────────
// Identified by what they SAY, not by id: ids would rot silently if the store is
// ever rebuilt, and a silent gate is worse than none.
const HERITAGE_DAY = "2026-06-12";
const HERITAGE_CHAR = "professor_mari";
const HERITAGE_TALK = /\bshown\b|\bone-?shot\b|\bspecificity\b|\bmy voice\b|\bexample\b/i;

function isHeritage(characterId, beat) {
  if (characterId !== HERITAGE_CHAR) return false;
  if (!String(beat.created ?? "").startsWith(HERITAGE_DAY)) return false;
  return HERITAGE_TALK.test(`${beat.motivation ?? ""} ${beat.text ?? ""}`);
}

// ── Collect targets ───────────────────────────────────────────────────────────

const characterIds = await readdir(join(dataDir, "characters")).catch(() => []);
const targets = [];       // beats to retire
const heritageHits = [];  // must be empty
const heritageSeen = [];  // for the report — proof the gate found them at all

for (const characterId of characterIds) {
  // includeRetired so a re-run reports accurately instead of "finding" nothing.
  const beats = await readAllBeats(characterId, { includeRetired: true }).catch(() => []);
  for (const beat of beats) {
    if (isHeritage(characterId, beat)) heritageSeen.push({ characterId, id: beat.id, text: String(beat.text ?? "").slice(0, 60) });
    if (beat.retiredAt) continue;
    if (meetsContentFloor(String(beat.text ?? ""), MIN_TOKENS)) continue;
    if (isHeritage(characterId, beat)) { heritageHits.push({ characterId, id: beat.id }); continue; }
    targets.push({ characterId, beat });
  }
}

// ── Match companion entries ───────────────────────────────────────────────────
// A beat's companion entry is found by its rendered summary, which is how it was
// created (companionEntryFromBeat). Matching on that rather than on an id link,
// because beats carry no entry id — the same reason 0y2i matched on summary.

const wantedSummaries = new Map();   // summary -> count of beats that produced it
for (const { beat } of targets) {
  const { summary } = companionEntryFromBeat(beat);
  if (summary) wantedSummaries.set(summary, (wantedSummaries.get(summary) ?? 0) + 1);
}

async function scopes() {
  const out = [];
  for (const [kind, sub] of [["character", "characters"], ["chat", "chats"]]) {
    try {
      for (const id of await readdir(join(dataDir, sub))) out.push({ scope: kind, scopeId: id });
    } catch {}
  }
  return out;
}

const entryTargets = [];
// Already-retired companions, counted from COLD. retireEntries() moves a retired
// row out of the live index entirely, so a live-index scan reports zero of them
// and the live count looks alarmingly small. Counting cold is what turns "only 12
// entries for 517 beats?" from a red flag into an accounted-for number — most of
// this entry population was already taken by the 0y2i echo cleanup.
const alreadyCold = new Map();
for (const { scope, scopeId } of await scopes()) {
  const index = await readIndex(scope, scopeId).catch(() => null);
  for (const row of index?.entries ?? []) {
    if (row.discardedAt) continue;
    if (!wantedSummaries.has(row.summary)) continue;
    entryTargets.push({ scope, scopeId, id: row.id, summary: row.summary });
  }
  const cold = await readColdIndex(scope, scopeId).catch(() => null);
  for (const row of cold?.entries ?? []) {
    if (!wantedSummaries.has(row.summary)) continue;
    const r = row.retiredReason ?? (row.deletedAt ? "(user deleted)" : "(no reason)");
    alreadyCold.set(r, (alreadyCold.get(r) ?? 0) + 1);
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

const byText = new Map();
for (const { beat } of targets) {
  const t = String(beat.text ?? "");
  byText.set(t, (byText.get(t) ?? 0) + 1);
}
const byChar = new Map();
for (const { characterId } of targets) byChar.set(characterId, (byChar.get(characterId) ?? 0) + 1);
const byChat = new Map();
for (const { beat } of targets) {
  const c = beat.sourceChatId ?? "(none)";
  byChat.set(c, (byChat.get(c) ?? 0) + 1);
}

console.log(`floor in force            : min_chunk_tokens = ${MIN_TOKENS}`);
console.log(`beats below the floor     : ${targets.length}`);
console.log(`companion entries LIVE    : ${entryTargets.length}`);
for (const [r, n] of [...alreadyCold.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  already cold            : ${String(n).padStart(4)}  ${r}`);
}
console.log("");
console.log("DISTINCT CHUNK TEXTS TARGETED");
for (const [t, n] of [...byText.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${String(n).padStart(4)} x  ${JSON.stringify(t)}`);
}
console.log("\nBY CHARACTER STORE");
for (const [c, n] of [...byChar.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${c}`);
console.log("\nBY SOURCE CHAT");
for (const [c, n] of [...byChat.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${c}`);

console.log("\nHERITAGE GATE (06-12 origin beats — must never be touched)");
console.log(`  heritage beats located in store : ${heritageSeen.length}`);
for (const h of heritageSeen) console.log(`     ${h.characterId}  ${h.id}  ${JSON.stringify(h.text)}`);
console.log(`  heritage beats inside target set: ${heritageHits.length}`);

if (heritageHits.length > 0) {
  console.error("\nABORT — the target set brushes the 06-12 heritage beats. Nothing was written.");
  for (const h of heritageHits) console.error(`   ${h.characterId}  ${h.id}`);
  process.exit(1);
}

if (heritageSeen.length === 0) {
  console.warn("\n  NOTE: the gate located no heritage beats at all. That is expected only if");
  console.warn("  they live outside professor_mari or off 2026-06-12 — verify before trusting");
  console.warn("  a clean gate. A gate that matches nothing proves nothing.");
}

if (!APPLY) {
  console.log("\nDRY RUN — nothing was written. Re-run with --apply.");
  process.exit(0);
}

// ── Apply ─────────────────────────────────────────────────────────────────────

console.log("\nBacking up the data dir before touching anything...");
const backup = await backupDataDir();
console.log(`  backup: ${backup.dir}  (${backup.files} files)`);

const byCharacter = new Map();
for (const { characterId, beat } of targets) {
  if (!byCharacter.has(characterId)) byCharacter.set(characterId, []);
  byCharacter.get(characterId).push(beat.id);
}

let beatsRetired = 0;
for (const [characterId, ids] of byCharacter) {
  beatsRetired += (await retireBeats(characterId, ids, REASON)).length;
}

const byScope = new Map();
for (const e of entryTargets) {
  const k = `${e.scope} ${e.scopeId}`;
  if (!byScope.has(k)) byScope.set(k, []);
  byScope.get(k).push(e.id);
}
let entriesRetired = 0;
for (const [k, ids] of byScope) {
  const [scope, scopeId] = k.split(" ");
  entriesRetired += (await retireEntries(scope, scopeId, ids, REASON)).length;
}

const event = await recordStatsEvent({
  kind: "retirement",
  issue: ISSUE,
  reason:
    "Retired the sub-floor beat stratum: chunks with fewer than " + MIN_TOKENS +
    " raw tokens, overwhelmingly the token 'open' produced by a `status: open` line " +
    "parsed as dialogue (4ghy). 89.1% of these carried a prompt-example motivation " +
    "and only 15.6% were distinct. Entries AND beats retired — unlike 0y2i, there " +
    "was no real text under the boilerplate; the chunk itself was the artifact.",
  selector: `meetsContentFloor(beat.text, ${MIN_TOKENS}) === false`,
  counts: { beats: beatsRetired, entries: entriesRetired, distinctTexts: byText.size },
  spared:
    `The ${HERITAGE_DAY} origin beats in ${HERITAGE_CHAR} that record choosing the ` +
    "sentence as the prompt's one-shot. Gated on, not assumed: the script aborts if " +
    "any is in the target set.",
  backup: backup.dir,
  affectsHistoricalCurves: true,
});

console.log(`\nAPPLIED`);
console.log(`  beats retired   : ${beatsRetired}`);
console.log(`  entries retired : ${entriesRetired}`);
console.log(`  stats event     : ${event.id}`);
console.log(`  backup          : ${backup.dir}`);
console.log("\nNothing was deleted. Re-run chunk-floor-scan.mjs to see the curve with the");
console.log("retirement declared.");
