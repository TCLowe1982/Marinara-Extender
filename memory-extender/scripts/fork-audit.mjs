// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// WHAT THE FORK FILTER ACTUALLY ADMITS, against what it was designed to admit.
//
// yi70's design is a UNION and the comment in fork.ts states it plainly:
//
//     admit  if  created <= splitAt                  (shared childhood)
//       or  if  the entry came from one of MY chats  (my own life since)
//
// The first half is inert. rowInBranch reads `row.created ?? row.lastAccessed`,
// and an INDEX ROW HAS NO `created` FIELD — it is not declared on IndexEntry and
// not one of the 8,751 rows carries it. So the shared-childhood test is really
// `lastAccessed <= splitAt`, i.e. "this memory has not been READ since the
// split". Every pre-split memory that is still in use fails it, and gwny makes
// that worse: merely being loaded refreshes lastAccessed.
//
// The entry FILES do carry `created`. This script reads them, so it can compare
// what the filter admits now against what it would admit if it used the real
// creation date, and report the difference per branch.
//
//   node scripts/fork-audit.mjs [identityKey]     default: professor_mari

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { readIndexRows } from "./read-index.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.argv[2] ?? "professor_mari";
const SCOPE = join(PKG, "data", "characters", KEY);

const idMap = YAML.parse(readFileSync(join(PKG, "data", "identity-map.yaml"), "utf8"));
const entriesOf = (y) => (Array.isArray(y) ? y : y?.entries ?? []);
const forks = entriesOf(idMap).filter((e) => e.identityKey === KEY && e.forkSplitAt);
if (!forks.length) { console.log(`no fork configured for ${KEY}`); process.exit(0); }
const splitAt = String(forks[0].forkSplitAt);

console.log(`identityKey ${KEY} — split ${splitAt}`);
for (const f of forks) console.log(`  card ${String(f.characterId).padEnd(24)} primary=${!!f.forkPrimary}`);

// Chat ownership, straight from the Engine — the same source fork.ts uses.
let owners = new Map();
try {
  const res = await fetch("http://127.0.0.1:7860/api/chats", { signal: AbortSignal.timeout(8000) });
  const j = await res.json();
  for (const c of (j?.chats ?? j ?? [])) {
    const id = String(c.id ?? "");
    const ids = Array.isArray(c.characterIds) ? c.characterIds.map(String) : [];
    if (id) owners.set(id, ids);
  }
  console.log(`chats known to the Engine: ${owners.size}`);
} catch (e) {
  console.log(`ENGINE UNREACHABLE (${e.message}) — a chat with no known owner falls to the primary branch, exactly as the live filter does, so the counts below still hold.`);
}

function rows() {
  const out = [];
  for (const base of ["index", "index.cold"]) {
    for (const e of readIndexRows(SCOPE, base)) out.push({ ...e, cold: base !== "index" });
  }
  return out;
}

// The real creation date lives in the entry file, never in the index row.
function createdOf(r) {
  if (r.created) return String(r.created);
  if (!r.path) return "";
  const p = join(SCOPE, r.path);
  if (!existsSync(p)) return "";
  try {
    const y = YAML.parse(readFileSync(p, "utf8"));
    return y?.created ? String(y.created) : "";
  } catch { return ""; }
}

function admits(r, { primary, mine, useRealCreated }) {
  const stamp = useRealCreated ? r.realCreated : String(r.created ?? r.lastAccessed ?? "");
  if (stamp && stamp <= splitAt) return true;          // shared childhood
  const chat = r.sourceChatId ?? r.citesChatId;
  if (!chat) return primary;                            // unattributable -> primary
  const o = owners.get(chat);
  if (!o || !o.length) return primary;                  // chat gone -> primary
  return o.some((x) => mine.includes(x));
}

const all = rows();
for (const r of all) r.realCreated = createdOf(r);

const missingCreated = all.filter((r) => !r.realCreated).length;
const trulyPreSplit = all.filter((r) => r.realCreated && r.realCreated <= splitAt);
const passesNow = all.filter((r) => {
  const s = String(r.created ?? r.lastAccessed ?? "");
  return s && s <= splitAt;
});

console.log(`\nrows: ${all.length}   entry files with no created: ${missingCreated}`);
console.log(`SHARED CHILDHOOD (created <= ${splitAt}), the real figure : ${trulyPreSplit.length}`);
console.log(`what the filter currently treats as shared (lastAccessed): ${passesNow.length}`);
console.log(`  -> the carve-out is missing ${trulyPreSplit.length - passesNow.length} pre-split memories`);

console.log(`\nPER BRANCH — admitted now vs admitted if the real creation date were used:`);
for (const f of forks) {
  const cfg = { primary: !!f.forkPrimary, mine: [String(f.characterId)] };
  const now = all.filter((r) => admits(r, { ...cfg, useRealCreated: false })).length;
  const fixed = all.filter((r) => admits(r, { ...cfg, useRealCreated: true })).length;
  const lost = all.filter((r) => !admits(r, { ...cfg, useRealCreated: false }) && admits(r, { ...cfg, useRealCreated: true }));
  console.log(`  ${String(f.characterId).padEnd(24)} primary=${cfg.primary ? "yes" : "no "}  now ${String(now).padStart(5)}   fixed ${String(fixed).padStart(5)}   RECOVERED ${lost.length}`);
  for (const r of lost.slice(0, 6)) {
    console.log(`       ${r.realCreated}  ${String(r.summary ?? "").slice(0, 78)}`);
  }
}
