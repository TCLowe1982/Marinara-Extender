// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// RETROSPECTIVE AUDIT OF THE MODEL-AUTHORED MEMORY PATH (7bkx).
//
// The ambient extractor has 616 hand-labelled facts and a published precision
// figure. The [remember:] / [bookmark:] path — where the model AUTHORS the
// summary prose that lands in permanent memory — has never been measured at all.
// It is not trusted because it passed something; it was never put on trial.
//
// This needs no new generation. Two facts make a retrospective pass possible:
//   - processResponse's `clean` is discarded (api.ts:701), so the beats retain
//     the model's RAW output with its tags intact. That is a live defect (zex4)
//     and simultaneously the only reason this audit can be run at all.
//   - TC does not curate the store — memories are edited only for a test or a
//     known error — so what is on disk is what the model emitted, not what a
//     reviewer allowed to survive.
//
// There is NO provenance marker on an entry saying which lane wrote it
// (EntryProvenance is "played"|"unplayed", about outlines). So the authored
// population has to be RECONSTRUCTED by matching emitted tag content back to
// entry summaries, which is what `landing` below does.
//
// WHAT THIS MEASURES, and what it deliberately does not. It measures VOLUME,
// COMPLIANCE and LANDING — all mechanical, all checkable without judgement.
// It does NOT measure whether an emitted memory is true or correctly attributed;
// that needs blind labelling with the same vocabulary the ambient bench used, and
// must report user-requested saves separately from unprompted ones (the prompt
// itself distinguishes them at loader.ts:486, and they are different epistemic
// acts — transcription versus salience judgement).
//
//   node scripts/remember-audit.mjs            summary
//   node scripts/remember-audit.mjs --sample N dump N emitted tags for labelling

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { readIndexRows } from "./read-index.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(PKG, "data", "characters");

// The save-request vocabulary the prompt actually teaches (loader.ts:486). A
// user line matching one of these is a DIRECT instruction the model is told
// ALWAYS to honour — so a miss here is a compliance failure, not a judgement
// call. Kept narrow on purpose: the prompt itself warns that "remember when we
// went to Rome?" is reminiscence, not a save request.
// IMPERATIVE forms only. The first cut of this matched "remember (that|this|my|
// our|to|for)" anywhere in the line and reported 11% compliance — which was an
// artefact, not a finding: "I denied I had PTSD for years, but I remember my
// freshman year" is reminiscence about the speaker's own past and matched on
// "remember my". A save request is addressed TO the character, so a first-person
// "I remember" disqualifies the line no matter what follows it.
const SAVE_REQUEST = [
  /(?:^|[.!?,;]\s*|\band\s+|\bplease\s+)remember (?:that|this|to)\b/i,
  /\b(?:can|could|will|would) you remember\b/i,
  /\bsave (?:this|that)\b/i,
  /\bdon'?t forget (?:that|this|to)\b/i,
  /\bmake a note\b/i,
  /\bkeep in mind that\b/i,
];
// Reminiscence or self-report, not instruction. Tested BEFORE the request test,
// and any first-person "I remember" kills the line outright.
const REMINISCENCE = [
  /\bremember when\b/i,
  /\bremember the time\b/i,
  /\bdo you remember\b/i,
  /\bi (?:still )?remember\b/i,
  /\bi don'?t remember\b/i,
  /\bremember(?:ing)? (?:it|him|her|them|us)\b/i,
];

const REMEMBER_RE = /\[remember:\s*([^\]]*)\]/gi;
const BOOKMARK_RE = /\[bookmark:\s*([^\]]*)\]/gi;

// Pull the QUOTED free-text params out first and parse the structured ones from
// what is left. Without this, `scope=` matches inside a content="..." string and
// a whole sentence gets reported as a scope value — which is exactly what the
// first run of this script did.
function splitParams(s) {
  const free = {};
  let rest = s;
  for (const key of ["content", "summary", "why"]) {
    const m = new RegExp(`${key}\\s*=\\s*"([\\s\\S]*?)"(?=\\s*(?:,\\s*\\w+\\s*=|$))`, "i").exec(rest)
      ?? new RegExp(`${key}\\s*=\\s*'([\\s\\S]*?)'(?=\\s*(?:,\\s*\\w+\\s*=|$))`, "i").exec(rest);
    if (m) { free[key] = m[1].trim(); rest = rest.slice(0, m.index) + rest.slice(m.index + m[0].length); }
  }
  return { free, rest };
}

function param(s, name) {
  const { free, rest } = splitParams(s);
  if (name in free) return free[name];
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(rest)
    ?? new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i").exec(rest)
    ?? new RegExp(`${name}\\s*=\\s*([^,\\]]+)`, "i").exec(rest);
  return m ? m[1].trim() : null;
}

function loadBeats() {
  const out = [];
  for (const scope of readdirSync(ROOT)) {
    const bd = join(ROOT, scope, "beats");
    if (!existsSync(bd)) continue;
    for (const f of readdirSync(bd)) {
      if (!f.endsWith(".yaml") || f === "index.yaml") continue;
      let b;
      try { b = YAML.parse(readFileSync(join(bd, f), "utf8")); } catch { continue; }
      if (!b || !b.sourceChatId) continue;
      out.push({
        scope, id: b.id, chatId: b.sourceChatId,
        turnStart: typeof b.turnStart === "number" ? b.turnStart : 0,
        speaker: String(b.speaker ?? ""),
        text: String(b.text ?? ""),
        created: String(b.created ?? ""),
        retired: Boolean(b.retiredAt),
      });
    }
  }
  return out;
}

function loadEntrySummaries() {
  const sums = [];
  for (const scope of readdirSync(ROOT)) {
    for (const base of ["index", "index.cold"]) {
      for (const e of readIndexRows(join(ROOT, scope), base)) {
        if (e?.summary) sums.push({ scope, cold: base !== "index", summary: String(e.summary), lane: String(e.lane ?? "") });
      }
    }
  }
  return sums;
}

const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const beats = loadBeats();
const entries = loadEntrySummaries();
const entryNorms = entries.map((e) => ({ ...e, n: norm(e.summary) }));

// ── 1. VOLUME ────────────────────────────────────────────────────────────────
const tags = [];
for (const b of beats) {
  let m;
  REMEMBER_RE.lastIndex = 0;
  while ((m = REMEMBER_RE.exec(b.text)) !== null) {
    const raw = m[1];
    tags.push({
      beat: b, kind: "remember",
      lane: param(raw, "lane"), scope: param(raw, "scope") ?? "character",
      content: param(raw, "content"),
    });
  }
  BOOKMARK_RE.lastIndex = 0;
  while ((m = BOOKMARK_RE.exec(b.text)) !== null) {
    const raw = m[1];
    tags.push({ beat: b, kind: "bookmark", topic: param(raw, "topic"), content: param(raw, "summary") });
  }
}

const rem = tags.filter((t) => t.kind === "remember");
const bmk = tags.filter((t) => t.kind === "bookmark");

console.log("=".repeat(72));
console.log("VOLUME — what the model emitted, recovered from the raw beat text");
console.log("=".repeat(72));
console.log(`beats scanned            ${beats.length}`);
console.log(`[remember:] tags emitted ${rem.length}   in ${new Set(rem.map((t) => t.beat.id)).size} beats`);
console.log(`[bookmark:] tags emitted ${bmk.length}   in ${new Set(bmk.map((t) => t.beat.id)).size} beats`);
const malformed = rem.filter((t) => !t.content);
console.log(`malformed (no content=)  ${malformed.length}`);
const byLane = {};
for (const t of rem) byLane[t.lane ?? "(none)"] = (byLane[t.lane ?? "(none)"] ?? 0) + 1;
console.log(`by lane                  ${JSON.stringify(byLane)}`);
const byScope = {};
for (const t of rem) byScope[t.scope] = (byScope[t.scope] ?? 0) + 1;
console.log(`by scope                 ${JSON.stringify(byScope)}`);

// Emitted by the USER's own block is a category error worth counting: the
// vocabulary is taught to the character, and a tag inside a user beat means the
// human typed it or the chunker mis-split the turn.
const inUserBeats = rem.filter((t) => t.beat.speaker === "user").length;
console.log(`emitted inside [user] beats  ${inUserBeats}  (should be ~0)`);

// ── 2. COMPLIANCE ────────────────────────────────────────────────────────────
// The prompt says a direct save request ALWAYS gets a tag and OVERRIDES the
// "only if it matters" rule. So this is the one place with a hard expectation.
const byChat = new Map();
for (const b of beats) {
  if (!byChat.has(b.chatId)) byChat.set(b.chatId, []);
  byChat.get(b.chatId).push(b);
}
let asked = 0, honoured = 0, saveish = 0;
const misses = [];
for (const [, bs] of byChat) {
  bs.sort((x, y) => x.turnStart - y.turnStart || String(x.id).localeCompare(String(y.id)));
  for (let i = 0; i < bs.length - 1; i++) {
    const u = bs[i];
    if (u.speaker !== "user") continue;
    if (/\bremember\b|\bdon'?t forget\b|\bsave this\b|\bmake a note\b|\bkeep in mind\b/i.test(u.text)) saveish++;
    if (REMINISCENCE.some((r) => r.test(u.text))) continue;
    if (!SAVE_REQUEST.some((r) => r.test(u.text))) continue;
    asked++;
    // The reply is the next non-user beat in the same chat.
    let reply = null;
    for (let j = i + 1; j < bs.length; j++) {
      if (bs[j].speaker !== "user") { reply = bs[j]; break; }
    }
    if (reply && /\[remember:/i.test(reply.text)) honoured++;
    else if (misses.length < 8) misses.push({ chat: u.chatId, turn: u.turnStart, text: u.text.slice(0, 110) });
  }
}
console.log();
console.log("=".repeat(72));
console.log("COMPLIANCE — the user asked directly; the prompt says ALWAYS honour it");
console.log("=".repeat(72));
// Report the DENOMINATOR alongside the count. A bare 0 is unreadable - it could
// mean the detector is broken or the population is genuinely absent, and those
// call for opposite responses. Calibrated by hand against all 132 user sentences
// containing a save-ish verb: they are RP narration ("the leather won't remember
// a damn thing"), in-character dialogue ("do you remember promising to make
// Chai") and dev talk ABOUT this pipeline. The population really is ~empty.
console.log(`user lines mentioning a save verb  ${saveish}  <- the denominator`);
console.log(`of those, actual save REQUESTS     ${asked}`);
console.log(`followed by a tag        ${honoured}   ${asked ? ((honoured / asked) * 100).toFixed(0) + "%" : "n/a"}`);
console.log(`SILENT MISSES            ${asked - honoured}`);
for (const m of misses) console.log(`   turn ${String(m.turn).padStart(4)}  ${m.text}`);

// ── 3. LANDING ───────────────────────────────────────────────────────────────
// An emitted tag that never became an entry is silent loss — the model believed
// it saved something and told the user so.
let landed = 0;
const orphans = [];
for (const t of rem) {
  if (!t.content) continue;
  const n = norm(t.content);
  if (!n) continue;
  const head = n.slice(0, 60);
  const hit = entryNorms.some((e) => e.n.startsWith(head) || n.startsWith(e.n.slice(0, 60)));
  if (hit) landed++;
  else if (orphans.length < 8) orphans.push(t.content.slice(0, 100));
}
const withContent = rem.filter((t) => t.content).length;
console.log();
console.log("=".repeat(72));
console.log("LANDING — did the emitted memory reach the store?");
console.log("=".repeat(72));
console.log(`tags with content=      ${withContent}`);
console.log(`matched a live entry    ${landed}   ${withContent ? ((landed / withContent) * 100).toFixed(0) + "%" : "n/a"}`);
console.log(`NO MATCH                ${withContent - landed}`);
console.log("(no-match is an upper bound on loss: an entry may have been retired,");
console.log(" superseded, or reworded past a 60-char prefix match)");
for (const o of orphans) console.log(`   ${o}`);

// ── optional sample for blind labelling ──────────────────────────────────────
const sampleIdx = process.argv.indexOf("--sample");
if (sampleIdx !== -1) {
  const n = Number(process.argv[sampleIdx + 1] ?? 30);
  console.log();
  console.log("=".repeat(72));
  console.log(`SAMPLE — ${n} emitted memories with their source turn, for labelling`);
  console.log("=".repeat(72));
  // Deterministic: sort by beat id, stride evenly. No RNG (scripts must stay
  // reproducible; see the bench's note on Date.now/Math.random).
  const pool = rem.filter((t) => t.content).sort((a, b) => String(a.beat.id).localeCompare(String(b.beat.id)));
  const stride = Math.max(1, Math.floor(pool.length / n));
  let k = 0;
  for (let i = 0; i < pool.length && k < n; i += stride, k++) {
    const t = pool[i];
    console.log(`#${k + 1}  lane=${t.lane} scope=${t.scope}  chat=${t.beat.chatId} turn=${t.beat.turnStart}`);
    console.log(`  emitted : ${t.content}`);
    console.log(`  source  : ${t.beat.text.replace(/\[(remember|bookmark):[^\]]*\]/gi, "").replace(/\s+/g, " ").trim().slice(0, 300)}`);
    console.log();
  }
}
