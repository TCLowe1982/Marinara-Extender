// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Clean polluted alias-table entries (MarinaraExtender-50e).
//
// The learner had recorded compound labels ("Mari and TC") and the player's
// name ("Thomas") as aliases of a character, misrouting the player's memory into
// that character's ledger. addAlias now refuses both going forward; this removes
// the pollution that already exists. The canonical name of a record is never
// touched.
//
//   node scripts/clean-alias-pollution.mjs                       # dry run
//   node scripts/clean-alias-pollution.mjs --persona Thomas      # also treat "Thomas" as the player
//   node scripts/clean-alias-pollution.mjs --persona Thomas --apply
//
// --persona names the player's persona(s) so they're stripped from any character
// that wrongly claims them. Existing "user"-record names are protected too, but
// until the sidecar has registered the persona (process-turn), pass it here.
// Run from the memory-extender/ directory.

import { pathToFileURL } from "node:url";
import { join } from "node:path";

const APPLY = process.argv.includes("--apply");
const personas = process.argv.reduce((acc, a, i) => {
  if (a === "--persona" && process.argv[i + 1]) acc.push(process.argv[i + 1]);
  return acc;
}, []);
const imp = (p) => import(pathToFileURL(join(process.cwd(), "dist", p)).href);
const { readAliasTable, removeAlias, isCompoundLabel, normalizeLabel, USER_IDENTITY_KEY } = await imp("aliases.js");

const table = await readAliasTable();

// Labels claimed by the player/persona — no character should alias these.
const userRec = table[USER_IDENTITY_KEY];
const userLabels = new Set();
if (userRec) {
  userLabels.add(normalizeLabel(userRec.canonicalName));
  for (const a of userRec.aliases ?? []) userLabels.add(normalizeLabel(a));
}
for (const p of personas) userLabels.add(normalizeLabel(p));

const toRemove = []; // { identityKey, canonicalName, label, reason }
for (const [identityKey, rec] of Object.entries(table)) {
  if (identityKey === USER_IDENTITY_KEY) continue;
  for (const label of rec.aliases ?? []) {
    if (normalizeLabel(label) === normalizeLabel(rec.canonicalName)) continue; // never the canonical
    let reason = null;
    if (isCompoundLabel(label)) reason = "compound (names >1 entity)";
    else if (userLabels.has(normalizeLabel(label))) reason = "player/persona name";
    if (reason) toRemove.push({ identityKey, canonicalName: rec.canonicalName, label, reason });
  }
}

if (toRemove.length === 0) {
  console.log("No polluted aliases found. Table is clean.");
  process.exit(0);
}

console.log(`${APPLY ? "REMOVING" : "DRY RUN — would remove"} ${toRemove.length} polluted alias(es):\n`);
for (const r of toRemove) {
  console.log(`  ${r.canonicalName} (${r.identityKey})  —  drop "${r.label}"  [${r.reason}]`);
}
if (userLabels.size > 0) {
  console.log(`\n(player/persona names protected: ${[...userLabels].join(", ")})`);
}

if (APPLY) {
  for (const r of toRemove) await removeAlias(r.identityKey, r.label);
  console.log(`\nRemoved ${toRemove.length} alias(es).`);
} else {
  console.log("\ndry run — re-run with --apply to remove.");
}
