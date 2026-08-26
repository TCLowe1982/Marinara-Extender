// pe1c — retire the ghost scope, and four resolved threads with it.
//
// ONE SHOT, DELIBERATELY. The evs1 lesson: the watchdog relaunches the sidecar in
// ~10s, so a multi-step repair against the live store must be a script that runs
// to completion, never a sequence typed interactively into that window.
//
// WHAT THIS DOES, and why each part is safe:
//
//  1. BACKS UP FIRST, outside data/, because data/ is gitignored and there is no
//     other copy. The ghost index, professor_mari's index, and the four entry
//     files being retired.
//
//  2. RETIRES four threads in professor_mari via retireEntries() — the same
//     mechanism wct1 used. That is a TIER MOVE, not a delete: the rows go cold at
//     full fidelity with discardedAt + retiredReason, are excluded from recall,
//     and show in the memory tab's Discarded view (ud30). Reversible.
//     TC, 2026-08-25: "They are threads that have been resolved, more or less. Or
//     been superseded by things beyond that entry." Not supersedeEntry, because
//     there is no single replacement row to point at.
//
//  3. DELETES data/characters/__professor_mari__/ outright. This one IS a delete,
//     and it is safe because the scope holds NOTHING BUT A STALE INDEX: 657 rows
//     whose every `path:` points at a file that does not exist, and all 657
//     summaries verified present in a live index elsewhere — checked row by row,
//     not sampled. Zero unique. The 26 rows with a higher retrievalCount are
//     odometer readings from a scope that froze on 2026-06-02, and one of them
//     would have REOPENED a thread the live store has since marked done, which is
//     the proof the ghost is stale rather than authoritative.
//
//     The live cost of leaving it: listScopeIds() returns every directory under
//     data/characters/, so promotion and cleanup walk 657 dead rows every cycle.
//     It never reaches the prompt — the identity map resolves __professor_mari__
//     to professor_mari before the loader runs.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(PKG, "data");
const GHOST = join(DATA, "characters", "__professor_mari__");
const LIVE = join(DATA, "characters", "professor_mari");
const STAMP = process.env.PE1C_STAMP;             // passed in — Date.now() is banned in workflows and unhelpful here
if (!STAMP) throw new Error("PE1C_STAMP required");
const BACKUP = join(PKG, "backups", `pe1c-${STAMP}`);

const REASON = "resolved, or superseded by later work beyond the entry (TC, 2026-08-25, pe1c review)";
const IDS = JSON.parse(readFileSync(join(PKG, "scratch", "retire-ids.json"), "utf8"));

const { retireEntries, readIndex, readColdIndex } = await import(
  pathToFileURL(join(PKG, "dist", "storage.js")).href
);

// ── 1. back up ───────────────────────────────────────────────────────────────
mkdirSync(BACKUP, { recursive: true });
cpSync(GHOST, join(BACKUP, "__professor_mari__"), { recursive: true });
cpSync(join(LIVE, "index.yaml"), join(BACKUP, "professor_mari.index.yaml"));
const before = YAML.parse(readFileSync(join(LIVE, "index.yaml"), "utf8"));
const rows = (before.entries || []).filter((e) => IDS.includes(e.id));
mkdirSync(join(BACKUP, "entries"), { recursive: true });
for (const r of rows) {
  const src = join(LIVE, r.path);
  if (existsSync(src)) cpSync(src, join(BACKUP, "entries", r.id + ".yaml"));
}
writeFileSync(join(BACKUP, "retired-rows.json"), JSON.stringify(rows, null, 2));
console.log(`backup    ${BACKUP}`);
console.log(`          ghost index + professor_mari index + ${rows.length} entry files`);

// PRE-FLIGHT: refuse to proceed unless every id resolved. A silent miss here
// would retire three of four and read as success.
if (rows.length !== IDS.length) {
  throw new Error(`expected ${IDS.length} rows, resolved ${rows.length} — refusing to proceed`);
}

// ── 2. retire the four ───────────────────────────────────────────────────────
process.env.MARINARA_EXTENDER_DATA = DATA;
const retired = await retireEntries("character", "professor_mari", IDS, REASON);
console.log(`retired   ${retired.length}/${IDS.length}  ${retired.join(", ")}`);

// ── 3. delete the ghost ──────────────────────────────────────────────────────
const ghostRows = (YAML.parse(readFileSync(join(GHOST, "index.yaml"), "utf8")).entries || []).length;
rmSync(GHOST, { recursive: true, force: true });
console.log(`deleted   ${GHOST}  (${ghostRows} dead rows)`);

// ── 4. verify against the store, not against this script's own report ────────
const hot = await readIndex("character", "professor_mari");
const cold = await readColdIndex("character", "professor_mari");
const stillHot = (hot?.entries || []).filter((e) => IDS.includes(e.id));
const inCold = (cold?.entries || []).filter((e) => IDS.includes(e.id));
console.log();
console.log(`VERIFY  ghost dir exists ........ ${existsSync(GHOST)}   (want false)`);
console.log(`VERIFY  retired still in hot .... ${stillHot.length}       (want 0)`);
console.log(`VERIFY  retired now in cold ..... ${inCold.length}       (want ${IDS.length})`);
console.log(`VERIFY  cold rows carry reason .. ${inCold.filter((e) => e.retiredReason === REASON).length}       (want ${IDS.length})`);
console.log(`VERIFY  hot index row count ..... ${(hot?.entries || []).length}  (was ${(before.entries || []).length})`);
const ok = !existsSync(GHOST) && stillHot.length === 0 && inCold.length === IDS.length
  && inCold.every((e) => e.retiredReason === REASON);
console.log(`\n${ok ? "OK" : "FAILED — restore from " + BACKUP}`);
process.exit(ok ? 0 : 1);
