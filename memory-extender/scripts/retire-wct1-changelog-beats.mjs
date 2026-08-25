// Marinara Extender — wct1: retire the six changelog-derived beats mln9 found.
//
// mln9 shipped the GATE (classifyChangelog). The gate stops new ones; it does
// not clean the old. These six remain retrievable, so the character can still
// "remember feeling ashamed" about an Engine bug she has no relationship to —
// which is the harm the ticket was actually about. Two reached the ledger on the
// CURRENT build, which is what settles that it was live and not history.
//
// NOT A PREDICATE SWEEP. fqnl's rule stands: a provenance failure is triage, not
// a verdict. Six records is small enough to read, and they were read before this
// was written. The ids are hard-coded on purpose so this script cannot widen.
//
// The two ABOUT-WORK beats (beat-4cf78d9e6f32, beat-e45fb60631d1) are Mari
// reacting in her own voice to real work. They are pinned as must-not-fire cases
// in changelog.test.ts and are NOT touched here. Their dialogue rate is 4.4-6.4%
// against 0.2-1.4% for the pastes — the 4x split mln9 measured.
//
// Companion entries are handled by retireBeats itself, veto included (41uo): an
// entry is retired only when no surviving beat produces the same summary.
//
// Usage:
//   node scripts/retire-wct1-changelog-beats.mjs            # dry run
//   node scripts/retire-wct1-changelog-beats.mjs --execute   # write
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(join(PKG, "dist", p)).href);
const EXECUTE = process.argv.includes("--execute");

const CHAR = "professor_mari";
const TARGETS = [
  "beat-37faa0d37ec5", "beat-d7d767b27166", "beat-2b6ff6f8480d",
  "beat-a39cf0d43085", "beat-6e75eeb7f8b6", "beat-61b2658165f9",
];
const MUST_SURVIVE = ["beat-4cf78d9e6f32", "beat-e45fb60631d1"];
const REASON = "wct1: derived from a pasted Engine changelog, not a lived moment (mln9)";

const { classifyChangelog } = await imp("sentiment/changelog.js");
const { retireBeats, readBeat } = await imp("sentiment/encoder.js");
const { snapshotScope } = await imp("backup.js");

// RE-VERIFY WITH THE SHIPPED DETECTOR before writing. The scan and the gate must
// not be able to disagree — if a target no longer classifies as release-notes,
// something changed and this must not run blind.
let bad = 0;
for (const id of TARGETS) {
  const b = await readBeat(CHAR, id);
  if (!b) { console.log(`  ABORT-WORTHY: ${id} not found`); bad++; continue; }
  if (b.retiredAt) { console.log(`  already retired: ${id}`); continue; }
  const v = classifyChangelog(String(b.text ?? ""));
  if (!v.isChangelog) { console.log(`  ABORT-WORTHY: ${id} no longer classifies as changelog (${v.reason})`); bad++; }
}
for (const id of MUST_SURVIVE) {
  const b = await readBeat(CHAR, id);
  if (!b) { console.log(`  ABORT-WORTHY: protected beat ${id} missing`); bad++; continue; }
  const v = classifyChangelog(String(b.text ?? ""));
  if (v.isChangelog) { console.log(`  ABORT-WORTHY: protected beat ${id} now classifies as changelog`); bad++; }
  if (b.retiredAt) { console.log(`  ABORT-WORTHY: protected beat ${id} is ALREADY retired`); bad++; }
}
if (bad) { console.log(`\nREFUSING: ${bad} precondition failure(s). Nothing written.`); process.exit(1); }
console.log(`preconditions ok — ${TARGETS.length} targets classify as release-notes, ${MUST_SURVIVE.length} protected beats intact\n`);

if (!EXECUTE) {
  console.log("DRY RUN. Would retire:");
  for (const id of TARGETS) console.log(`   ${id}`);
  console.log(`\nreason: ${REASON}`);
  console.log("\nCompanion entries are decided by retireBeats' veto at write time; re-run with --execute.");
  process.exit(0);
}

await snapshotScope("character", CHAR);
console.log("snapshot taken.");
const done = await retireBeats(CHAR, TARGETS, REASON);
console.log(`\nretired ${done.length} beat(s):`);
for (const id of done) console.log(`   ${id}`);
