import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
// DELIBERATE capture syntax — TC and Mari write these ON PURPOSE to save a memory.
// Refusing one would break the primary manual-capture path. NOT contamination.
const DELIBERATE = /\[(remember|bookmark)\s*:/i;
// The store describing ITSELF — ids it minted, tags it wrote, logs it printed.
// A human does not type "ctopic-8f3k2a1b" to mean something; it is a paste.
const MIRROR = [
  ["entry-id", /\b(ctopic|utopic|nthr|recap|otopic)-[a-z0-9]{6,}/i],
  ["about-tag", /\[about:\s*[^\]]*\]/],
  ["ME-log", /\[ME:[a-z-]+\]/i],
  ["beat-id", /\bbeat-[0-9a-f]{12}\b/],
  ["ticket-id", /\bMarinaraExtender-[a-z0-9]{3,4}\b/i],
];
let beats = 0;
const mirrorOnly = [], both = [], deliberateOnly = [];
const root = join(PKG, "data/characters");
for (const c of readdirSync(root)) {
  const bd = join(root, c, "beats");
  if (!existsSync(bd)) continue;
  for (const f of readdirSync(bd)) {
    if (!f.endsWith(".yaml")) continue;
    let d; try { d = YAML.parse(readFileSync(join(bd, f), "utf8")); } catch { continue; }
    beats++;
    const t = String(d?.text ?? "");
    const m = MIRROR.filter(([, re]) => re.test(t)).map(([n]) => n);
    const del = DELIBERATE.test(t);
    const row = { f, c, date: d.created, speaker: d.speaker, sigs: m, len: t.length, t };
    if (m.length && del) both.push(row);
    else if (m.length) mirrorOnly.push(row);
    else if (del) deliberateOnly.push(row);
  }
}
console.log(`beats: ${beats}\n`);
console.log(`  DELIBERATE capture syntax only ([remember:]/[bookmark:])  ${deliberateOnly.length}   <- a FEATURE, never refuse`);
console.log(`  MIRROR signals only (store's own ids/tags/logs)           ${mirrorOnly.length}`);
console.log(`  BOTH in the same beat                                      ${both.length}   <- the hard case`);
const tally = new Map();
for (const r of [...mirrorOnly, ...both]) for (const s of r.sigs) tally.set(s, (tally.get(s) ?? 0) + 1);
console.log("\n  mirror signals by kind:"); for (const [k, v] of [...tally].sort((a,b)=>b[1]-a[1])) console.log(`    ${String(v).padStart(4)}  ${k}`);
console.log("\n── MIRROR-ONLY SAMPLES (what a guard would refuse) ──");
for (const r of mirrorOnly.slice(0, 6)) console.log(`  [${r.sigs.join(",")}] ${r.speaker} ${r.date}\n     ${r.t.replace(/\s+/g," ").slice(0,145)}\n`);
console.log("── 'BOTH' SAMPLES (deliberate tag AND store output — must NOT be refused wholesale) ──");
for (const r of both.slice(0, 3)) console.log(`  [${r.sigs.join(",")}] ${r.speaker}\n     ${r.t.replace(/\s+/g," ").slice(0,145)}\n`);
