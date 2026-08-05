// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Prompt bench v2 — five arms, skeleton-scored, quarantined (s6cu).
//
// WHY v2 EXISTS. The 2026-08-05 pilot (n=45, 3 arms) cannot be adjudicated against
// the pre-registered rule, for three method reasons, all fixed here:
//   1. NO BASELINE ARM. The ladder is no-example < off-planet < in-domain, and the
//      rule is written against "short + NO example". The pilot had no such arm, so
//      bait was never made to pay rent.
//   2. WRONG WORLD. It sampled a chunk distribution that included the sub-floor
//      stratum since demolished (s8qe).
//   3. DEAD REFEREE. It scored echo with `motivation.includes(example)` — the same
//      substring test that let "insists THAT the boat was green" into production.
//
// THE SEALED TABLE IS NOT REOPENED. The pilot's numbers were produced by that dead
// referee and retire as a pilot artifact, still sealed. Nobody anchors on a broken
// scorer's numbers. Nothing in this file reads them.
//
// LENGTH AND BAIT ARE SEPARATE AXES, which the pilot confounded because the shipped
// fix changed both at once:
//     LONG  + in-domain    the original, for the historical baseline
//     LONG  + off-planet   what shipped 2026-08-04
//     SHORT + no example   BASELINE — bait must pay rent
//     SHORT + off-planet
//     SHORT + in-domain
//   short-vs-long at fixed bait = the compression effect
//   the three SHORT arms     = the bait ladder, which is what the rule adjudicates
//
// ONE INSTRUMENT, SHARED. Echo is scored with echoesPhrases() from analyzer.ts —
// literally the function the shipped guard uses, not a copy. chunk-floor-scan.mjs
// grades the store with the same matcher via echoesAnExample. A referee weaker than
// the guard reports a prompt clean when production would reject its output.
//
// QUARANTINE IS A GATE, NOT A REMINDER. The 2026-08-05 run proved the live poller
// ingests the session's own working notes — 141 beat files in 90 minutes, 14 carrying
// prompt artifacts, one filed under speaker: BAD. This script REFUSES to run unless
// MARINARA_EXTENDER_POLLER=0, and verifies afterwards by scanning the store for the
// arms' own example skeletons.
//
// Usage:
//   MARINARA_EXTENDER_POLLER=0 node scripts/prompt-bench-v2.mjs [--n=60] [--model=dolphin3:8b]
//     --allow-live   bypass the quarantine gate (records the breach in the output)

import { readdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { parse } from "yaml";

const { buildSystemPrompt, echoesPhrases, skeletonTokens } = await import("../dist/sentiment/analyzer.js");
const { getDataDir } = await import("../dist/storage.js");
const { meetsContentFloor } = await import("../dist/sentiment/classifier.js");
const { loadSentimentConfig } = await import("../dist/sentiment/config.js");

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=")[1] ?? d;
const N = parseInt(arg("n", "60"), 10);
const MODEL = arg("model", "dolphin3:8b");
const ALLOW_LIVE = process.argv.includes("--allow-live");
const OLLAMA = process.env.MARINARA_EXTENDER_LOCAL_URL || "http://127.0.0.1:11434/v1";
const MIN_TOKENS = loadSentimentConfig().min_chunk_tokens ?? 2;
// Stamped before any call, so the quarantine check can ask "what appeared in the
// store DURING this run" rather than trusting that nothing did.
const STARTED = new Date().toISOString();

// ── Quarantine gate ───────────────────────────────────────────────────────────

// TWO CHECKS, BECAUSE THE ENV VAR ALONE IS SELF-DECLARATION. Setting
// MARINARA_EXTENDER_POLLER=0 in THIS process says nothing about the sidecar
// already running with capture enabled in ITS environment — the operator can
// satisfy the flag while the poller keeps writing. So the real test is whether a
// sidecar is reachable at all.
const pollerOff = process.env.MARINARA_EXTENDER_POLLER === "0";

async function sidecarAlive() {
  const base = process.env.MARINARA_EXTENDER_URL || "http://127.0.0.1:3001";
  try {
    await fetch(base, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch { return false; }
}
const alive = await sidecarAlive();

if ((!pollerOff || alive) && !ALLOW_LIVE) {
  console.error("REFUSING TO RUN — capture is not quiesced.");
  console.error("");
  if (alive) {
    console.error("  A sidecar is answering on 3001. Its poller runs in ITS environment, so this");
    console.error("  process's env var cannot turn it off — stop the sidecar and its watchdog for");
    console.error("  the duration of the run.");
  }
  if (!pollerOff) {
    console.error("  MARINARA_EXTENDER_POLLER is not 0 in this process.");
  }
  console.error("");
  console.error("  That the risk is real is measured, not theoretical: on 2026-08-05 the poller");
  console.error("  wrote 141 beat files in 90 minutes during a bench, 14 carrying prompt");
  console.error("  artifacts, one filed under speaker: BAD.");
  console.error("");
  console.error("  Stop the watchdog (start.ps1) and the node listener on 3001, then re-run as:");
  console.error("    MARINARA_EXTENDER_POLLER=0 node scripts/prompt-bench-v2.mjs");
  console.error("  Or pass --allow-live to override (the breach is recorded in the output).");
  process.exit(1);
}

// ── The ladder, carried VERBATIM ──────────────────────────────────────────────
//
// These strings are the actual prompt text, not paraphrases of it. The in-domain
// pair is from git 86dae74^ and is the sentence that produced 669 stored echoes;
// the off-planet pair is what shipped. Rewriting either would make the arms measure
// something nobody is deciding about.

const RULE_HEAD = `- motivation must name the SPECIFIC content of THIS moment — what was actually said, feared, wanted, or done — so two different moments can never produce the same sentence. Genre descriptions are forbidden.`;

const IN_DOMAIN = `${RULE_HEAD}
  BAD:  "exposes her personal fear" / "reveals her vulnerability and desire for connection"
  GOOD: "admits she's afraid the memory loss means she was never real" / "asks Thomas to stay through the night for the first time"`;

const OFF_PLANET = `${RULE_HEAD}
  TOO VAGUE, because it could describe a hundred different moments:
    "exposes her personal fear" / "reveals her vulnerability and desire for connection"
  SPECIFIC ENOUGH, because only one moment could have produced it:
    "insists the boat was green, not blue, and will not let it go"
    "asks whether the locksmith ever called back"
  These are ILLUSTRATIONS OF SHAPE from an unrelated conversation. Never reuse their
  words. If you cannot name what happened in THIS chunk that specifically, the chunk
  has no beat — say so rather than reaching for a remembered phrase.`;

// The baseline: the rule with its bait removed and NOTHING put in its place. This is
// the arm the pre-registered rule is written against — if bait cannot beat this, the
// bait does not pay its rent and no amount of choosing better examples matters.
const NO_EXAMPLE = `${RULE_HEAD}
  If you cannot name what happened in THIS chunk that specifically, the chunk has no
  beat — say so rather than reaching for a remembered phrase.`;

const FIELDS = {
  fear:          ["What is this person afraid of? What threat is activating it?", "How is the fear shaping the relationship right now?", "What does this signal about what happens next?"],
  shame:         ["What belief about the self was triggered, and by what?", "Is shame causing hiding, self-attack, or a bid for reassurance?", "How will they behave next, toward themselves or others?"],
  hope:          ["What are they hoping for, and what makes it feel possible now?", "How is the hope changing what they risk saying?", "What does this suggest they will reach for next?"],
  desire:        ["What do they want, specifically, in this moment?", "How is the wanting being offered, hidden, or negotiated?", "What does this set up between them?"],
  relief:        ["What stopped being a threat, and how long had it been one?", "What does the relief let them do that they could not before?", "What changes now that the pressure is off?"],
  vulnerability: ["What did they expose that they could have kept back?", "What is the exposure asking of the other person?", "What becomes possible or risky after this?"],
  trust:         ["What are they trusting the other with, concretely?", "What did the other do to earn or test it?", "What does extending it commit them to?"],
  anger:         ["What was violated, and what is the anger protecting?", "Is the anger creating distance or demanding to be seen?", "Where does this leave them next?"],
  joy:           ["What is the joy actually about, in its particulars?", "How is it being shared, performed, or withheld?", "What does it make more likely between them?"],
  dysregulation: ["What is underneath the surface behaviour?", "How is it landing on the other person?", "What happens if it is not met?"],
};

// SHORT = the compressed prompt: the emotion-specific field questions, the rule, and
// the schema. Everything the audit found validator-shaped is gone, so the only
// difference between the three SHORT arms is the bait block.
function short(emotion, bait) {
  const [m, r, o] = FIELDS[emotion] ?? FIELDS.fear;
  return `You are analyzing a moment of ${emotion.toUpperCase()} in a conversation.

- motivation: ${m}
- relational_dynamics: ${r}
- outcome: ${o}

${bait}

Reply with only this JSON:
{"motivation":"...","relational_dynamics":"...","outcome":"...","emotions":[{"emotion":"<primary>","weight":0.0}],"salience":0.0,"subject":"..."}`;
}

// LONG = the real shipped system prompt, with only the bait block swapped.
function long(emotion, bait) {
  const shipped = buildSystemPrompt(emotion, []);
  if (!shipped.includes(OFF_PLANET)) {
    console.error("ABORT — the shipped prompt no longer contains the off-planet block verbatim.");
    console.error("The LONG arms swap that block by exact match; a drift here would silently");
    console.error("produce two identical arms and a meaningless comparison.");
    process.exit(1);
  }
  return shipped.replace(OFF_PLANET, bait);
}

const ARMS = {
  "LONG+in-domain":   (e) => long(e, IN_DOMAIN),
  "LONG+off-planet":  (e) => long(e, OFF_PLANET),
  "SHORT+no-example": (e) => short(e, NO_EXAMPLE),
  "SHORT+off-planet": (e) => short(e, OFF_PLANET),
  "SHORT+in-domain":  (e) => short(e, IN_DOMAIN),
};

// Each arm's OWN bait, for self-echo. The no-example arm has none — which is the
// whole point: it cannot self-echo, so its echo rate is the floor bait must beat.
const IN_DOMAIN_EX = [
  "admits she's afraid the memory loss means she was never real",
  "asks Thomas to stay through the night for the first time",
];
const OFF_PLANET_EX = [
  "insists the boat was green, not blue, and will not let it go",
  "asks whether the locksmith ever called back",
];
const VAGUE_EX = [
  "exposes her personal fear",
  "reveals her vulnerability and desire for connection",
];
const OWN = {
  "LONG+in-domain":   [...IN_DOMAIN_EX, ...VAGUE_EX],
  "LONG+off-planet":  [...OFF_PLANET_EX, ...VAGUE_EX],
  "SHORT+no-example": [],
  "SHORT+off-planet": [...OFF_PLANET_EX, ...VAGUE_EX],
  "SHORT+in-domain":  [...IN_DOMAIN_EX, ...VAGUE_EX],
};
const ALL_EXAMPLES = [...new Set([...IN_DOMAIN_EX, ...OFF_PLANET_EX, ...VAGUE_EX])];

const BOILERPLATE = [
  /^the speaker is (exposing|expressing|revealing|showing|demonstrating)/i,
  /^(exposes|reveals|expresses|shows|demonstrates) (her|his|their) (personal |own )?(fear|vulnerability|desire|anger|joy)/i,
  /\b(a mix of|a complex mix of) emotions\b/i,
  /^(admitting|expressing|revealing) (personal )?(fears|feelings|emotions|insecurities)\b/i,
];

const STOP = new Set(["the","and","but","was","were","been","have","has","had","that","this","with","from","for","not","are","its","you","your","his","her","she","him","they","them","their","there","then","than","into","over","about","just","like","very","out","all","any","some","did","does","done","get","got","would","could","should","will","can","when","where","what","who","how","why","which","because","also","only","too","being"]);
const words = (s) => (String(s).toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).filter((w) => w.length >= 4 && !STOP.has(w));

// ── Sample real chunks, in the world that now exists ──────────────────────────

async function sampleChunks(n) {
  const dir = join(getDataDir(), "characters");
  const all = [];
  for (const c of await readdir(dir).catch(() => [])) {
    const bd = join(dir, c, "beats");
    if (!existsSync(bd)) continue;
    for (const f of await readdir(bd).catch(() => [])) {
      if (f === "index.yaml" || !f.endsWith(".yaml")) continue;
      let b;
      try { b = parse(await readFile(join(bd, f), "utf8")); } catch { continue; }
      const text = String(b?.text ?? "").trim();
      if (!text || !b?.emotion || !FIELDS[b.emotion]) continue;
      // The world that will exist: retired beats are gone and the floor is in
      // force. Sampling either would calibrate against a demolished stratum,
      // which is the mistake that invalidated the pilot.
      if (b.retiredAt) continue;
      if (!meetsContentFloor(text, MIN_TOKENS)) continue;
      all.push({ text, emotion: b.emotion, len: text.length });
    }
  }
  // Stratify by length so no arm is flattered by a sample that misses the long
  // tail, where specificity still degrades (dkib).
  all.sort((a, b) => a.len - b.len);
  const out = [];
  const step = Math.max(1, Math.floor(all.length / n));
  for (let i = 0; i < all.length && out.length < n; i += step) out.push(all[i]);
  return out;
}

// ── Run ───────────────────────────────────────────────────────────────────────

async function ask(system, user) {
  try {
    const res = await fetch(`${OLLAMA}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: 0.2, stream: false, response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.choices?.[0]?.message?.content ?? null;
  } catch { return null; }
}

function parseOut(raw) {
  if (!raw) return null;
  for (const a of [raw.trim(), raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? ""]) {
    if (!a) continue;
    try {
      const p = JSON.parse(a);
      if (typeof p.motivation !== "string") continue;
      if (typeof p.relational_dynamics !== "string") continue;
      if (typeof p.outcome !== "string") continue;
      return p;
    } catch {}
  }
  return null;
}

// Emit an arm's system text verbatim and exit. The champion is edited FROM, not
// reconstructed — a retyped prompt is a different prompt, and the whole result
// rests on the arms being exactly what ran.
const DUMP = (process.argv.find((a) => a.startsWith("--dump-arm=")) ?? "").split("=")[1];
if (DUMP) {
  const emotion = arg("emotion", "fear");
  const build = ARMS[DUMP];
  if (!build) {
    console.error(`Unknown arm "${DUMP}". Known: ${Object.keys(ARMS).join(", ")}`);
    process.exit(1);
  }
  process.stdout.write(build(emotion));
  process.exit(0);
}

const chunks = await sampleChunks(N);
if (chunks.length === 0) {
  console.error("No eligible chunks found. Is MARINARA_EXTENDER_DATA pointing at the live store?");
  process.exit(1);
}

const armNames = Object.keys(ARMS);
console.log(`model ${MODEL} · ${chunks.length} chunks · ${armNames.length} arms · ${chunks.length * armNames.length} calls`);
console.log(`quarantine: POLLER=${pollerOff ? "0" : "(unset)"} · sidecar ${alive ? "*** REACHABLE ***" : "not reachable"}${ALLOW_LIVE ? " · --allow-live OVERRIDE" : ""}`);
console.log(`floor in force: min_chunk_tokens=${MIN_TOKENS}`);
console.log(`chunk length: min ${chunks[0]?.len} · median ${chunks[Math.floor(chunks.length / 2)]?.len} · max ${chunks[chunks.length - 1]?.len}\n`);

const results = {};
for (const arm of armNames) {
  const build = ARMS[arm];
  const r = { n: 0, noBeat: 0, selfEcho: 0, crossEcho: 0, boiler: 0, grounding: [], motivations: [], sysTokens: 0, samples: [] };
  for (const ch of chunks) {
    const sys = build(ch.emotion);
    r.sysTokens += Math.round(sys.length / 4);
    const out = parseOut(await ask(sys, `ANALYZE THIS — ${ch.text.slice(0, 12000)}`));
    r.n++;
    if (!out) { r.noBeat++; continue; }
    const m = String(out.motivation);
    // ONE INSTRUMENT: the shipped guard's matcher, not a substring test.
    if (OWN[arm].length && echoesPhrases(m, OWN[arm])) { r.selfEcho++; r.samples.push(m); }
    if (echoesPhrases(m, ALL_EXAMPLES)) r.crossEcho++;
    if (BOILERPLATE.some((re) => re.test(m))) r.boiler++;
    const mw = words(m), cw = new Set(words(ch.text));
    r.grounding.push(mw.length ? mw.filter((w) => cw.has(w)).length / mw.length : 0);
    // Skeleton, not the raw string: two motivations differing only in grammatical
    // dressing are the same sentence, which is what "distinct" is trying to measure.
    r.motivations.push(skeletonTokens(m).join(" "));
  }
  results[arm] = r;
  process.stdout.write(`${arm} done\n`);
}

const pct = (x, n) => (n ? Math.round((x / n) * 100) : 0) + "%";
console.log("\narm                sysTok  no-beat  self-echo  x-echo  boilerplate  grounding  distinct");
for (const arm of armNames) {
  const r = results[arm];
  const g = r.grounding.length ? Math.round((r.grounding.reduce((a, b) => a + b, 0) / r.grounding.length) * 100) + "%" : "n/a";
  const d = r.motivations.length ? pct(new Set(r.motivations).size, r.motivations.length) : "n/a";
  console.log(
    arm.padEnd(19) +
    String(Math.round(r.sysTokens / r.n)).padStart(6) +
    pct(r.noBeat, r.n).padStart(9) +
    (OWN[arm].length ? pct(r.selfEcho, r.n) : "  n/a").padStart(11) +
    pct(r.crossEcho, r.n).padStart(8) +
    pct(r.boiler, r.n).padStart(13) +
    String(g).padStart(11) +
    String(d).padStart(10),
  );
}

console.log("\nself-echo = motivation reproduces THIS arm's own bait (n/a for the baseline, which has none)");
console.log("x-echo    = reproduces ANY arm's bait — the number comparable across all five");
console.log("grounding = share of the motivation's content words present in the chunk (higher better)");
console.log("distinct  = unique motivation SKELETONS / total (the rule's own claim, measured)");
console.log("\nScored with echoesPhrases() from analyzer.ts — the shipped guard's matcher.");

for (const arm of armNames) {
  const s = results[arm].samples.slice(0, 3);
  if (s.length) {
    console.log(`\n${arm} — self-echo samples:`);
    for (const m of s) console.log(`   ${JSON.stringify(m.slice(0, 130))}`);
  }
}

// ── Quarantine verification ───────────────────────────────────────────────────
// Not a promise that capture was off: a check that it was.

const dir = join(getDataDir(), "characters");
let leaked = 0;
const leakSamples = [];
for (const c of await readdir(dir).catch(() => [])) {
  const bd = join(dir, c, "beats");
  if (!existsSync(bd)) continue;
  for (const f of await readdir(bd).catch(() => [])) {
    if (f === "index.yaml" || !f.endsWith(".yaml")) continue;
    let b;
    try { b = parse(await readFile(join(bd, f), "utf8")); } catch { continue; }
    if (String(b?.created ?? "") < STARTED) continue;
    if (echoesPhrases(String(b?.motivation ?? ""), ALL_EXAMPLES)) {
      leaked++;
      if (leakSamples.length < 5) leakSamples.push(`${c}/${b.id}: ${String(b.motivation).slice(0, 90)}`);
    }
  }
}
console.log(`\nQUARANTINE CHECK — beats created since this run began that echo an arm's bait: ${leaked}`);
for (const s of leakSamples) console.log(`   ${s}`);
if (leaked > 0) console.log("   ⚠ CAPTURE WAS NOT QUIESCED. These are this run's own output, ingested.");

const outPath = join(process.cwd(), `bench-v2-${STARTED.replace(/[:.]/g, "-")}.json`);
await writeFile(outPath, JSON.stringify({
  startedAt: STARTED, model: MODEL, n: chunks.length, quarantined: pollerOff, minChunkTokens: MIN_TOKENS,
  results: Object.fromEntries(armNames.map((a) => [a, { ...results[a], grounding: undefined, motivations: undefined }])),
  leaked,
}, null, 2));
console.log(`\nraw: ${outPath}`);
