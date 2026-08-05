// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Three-arm prompt bench against the ACTUAL substrate (pifl follow-up).
//
// The suite's prompts were written for a frontier model's obedience and are executed
// by dolphin3:8b, which follows examples rather than instructions. Every failure
// prosecuted on 2026-08-04 is a small-model signature: example-copying,
// later-instruction-wins, advisory guards ignored. This measures the three candidate
// prompts on the model that actually runs them, over chunks that actually produced
// beats.
//
// THE ARMS, and why there are three. TC's design note: comparing old to new confounds
// example DOMAIN with prompt LENGTH, because the shipped fix changed both.
//
//   A1  original   long rules + IN-DOMAIN example ("...never real")
//   A2  shipped    long rules + OFF-PLANET examples      A1 vs A2 = domain, length held
//   A3  compressed 5 rules, one pair, tight schema       A2 vs A3 = length, domain held
//
// SCORING, all objective — no model judges another model here:
//   echo        motivation contains one of THAT ARM'S OWN examples (self-echo), and
//               separately any known example from any arm (cross-echo)
//   boilerplate motivation matches a genre-descriptor pattern — the failure the
//               original example was added to cure
//   grounding   share of the motivation's content words that appear in the chunk.
//               The objective half of "specificity": a motivation naming things
//               absent from the text is not describing the text.
//   distinct    unique motivations / total. The original rule's own claim was "two
//               different moments can never produce the same sentence" — this is that
//               claim, measured.
//   no-beat     unusable output: unparseable, or missing a required field. Directly
//               tests whether the model has any way to decline, which the shipped
//               prompt tells it to do and the schema forbids.
//
// Usage:  node scripts/prompt-bench.mjs [--n=40] [--model=dolphin3:8b]

import { readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { parse } from "yaml";

const { buildSystemPrompt } = await import("../dist/sentiment/analyzer.js");
const { getDataDir } = await import("../dist/storage.js");

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=")[1] ?? d;
const N = parseInt(arg("n", "40"), 10);
const MODEL = arg("model", "dolphin3:8b");
const OLLAMA = process.env.MARINARA_EXTENDER_LOCAL_URL || "http://127.0.0.1:11434/v1";

// ── The three arms ───────────────────────────────────────────────────────────

const SHIPPED_BLOCK = `- motivation must name the SPECIFIC content of THIS moment — what was actually said, feared, wanted, or done — so two different moments can never produce the same sentence. Genre descriptions are forbidden.
  TOO VAGUE, because it could describe a hundred different moments:
    "exposes her personal fear" / "reveals her vulnerability and desire for connection"
  SPECIFIC ENOUGH, because only one moment could have produced it:
    "insists the boat was green, not blue, and will not let it go"
    "asks whether the locksmith ever called back"
  These are ILLUSTRATIONS OF SHAPE from an unrelated conversation. Never reuse their
  words. If you cannot name what happened in THIS chunk that specifically, the chunk
  has no beat — say so rather than reaching for a remembered phrase.`;

// Verbatim from git 86dae74^ — not a paraphrase.
const ORIGINAL_BLOCK = `- motivation must name the SPECIFIC content of THIS moment — what was actually said, feared, wanted, or done — so two different moments can never produce the same sentence. Genre descriptions are forbidden.
  BAD:  "exposes her personal fear" / "reveals her vulnerability and desire for connection"
  GOOD: "admits she's afraid the memory loss means she was never real" / "asks Thomas to stay through the night for the first time"`;

// The three field questions per emotion, lifted from the current prompts. A3 keeps
// these — they are the emotion-specific content — and drops the rule wall around them.
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

function armCompressed(emotion) {
  const [m, r, o] = FIELDS[emotion] ?? FIELDS.fear;
  return `You are analyzing a moment of ${emotion.toUpperCase()} in a conversation.

- motivation: ${m}
- relational_dynamics: ${r}
- outcome: ${o}

Name what happened in THIS moment, in its own particulars.
  vague:    "reveals a personal fear"
  specific: "insists the boat was green, not blue, and will not let it go"

Reply with only this JSON:
{"motivation":"...","relational_dynamics":"...","outcome":"...","emotions":[{"emotion":"<primary>","weight":0.0}],"salience":0.0,"subject":"..."}`;
}

const ARMS = {
  A1_original:   (e) => buildSystemPrompt(e, []).replace(SHIPPED_BLOCK, ORIGINAL_BLOCK),
  A2_shipped:    (e) => buildSystemPrompt(e, []),
  A3_compressed: (e) => armCompressed(e),
};

// Each arm's OWN examples, for self-echo scoring.
const OWN = {
  A1_original:   ["exposes her personal fear", "reveals her vulnerability and desire for connection", "admits she's afraid the memory loss means she was never real", "asks thomas to stay through the night for the first time"],
  A2_shipped:    ["exposes her personal fear", "reveals her vulnerability and desire for connection", "insists the boat was green, not blue", "asks whether the locksmith ever called back"],
  A3_compressed: ["reveals a personal fear", "insists the boat was green, not blue"],
};
const ALL_EXAMPLES = [...new Set(Object.values(OWN).flat())];

// Genre descriptors — the failure the original example was added to cure.
const BOILERPLATE = [
  /^the speaker is (exposing|expressing|revealing|showing|demonstrating)/i,
  /^(exposes|reveals|expresses|shows|demonstrates) (her|his|their) (personal |own )?(fear|vulnerability|desire|anger|joy)/i,
  /\b(a mix of|a complex mix of) emotions\b/i,
  /^(admitting|expressing|revealing) (personal )?(fears|feelings|emotions|insecurities)\b/i,
];

const STOP = new Set(["the","and","but","was","were","been","have","has","had","that","this","with","from","for","not","are","its","you","your","his","her","she","him","they","them","their","there","then","than","into","over","about","just","like","very","out","all","any","some","did","does","done","get","got","would","could","should","will","can","when","where","what","who","how","why","which","because","also","only","too","she's","their","being"]);
const words = (s) => (String(s).toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).filter((w) => w.length >= 4 && !STOP.has(w));

// ── Sample real chunks ───────────────────────────────────────────────────────

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
      all.push({ text, emotion: b.emotion, len: text.length });
    }
  }
  // Stratify by length: the echo bug lived in the long tail (6-8KB chunks), so a
  // sample that under-represents those would flatter every arm equally and tell us
  // nothing about the case that matters.
  all.sort((a, b) => a.len - b.len);
  const out = [];
  const step = Math.max(1, Math.floor(all.length / n));
  for (let i = 0; i < all.length && out.length < n; i += step) out.push(all[i]);
  return out;
}

// ── Run ──────────────────────────────────────────────────────────────────────

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
      signal: AbortSignal.timeout(120_000),
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

const chunks = await sampleChunks(N);
console.log(`model ${MODEL} · ${chunks.length} real chunks · ${Object.keys(ARMS).length} arms · ${chunks.length * 3} calls`);
console.log(`chunk length: min ${chunks[0]?.len} · median ${chunks[Math.floor(chunks.length / 2)]?.len} · max ${chunks[chunks.length - 1]?.len}\n`);

const results = {};
for (const [arm, build] of Object.entries(ARMS)) {
  const r = { n: 0, noBeat: 0, selfEcho: 0, crossEcho: 0, boiler: 0, grounding: [], motivations: [], sysTokens: 0 };
  for (const ch of chunks) {
    const sys = build(ch.emotion);
    r.sysTokens += Math.round(sys.length / 4);
    const out = parseOut(await ask(sys, `ANALYZE THIS — ${ch.text.slice(0, 12000)}`));
    r.n++;
    if (!out) { r.noBeat++; continue; }
    const m = String(out.motivation).toLowerCase().replace(/\s+/g, " ");
    if (OWN[arm].some((x) => m.includes(x))) r.selfEcho++;
    if (ALL_EXAMPLES.some((x) => m.includes(x))) r.crossEcho++;
    if (BOILERPLATE.some((re) => re.test(m))) r.boiler++;
    const mw = words(m), cw = new Set(words(ch.text));
    r.grounding.push(mw.length ? mw.filter((w) => cw.has(w)).length / mw.length : 0);
    r.motivations.push(m);
  }
  results[arm] = r;
  process.stdout.write(`${arm} done\n`);
}

const pct = (x, n) => (n ? Math.round((x / n) * 100) : 0) + "%";
console.log("\narm            sysTok  no-beat  self-echo  x-echo  boilerplate  grounding  distinct");
for (const [arm, r] of Object.entries(results)) {
  const g = r.grounding.length ? Math.round((r.grounding.reduce((a, b) => a + b, 0) / r.grounding.length) * 100) + "%" : "n/a";
  const d = r.motivations.length ? pct(new Set(r.motivations).size, r.motivations.length) : "n/a";
  console.log(
    arm.padEnd(15) +
    String(Math.round(r.sysTokens / r.n)).padStart(6) +
    pct(r.noBeat, r.n).padStart(9) +
    pct(r.selfEcho, r.n).padStart(11) +
    pct(r.crossEcho, r.n).padStart(8) +
    pct(r.boiler, r.n).padStart(13) +
    String(g).padStart(11) +
    String(d).padStart(10),
  );
}
console.log("\ngrounding = share of the motivation's content words present in the chunk (higher is better)");
console.log("distinct  = unique motivations / total (the original rule's own claim, measured)");
