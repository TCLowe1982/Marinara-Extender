// Reconstruct the EXACT 60 turns arms A/B/C were measured on (icke).
//
// The bench samples from the live store, and the store has grown since that run
// (1165 -> 1167 turns built). Same seed over a different pool yields a different
// slice(0,60), so running D/E against today's store would compare them to a
// sample A/B/C never saw. This finds the cutoff that reproduces the original
// corpus, derives the sample from it, and CHECKS that derivation against the 57
// turns recoverable from the committed rows before writing anything.

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (f) => pathToFileURL(join(PKG, "dist", f)).href;
const { extractCandidates, isSecondPersonOnly } = await import(dist("ambient.js"));

const TARGET_BUILT = 1165;
const TARGET_ELIGIBLE = 914;
const SEED = 20260825;

function loadBeats() {
  const root = join(PKG, "data", "characters");
  const out = [];
  for (const c of readdirSync(root)) {
    const bd = join(root, c, "beats");
    if (!existsSync(bd)) continue;
    for (const f of readdirSync(bd)) {
      if (!f.endsWith(".yaml") || f === "index.yaml") continue;
      let b;
      try { b = YAML.parse(readFileSync(join(bd, f), "utf8")); } catch { continue; }
      if (b.retiredAt || !b.sourceChatId || typeof b.turnStart !== "number") continue;
      out.push({ ...b, scope: c });
    }
  }
  return out;
}

// Mirrors loadTurns() in the bench exactly, but over a pre-filtered beat list.
function buildTurns(beats) {
  const byChat = new Map();
  for (const b of beats) {
    if (!byChat.has(b.sourceChatId)) byChat.set(b.sourceChatId, []);
    byChat.get(b.sourceChatId).push(b);
  }
  const turns = [];
  for (const [chatId, bs] of byChat) {
    bs.sort((x, y) => x.turnStart - y.turnStart || String(x.id).localeCompare(String(y.id)));
    for (let i = 0; i < bs.length - 1; i++) {
      const u = bs[i], a = bs[i + 1];
      if (String(u.speaker) !== "user" || String(a.speaker) === "user") continue;
      turns.push({
        chatId, scope: u.scope, turnStart: u.turnStart,
        userText: String(u.text ?? ""), characterText: String(a.text ?? ""),
        characterName: String(a.speaker ?? ""),
      });
    }
  }
  return turns;
}

function cells(t) {
  const uOld = extractCandidates(t.userText);
  const cOld = extractCandidates(t.characterText);
  const uNew = extractCandidates(t.userText, { admitSecondPerson: true });
  const cNew = extractCandidates(t.characterText, { admitSecondPerson: true });
  const added = [
    ...uNew.filter((s) => !uOld.includes(s)),
    ...cNew.filter((s) => !cOld.includes(s)),
  ].filter((s) => isSecondPersonOnly(s));
  return { uOld, cOld, added };
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleFor(beats) {
  const all = buildTurns(beats);
  const eligible = all.filter((t) => {
    const c = cells(t);
    return c.added.length > 0 && c.uOld.length + c.cOld.length > 0;
  });
  const rand = rng(SEED);
  const pool = eligible.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return { built: all.length, eligible: eligible.length, sample: pool.slice(0, 60) };
}

const beats = loadBeats();
console.log(`beats loaded: ${beats.length}`);

// Candidate cutoffs: every distinct `created` value, newest first. The original
// corpus is the store as it stood at some instant, so one of these reproduces it.
const stamps = [...new Set(beats.map((b) => String(b.created ?? "")).filter(Boolean))].sort();
let hit = null;
for (let i = stamps.length - 1; i >= 0; i--) {
  const cutoff = stamps[i];
  const kept = beats.filter((b) => String(b.created ?? "") <= cutoff);
  const r = sampleFor(kept);
  if (r.built === TARGET_BUILT && r.eligible === TARGET_ELIGIBLE) { hit = { cutoff, ...r }; break; }
}

if (!hit) {
  const now = sampleFor(beats);
  console.log(`NO CUTOFF REPRODUCES ${TARGET_BUILT}/${TARGET_ELIGIBLE}. Today: ${now.built}/${now.eligible}`);
  process.exit(1);
}

console.log(`cutoff ${hit.cutoff} reproduces built=${hit.built} eligible=${hit.eligible}`);

// VERIFY against the committed rows before trusting it.
const rows = readFileSync(join(PKG, "scratch", "precision-bench.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const known = new Map();
for (const r of rows) known.set(r.turn, `${r.chatId}@${r.turnStart}`);

let ok = 0, bad = [];
for (const [turnIdx, key] of known) {
  const got = hit.sample[turnIdx - 1];
  const gotKey = got ? `${got.chatId}@${got.turnStart}` : "(none)";
  if (gotKey === key) ok++; else bad.push({ turnIdx, expected: key, got: gotKey });
}
console.log(`VERIFY: ${ok}/${known.size} recoverable turns match`);
if (bad.length) {
  console.log("MISMATCHES:", JSON.stringify(bad.slice(0, 10), null, 2));
  process.exit(1);
}

const outPath = join(PKG, "scratch", "bench-sample.json");
writeFileSync(outPath, JSON.stringify({
  seed: SEED,
  note: "The exact 60 turns arms A/B/C were measured on, reconstructed for icke (arms D/E). Verified: all 57 turns recoverable from precision-bench.jsonl match by chatId+turnStart.",
  reconstructedFromCutoff: hit.cutoff,
  built: hit.built,
  eligible: hit.eligible,
  turns: hit.sample,
}, null, 2), "utf8");
console.log(`wrote ${outPath} — ${hit.sample.length} turns`);
