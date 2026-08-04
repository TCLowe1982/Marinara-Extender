// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Find lane/world misfilings (MarinaraExtender-np4b). READ-ONLY — reports, never
// mutates. Deciding what a memory should say is the author's call, not a script's.
//
// THE FAILURE IT LOOKS FOR. `user_topics` means "facts about the human player"
// and `character_topics` means "facts about the scope owner". A fact about a
// THIRD person has no correct lane (that gap is 4g9w), so it lands in one of the
// two and is thereby asserted to be about someone it is not. Both directions
// have been confirmed by hand:
//
//   ctopic-bd3nqxku  "TC's sons: Henry Warren and Malcolm Bradley Collier"
//                    the user's real children, filed as character lore, with the
//                    CHARACTER's surname attached. Deleted 2026-08-04.
//   utopic-n9gjyuap  "Thomas's sister is Rebecca 'Becky' Collier"
//                    a fact about the RP character, filed as a fact about the user.
//
// WHY IT ONLY WORKS NOW. The detector needs to know which names mean the user,
// and the corpus cannot supply that — measured, the character's surname and the
// user's never once co-occur. egj3 supplies it by declaration.
//
// PRECISION OVER RECALL, deliberately. A user_topics entry MENTIONING another
// person is completely normal ("user's friend Bob moved away"). Only the SUBJECT
// position is evidence, so the sweep looks at what a summary is about, not what
// it contains. It will miss misfilings phrased indirectly; that is the right
// trade for a list a human has to read.
//
// Usage:
//   node scripts/confound-sweep.mjs [--json] [--limit=N]

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { parse } from "yaml";

const { getDataDir, readIndex } = await import("../dist/storage.js");
const { readUserIdentity, userTokens, excludedForms } = await import("../dist/user-identity.js");
const { readEntityIndex } = await import("../dist/entities.js");

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const LIMIT = parseInt((args.find((a) => a.startsWith("--limit=")) ?? "").split("=")[1] ?? "0", 10);

const identity = await readUserIdentity();
if (!identity) {
  console.error("No user identity declared. Run PUT /api/user-identity first (egj3) — without it");
  console.error("the sweep cannot tell the user's names from a character's, which is the whole point.");
  process.exit(1);
}
const mine = userTokens(identity);
const disclaimed = excludedForms(identity);
const entityIndex = await readEntityIndex();

// Entities that read as people and are NOT the user. A subject drawn from here
// inside user_topics is the signal.
const otherPeople = new Set();
for (const e of entityIndex?.entities ?? []) {
  // The person tag is deliberately noisy (76aw ruled that acceptable), so it is
  // not sufficient here. A confound is about a PERSON, and the evidence that
  // actually separates people from products is pronouns following the name —
  // "Marinara Engine" never gets them, "Aunt Marilee" does.
  if (!e.person || e.pronounHits < 2) continue;
  const canonical = e.canonical.toLowerCase();
  if (canonical.split(" ").every((t) => mine.has(t))) continue;   // that's the user
  for (const form of [canonical, ...e.aliases]) {
    if (mine.has(form)) continue;                                  // a form the user owns
    otherPeople.add(form);
  }
}

// Words that open a sentence and are not names. Without this the leading-capital
// trap from tp5 reappears here: "After the divorce..." reports a subject of
// "After", and the entity extractor has already minted junk like "After Priya"
// that makes it look like a person.
const SENTENCE_STARTERS = new Set(
  ("after before during when while then there here this that these those one two both each every " +
   "confirmed noted following per despite because although since until unless if user users his her " +
   "their they she he it").split(" "),
);

/** The apparent subject of a summary: a leading name, with or without possessive. */
function subjectOf(summary) {
  const m = String(summary ?? "").trim().match(/^([\p{Lu}][\p{L}'’-]*(?:\s+[\p{Lu}][\p{L}'’-]*)?)(?:['’]s)?\b/u);
  if (!m) return null;
  const subject = m[1].toLowerCase().replace(/['’]s$/u, "");
  if (SENTENCE_STARTERS.has(subject.split(" ")[0])) return null;
  return subject;
}

const findings = [];
const dataDir = getDataDir();

async function scopes() {
  const out = [];
  for (const [kind, sub] of [["character", "characters"], ["chat", "chats"]]) {
    try {
      for (const id of await readdir(join(dataDir, sub))) out.push({ scope: kind, scopeId: id, dir: join(dataDir, sub, id) });
    } catch {}
  }
  return out;
}

for (const { scope, scopeId, dir } of await scopes()) {
  const index = await readIndex(scope, scopeId).catch(() => null);
  for (const row of index?.entries ?? []) {
    const summary = row.summary ?? "";
    const subject = subjectOf(summary);
    if (!subject) continue;

    let reason = null;
    if (row.lane === "user_topics") {
      // Strongest signal first: the user has explicitly disclaimed this name.
      if (disclaimed.has(subject)) reason = `subject "${subject}" is DISCLAIMED by the user`;
      else if (otherPeople.has(subject) && !mine.has(subject)) reason = `subject "${subject}" is another person`;
    } else if (row.lane === "character_topics") {
      // The reverse direction: the user's own facts filed as character lore.
      if (mine.has(subject)) reason = `subject "${subject}" is the USER, in the character lane`;
    }
    if (!reason) continue;

    let content = "";
    if (row.path) {
      try { content = parse(await readFile(join(dir, row.path), "utf8"))?.content ?? ""; } catch {}
    }
    findings.push({ scope, scopeId, id: row.id, lane: row.lane, subject, reason, summary, content: content.slice(0, 300) });
  }
}

findings.sort((a, b) => a.lane.localeCompare(b.lane) || a.subject.localeCompare(b.subject));
const shown = LIMIT > 0 ? findings.slice(0, LIMIT) : findings;

if (JSON_OUT) {
  console.log(JSON.stringify({ total: findings.length, findings: shown }, null, 2));
} else {
  console.log(`user declared as: ${identity.canonical}  (forms: ${identity.aliases.join(", ")})`);
  console.log(`non-user people known: ${otherPeople.size}\n`);
  console.log(`CANDIDATES: ${findings.length}${LIMIT > 0 && findings.length > LIMIT ? ` (showing ${LIMIT})` : ""}\n`);
  const byLane = {};
  for (const f of findings) byLane[f.lane] = (byLane[f.lane] ?? 0) + 1;
  for (const [lane, n] of Object.entries(byLane)) console.log(`  ${lane}: ${n}`);
  console.log("");
  for (const f of shown) {
    console.log(`── ${f.scope}/${f.scopeId}  ${f.id}  [${f.lane}]`);
    console.log(`   ${f.reason}`);
    console.log(`   ${f.summary}`);
    console.log("");
  }
  console.log("READ-ONLY. Nothing was changed.");
}
