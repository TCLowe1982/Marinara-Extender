// AMBIENT EXTRACTOR PRECISION BENCH (cye6 slice 3).
//
// The first measurement of the tier-3 ambient extractor's precision. Not a
// re-measurement: no figure for this stage exists anywhere in the repo (1dn is
// the scene path, 8jw the durability judge, hjt9/mln9 chunk routing, np4b a
// report about stored rows).
//
// FIVE ARMS, same turns, same model, so a change can be ATTRIBUTED:
//   A  old gate + old prompt              what ships today (see PROMPT PINNING)
//   B  new gate + new prompt              the cye6 slice-2 configuration
//   C  new gate + OLD prompt              separates "the gate did it" from "the prompt did it"
//   D  OLD gate + new prompt              icke: the cell never run - the prompt in the
//                                         configuration that is actually shipping
//   E  OLD gate + new prompt + IDENTITY   D plus a header naming who spoke and who the
//                                         human player is (qhej/egj3)
//
// PROMPT PINNING (icke). Both prompts are read from scratch/*.txt, NOT from the
// live SYSTEM_PROMPT. The DIRECTION OF ADDRESS block was pulled from the build in
// fe71f9f, so reading the live constant would silently make the "new" arm a copy
// of the old one - D would compare a prompt against itself and report no effect.
// The snapshots are the exact bytes arms B and C were measured against (extracted
// from ambient.ts at 4cbb393), which is what makes D comparable to B at all.
//   Verified when pinned: system-prompt-old.txt is byte-identical to the live
//   SYSTEM_PROMPT, and -new.txt differs from it by exactly one inserted block.
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
const NEW_PROMPT = readFileSync(join(PKG, "scratch", "system-prompt-new.txt"), "utf8");
if (/DIRECTION OF ADDRESS/.test(OLD_PROMPT)) throw new Error("old prompt is not old");
if (!/DIRECTION OF ADDRESS/.test(NEW_PROMPT)) throw new Error("new prompt is not new");
// The old snapshot must still be what the build ships, or arm A is not a baseline
// for anything. Cheap to check, and it fails loudly the day the prompt is edited
// without re-pinning.
if (OLD_PROMPT !== SYSTEM_PROMPT) {
  throw new Error("scratch/system-prompt-old.txt no longer matches the live SYSTEM_PROMPT - re-pin the snapshots before trusting these arms");
}

// ARM E's identity clause. Appended to the NEW prompt so E differs from D by
// exactly one thing: the header, and the instruction to use it.
const IDENTITY_CLAUSE = `

WHO IS SPEAKING — the turn header names the people involved. Use it.
- The header gives the human player's names. A sentence naming any of them is
  about the user: subject "user". Do not file it under a character who happens to
  share the name.
- The header also lists names that are NOT the player. Those are characters,
  however closely they resemble the player's name.
- The header names the character who spoke the [character] block. A [character]
  sentence describing the speaker is about that character.
- The header does not outrank the sentence. If the content is plainly about
  someone else, follow the content.
- [character] "Thomas, you never told me about Texas", where the header says
  Thomas is the player → character scope, user_topics, subject "user"`;
const E_PROMPT = NEW_PROMPT + IDENTITY_CLAUSE;

// The DECLARED user identity (egj3), read from the store rather than invented
// here, so arm E measures something the live path could actually supply. Absent
// or empty, E is not runnable - it would quietly degrade into a second copy of D
// and report as though the identity header had made no difference.
const IDENTITY = (() => {
  const f = join(PKG, "data", "user-identity.yaml");
  if (!existsSync(f)) throw new Error("arm E needs data/user-identity.yaml (egj3) and it is missing");
  const y = YAML.parse(readFileSync(f, "utf8")) ?? {};
  if (!y.canonical) throw new Error("user-identity.yaml has no canonical name - arm E cannot run");
  return {
    canonical: String(y.canonical),
    aliases: (y.aliases ?? []).map(String),
    excludes: (y.excludes ?? []).map(String),
  };
})();

const SEED = Number(process.env.BENCH_SEED ?? 20260825);
const TURNS = Number(process.env.BENCH_TURNS ?? 60);

// WHICH ARMS TO RUN, and WHERE THE ROWS GO. Both exist for the same reason: the
// committed scratch/precision-bench.jsonl is a LABELLED corpus (496 verdicts in
// labels.tsv), and the blind ids in that file are positions in a seeded shuffle
// over its rows. Re-running A/B/C would regenerate those rows - the model is not
// deterministic at temperature 0.1 - and appending rows would change the shuffle.
// Either one silently remaps every existing id onto a different fact. So a
// partial run must write somewhere else, and the guard below enforces it rather
// than trusting whoever is at the keyboard to remember.
const ONLY = (process.env.BENCH_ARMS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const DEFAULT_OUT = "precision-bench.jsonl";
const OUT = process.env.BENCH_OUT ?? DEFAULT_OUT;
if (ONLY.length && OUT === DEFAULT_OUT) {
  throw new Error(`refusing to overwrite ${DEFAULT_OUT} with a partial run (arms ${ONLY.join(",")}) - set BENCH_OUT to a new file`);
}
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

// `identity` is arm E only. Named forms are used VERBATIM from the declared
// identity - including the stored lowercase - because normalising them here would
// measure a prompt the live path cannot reproduce.
function buildPrompt(userC, charC, roster, identity, characterName) {
  const lines = [...userC.map((s) => `[user] ${s}`), ...charC.map((s) => `[character] ${s}`)];
  const rosterLine = roster?.length ? `Known characters: ${roster.join(", ")}\n\n` : "";
  let header = "";
  if (identity) {
    const forms = [identity.canonical, ...identity.aliases].filter(Boolean);
    const parts = [
      `- The [user] block was spoken by the human player: ${forms.join(", ")}. Any of those names means the user.`,
    ];
    if (identity.excludes.length) {
      parts.push(`- NOT the player, despite the resemblance: ${identity.excludes.join(", ")}.`);
    }
    if (characterName) parts.push(`- The [character] block was spoken by ${characterName}.`);
    header = `WHO IS SPEAKING\n${parts.join("\n")}\n\n`;
  }
  return {
    lines,
    prompt: `${header}${rosterLine}Sentences to evaluate:\n${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}`,
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

// `enforce` tracks the PROMPT, not the gate: enforceAddressDirection is the code
// half of the DIRECTION OF ADDRESS change, so every arm carrying the new prompt
// carries it too. D and E therefore differ from B only in the gate.
const ARMS = [
  { id: "A", gate: false, prompt: OLD_PROMPT, enforce: false, identity: false },
  { id: "B", gate: true,  prompt: NEW_PROMPT, enforce: true,  identity: false },
  { id: "C", gate: true,  prompt: OLD_PROMPT, enforce: false, identity: false },
  { id: "D", gate: false, prompt: NEW_PROMPT, enforce: true,  identity: false },
  { id: "E", gate: false, prompt: E_PROMPT,   enforce: true,  identity: true  },
];

// DUMP MODE (BENCH_DUMP=1). Prints the exact system prompt and the exact first
// assembled user message for each arm, then exits without calling the model.
// It runs the same buildPrompt the measured run uses, so what gets reviewed is
// what gets sent - a hand-written reproduction in a separate script would drift
// from this one the first time either changed.
const DUMP = process.env.BENCH_DUMP === "1";
// THE SAMPLE IS PINNED, NOT RE-DERIVED (icke). The bench samples from the live
// store, and the store grows: between the A/B/C run and the D/E run it went from
// 1165 turns built to 1167. The seed is the same but the POOL is not, so
// slice(0, 60) returns a different 60 turns and a later arm would be measured
// against a sample the earlier arms never saw. scratch/bench-sample.json holds
// the original 60, reconstructed and verified turn-for-turn against the
// committed rows by scripts/bench-pin-sample.mjs.
//   Delete the file to sample afresh - appropriate for a NEW experiment, never
//   for adding an arm to an existing one.
const SAMPLE_FILE = join(PKG, "scratch", "bench-sample.json");
let sample, all, eligible;
if (existsSync(SAMPLE_FILE)) {
  const pinned = JSON.parse(readFileSync(SAMPLE_FILE, "utf8"));
  if (pinned.seed !== SEED) throw new Error(`pinned sample was built with seed ${pinned.seed}, not ${SEED}`);
  sample = pinned.turns;
  all = { length: pinned.built };
  eligible = { length: pinned.eligible };
  console.error(`SAMPLE PINNED from scratch/bench-sample.json - ${sample.length} turns (corpus as of ${pinned.reconstructedFromCutoff})`);
} else {
  all = loadTurns();
  eligible = all.filter((t) => {
    const c = cells(t);
    return c.added.length > 0 && c.uOld.length + c.cOld.length > 0;
  });
  const rand = rng(SEED);
  const pool = eligible.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  sample = pool.slice(0, TURNS);
}

const RUN_ARMS = ONLY.length ? ARMS.filter((a) => ONLY.includes(a.id)) : ARMS;
if (ONLY.length && RUN_ARMS.length !== ONLY.length) {
  throw new Error(`unknown arm in BENCH_ARMS=${ONLY.join(",")} - known arms are ${ARMS.map((a) => a.id).join(",")}`);
}

console.error(`turns built ${all.length} | eligible ${eligible.length} | sampled ${sample.length} | seed ${SEED} | model ${MODEL} | arms ${RUN_ARMS.map((a) => a.id).join(",")}`);

if (DUMP) {
  const t = sample[0];
  const c = cells(t);
  for (const arm of RUN_ARMS) {
    const userC = arm.gate ? c.uNew : c.uOld;
    const charC = arm.gate ? c.cNew : c.cOld;
    const { prompt } = buildPrompt(userC, charC, [t.characterName], arm.identity ? IDENTITY : null, t.characterName);
    console.log(`${"=".repeat(78)}`);
    console.log(`ARM ${arm.id}  gate=${arm.gate ? "wide" : "old"}  enforce=${arm.enforce}  identity=${arm.identity}`);
    console.log(`${"=".repeat(78)}`);
    console.log(`--- SYSTEM PROMPT (${arm.prompt.length} chars) ---`);
    console.log(arm.prompt);
    console.log(`--- USER MESSAGE, turn 1 of the sample (${prompt.length} chars) ---`);
    console.log(prompt);
    console.log("");
  }
  process.exit(0);
}

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
  for (const arm of RUN_ARMS) {
    const userC = arm.gate ? c.uNew : c.uOld;
    const charC = arm.gate ? c.cNew : c.cOld;
    const { lines, prompt } = buildPrompt(userC, charC, [t.characterName], arm.identity ? IDENTITY : null, t.characterName);
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
const path = join(PKG, "scratch", OUT);
writeFileSync(path, out.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

const tally = {};
for (const r of out) {
  const k = `${r.arm}/${r.cell}`;
  tally[k] = (tally[k] ?? 0) + 1;
}
writeFileSync(join(PKG, "scratch", OUT.replace(/\.jsonl$/, "") + "-validity.jsonl"),
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
