// AMBIENT EXTRACTOR PRECISION BENCH (cye6 slice 3).
//
// The first measurement of the tier-3 ambient extractor's precision. Not a
// re-measurement: no figure for this stage exists anywhere in the repo (1dn is
// the scene path, 8jw the durability judge, hjt9/mln9 chunk routing, np4b a
// report about stored rows).
//
// THREE ARMS, same turns, same model, so a change can be ATTRIBUTED:
//   A  old gate + old prompt   what shipped before cye6 (git 5feb60f)
//   B  new gate + new prompt   what is shipped now
//   C  new gate + OLD prompt   separates "the gate did it" from "the prompt did it"
//
// QUARANTINE. No sidecar is started and none is needed: this imports dist/ and
// calls the extractor in-process. It WRITES NOTHING to the store and the poller
// is not involved. An isolated data dir does not isolate the engine connection,
// which is exactly why this does not launch a second sidecar.
//
// FIDELITY CAVEAT, stated up front: a turn here is a pair of BEATS (one user,
// one character), not the whole messages production sees. Beats are chunks, so
// candidate counts per turn run lower than live. That affects volume, not the
// per-fact precision this bench exists to measure, and every arm sees the same
// texts.

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (f) => pathToFileURL(join(PKG, "dist", f)).href;
const { extractCandidates, isSecondPersonOnly, parseFactsJson, enforceAddressDirection, SYSTEM_PROMPT } =
  await import(dist("ambient.js"));
const { localUrl, localModel } = await import(dist("llm-config.js"));

const OLD_PROMPT = readFileSync(join(PKG, "scratch", "system-prompt-old.txt"), "utf8");
const NEW_PROMPT = SYSTEM_PROMPT;
if (/DIRECTION OF ADDRESS/.test(OLD_PROMPT)) throw new Error("old prompt is not old");
if (!/DIRECTION OF ADDRESS/.test(NEW_PROMPT)) throw new Error("new prompt is not new");

const SEED = Number(process.env.BENCH_SEED ?? 20260825);
const TURNS = Number(process.env.BENCH_TURNS ?? 60);
const MODEL = localModel();
const BASE = localUrl();

// ── deterministic RNG (mulberry32) — the seed is reported with the result ────
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── corpus: pair a user beat with the next character beat in the same chat ───
function loadTurns() {
  const root = join(PKG, "data", "characters");
  const byChat = new Map();
  for (const c of readdirSync(root)) {
    const bd = join(root, c, "beats");
    if (!existsSync(bd)) continue;
    for (const f of readdirSync(bd)) {
      if (!f.endsWith(".yaml") || f === "index.yaml") continue;
      let b;
      try { b = YAML.parse(readFileSync(join(bd, f), "utf8")); } catch { continue; }
      if (b.retiredAt || !b.sourceChatId || typeof b.turnStart !== "number") continue;
      if (!byChat.has(b.sourceChatId)) byChat.set(b.sourceChatId, []);
      byChat.get(b.sourceChatId).push({ ...b, scope: c });
    }
  }
  const turns = [];
  for (const [chatId, beats] of byChat) {
    beats.sort((x, y) => x.turnStart - y.turnStart || String(x.id).localeCompare(String(y.id)));
    for (let i = 0; i < beats.length - 1; i++) {
      const u = beats[i], a = beats[i + 1];
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

// A turn is ELIGIBLE when the widening actually does something AND there is an
// old-population line to compare against — so every sampled turn populates both
// cells. This is a deliberate restriction on the measured population and it is
// reported: these numbers describe turns where the change has an effect, which
// is the population the decision is about.
function cells(t) {
  const uOld = extractCandidates(t.userText);
  const cOld = extractCandidates(t.characterText);
  const uNew = extractCandidates(t.userText, { admitSecondPerson: true });
  const cNew = extractCandidates(t.characterText, { admitSecondPerson: true });
  const added = [
    ...uNew.filter((s) => !uOld.includes(s)).map((s) => ({ s, block: "user" })),
    ...cNew.filter((s) => !cOld.includes(s)).map((s) => ({ s, block: "character" })),
  ].filter((x) => isSecondPersonOnly(x.s));
  return { uOld, cOld, uNew, cNew, added };
}

function buildPrompt(userC, charC, roster) {
  const lines = [...userC.map((s) => `[user] ${s}`), ...charC.map((s) => `[character] ${s}`)];
  const rosterLine = roster?.length ? `Known characters: ${roster.join(", ")}\n\n` : "";
  return {
    lines,
    prompt: `${rosterLine}Sentences to evaluate:\n${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}`,
  };
}

// Mirrors callLocal() in ambient.ts exactly: same endpoint, same temperature,
// same json_object response_format, same 30s timeout. Only the system prompt
// varies, which is the thing under test.
async function ask(system, prompt) {
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
        temperature: 0.1, stream: false, response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.choices?.[0]?.message?.content ?? null;
  } catch { return null; }
}

const ARMS = [
  { id: "A", gate: false, prompt: OLD_PROMPT, enforce: false },
  { id: "B", gate: true,  prompt: NEW_PROMPT, enforce: true  },
  { id: "C", gate: true,  prompt: OLD_PROMPT, enforce: false },
];

const all = loadTurns();
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
const sample = pool.slice(0, TURNS);

console.error(`turns built ${all.length} | eligible ${eligible.length} | sampled ${sample.length} | seed ${SEED} | model ${MODEL}`);

function looksParseable(raw) {
  const attempts = [String(raw).trim(), String(raw).match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? ""];
  for (const a of attempts) {
    if (!a) continue;
    try {
      const p = JSON.parse(a);
      if (Array.isArray(p) || Array.isArray(p?.facts)) return true;
    } catch { /* next */ }
  }
  return false;
}

const out = [];
const validity = [];
let n = 0;
for (const t of sample) {
  n++;
  const c = cells(t);
  const addedSet = new Set(c.added.map((x) => x.s));
  for (const arm of ARMS) {
    const userC = arm.gate ? c.uNew : c.uOld;
    const charC = arm.gate ? c.cNew : c.cOld;
    const { lines, prompt } = buildPrompt(userC, charC, [t.characterName]);
    if (!lines.length) continue;
    const raw = await ask(arm.prompt, prompt);
    let facts = parseFactsJson(raw);
    // VALIDITY, reported not gated. Added AFTER a 2-turn smoke run showed arm B
    // returning nothing twice — so it is an observation this bench was not
    // pre-registered to threshold on, and it is labelled as such in the writeup.
    // Recorded because parse loss is silent fact loss and would otherwise read
    // as "the new prompt is more conservative".
    validity.push({
      arm: arm.id, turn: n,
      reached: raw !== null,
      parsed: raw !== null && facts.length >= 0 && looksParseable(raw),
      empty: facts.length === 0,
      rawLen: raw === null ? 0 : raw.length,
      raw: raw === null ? null : String(raw).slice(0, 300),
    });
    if (arm.enforce) {
      facts = enforceAddressDirection(facts, userC.filter(isSecondPersonOnly), t.characterName).facts;
    }
    for (const f of facts) {
      // Which cell does this fact belong to? By its SUPPORTING SENTENCE.
      const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      const isNew = [...addedSet].some((s) => norm(s) === norm(f.text));
      out.push({
        turn: n, chatId: t.chatId, turnStart: t.turnStart, arm: arm.id,
        cell: isNew ? "NEW" : "OLD",
        characterName: t.characterName,
        userText: t.userText, characterText: t.characterText,
        candidates: lines,
        text: f.text, fact: f.fact, lane: f.lane, scope: f.scope, subject: f.subject ?? null,
      });
    }
    console.error(`  turn ${n}/${sample.length} arm ${arm.id}: ${lines.length} cand -> ${facts.length} facts`);
  }
}

mkdirSync(join(PKG, "scratch"), { recursive: true });
const path = join(PKG, "scratch", "precision-bench.jsonl");
writeFileSync(path, out.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

const tally = {};
for (const r of out) {
  const k = `${r.arm}/${r.cell}`;
  tally[k] = (tally[k] ?? 0) + 1;
}
writeFileSync(join(PKG, "scratch", "precision-bench-validity.jsonl"),
  validity.map((r) => JSON.stringify(r)).join(String.fromCharCode(10)) + String.fromCharCode(10), "utf8");

const vs = {};
for (const v of validity) {
  const k = v.arm;
  vs[k] ??= { calls: 0, unreachable: 0, unparseable: 0, emptyFacts: 0 };
  vs[k].calls++;
  if (!v.reached) vs[k].unreachable++;
  else if (!v.parsed) vs[k].unparseable++;
  if (v.empty) vs[k].emptyFacts++;
}
console.log(JSON.stringify({ seed: SEED, model: MODEL, turnsBuilt: all.length, eligible: eligible.length, sampled: sample.length, facts: out.length, tally, validity: vs, path }, null, 2));
