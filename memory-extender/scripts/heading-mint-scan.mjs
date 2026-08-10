// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// WOULD TODAY'S INTAKE STILL MINT A HEADING SPEAKER? (hjt9, the 4ghy residue)
// READ-ONLY — runs the real Stage -1 + chunker over the actual offending
// documents and reports which speakers mint. No store access, no writes.
//
// The pe4o census (13 live self-ingested records) found every phantom speaker
// was a DOCUMENT HEADING: 9x "Format", 1x "SOFT SIGNALS", 1x "BAD". Those
// records predate the ops lane. This measures whether the current stack —
// routeOps at message level, then parseTurns with the noun-phrase rule and the
// recurrence floor — still lets a paste of the same documents mint them.
//
// Inputs are the documents that actually did the damage:
//   1. docs/PROMPTS.md            — the "Format:" x10 catalog
//   2. src/sentiment/analyzer.ts  — the thread-rule GOOD:/BAD: examples
//   3. a synthetic real-conversation control (interleaved dialogue + a pasted
//      report in the middle) — real speakers must mint, headings must not.

import { readFile } from "fs/promises";

const { routeOps } = await import("../dist/sentiment/ops-lane.js");
const { parseTurns } = await import("../dist/sentiment/chunker.js");
const { pasteEvidence, PASTE_THRESHOLD } = await import("../dist/sentiment/paste-prior.js");

function mintReport(name, content, characterName = "Mari") {
  // The live path: Stage -1 reduces the message, then the chunker parses turns.
  const ev = pasteEvidence(content);
  const routed = content.includes("\n") ? routeOps(content) : { prose: content, dropped: [] };
  const msgs = [{ role: "user", content: routed.prose }];
  const turns = parseTurns(msgs, characterName);
  const bySpeaker = new Map();
  for (const t of turns) bySpeaker.set(t.speaker, (bySpeaker.get(t.speaker) ?? 0) + 1);
  console.log(`── ${name} ──`);
  console.log(`  pasteEvidence: score ${ev.score.toFixed(3)} (threshold ${PASTE_THRESHOLD}) isPaste=${ev.isPaste}  [${ev.signals.join(", ")}]`);
  console.log(`  lines routed to ops sink: ${routed.dropped.length}`);
  console.log(`  speakers minted (beyond the sender):`);
  let phantom = 0;
  for (const [s, n] of [...bySpeaker].sort((a, b) => b[1] - a[1])) {
    if (s === "user" || s === "Narrator") continue;
    phantom++;
    console.log(`    ${String(n).padStart(4)}  ${JSON.stringify(s)}`);
  }
  if (!phantom) console.log(`    (none)`);
  console.log();
  return bySpeaker;
}

const prompts = await readFile(new URL("../docs/PROMPTS.md", import.meta.url), "utf8");
mintReport("PROMPTS.md pasted whole", prompts);

const analyzer = await readFile(new URL("../src/sentiment/analyzer.ts", import.meta.url), "utf8");
mintReport("analyzer.ts source pasted whole", analyzer);

// Control: real interleaved dialogue with one walk-on ("Driver" speaks twice,
// separated by other speakers) and a Format-heading paste in the middle. The
// dialogue must mint; "Format" must not.
const control = [
  "Mari: so where were we before the reactor alarm?",
  "Thomas: you were telling me about the transfer paperwork.",
  "Driver: your cab's here, someone called for a pickup?",
  "Mari: two minutes! okay — the short version is they approved it.",
  "here's the analyzer doc I mentioned, pasting it:",
  "Format: Respond with a JSON object containing emotion, motivation, and outcome.",
  "Return only the JSON. Do not add commentary.",
  "Format: For anger, the motivation must name what boundary was crossed.",
  "Return only the JSON. Do not add commentary.",
  "Thomas: got it, that matches what the bench showed.",
  "Driver: meter's running, no rush though.",
  "Mari: coming!",
].join("\n");
mintReport("control: real dialogue + Format paste inline", control);

// MUST-NOT-BREAK #1: a pasted TRANSCRIPT — the primary import path. One big
// message of pure interleaved dialogue. Every recurring speaker must mint, and
// the message must score BELOW the paste threshold (dialogue has no structure).
const transcriptTurns = [];
const lines = [
  ["Mari", "so tell me again what the reactor log showed, from the top."],
  ["Thomas", "the same spike as last week, but this time it held for nine minutes."],
  ["Mari", "nine? that's not a transient, that's a mode."],
  ["Thomas", "which is what I said, and Priya pulled the maintenance record to check."],
  ["Priya", "the record shows the valve was replaced in March, so it isn't wear."],
  ["Mari", "then we're back to the controller. I hate being back to the controller."],
  ["Thomas", "you hate being wrong about the controller."],
  ["Priya", "she was not wrong, she was early. there is a difference."],
];
for (let i = 0; i < 12; i++) for (const [s, t] of lines) transcriptTurns.push(`${s}: ${t}`);
mintReport("must-not-break: pasted transcript (~7KB pure dialogue)", transcriptTurns.join("\n"));

// MUST-NOT-BREAK #2: long single-block RP prose — the best memories in the
// store are exactly this shape. Nothing should mint, nothing should route.
const rp = "She held the letter for a long time before opening it, because opening it made the thing inside true. " .repeat(60);
mintReport("must-not-break: 6KB unbroken RP prose", rp);
