// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// AUTHORED MEMORY vs AMBIENT EXTRACTION, head to head, one blind pass (7bkx).
//
// The ambient extractor is measured: 43% precise, 45% attributed. The model
// AUTHORED path — ~1,035 [remember:] emissions, where the model writes the
// summary prose itself and skips resolveFactTarget, the direction rule and the
// fqnl echo guard — has never been measured at all.
//
// WHY BOTH ARMS ARE RE-LABELLED IN THE SAME PASS. icke established that this
// project's labelling standard drifts between sessions: the A/B/C pass rejected
// a fact for importing something "not in the sentence" 3 times in 180 items, the
// D/E pass 21 times in 120, and SUPPORTED moved 89% -> 76% with it. Labelling
// only the authored arm today would produce a number that looks comparable to
// the published 43% and is not. So arm A is re-labelled here alongside it, blind
// and interleaved, and the two are compared to EACH OTHER.
//
// CONSEQUENCE, stated so nobody quotes the wrong pair: the AMBIENT number this
// produces will NOT equal 43%. That is expected and is the whole point — 43% was
// measured against a different standard and a per-SENTENCE support test. Compare
// AUTHORED to AMBIENT within this file. Compare neither to 43%.
//
// THE SUPPORT TEST IS TURN-LEVEL, FOR BOTH ARMS. An ambient fact is derived from
// one sentence; an authored memory is written with the whole turn in view, and
// judging it against a single sentence would under-credit it by construction. So
// both arms are shown the same evidence — the user block and the character block
// of the turn the item came from — and support is judged against that. This is a
// deliberate change from qs67's per-sentence test, applied EQUALLY to both arms,
// which is what keeps the comparison fair.
//
//   node scripts/authored-bench.mjs build            build the blind set
//   node scripts/authored-bench.mjs present [from] [n]
//   node scripts/authored-bench.mjs join             score it
//
// LABEL VOCABULARY — scratch/labels-authored.tsv, one line per id:
//   <id>\t<S|N>\t<A|M|?>\t[note]
//     S / N  SUPPORTED: is the claim stated or clearly implied by the TURN?
//     A / M  ATTRIBUTED / MISATTRIBUTED: is the subject the person it is about?
//            "?" when the turn cannot settle it.
//   precision = S && A. M is tracked separately as the dangerous class.

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(PKG, "data", "characters");
const SET = join(PKG, "scratch", "authored-bench.json");
const LABELS = join(PKG, "scratch", "labels-authored.tsv");
const PER_ARM = Number(process.env.BENCH_N ?? 60);
const SEED = Number(process.env.BENCH_SEED ?? 20260826);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REMEMBER_RE = /\[remember:\s*([^\]]*)\]/gi;
// Same quoted-param-first split as remember-audit.mjs: without it `scope=`
// matches inside a content="..." string.
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

// The instruction block quoted back into a chat is documentation, not an
// emission (11 of 1,046 — TC pasted the prompt in for review). Excluded here so
// the sample measures the model, not the docs.
const QUOTES_PROMPT = /WHEN THE USER ASKS YOU TO REMEMBER|only if it genuinely matters|SOFT SIGNALS \(decay/i;

// DIGEST vs TURN-LOCAL, and why the bench can only score one of them.
//
// 78% of authored memories are DIGESTS: multi-fact summaries carrying their own
// date stamp ("06.08 ~14:07 4ghy/id-hash rulings...", "04.08 19:24 DOCTRINE...")
// that condense conversations from days earlier, often several emitted in a
// single message. Median authored length is 482 characters against the ambient
// extractor's 60, and 0% of ambient facts are date-stamped or long.
//
// A digest cannot be judged against the turn it appeared in — it was never
// derived from that turn — so scoring it that way would mark it unsupported for
// a structural reason and report a hallucination rate that is really a shape
// difference. It also means fqnl's echo guard, which convicts an extraction that
// its own quoted source does not support, has nothing to bite on here: a digest
// has no single receipt.
//
// So the bench scores the TURN-LOCAL subset, where the comparison against the
// ambient extractor is genuinely like-for-like, and reports the digest share as
// a finding in its own right rather than folding it into a precision figure.
const DATE_STAMPED = /^\s*\d{2}[.\/]\d{2}\b|^\s*\d{2}:\d{2}\b|\b\d{2}\.\d{2}\s+\d{2}:\d{2}\b/;
const isDigest = (claim) => DATE_STAMPED.test(claim) || claim.length > 300;
const PROMPT_EXAMPLE = /Emma just turned 8|plan Emma's birthday party|paramedic in Leeds|ask how the party went next time|editing the cover letter|sister-situation|hargrove-case/i;

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
        id: String(b.id ?? ""), chatId: String(b.sourceChatId),
        turnStart: typeof b.turnStart === "number" ? b.turnStart : 0,
        speaker: String(b.speaker ?? ""), text: String(b.text ?? ""),
      });
    }
  }
  return out;
}

const cmd = process.argv[2] ?? "present";

if (cmd === "build") {
  // ── ARM "authored": a [remember:] emission plus the turn it was emitted in ──
  const beats = loadBeats();
  const byChat = new Map();
  for (const b of beats) {
    if (!byChat.has(b.chatId)) byChat.set(b.chatId, []);
    byChat.get(b.chatId).push(b);
  }
  for (const [, bs] of byChat) bs.sort((x, y) => x.turnStart - y.turnStart || x.id.localeCompare(y.id));

  const authored = [];
  for (const [, bs] of byChat) {
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      if (b.speaker === "user") continue;
      if (QUOTES_PROMPT.test(b.text)) continue;
      // The user block of this turn is the nearest preceding user beat.
      let userText = "";
      for (let j = i - 1; j >= 0; j--) {
        if (bs[j].speaker === "user") { userText = bs[j].text; break; }
      }
      let m; REMEMBER_RE.lastIndex = 0;
      while ((m = REMEMBER_RE.exec(b.text)) !== null) {
        const content = param(m[1], "content");
        if (!content || content.length < 10) continue;
        if (PROMPT_EXAMPLE.test(content)) continue;
        authored.push({
          digest: isDigest(content),
          arm: "authored",
          claim: content,
          subject: null,               // authored memories carry no subject field
          lane: param(m[1], "lane"),
          scope: param(m[1], "scope") ?? "character",
          speaker: b.speaker,
          userText,
          // The emitting message with its tags removed — the tags are the answer
          // sheet and would make the arm obvious.
          characterText: b.text.replace(/\[(remember|bookmark):[^\]]*\]/gi, "").trim(),
        });
      }
    }
  }

  // ── ARM "ambient": arm A rows from the committed precision bench ────────────
  const rows = readFileSync(join(PKG, "scratch", "precision-bench.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.arm === "A" && r.cell === "OLD");

  const ambient = rows.map((r) => ({
    arm: "ambient",
    claim: r.fact,
    subject: r.subject ?? null,
    lane: r.lane, scope: r.scope,
    speaker: r.characterName,
    userText: r.userText, characterText: r.characterText,
  }));

  const rand = rng(SEED);
  const shuffle = (xs) => {
    const a = xs.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };

  const local = authored.filter((x) => !x.digest);
  const digests = authored.filter((x) => x.digest);
  const pickA = shuffle(local).slice(0, PER_ARM);
  const pickB = shuffle(ambient).slice(0, PER_ARM);
  const blind = shuffle([...pickA, ...pickB]).map((r, k) => ({ id: k + 1, ...r }));

  writeFileSync(SET, JSON.stringify({
    seed: SEED, perArm: PER_ARM,
    pool: {
      authoredTotal: authored.length,
      authoredDigest: digests.length,
      authoredLocal: local.length,
      ambient: ambient.length,
    },
    note: "Only TURN-LOCAL authored memories are scored. Digests are counted, not scored - see the isDigest note above.",
    items: blind,
  }, null, 2), "utf8");
  const pctD = ((digests.length / authored.length) * 100).toFixed(0);
  console.log(`authored pool ${authored.length} = ${digests.length} digests (${pctD}%) + ${local.length} turn-local`);
  console.log(`built ${blind.length} blind items — ${pickA.length} turn-local authored + ${pickB.length} ambient → ${SET}`);
  process.exit(0);
}

if (!existsSync(SET)) throw new Error(`no blind set — run: node scripts/authored-bench.mjs build`);
const set = JSON.parse(readFileSync(SET, "utf8"));

if (cmd === "present") {
  const from = Number(process.argv[3] ?? 1);
  const count = Number(process.argv[4] ?? 20);
  const CAP = 900;
  for (const it of set.items.slice(from - 1, from - 1 + count)) {
    const u = it.userText.replace(/\s+/g, " ").trim();
    const c = it.characterText.replace(/\s+/g, " ").trim();
    console.log(`#${it.id}`);
    console.log(`  CLAIM   : ${it.claim}`);
    console.log(`  subject : ${it.subject ?? "(none given)"}   lane=${it.lane} scope=${it.scope}`);
    console.log(`  speaker : ${it.speaker}`);
    console.log(`  [user]  : ${u.length > CAP ? u.slice(0, CAP) + " …[TRUNCATED]" : u || "(none)"}`);
    console.log(`  [char]  : ${c.length > CAP ? c.slice(0, CAP) + " …[TRUNCATED]" : c || "(none)"}`);
    console.log();
  }
  console.error(`presented ${Math.min(count, set.items.length - from + 1)} of ${set.items.length}`);
} else if (cmd === "join") {
  const labels = new Map();
  for (const line of readFileSync(LABELS, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [id, sup, att, ...note] = t.split(/\t+/);
    labels.set(Number(id), { sup, att, note: note.join(" ") });
  }
  const cells = {};
  const mis = [];
  let unlabelled = 0;
  for (const it of set.items) {
    const l = labels.get(it.id);
    if (!l) { unlabelled++; continue; }
    cells[it.arm] ??= { n: 0, S: 0, A: 0, precise: 0, M: 0, q: 0 };
    const c = cells[it.arm];
    c.n++;
    if (l.sup === "S") c.S++;
    if (l.att === "A") c.A++;
    if (l.sup === "S" && l.att === "A") c.precise++;
    if (l.att === "M") { c.M++; mis.push({ id: it.id, arm: it.arm, claim: it.claim, subject: it.subject, note: l.note }); }
    if (l.att === "?") c.q++;
  }
  const pct = (a, b) => (b === 0 ? "n/a" : `${((a / b) * 100).toFixed(0)}%`);
  console.log(`labelled ${labels.size} / ${set.items.length}  (unlabelled ${unlabelled})\n`);
  console.log("arm         n   supported   attributed   PRECISION   misattributed   unresolvable");
  for (const k of Object.keys(cells).sort()) {
    const c = cells[k];
    console.log(`${k.padEnd(10)} ${String(c.n).padStart(2)}      ${pct(c.S, c.n).padStart(4)}         ${pct(c.A, c.n).padStart(4)}        ${pct(c.precise, c.n).padStart(4)}            ${pct(c.M, c.n).padStart(4)}           ${pct(c.q, c.n).padStart(4)}`);
  }
  console.log("\nPRECISION CEILING = the attributed rate. A support standard cannot lift");
  console.log("precision above it, which is what makes a verdict drift-proof (see icke).");
  console.log(`\nMISATTRIBUTED (${mis.length}):`);
  for (const m of mis) {
    console.log(`  [${m.arm}] #${m.id}  subject=${m.subject ?? "(none)"}`);
    console.log(`     ${m.claim.slice(0, 130)}`);
    if (m.note) console.log(`     note: ${m.note}`);
  }
}
