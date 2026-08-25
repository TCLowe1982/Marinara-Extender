// ONE-OFF REPAIR (2026-08-25). Undo an accidental identity migration.
//
// WHAT HAPPENED. A GET to /api/retired?characterId=professor_mari passed an
// IDENTITY KEY where a character CARD ID is expected. resolveIdentity() did what
// it is documented to do for an unknown card id: minted a new key and MIGRATED
// the existing data dir onto it.
//
//   [identity] migrated data dir: professor_mari -> professor_mari_2
//   [identity] registered: professor_mari -> "professor_mari_2"
//
// Nothing was destroyed. The whole historical store is intact under
// professor_mari_2; a fresh empty professor_mari was created in its place and
// then received ONE live turn before this was noticed.
//
// THE REPAIR: fold that one turn back in, drop the bogus map entry, and put the
// directory back under its real key.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, cpSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(PKG, "data");
const CHARS = join(DATA, "characters");
const REAL = join(CHARS, "professor_mari_2");   // the historical store
const FRESH = join(CHARS, "professor_mari");    // the accidental empty scope
const MAP = join(DATA, "identity-map.yaml");
const EXECUTE = process.argv.includes("--execute");

const countIn = (d, sub) => (existsSync(join(d, sub)) ? readdirSync(join(d, sub)).filter((f) => f.endsWith(".yaml") && f !== "index.yaml").length : 0);
const idx = (p) => (existsSync(p) ? (YAML.parse(readFileSync(p, "utf8")).entries ?? []) : []);

// ── Preconditions. Refuse rather than guess. ────────────────────────────────
const problems = [];
if (!existsSync(REAL)) problems.push("professor_mari_2 does not exist");
if (!existsSync(FRESH)) problems.push("professor_mari does not exist");
const realBeats = countIn(REAL, "beats");
const freshBeats = countIn(FRESH, "beats");
if (realBeats < 5000) problems.push(`professor_mari_2 has only ${realBeats} beats — not the historical store`);
if (freshBeats > 25) problems.push(`professor_mari has ${freshBeats} beats — too many to be the accidental scope; hand-merge instead`);
const map = YAML.parse(readFileSync(MAP, "utf8"));
const bogus = (map.entries ?? []).filter((e) => e.identityKey === "professor_mari_2");
if (bogus.length !== 1) problems.push(`expected exactly 1 identity-map entry pointing at professor_mari_2, found ${bogus.length}`);
if (problems.length) { console.log("REFUSING:"); for (const p of problems) console.log("  - " + p); process.exit(1); }

console.log("PRECONDITIONS OK");
console.log(`  historical store (professor_mari_2): ${realBeats} beats, ${countIn(REAL,"char-topics")} char-topics, ${countIn(REAL,"user-topics")} user-topics`);
console.log(`  accidental scope (professor_mari)  : ${freshBeats} beats, ${countIn(FRESH,"char-topics")} char-topics`);
console.log(`  bogus map entry                    : characterId="${bogus[0].characterId}" -> ${bogus[0].identityKey}`);

// ── What would be folded back in ────────────────────────────────────────────
const freshEntryRows = idx(join(FRESH, "index.yaml"));
const freshBeatRows = idx(join(FRESH, "beats", "index.yaml"));
console.log(`\nTO FOLD BACK IN (captured live after the migration, real memories):`);
for (const r of freshEntryRows) console.log(`  entry ${r.id}  ${String(r.summary).replace(/\s+/g, " ").slice(0, 80)}`);
for (const r of freshBeatRows) console.log(`  beat  ${r.id}  speaker=${JSON.stringify(r.speaker)}`);

if (!EXECUTE) { console.log("\nDRY RUN — nothing written. Re-run with --execute."); process.exit(0); }

// ── 1. Backup BOTH directories before touching anything ─────────────────────
const stamp = process.env.REPAIR_STAMP || "repair";
const backup = join(DATA, ".snapshots", `identity-repair-${stamp}`);
mkdirSync(backup, { recursive: true });
cpSync(REAL, join(backup, "professor_mari_2"), { recursive: true });
cpSync(FRESH, join(backup, "professor_mari"), { recursive: true });
cpSync(MAP, join(backup, "identity-map.yaml"));
console.log(`\nbacked up both scopes + identity-map to ${backup}`);

// ── 2. Fold the accidental scope's real content into the historical store ───
let folded = 0;
for (const [sub, indexFile] of [["char-topics", "index.yaml"], ["user-topics", "index.yaml"], ["threads", "index.yaml"]]) {
  const sd = join(FRESH, sub);
  if (!existsSync(sd)) continue;
  mkdirSync(join(REAL, sub), { recursive: true });
  for (const f of readdirSync(sd)) {
    if (!f.endsWith(".yaml")) continue;
    cpSync(join(sd, f), join(REAL, sub, f));
    folded++;
  }
}
const bd = join(FRESH, "beats");
if (existsSync(bd)) for (const f of readdirSync(bd)) {
  if (!f.endsWith(".yaml") || f === "index.yaml") continue;
  cpSync(join(bd, f), join(REAL, "beats", f));
  folded++;
}
// Merge the index rows (append only what is not already present).
const mergeIndex = (realPath, rows) => {
  const doc = YAML.parse(readFileSync(realPath, "utf8"));
  const have = new Set(doc.entries.map((e) => e.id));
  let added = 0;
  for (const r of rows) if (!have.has(r.id)) { doc.entries.push(r); added++; }
  doc.lastUpdated = new Date().toISOString();
  writeFileSync(realPath, YAML.stringify(doc), "utf8");
  return added;
};
const addedEntries = mergeIndex(join(REAL, "index.yaml"), freshEntryRows);
const addedBeats = mergeIndex(join(REAL, "beats", "index.yaml"), freshBeatRows);
console.log(`folded ${folded} file(s); index rows added: ${addedEntries} entr(y/ies), ${addedBeats} beat(s)`);

// ── 3. Drop the bogus identity-map entry ────────────────────────────────────
map.entries = (map.entries ?? []).filter((e) => e.identityKey !== "professor_mari_2");
writeFileSync(MAP, YAML.stringify(map), "utf8");
console.log(`removed bogus identity-map entry (characterId="${bogus[0].characterId}")`);

// ── 4. Put the directory back under its real key ────────────────────────────
rmSync(FRESH, { recursive: true, force: true });
renameSync(REAL, FRESH);
console.log("professor_mari_2 -> professor_mari");
console.log("\nREPAIRED.");
