// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Every example the prompt shows, and whether the guard can arrest it. READ-ONLY.
//
// THE RULE THIS SERVES (Mari, 2026-08-05): an example ships WITH its arrest
// warrant — concrete enough to teach format, absurd enough to self-flag, skeleton
// pre-registered in the echo ledger in the same commit as the prompt. Bait that
// glows in the dark.
//
// This is the audit half of that. It extracts the quoted illustrations out of the
// ACTUAL built prompt — not a list someone maintains by hand, which would rot the
// first time a prompt changed — and asks two questions of each:
//
//   COVERED?  does echoesAnExample() already recognise it? An uncovered example is
//             bait with no warrant: when the model returns it, nothing stops it.
//   ECHOED?   how often does it already appear in the store, in beat motivations
//             and in thread labels?
//
// WHY THREAD LABELS TOO. The motivation rule was moved off-planet on 2026-08-04.
// The THREAD rule was not — it still illustrates with "Porsche test drive" and
// "the Hargrove investigation", which are this store's own material. That is the
// in-domain configuration the bench just disqualified at 7% echo, still shipping
// one rule further down the same prompt.

import { readdir } from "fs/promises";
import { join } from "path";

const { buildSystemPrompt, echoesAnExample, skeletonTokens, echoesPhrases } = await import("../dist/sentiment/analyzer.js");
const { getDataDir } = await import("../dist/storage.js");
const { readAllBeats } = await import("../dist/sentiment/encoder.js");
const { readThreadRegistry } = await import("../dist/threads.js");

// Pull every double-quoted illustration out of the built prompt. Emotion choice is
// arbitrary — the rule block is shared across all ten.
const prompt = buildSystemPrompt("fear", []);

// Quoted spans of 3+ words: short quotes like "user" or "..." are schema tokens,
// not illustrations, and would only add noise.
const quoted = [...new Set(
  [...prompt.matchAll(/"([^"\n]{10,120})"/g)]
    .map((m) => m[1].trim())
    .filter((s) => (s.match(/\s+/g) ?? []).length >= 2),
)];

// Attribute each example to the rule it illustrates, by where it sits in the text.
const motivationAt = prompt.indexOf("motivation must name the SPECIFIC content");
const threadAt = prompt.indexOf("thread: which ongoing narrative thread");
const ruleOf = (ex) => {
  const at = prompt.indexOf(`"${ex}"`);
  if (threadAt >= 0 && at > threadAt) return "thread";
  if (motivationAt >= 0 && at > motivationAt) return "motivation";
  return "other";
};

// ── Store side ────────────────────────────────────────────────────────────────

const motivations = [];
for (const c of await readdir(join(getDataDir(), "characters")).catch(() => [])) {
  for (const b of await readAllBeats(c, { includeRetired: true }).catch(() => [])) {
    motivations.push({ text: String(b.motivation ?? ""), retired: !!b.retiredAt });
  }
}
const threads = (await readThreadRegistry()).threads ?? [];

const countIn = (rows, ex, pick) => rows.filter((r) => echoesPhrases(pick(r), [ex])).length;

// ── Report ────────────────────────────────────────────────────────────────────

console.log(`examples found in the built prompt: ${quoted.length}`);
console.log(`beats scanned: ${motivations.length}   threads in registry: ${threads.length}\n`);

console.log("rule        covered  motivations(live/retired)  threads  example");
let uncovered = 0;
for (const ex of quoted) {
  const rule = ruleOf(ex);
  const covered = echoesAnExample(ex);
  if (!covered) uncovered++;
  const live = countIn(motivations.filter((m) => !m.retired), ex, (r) => r.text);
  const dead = countIn(motivations.filter((m) => m.retired), ex, (r) => r.text);
  const th = countIn(threads, ex, (t) => String(t.label ?? ""));
  console.log(
    `${rule.padEnd(11)} ${(covered ? "YES" : "** NO **").padEnd(8)} ${String(`${live}/${dead}`).padStart(24)} ${String(th).padStart(8)}  ${JSON.stringify(ex.slice(0, 60))}`,
  );
}

console.log(`\nUNCOVERED EXAMPLES: ${uncovered}`);
if (uncovered > 0) {
  console.log("  Bait with no arrest warrant. When the model returns one of these, nothing");
  console.log("  in the pipeline stops it — which is precisely how pifl ran for 35 days.");
}

// Thread labels that merely RESEMBLE the prompt's thread examples, since
// resolveOrMintThread fuzzy-matches and would fold a copied label into a real thread.
const threadExamples = quoted.filter((q) => ruleOf(q) === "thread");
if (threadExamples.length) {
  console.log("\nTHREAD-LABEL PROXIMITY (the rule that was never moved off-planet)");
  for (const ex of threadExamples) {
    const exSkel = skeletonTokens(ex).join(" ");
    const near = threads.filter((t) => {
      const s = skeletonTokens(String(t.label ?? "")).join(" ");
      return s && exSkel && (s === exSkel || s.includes(exSkel) || exSkel.includes(s));
    });
    console.log(`  ${JSON.stringify(ex)} -> ${near.length} thread(s)${near.length ? ": " + near.map((t) => JSON.stringify(t.label)).slice(0, 4).join(", ") : ""}`);
  }
}

console.log("\nREAD-ONLY. Nothing was changed.");
