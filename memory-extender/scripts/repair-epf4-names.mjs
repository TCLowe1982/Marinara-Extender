// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// REPAIR THE BEATS THAT NAME A PERSON WHO WAS NEVER THERE (MarinaraExtender-v6tw).
//
// epf4 shipped the guard, which stops NEW fabrications. It does nothing about what is
// already stored, and what is already stored is retrievable today: two beats and their
// two companion entries name "Professor Alexei Kowalski" and "Dr. Alexei Petrov",
// neither of whom appears in the source text either beat was built from.
//
// THE COMPANION ENTRY IS THE POINT, NOT THE BEAT. The loader ranks and injects the
// ENTRY INDEX, never the beat store. A repaired beat sitting behind an unrepaired
// entry fixes nothing the user would ever see — and the summary is mirrored onto
// index.yaml as well, so there are three places per record, not one.
//
// IT REUSES THE SHIPPED GUARD rather than re-deriving the substitution. That is the
// whole reason this is safe to run: the repair is BY CONSTRUCTION identical to what
// the analyzer would now write, so it cannot invent a third spelling of the fix. The
// beat's own stored `text` is the source evidence, exactly as at write time.
//
// RUN IT WITH THE SIDECAR STOPPED. A script writing the store beside a live sidecar is
// a second uncoordinated writer — that is 1akw, and it has already cost this project a
// character's lorebook once.
//
//   node scripts/repair-epf4-names.mjs            # dry run, prints the diff
//   node scripts/repair-epf4-names.mjs --apply    # writes

const APPLY = process.argv.includes("--apply");
const CHARACTER = "professor_mari";

// Verified pairs. Each beat and the companion entry built from the same turn.
const TARGETS = [
  { beat: "beat-b17de10fbe6e", entry: "ctopic-melm6rkd" },
  { beat: "beat-710714a2f410", entry: "ctopic-6a7v97kp" },
];

const { knownNames, stripInventedNames, stripNamed } = await import("../dist/sentiment/name-guard.js");
const { readBeat, writeBeat } = await import("../dist/sentiment/encoder.js");
const { readEntry, writeEntry, mutateIndex, getDataDir } = await import("../dist/storage.js");

const exempt = await knownNames();
if (exempt === null) {
  console.error("[v6tw] could not load the exemption list — refusing to run.");
  console.error("       Without it every real name looks unsupported, which would strip the store.");
  process.exit(1);
}

console.log(`[v6tw] data dir: ${getDataDir()}`);
console.log(`[v6tw] ${exempt.length} exempt names loaded`);
console.log(`[v6tw] mode: ${APPLY ? "APPLY" : "dry run"}\n`);

let changes = 0;

for (const { beat: beatId, entry: entryId } of TARGETS) {
  const beat = await readBeat(CHARACTER, beatId);
  if (!beat) { console.error(`  !! ${beatId} not found`); continue; }

  // The source evidence. If a name is genuinely in here, the guard keeps it — which
  // is the point: this script cannot decide a name is fake, only the guard can.
  const source = beat.text ?? "";

  console.log(`── ${beatId}`);
  const patchedBeat = { ...beat };
  // The verdict is reached HERE, on the raw analysis fields, which is the only text
  // stripInventedNames may judge. Everything downstream reuses this verdict.
  const guilty = new Set();
  for (const field of ["motivation", "relationalDynamics", "outcome"]) {
    const before = beat[field];
    if (typeof before !== "string" || !before) continue;
    const { text, removed } = stripInventedNames(before, source, exempt);
    if (removed.length === 0) continue;
    changes++;
    removed.forEach((n) => guilty.add(n));
    patchedBeat[field] = text;
    console.log(`   ${field}: removed ${removed.join(", ")}`);
    console.log(`      - ${before.replace(/\s+/g, " ")}`);
    console.log(`      + ${text.replace(/\s+/g, " ")}`);
  }

  const entry = await readEntry("character", CHARACTER, `char-topics/${entryId}.yaml`);
  if (!entry) { console.error(`  !! ${entryId} not found`); continue; }

  // Assert the pair really is a pair before touching either. A mismatched link would
  // repair one record against another's evidence, which is a worse bug than the one
  // being fixed.
  const beatMsg = String(beat.provenanceKey ?? "").split(":")[0];
  if (beatMsg && entry.sourceMessageId && beatMsg !== entry.sourceMessageId) {
    console.error(`  !! ${beatId} and ${entryId} are not the same turn — skipping`);
    continue;
  }

  console.log(`── ${entryId} (the record the loader actually injects)`);
  const patchedEntry = { ...entry };
  // stripNamed, NOT stripInventedNames. The entry body is ASSEMBLED text carrying
  // structural labels — "Emotion:", "Motivation:", "Relational dynamics:", "Outcome:"
  // — every one of which is capitalised, absent from the source, and therefore
  // convictable. The first dry run of this script did exactly that and rewrote
  // "Emotion: vulnerability" to "someone: vulnerability". The verdict must come from
  // the raw fields above; here we only carry it out.
  for (const field of ["summary", "content"]) {
    const before = entry[field];
    if (typeof before !== "string" || !before) continue;
    const { text, removed } = stripNamed(before, [...guilty]);
    if (removed.length === 0) continue;
    changes++;
    patchedEntry[field] = text;
    console.log(`   ${field}: removed ${removed.join(", ")}`);
    console.log(`      - ${before.replace(/\s+/g, " ").slice(0, 150)}`);
    console.log(`      + ${text.replace(/\s+/g, " ").slice(0, 150)}`);
  }

  if (!APPLY) { console.log(""); continue; }

  await writeBeat(CHARACTER, patchedBeat);
  await writeEntry("character", CHARACTER, patchedEntry);
  // The index carries its own MIRRORED copy of the summary, and that mirror is what
  // the loader ranks. Writing the entry alone leaves the fabricated name live.
  await mutateIndex("character", CHARACTER, (index) => {
    const row = index.entries?.find((e) => e.id === entryId);
    if (!row) return false;
    row.summary = patchedEntry.summary;
    return true;
  });
  console.log(`   written: beat + entry + index row\n`);
}

console.log(`[v6tw] ${changes} field(s) ${APPLY ? "repaired" : "would be repaired"}.`);
if (!APPLY) console.log("[v6tw] dry run — nothing written. Re-run with --apply.");
