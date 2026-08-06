// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// CHOOSE BAIT BY ANTI-JOIN AGAINST THE LIVE STORE. READ-ONLY except for --write.
//
// WHY THIS EXISTS (2026-08-06). "Off-planet" was being decided by ear — does this
// sentence SOUND absurd for this domain — and ear is not a measurement. Two of the
// shipped examples went in-domain within 48 hours of being chosen that way:
//
//   "asks whether the locksmith ever called back"  -> "locksmith" became a live
//      thread label the same week, via Mari's own "read-side sealed = locksmith
//      problem" metaphor. Its warrant is /\blocksmith\b/ — ONE common noun.
//   "insists the boat was green, not blue..."      -> 10 live motivations, several
//      verbatim with a character name welded on, two dated AFTER the bait shipped.
//
// And the replacement candidates drafted by ear were WORSE, not better: "insists the
// parrot learned that whistle from the neighbour's kettle" is built from parrot (10
// live), whistle (9) and kettle (31). It read as off-planet and was born rotted.
//
// THE TWO TESTS ARE DIFFERENT, AND THAT IS THE WHOLE POINT.
//   echoesPhrases() asks: has this WHOLE SKELETON been echoed?  -> cleared all five.
//   the escape hatch asks: does the PROBE appear in source text? -> a single word.
// Clearing a candidate with the first test and shipping it against the second is how
// bait rots. This script runs the second one, per word, over the entire corpus.
//
// SINGLE-CHANNEL EXPOSURE (TC's ruling, and it is the reason the winners are written
// to a file rather than printed): bait may appear in the system prompt and NOWHERE
// else the pipeline can ingest. The boat leaked because it was DISCUSSED in a chat
// that this sidecar then chunked, analyzed and stored — which made its probe
// corroborable, which voided its own warrant. Discussing bait contaminates bait.
// So: --write emits to the fixture; stdout reports properties only, never text.

import { readdir, readFile, writeFile, stat } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { skeletonTokens, containsInOrder } = await import("../dist/sentiment/analyzer.js");
const { getDataDir } = await import("../dist/storage.js");

const MIN_SKELETON = 4;   // packet §5: the floor is 3; new bait aims >=4 for erosion margin
const PROBE_WORDS  = 2;   // a warrant voided by one common noun is not a warrant

/**
 * PER-WORD FREQUENCY CEILING (TC, 2026-08-06). Skeleton uniqueness and a clean probe
 * are both necessary and together still insufficient.
 *
 * Measured on the first candidate batch: all 14 passed the probe test on two
 * zero-occurrence nouns while carrying content words like dark (698 occurrences),
 * knew (737), came (1041) and down (3304). Two rare nouns were doing the entire job
 * of keeping the sentence off-planet; everything around them sat squarely inside the
 * store's ordinary vocabulary. That is the same brittleness as a one-word probe,
 * moved one level out — and it drags the whole sentence semantically NEAR the corpus,
 * which is what makes a sentence parrot-able in the first place.
 *
 * So: every skeleton token must be under the ceiling, except the speech-act
 * scaffolding, which has to stay ordinary or the bait stops teaching shape.
 */
const WORD_FREQ_CEILING = 25;

// The frame that carries "a person said/asked something definite". These are the
// SHAPE being taught, so they are exempt by design — an allowlist, small and
// explicit, rather than a silent carve-out for anything that scores badly.
//
// PUT THROUGH skeletonTokens RATHER THAN WRITTEN AS STEMS BY HAND. Writing "ask"
// here does not exempt "asks": the stemmer leaves words under 5 characters alone,
// so "asks" stays "asks" while "insists" becomes "insist" — the same verb stemming
// differently by length, exactly as the packet §5 warns. Hand-stemming this list
// silently scored "asks" as a content word with 532 occurrences and failed every
// question-shaped candidate for a reason that had nothing to do with the candidate.
const SCAFFOLD = new Set(
  skeletonTokens("insists insist asks ask whether ever still before after never again"),
);

// ── Corpus vocabulary: the anti-join target ──────────────────────────────────
// A SUPERSET on purpose. The hatch tests chunk SOURCE TEXT, so any word the store
// has ever held counts as corroborating vocabulary — not just words in motivations.
//
// COUNTED IN SKELETON SPACE, and this is not a detail. A candidate's tokens arrive
// stemmed ("dredged" -> "dredg", "crates" -> "crat"), so a vocabulary of RAW words
// would report 0 for every stemmed lookup that does not happen to be a whole word —
// scoring "dredged" as off-planet even in a store that says "dredge" constantly.
// A rarity test that silently reports zero for its own tokenisation mismatch is
// worse than no test, because it reports clean. Both sides use skeletonTokens().

async function buildVocab(root) {
  const counts = new Map();
  let files = 0;
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (!/\.(yaml|json|jsonl)$/.test(e.name)) continue;
      files++;
      const text = await readFile(p, "utf8").catch(() => "");
      for (const line of text.split("\n")) {
        // Embedding blobs are long runs of numerics; they carry no vocabulary.
        if (line.length > 400 && /[\d.,\-e]{200,}/.test(line)) continue;
        for (const w of skeletonTokens(line)) {
          counts.set(w, (counts.get(w) ?? 0) + 1);
        }
      }
    }
  }
  await walk(root);
  return { counts, files };
}

// ── Live motivations, for skeleton uniqueness ────────────────────────────────

async function liveSkeletons() {
  const { readAllBeats } = await import("../dist/sentiment/encoder.js");
  const out = [];
  for (const c of await readdir(join(getDataDir(), "characters")).catch(() => [])) {
    for (const b of await readAllBeats(c, { includeRetired: false }).catch(() => [])) {
      out.push(skeletonTokens(String(b.motivation ?? "")));
    }
  }
  return out;
}

// ── Scoring one candidate ────────────────────────────────────────────────────

/**
 * The two kinds of bait have DIFFERENT warrant models, so they get different rules.
 *
 * SPECIFIC bait teaches shape by being concrete, and its ledger entry carries a
 * `probe` so a genuine utterance can still be recorded (the escape hatch). That probe
 * is the attack surface: every word in it is a word the world might say. So specific
 * bait must be built from vocabulary the corpus has NEVER contained, and must not
 * already collide with a live motivation.
 *
 * VAGUE bait is the failure mode itself — "reveals her vulnerability and desire for
 * connection". It carries NO probe, so corroboration requires the whole phrase
 * verbatim in the source, which is effectively unreachable. Its warrant cannot rot
 * the way a one-word probe rots. And it is SUPPOSED to collide with live motivations:
 * those collisions are the boilerplate it exists to arrest (the shipped vague entries
 * match 15 and 22 live beats respectively). Judging it by the specific rules would
 * reject it for doing its job.
 */
export function scoreCandidate(text, vocab, live, mode = "specific") {
  const toks = skeletonTokens(text);
  const counts = toks.map((t) => ({ word: t, n: vocab.get(t) ?? 0 }));
  const clean = counts.filter((c) => c.n === 0);
  // The probe should rest on the rarest words available.
  const probe = mode === "vague" ? [] : [...counts].sort((a, b) => a.n - b.n).slice(0, PROBE_WORDS);
  const probeFloor = probe.length ? Math.max(...probe.map((p) => p.n)) : 0;
  const collides = live.filter((m) => containsInOrder(m, toks)).length;

  // Content = everything that is not speech-act scaffolding. This is what the
  // ceiling applies to.
  const content = counts.filter((c) => !SCAFFOLD.has(c.word));
  const overCeiling = content.filter((c) => c.n > WORD_FREQ_CEILING);
  const peak = content.length ? Math.max(...content.map((c) => c.n)) : 0;

  const reasons = [];
  if (toks.length < MIN_SKELETON) reasons.push(`skeleton ${toks.length} < ${MIN_SKELETON}`);
  if (mode !== "vague") {
    if (clean.length < PROBE_WORDS) reasons.push(`only ${clean.length} zero-occurrence word(s), need ${PROBE_WORDS}`);
    if (probeFloor > 0) reasons.push(`probe would rest on a word seen ${probeFloor}x`);
    if (collides > 0) reasons.push(`skeleton already matches ${collides} live motivation(s)`);
    if (overCeiling.length > 0) {
      reasons.push(`${overCeiling.length} content word(s) over the ${WORD_FREQ_CEILING} ceiling (peak ${peak})`);
    }
  }

  return {
    skeletonLen: toks.length,
    counts,
    cleanWords: clean.map((c) => c.word),
    probe: probe.map((p) => p.word),
    probeFloor,
    collides,
    peak,
    pass: reasons.length === 0,
    reasons,
  };
}

// ── Generation ───────────────────────────────────────────────────────────────
//
// HAND-AUTHORING BAIT IS THE LEAK. A person writing candidate sentences has to write
// them SOMEWHERE — a file, a message, a review comment — and every one of those is a
// channel. The first pool for this rotation was hand-written into a working
// transcript, which exposed all sixteen candidates before any of them shipped.
//
// So the tool composes instead. A LEXICON of individual words carries no bait: the
// bait is the combination, and the combination is minted here, verified against the
// corpus, and written straight to the fixture without passing through prose. That
// makes examples genuinely disposable — the answer to exposure is `--generate` again,
// not a policy about who may read what.
//
// The lexicon is deliberately drawn from trades and infrastructure with no purchase
// on this store's subject matter. Every word is still checked at scoring time, so a
// term that drifts in-domain later simply stops being selected.

const LEXICON = {
  agent: ["wheelwright", "farrier", "cordwainer", "tinsmith", "millwright", "fletcher",
          "sailmaker", "lockkeeper", "shunter", "fettler", "winnower", "cooper"],
  place: ["cooperage", "chandlery", "ropewalk", "tannery", "brickworks", "gasworks",
          "malthouse", "oasthouse", "colliery", "smelter", "limekiln", "creamery",
          "granary", "dovecote", "apiary", "byre", "haymow", "millpond"],
  object: ["axle", "sprocket", "ferrule", "grommet", "dowel", "bobbin", "spindle",
           "flange", "rivet", "gasket", "escapement", "mainspring", "fusee", "detent",
           "pinion", "selvedge", "skein", "quoin", "penstock", "culvert", "weir",
           "towpath", "spillway", "aqueduct", "turntable", "semaphore", "gantry"],
  verb: ["tarred", "caulked", "shimmed", "swaged", "reamed", "brazed", "chamfered",
         "splined", "scarfed", "winched", "hoisted", "carted", "stowed", "greased",
         "oiled", "soldered", "thatched", "limed", "whitewashed", "dredged", "puttied"],
};

const FRAMES = [
  ({ agent, verb, object, agent2 }) => `insists the ${agent} ${verb} the ${object}, not the ${agent2}`,
  ({ place, verb, object })         => `asks whether the ${place} ever ${verb} the ${object}`,
  ({ agent, verb, object, place })  => `insists the ${agent} ${verb} the ${object} before the ${place} was sold`,
  ({ place, object, agent })        => `asks whether the ${place} ever returned the ${agent} his ${object}`,
];

function generateCandidates(count, seedStr) {
  let seed = [...seedStr].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 11);
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const pickOne = (arr) => arr[Math.floor(rnd() * arr.length)];
  const out = new Set();
  let guard = 0;
  while (out.size < count && guard++ < count * 50) {
    const slots = {
      agent: pickOne(LEXICON.agent),
      agent2: pickOne(LEXICON.agent),
      place: pickOne(LEXICON.place),
      object: pickOne(LEXICON.object),
      verb: pickOne(LEXICON.verb),
    };
    if (slots.agent === slots.agent2) continue;
    out.add(pickOne(FRAMES)(slots));
  }
  return [...out];
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const quiet = !args.includes("--show");        // default: NEVER print candidate text
const writeTo = args.includes("--write") ? args[args.indexOf("--write") + 1] : null;
const fromFile = args.includes("--from") ? args[args.indexOf("--from") + 1] : null;

const genN = args.includes("--generate") ? Number(args[args.indexOf("--generate") + 1]) : 0;
const seedArg = args.includes("--seed") ? args[args.indexOf("--seed") + 1] : "default";

if (!fromFile && !genN) {
  console.error("usage: node scripts/bait-select.mjs (--generate <n> [--seed <s>] | --from <candidates.json>)");
  console.error("                                    [--pick specific:2,vague:2] [--write <fixture.json>] [--show]");
  console.error("  --generate mints candidates from the built-in lexicon, so no sentence is");
  console.error("             ever hand-written into a file, message or transcript.");
  console.error("  --from     scores a hand-written pool: { \"specific\": [...], \"vague\": [...] }");
  console.error("  Output NEVER prints candidate text unless --show is passed.");
  process.exit(2);
}

const { counts: vocab, files } = await buildVocab(getDataDir());
const live = await liveSkeletons();
console.log(`corpus: ${files} files, ${vocab.size} distinct words, ${live.length} live motivations\n`);

// Vague bait is genre-boilerplate by definition — it cannot be minted from a rare-word
// lexicon, because being made of the commonest phrasing IS the property. It stays
// hand-written, and that is safe: it carries no probe, so corroboration needs the
// literal sentence, which no rotation pressure applies to.
const VAGUE_POOL = [
  "conveys her emotional turmoil about the situation",
  "shows the depth of their emotional connection in this moment",
  "underscores the significance of what they are feeling here",
  "captures the emotional weight of their shared history",
];

const cands = genN
  ? { specific: generateCandidates(genN, seedArg), vague: VAGUE_POOL }
  : JSON.parse(await readFile(fromFile, "utf8"));
if (genN) console.log(`generated ${cands.specific.length} candidate(s) from the lexicon (seed "${seedArg}")\n`);
const results = {};

for (const [group, list] of Object.entries(cands)) {
  console.log(`── ${group} ──`);
  console.log("  #  skel  zero-words  probe-floor  peak-content  collides  verdict");
  results[group] = [];
  list.forEach((text, i) => {
    const s = scoreCandidate(text, vocab, live, group);
    console.log(
      `  ${String(i).padStart(2)}  ${String(s.skeletonLen).padStart(4)}  ${String(s.cleanWords.length).padStart(10)}  ${String(s.probeFloor).padStart(11)}  ${String(s.peak).padStart(12)}  ${String(s.collides).padStart(8)}  ${s.pass ? "PASS" : "fail: " + s.reasons.join("; ")}`,
    );
    if (!quiet) console.log(`      ${JSON.stringify(text)}`);
    if (s.pass) results[group].push({ text, probe: s.probe, skeletonLen: s.skeletonLen });
  });
  console.log(`  -> ${results[group].length}/${list.length} passed\n`);
}

/**
 * ROTATION IS THE REAL DEFENCE, not secrecy.
 *
 * Bait chosen by ear was expensive to author, so it was protected and reused until
 * it rotted. Bait chosen by anti-join costs seconds, which changes the economics
 * completely: any example that leaks into a readable channel can simply be replaced.
 * So the goal is not a candidate pool nobody has ever seen — it is a pipeline that
 * can mint a fresh, verified example on demand. --pick draws from the passing pool
 * and writes the fixture WITHOUT printing which ones it drew.
 */
const pick = args.includes("--pick") ? args[args.indexOf("--pick") + 1] : null;
if (pick) {
  // Seeded from the fixture path + pool size so a re-run is reproducible from the
  // repo, but the selection is not derivable from this script's stdout.
  const seedStr = (writeTo ?? "") + Object.values(results).map((r) => r.length).join(",");
  let seed = [...seedStr].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (const spec of pick.split(",")) {
    const [group, nStr] = spec.split(":");
    const want = Number(nStr);
    const pool = results[group] ?? [];
    const shuffled = [...pool].sort(() => rnd() - 0.5);
    // PREFER DISTINCT FRAMES. The examples teach SHAPE, so two of the same syntactic
    // frame ("asks whether X ever Y" twice) teach half as much as one assertion and
    // one question — and the first roll drew exactly that. Frame is keyed on the
    // leading skeleton token, which is the speech-act verb.
    const chosen = [];
    const frames = new Set();
    for (const pass of [1, 2]) {
      for (const c of shuffled) {
        if (chosen.length >= want || chosen.includes(c)) continue;
        const frame = skeletonTokens(c.text)[0] ?? "";
        if (pass === 1 && frames.has(frame)) continue;
        frames.add(frame);
        chosen.push(c);
      }
    }
    results[group] = chosen;
    console.log(`picked ${chosen.length}/${pool.length} from "${group}" across ${frames.size} frame(s)`);
  }
}

if (writeTo) {
  await writeFile(writeTo, JSON.stringify(results, null, 2) + "\n", "utf8");
  const total = Object.values(results).reduce((a, b) => a + b.length, 0);
  console.log(`\nWROTE ${total} entr(ies) to ${writeTo}`);
  console.log("Text intentionally NOT echoed to stdout — single-channel exposure.");
  for (const [g, rows] of Object.entries(results)) {
    for (const r of rows) console.log(`  ${g}: skeleton ${r.skeletonLen} tokens, probe rests on ${r.probe.length} zero-occurrence word(s)`);
  }
}
