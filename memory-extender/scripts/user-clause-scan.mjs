// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// How much of the store already lost the user's clause (MarinaraExtender-2tro).
// READ-ONLY — reports, never mutates.
//
// The fix in src/user-clause.ts protects NEW extractions. This asks the separate
// question the issue's verify step needs answered: how many stored entries would
// it have saved, and which ones.
//
// TWO CAVEATS, AND THEY ARE WHY THIS DOES NOT WRITE.
//
// 1. The live pass claims a first-person clause for the user only when the words
//    appear in what the USER said — the guard that stops a character's "I grew up
//    in Kraków" being filed as the user's. A stored entry has no such split:
//    `content` is one blob with the speaker already discarded (that loss is np4b
//    finding #1). This scan substitutes the entry's own content, so a character's
//    line captured as a user fact will appear as a hit.
//
// 2. Stored entries do not keep the extractor's `subject`, so the live path's
//    strongest third-party signal is unavailable retroactively. The entity index
//    (76aw) stands in for it: only persons it knows, minus the user's own forms.
//
// Every hit is therefore a CANDIDATE, not a verdict. An earlier build of this
// script omitted the third-party test entirely and reported 169 — mostly
// summaries that carried the user fine and simply never named them. That number
// is what put the test in the fix; do not quote it as damage.
//
// Usage:
//   node scripts/user-clause-scan.mjs [--json] [--limit=N]

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { parse } from "yaml";

const { getDataDir, readIndex } = await import("../dist/storage.js");
const { readUserIdentity } = await import("../dist/user-identity.js");
const { keepUserClause } = await import("../dist/user-clause.js");
const { userTokens } = await import("../dist/user-identity.js");
const { readEntityIndex } = await import("../dist/entities.js");

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const LIMIT = parseInt((args.find((a) => a.startsWith("--limit=")) ?? "").split("=")[1] ?? "0", 10);

const identity = await readUserIdentity();
const userForms = identity?.aliases ?? [];

// People the corpus knows who are not the user. Same pronoun-corroboration bar
// the confound sweep uses — the bare person tag is too noisy on its own.
const mine = userTokens(identity);
const entityIndex = await readEntityIndex();
const thirdParties = [];
for (const e of entityIndex?.entities ?? []) {
  if (!e.person || e.pronounHits < 2) continue;
  const canonical = e.canonical.toLowerCase();
  if (canonical.split(" ").every((t) => mine.has(t))) continue;
  for (const form of [canonical, ...e.aliases]) {
    if (!mine.has(form) && form.length >= 3) thirdParties.push(form);
  }
}

const dataDir = getDataDir();
const findings = [];
let examined = 0;
let unreadable = 0;

async function scopes() {
  const out = [];
  for (const [kind, sub] of [["character", "characters"], ["chat", "chats"]]) {
    try {
      for (const id of await readdir(join(dataDir, sub))) {
        out.push({ scope: kind, scopeId: id, dir: join(dataDir, sub, id) });
      }
    } catch {}
  }
  return out;
}

for (const { scope, scopeId, dir } of await scopes()) {
  const index = await readIndex(scope, scopeId).catch(() => null);
  for (const row of index?.entries ?? []) {
    if (row.lane !== "user_topics") continue;
    if (!row.path) continue;
    let content = "";
    try {
      content = parse(await readFile(join(dir, row.path), "utf8"))?.content ?? "";
    } catch {
      unreadable++;
      continue;
    }
    if (!content.trim() || !row.summary) continue;
    examined++;

    const before = { text: content, fact: row.summary, lane: "user_topics", scope: "character" };
    const [after] = keepUserClause([before], { userText: content, userForms, thirdParties });
    if (after.fact === before.fact) continue;

    findings.push({
      scope,
      scopeId,
      id: row.id,
      summary: row.summary,
      content: content.slice(0, 300),
      repaired: after.fact,
    });
  }
}

const shown = LIMIT > 0 ? findings.slice(0, LIMIT) : findings;

if (JSON_OUT) {
  console.log(JSON.stringify({ examined, unreadable, total: findings.length, findings: shown }, null, 2));
} else {
  console.log(`user declared as: ${identity?.canonical ?? "(none)"}`);
  console.log(`third-party name forms known: ${thirdParties.length}`);
  console.log(`user_topics entries examined: ${examined}   unreadable: ${unreadable}`);
  console.log(`WOULD REPAIR: ${findings.length}${LIMIT > 0 && findings.length > LIMIT ? ` (showing ${LIMIT})` : ""}\n`);
  for (const f of shown) {
    console.log(`── ${f.scope}/${f.scopeId}  ${f.id}`);
    console.log(`   content : ${f.content.replace(/\s+/g, " ").slice(0, 160)}`);
    console.log(`   now     : ${f.summary}`);
    console.log(`   would be: ${f.repaired}`);
    console.log("");
  }
  console.log("READ-ONLY. Nothing was changed. Each hit is a candidate — see the header caveat.");
}
