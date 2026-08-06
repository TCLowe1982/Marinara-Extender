// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// THE INVERSE OF bait-warrant. READ-ONLY.
//
// bait-warrant.test.ts asks: can the echo ledger ARREST every illustration the prompt
// shows? That is a static question with a static answer, and it passed every day while
// the guard was quietly losing its grip.
//
// This asks the moving question: can the STORE now CORROBORATE an illustration's probe?
// Because corroboration opens the escape hatch (analyzer.ts rejectAsEcho), a probe the
// corpus can satisfy is a warrant that no longer arrests anything. The example is still
// in the ledger, the test still passes, and the guard is off.
//
// WHY IT MUST RUN ON A CADENCE, NOT AT COMMIT. Nothing about the CODE changes when a
// warrant rots. What changes is the conversation: "locksmith" became a live thread
// label via an unrelated metaphor about sealed read paths, and /\blocksmith\b/ — a
// one-word warrant — was void from that moment. No commit touched the prompt. A
// commit-time check cannot see a store that moved underneath it.
//
// EXIT CODES:  0 = every warrant intact   1 = at least one rotted   2 = usage error

import { readdir, readFile } from "fs/promises";
import { join } from "path";

const { listEchoEntries, skeletonTokens } = await import("../dist/sentiment/analyzer.js");
const { getDataDir } = await import("../dist/storage.js");

const json = process.argv.includes("--json");

// ── Corpus, as a single lowercased haystack per file ─────────────────────────
// The hatch tests a chunk's SOURCE TEXT, so any stored text is a proxy for what a
// future chunk might contain. Deliberately generous: we want early warning.

// SPLIT BY PROVENANCE, because counting everything cries wolf.
//
// The hatch tests a chunk's SOURCE TEXT — words a person actually typed. But a beat
// record under characters/ holds MOTIVATIONS, which are model OUTPUT, and a rotted
// example is by definition already sitting in a pile of them. Counting those as
// corroboration means every echo the guard failed to stop is then scored as evidence
// that its own warrant has rotted: circular, and inflating. On the first run it put
// "exposes her personal fear" at 20 corroborations purely from beats echoing it.
//
// So: `spoken` counts lines under chats/, which is where stored utterances live, and
// that is what the verdict rests on. `derived` counts the rest and is reported for
// context only. A warrant is called rotted on SPOKEN evidence.
async function* corpusLines(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!/\.(yaml|json|jsonl)$/.test(e.name)) continue;
      const spoken = /[\\/]chats[\\/]/.test(p);
      const text = await readFile(p, "utf8").catch(() => "");
      for (const line of text.split("\n")) {
        if (line.length > 400 && /[\d.,\-e]{200,}/.test(line)) continue;
        yield { line: line.toLowerCase(), spoken };
      }
    }
  }
}

const entries = listEchoEntries();
const hits = entries.map(() => 0);
// probeAll words are SKELETON STEMS, so match as a prefix: "tarr" must find
// "tarred"/"tarring". A trailing \b would miss every inflection the stemmer removed.
const matchers = entries.map((e) => {
  if (e.probeAll) {
    const res = e.probeAll.map((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
    return (line) => res.every((r) => r.test(line));
  }
  if (e.probeSource) {
    const r = new RegExp(e.probeSource, "i");
    return (line) => r.test(line);
  }
  const lit = e.phrase.toLowerCase();
  return (line) => line.includes(lit);
});

const derived = entries.map(() => 0);
let lines = 0, spokenLines = 0;
for await (const { line, spoken } of corpusLines(getDataDir())) {
  lines++;
  if (spoken) spokenLines++;
  for (let i = 0; i < matchers.length; i++) {
    if (!matchers[i](line)) continue;
    if (spoken) hits[i]++; else derived[i]++;
  }
}

const rows = entries.map((e, i) => ({
  kind: e.probeAll ? `probeAll(${e.probeAll.length})` : e.probeSource ? "probe(regex)" : "literal",
  skeleton: skeletonTokens(e.phrase).length,
  spoken: hits[i],
  derived: derived[i],
  rotted: hits[i] > 0,
  // Phrase deliberately withheld from stdout — single-channel exposure. Index is
  // enough to act on, and --json carries it for tooling that already has the file.
  index: i,
}));

if (json) {
  console.log(JSON.stringify({ lines, rows }, null, 2));
} else {
  console.log(`scanned ${lines} corpus lines (${spokenLines} spoken, under chats/) against ${entries.length} ledger entries\n`);
  console.log(" idx  warrant          skel  spoken  derived  status");
  for (const r of rows) {
    console.log(
      `  ${String(r.index).padStart(2)}  ${r.kind.padEnd(15)} ${String(r.skeleton).padStart(4)}  ${String(r.spoken).padStart(6)}  ${String(r.derived).padStart(7)}  ${r.rotted ? "** ROTTED **" : "intact"}`,
    );
  }
  const bad = rows.filter((r) => r.rotted);
  console.log(`\n${bad.length} of ${rows.length} warrants are corroborable from SPOKEN text.`);
  console.log(`("derived" counts beat motivations and summaries — model output, not utterance.`);
  console.log(` A high derived count with spoken 0 means the echo already happened but the`);
  console.log(` warrant still holds; that is a cleanup job, not a rotted warrant.)`);
  if (bad.length) {
    console.log("A corroborable probe means the escape hatch opens: the example is still in");
    console.log("the ledger and bait-warrant still passes, but nothing gets arrested.");
    console.log("Rotate with: node scripts/bait-select.mjs --from <candidates.json> --pick specific:2,vague:2 --write src/sentiment/bait.json");
    console.log("Retire, do not delete: PROMPT_EXAMPLE_ECHOES keeps retired phrases so older");
    console.log("stored echoes stay catchable.");
  }
}

process.exit(rows.some((r) => r.rotted) ? 1 : 0);
