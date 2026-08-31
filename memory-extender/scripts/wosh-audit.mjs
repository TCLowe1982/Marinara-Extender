// Marinara Extender — wosh audit. READ-ONLY. Throwaway diagnostic.
//
// Answers TC's audit questions in one corpus fetch, caching the corpus so every
// later question is free:
//   1. are the two "manor" pastes byte-identical (scorer purity)
//   2. rawScore MINIMUM and true distribution, not a count below an arbitrary line
//   3. the messages the guard rescues at 0.30, dumped for hand-labelling

import { writeFileSync, readFileSync, existsSync } from "fs";

const CACHE = process.env.WOSH_CACHE || "corpus-cache.json";

const { manuscriptEvidence } = await import("../dist/sentiment/manuscript.js");

let corpus, rosterNames;
if (existsSync(CACHE)) {
  ({ corpus, rosterNames } = JSON.parse(readFileSync(CACHE, "utf8")));
  console.error(`(cache: ${corpus.length} messages)`);
} else {
  const { listChats, listMessages, listCharacters, listPersonas, parseData } =
    await import("../dist/engine-client.js");
  const chars = await listCharacters().catch(() => []);
  const personas = await listPersonas().catch(() => []);
  rosterNames = [...chars, ...personas]
    .map((c) => String(parseData(c).name ?? c.name ?? "").trim())
    .filter(Boolean);
  corpus = [];
  const chats = await listChats();
  for (const c of chats) {
    const id = String(c.id ?? "");
    if (!id) continue;
    let msgs = [];
    try { msgs = await listMessages(id); } catch { continue; }
    for (const m of msgs) {
      if (m?.role !== "user") continue;
      const text = typeof m.content === "string" ? m.content : "";
      if (text.length < 1500) continue;
      corpus.push({ chatId: id, chatName: String(c.name ?? ""), id: String(m.id ?? ""), text });
    }
  }
  writeFileSync(CACHE, JSON.stringify({ corpus, rosterNames }));
  console.error(`(fetched and cached: ${corpus.length} messages)`);
}

const crypto = await import("crypto");
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
const clip = (s, n) => s.replace(/\s+/g, " ").slice(0, n);

const scored = corpus.map((f) => ({ ...f, ev: manuscriptEvidence(f.text, rosterNames) }));

// ── 1. THE TWO MANOR PASTES ───────────────────────────────────────────────────
console.log("=".repeat(78));
console.log("1. SCORER PURITY — the two 'manor' pastes");
console.log("=".repeat(78));
const manor = scored.filter((s) => /anticipation was nearly killing her/i.test(s.text));
console.log(`found ${manor.length} messages matching the manor opening\n`);
for (const m of manor) {
  console.log(`  score ${m.ev.score.toFixed(2)}  raw ${m.ev.rawScore.toFixed(2)}  ${String(m.text.length).padStart(6)} chars  sha ${sha(m.text)}  chat "${clip(m.chatName, 28)}"`);
}
if (manor.length === 2) {
  const [a, b] = manor;
  const identical = a.text === b.text;
  console.log(`\n  BYTE-IDENTICAL: ${identical ? "YES" : "NO"}`);
  if (!identical) {
    console.log(`  length delta   : ${b.text.length - a.text.length}`);
    // Where do they first diverge, and is one a prefix/substring of the other?
    let i = 0;
    while (i < Math.min(a.text.length, b.text.length) && a.text[i] === b.text[i]) i++;
    console.log(`  first divergence at char ${i}`);
    console.log(`    A: "${clip(a.text.slice(Math.max(0, i - 40), i + 60), 100)}"`);
    console.log(`    B: "${clip(b.text.slice(Math.max(0, i - 40), i + 60), 100)}"`);
    const shorter = a.text.length <= b.text.length ? a.text : b.text;
    const longer = a.text.length <= b.text.length ? b.text : a.text;
    console.log(`  shorter is a substring of longer: ${longer.includes(shorter) ? "YES" : "NO"}`);
  }
  // Purity check regardless: same input twice must give the same answer.
  const r1 = manuscriptEvidence(a.text, rosterNames);
  const r2 = manuscriptEvidence(a.text, rosterNames);
  console.log(`  PURITY (same input scored twice identical): ${r1.score === r2.score && r1.rawScore === r2.rawScore ? "YES" : "NO — SCORER IS NOT PURE"}`);
}

// ── 2. rawScore DISTRIBUTION ──────────────────────────────────────────────────
console.log(`\n${"=".repeat(78)}`);
console.log("2. rawScore — MINIMUM and true distribution across the corpus");
console.log("=".repeat(78));
const raws = scored.map((s) => s.ev.rawScore).sort((a, b) => a - b);
const q = (p) => raws[Math.min(raws.length - 1, Math.floor(p * raws.length))];
console.log(`  n        ${raws.length}`);
console.log(`  MIN      ${raws[0].toFixed(3)}   <- if this is ~0.40 the floor is the instrument`);
console.log(`  p05      ${q(0.05).toFixed(3)}`);
console.log(`  p25      ${q(0.25).toFixed(3)}`);
console.log(`  median   ${q(0.50).toFixed(3)}`);
console.log(`  p75      ${q(0.75).toFixed(3)}`);
console.log(`  p95      ${q(0.95).toFixed(3)}`);
console.log(`  MAX      ${raws[raws.length - 1].toFixed(3)}`);
console.log("");
const edges = [0, .05, .1, .15, .2, .25, .3, .35, .4, .45, .5, .55, .6, .65, .7, 1.01];
for (let i = 0; i < edges.length - 1; i++) {
  const c = raws.filter((r) => r >= edges[i] && r < edges[i + 1]).length;
  if (c === 0) continue;
  console.log(`  ${edges[i].toFixed(2)}-${edges[i + 1].toFixed(2)}  ${String(c).padStart(4)}  ${"#".repeat(Math.min(60, c))}`);
}

// ── 3. THE 12 RESCUED AT 0.30 ─────────────────────────────────────────────────
const T = parseFloat((process.argv.find((a) => a.startsWith("--rescue-at=")) ?? "").split("=")[1] ?? "0.30");
console.log(`\n${"=".repeat(78)}`);
console.log(`3. RESCUED BY THE GUARD AT ${T} — for hand-labelling`);
console.log("=".repeat(78));
const rescued = scored.filter((s) => s.ev.rawScore >= T && s.ev.score < T);
console.log(`count: ${rescued.length}\n`);
rescued.sort((a, b) => b.ev.rawScore - a.ev.rawScore);
for (const [i, r] of rescued.entries()) {
  console.log(`--- [${i + 1}] raw ${r.ev.rawScore.toFixed(2)} -> ${r.ev.score.toFixed(2)}  1p ${r.ev.firstPersonRatio.toFixed(2)}  2p ${r.ev.addressRatio.toFixed(2)}  3p ${r.ev.thirdPersonRatio.toFixed(2)}  ${r.text.length}c  chat "${clip(r.chatName, 26)}"`);
  console.log(`    signals: ${r.ev.signals.join("  ")}`);
  console.log(`    "${clip(r.text, 300)}"`);
}

// ── 4. WORST REAL MEMOIR — the highest-scoring guard-engaged message ──────────
console.log(`\n${"=".repeat(78)}`);
console.log("4. WORST REAL MEMOIR IN THE CENSUS — highest rawScore among guard-engaged");
console.log("=".repeat(78));
const guarded = scored
  .filter((s) => s.ev.signals.some((x) => x.startsWith("memoir-guard")))
  .sort((a, b) => b.ev.rawScore - a.ev.rawScore);
console.log(`guard-engaged: ${guarded.length}\n`);
for (const r of guarded.slice(0, 5)) {
  console.log(`--- raw ${r.ev.rawScore.toFixed(2)} -> ${r.ev.score.toFixed(2)}  1p ${r.ev.firstPersonRatio.toFixed(2)}  2p ${r.ev.addressRatio.toFixed(2)}  3p ${r.ev.thirdPersonRatio.toFixed(2)}  ${r.text.length}c  chat "${clip(r.chatName, 26)}"`);
  console.log(`    signals: ${r.ev.signals.join("  ")}`);
  console.log(`    "${clip(r.text, 300)}"`);
}

console.log("\nNOTHING WAS MUTATED.");
