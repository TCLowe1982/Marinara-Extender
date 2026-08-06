// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.
//
// Retire biography facts established as unsupported by the corpus (fqnl).
//
// DRY RUN BY DEFAULT. Pass --apply to write.
//
// WHY A HAND-LISTED TARGET SET AND NOT A PREDICATE. The provenance test (layer 1)
// is TRIAGE, not a verdict: it proves a receipt did not come from the chat it
// cites, which is equally consistent with a stale sourceChatId. Seven of the eight
// entries it flagged turned out to be exactly that — Aurora facts carrying the
// provenance of the professor_mari card she was migrated from, all true. Retiring
// on the predicate would have destroyed them.
//
// So the targets below are named individually, each with the corpus-wide evidence
// that convicted it, and each verified by hand. A script that can only retire what
// a human enumerated cannot have a false-positive rate.
//
// THE EVIDENCE STANDARD, applied to every entry here: the CLAIM appears nowhere in
// 13,479 messages across 95 chats. Not the word — the claim. That distinction is
// the whole finding: "Kraków" occurs 31 times and "neurological" 11, and neither
// is ever an assertion about where Mari is from or what she trained in.
//
// Usage:
//   node scripts/retire-unsupported-facts.mjs               # dry run
//   node scripts/retire-unsupported-facts.mjs --apply
//   node scripts/retire-unsupported-facts.mjs --set=neurologist --apply

import { readdir } from "fs/promises";

const { getDataDir, readIndex, readEntry, retireEntries } = await import("../dist/storage.js");
const { recordStatsEvent } = await import("../dist/stats-events.js");
const { backupDataDir } = await import("../dist/backup.js");

const APPLY = process.argv.includes("--apply");
const SET = (process.argv.find((a) => a.startsWith("--set=")) ?? "").split("=")[1] ?? "krakow";

const SETS = {
  krakow: {
    reason: "unsupported biography: birthplace not attested anywhere in the corpus (fqnl)",
    evidence:
      "Swept 95 chats / 13,479 messages via the Engine. Kraków occurs 31 times and NOT ONCE " +
      "as an origin claim: an ex-boyfriend who lives there now, a lobster anecdote, " +
      "'the time in Kraków with the — anyway', and TC proposing dinner there. Every mention " +
      "places her as a visitor. The assertion originates from a worked example, " +
      "\"Mari grew up in Kraków\", that sat in the ambient extractor's own system prompt on " +
      "every call it ever made (ambient.ts:66,277). utopic-deaau6ak additionally cites a " +
      "393-message chat containing zero mentions of the city. Character card says Polish, no city.",
    targets: [
      ["character", "professor_mari", "utopic-deaau6ak"],
      ["character", "professor_mari", "ctopic-82p9tylw"],
    ],
  },
  neurologist: {
    reason: "unsupported biography: profession not attested anywhere in the corpus (fqnl)",
    evidence:
      "All 11 occurrences of 'neurolog*' in 13,479 messages are the ADJECTIVE 'neurological', " +
      "about Thomas's brain, sensory processing, or Priya's clinical concern. Not one asserts " +
      "that Mari is a neurologist. Canon, ratified in-chat 2026-08-04: two PhDs, both in " +
      "computational linguistics (Oxford). Both entries cite ARCHIVED - First Chat, where " +
      "'neurologist', 'poland' and 'canada' do not appear.",
    targets: [
      ["character", "professor_mari", "ctopic-57ow1i97"],
      ["character", "professor_mari", "utopic-20jsbkxj"],
    ],
  },
};

const chosen = SETS[SET];
if (!chosen) {
  console.error(`Unknown --set=${SET}. Known: ${Object.keys(SETS).join(", ")}`);
  process.exit(1);
}

// ── Resolve and show exactly what would be touched ────────────────────────────

const found = [];
for (const [scope, scopeId, id] of chosen.targets) {
  const index = await readIndex(scope, scopeId).catch(() => null);
  const row = index?.entries?.find((e) => e.id === id);
  if (!row) { console.error(`  [MISSING] ${scope}/${scopeId} ${id} — not in the live index`); continue; }
  if (row.discardedAt) { console.error(`  [ALREADY RETIRED] ${id} (${row.retiredReason ?? "no reason"})`); continue; }
  const full = row.path ? await readEntry(scope, scopeId, row.path).catch(() => null) : null;
  found.push({ scope, scopeId, id, row, content: String(full?.content ?? "") });
}

console.log(`set     : ${SET}`);
console.log(`reason  : ${chosen.reason}`);
console.log(`targets : ${chosen.targets.length}   resolvable now: ${found.length}\n`);
for (const f of found) {
  console.log(`-- ${f.scope}/${f.scopeId}  ${f.id}   lane=${f.row.lane}`);
  console.log(`   summary: ${String(f.row.summary).slice(0, 160)}`);
  console.log(`   content: ${f.content.slice(0, 160)}`);
  console.log(`   cites  : ${f.row.sourceChatId ?? "(no sourceChatId)"}\n`);
}

if (found.length === 0) { console.log("Nothing to do."); process.exit(0); }

if (!APPLY) {
  console.log("DRY RUN — nothing was written. Re-run with --apply.");
  process.exit(0);
}

// ── Apply ─────────────────────────────────────────────────────────────────────
// retireEntries marks discardedAt + retiredReason and moves the row to COLD. The
// entry survives at full fidelity and is restorable, which is the point: if a chat
// ever surfaces that supports one of these, it comes back.

console.log("Backing up the data dir before touching anything...");
const backup = await backupDataDir();
console.log(`  backup: ${backup.dir}  (${backup.files} files)\n`);

const byScope = new Map();
for (const f of found) {
  const k = `${f.scope} ${f.scopeId}`;
  if (!byScope.has(k)) byScope.set(k, []);
  byScope.get(k).push(f.id);
}

let retired = 0;
for (const [k, ids] of byScope) {
  const [scope, scopeId] = k.split(" ");
  retired += (await retireEntries(scope, scopeId, ids, chosen.reason)).length;
}

const event = await recordStatsEvent({
  kind: "retirement",
  issue: "MarinaraExtender-fqnl",
  reason: `${chosen.reason}. ${chosen.evidence}`,
  selector: `hand-verified target list "${SET}" — ${chosen.targets.map((t) => t[2]).join(", ")}`,
  counts: { entries: retired },
  spared:
    "Everything the provenance test flagged that turned out to be STALE PROVENANCE rather " +
    "than unsupported content — four aurora entries carrying the professor_mari card's " +
    "sourceChatId after migration. Their facts are true; only the citation is wrong.",
  backup: backup.dir,
  affectsHistoricalCurves: true,
});

console.log(`APPLIED`);
console.log(`  entries retired : ${retired}`);
console.log(`  stats event     : ${event.id}`);
console.log(`  backup          : ${backup.dir}`);
console.log(`\nNothing was deleted. Retired entries live in cold storage and are restorable.`);
