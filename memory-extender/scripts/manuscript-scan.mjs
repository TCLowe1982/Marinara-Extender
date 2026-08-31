// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Calibrate the memoir/manuscript discriminator (wosh). READ-ONLY.
//
// THE QUESTION THIS HAS TO ANSWER is not "does it find manuscripts". It is:
// DOES IT SPARE A MEMOIR. A long first-person account of something that happened
// to the user is the single most valuable thing this system captures, and a gate
// that routes one into a work-artifact lane would destroy the best memories in the
// store while looking like it was working.
//
// So the report LEADS WITH THE FALSE-POSITIVE SURFACE: the most testimony-shaped
// messages the detector nonetheless calls manuscripts, highest first-person ratio
// first. Those get read by hand. Recall is secondary — an under-caught manuscript
// leaves beats that later layers still see, while a misrouted memoir is a memory
// the user told once and will assume is known.
//
// Corpus is the ENGINE's own chats, not our store: we need the ORIGINAL user
// messages, and our beats are derived from them.
//
// Usage:
//   node scripts/manuscript-scan.mjs [--show=N] [--threshold=0.6] [--chats=N] [--min=1500]

const { listChats, listMessages, listCharacters, listPersonas, parseData } =
  await import("../dist/engine-client.js");
const { manuscriptEvidence, MANUSCRIPT_THRESHOLD, SIZE_FLOOR } =
  await import("../dist/sentiment/manuscript.js");

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=")[1] ?? d;
const SHOW = parseInt(arg("show", "8"), 10);
const THRESHOLD = parseFloat(arg("threshold", String(MANUSCRIPT_THRESHOLD)));
const MAXCHATS = parseInt(arg("chats", "0"), 10);
const MIN = parseInt(arg("min", String(SIZE_FLOOR)), 10);

const pct = (x, n) => (n === 0 ? "  0%" : `${String(Math.round((100 * x) / n)).padStart(3)}%`);
const clip = (s, n) => s.replace(/\s+/g, " ").slice(0, n);

// ── Roster ────────────────────────────────────────────────────────────────────
// Every character and persona name the install knows. Deliberately GLOBAL rather
// than per-chat: a name being known at all is what makes it not-a-stranger, and a
// per-chat roster would call the user's other characters strangers.
const chars = await listCharacters().catch(() => []);
const personas = await listPersonas().catch(() => []);
const rosterNames = [...chars, ...personas]
  .map((c) => String(parseData(c).name ?? c.name ?? "").trim())
  .filter(Boolean);
console.log(`roster: ${rosterNames.length} known names — ${rosterNames.slice(0, 8).join(", ")}${rosterNames.length > 8 ? " ..." : ""}\n`);

// ── Corpus ────────────────────────────────────────────────────────────────────
let chats = await listChats();
if (MAXCHATS > 0) chats = chats.slice(0, MAXCHATS);

const found = [];
let scanned = 0;
for (const c of chats) {
  const id = String(c.id ?? "");
  if (!id) continue;
  let msgs = [];
  try {
    msgs = await listMessages(id);
  } catch {
    continue;
  }
  scanned++;
  for (const m of msgs) {
    if (m?.role !== "user") continue;
    const text = typeof m.content === "string" ? m.content : "";
    if (text.length < MIN) continue;
    found.push({ chatId: id, chatName: String(c.name ?? ""), id: String(m.id ?? ""), text });
  }
  if (scanned % 20 === 0) process.stderr.write(`  ...${scanned}/${chats.length} chats\n`);
}

console.log(`chats scanned            ${scanned}`);
console.log(`long user messages       ${found.length}  (>= ${MIN} chars)\n`);
if (found.length === 0) {
  console.log("Nothing to score.");
  process.exit(0);
}

// ── Score ─────────────────────────────────────────────────────────────────────
const scored = found.map((f) => ({ ...f, ev: manuscriptEvidence(f.text, rosterNames) }));
const flagged = scored.filter((s) => s.ev.score >= THRESHOLD);
const spared = scored.filter((s) => s.ev.score < THRESHOLD);

const n = scored.length;
console.log(`threshold                ${THRESHOLD}`);
console.log(`called MANUSCRIPT        ${String(flagged.length).padStart(4)}  ${pct(flagged.length, n)}`);
console.log(`spared                   ${String(spared.length).padStart(4)}  ${pct(spared.length, n)}`);

const guarded = scored.filter((s) => s.ev.signals.some((x) => x.startsWith("memoir-guard")));
console.log(`memoir guard engaged     ${String(guarded.length).padStart(4)}  ${pct(guarded.length, n)}`);
const guardedAndFlagged = guarded.filter((s) => s.ev.score >= THRESHOLD).length;
console.log(`  ...and STILL flagged   ${String(guardedAndFlagged).padStart(4)}   <- must be 0 or explained`);

// ── THE FALSE-POSITIVE SURFACE — read these by hand ───────────────────────────
console.log(`\n${"=".repeat(78)}`);
console.log("FALSE-POSITIVE SURFACE — flagged messages that look most like testimony");
console.log("Highest first-person ratio first. Every one of these is a memory at risk.");
console.log("=".repeat(78));
const risky = [...flagged].sort((a, b) => b.ev.firstPersonRatio - a.ev.firstPersonRatio).slice(0, SHOW);
if (risky.length === 0) console.log("(none flagged)");
for (const r of risky) {
  console.log(`\n  score ${r.ev.score.toFixed(2)}  1p ${r.ev.firstPersonRatio.toFixed(2)}  2p ${r.ev.addressRatio.toFixed(2)}  3p ${r.ev.thirdPersonRatio.toFixed(2)}  ${r.ev.chars} chars  chat "${clip(r.chatName, 30)}"`);
  console.log(`  signals: ${r.ev.signals.join("  ")}`);
  console.log(`  "${clip(r.text, 220)}..."`);
}

// ── THE MISS SURFACE ──────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(78)}`);
console.log("NEAR MISSES — spared, but scoring highest. Manuscripts hiding below the line?");
console.log("=".repeat(78));
const near = [...spared].sort((a, b) => b.ev.score - a.ev.score).slice(0, SHOW);
for (const r of near) {
  console.log(`\n  score ${r.ev.score.toFixed(2)}  1p ${r.ev.firstPersonRatio.toFixed(2)}  2p ${r.ev.addressRatio.toFixed(2)}  3p ${r.ev.thirdPersonRatio.toFixed(2)}  ${r.ev.chars} chars  chat "${clip(r.chatName, 30)}"`);
  console.log(`  signals: ${r.ev.signals.join("  ")}`);
  console.log(`  "${clip(r.text, 220)}..."`);
}

// ── Distribution ──────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(78)}`);
console.log("SCORE DISTRIBUTION");
console.log("=".repeat(78));
const buckets = new Array(10).fill(0);
for (const s of scored) buckets[Math.min(9, Math.floor(s.ev.score * 10))]++;
for (let i = 0; i < 10; i++) {
  const lo = (i / 10).toFixed(1);
  const hi = ((i + 1) / 10).toFixed(1);
  const mark = i / 10 >= THRESHOLD ? " <- flagged" : "";
  console.log(`  ${lo}-${hi}  ${String(buckets[i]).padStart(4)}  ${"#".repeat(Math.min(50, buckets[i]))}${mark}`);
}

console.log(`\nNOTHING WAS MUTATED. This script only reads.`);
