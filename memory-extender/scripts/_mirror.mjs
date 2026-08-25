// READ-ONLY: how much of the beat store is the store's OWN OUTPUT, pasted back
// into chat and ingested as dialogue? Measure before guarding.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIGNALS = [
  ["entry-id",      /\b(ctopic|utopic|nthr|recap|otopic)-[a-z0-9]{6,}/i],
  ["about-tag",     /\[about:\s*[^\]]*\]/],
  ["remember-tag",  /\[remember:\s*lane\s*=/i],
  ["bookmark-tag",  /\[bookmark:\s*topic\s*=/i],
  ["lane-literal",  /\b(user_topics|character_topics|open_threads)\b/],
  ["ME-log",        /\[ME:[a-z-]+\]/i],
  ["beat-id",       /\bbeat-[0-9a-f]{12}\b/],
  ["ticket-id",     /\bMarinaraExtender-[a-z0-9]{3,4}\b/i],
];
let beats = 0;
const hits = new Map(SIGNALS.map(([n]) => [n, []]));
const anyHit = new Set();
const root = join(PKG, "data/characters");
for (const c of readdirSync(root)) {
  const bd = join(root, c, "beats");
  if (!existsSync(bd)) continue;
  for (const f of readdirSync(bd)) {
    if (!f.endsWith(".yaml")) continue;
    let d; try { d = YAML.parse(readFileSync(join(bd, f), "utf8")); } catch { continue; }
    beats++;
    const t = String(d?.text ?? "");
    for (const [name, re] of SIGNALS) {
      if (re.test(t)) { hits.get(name).push({ f, c, date: d.created, speaker: d.speaker, len: t.length }); anyHit.add(f); }
    }
  }
}
console.log(`beats scanned: ${beats}\n`);
console.log("SIGNAL                 beats");
for (const [n, rows] of SIGNALS.map(([n]) => [n, hits.get(n)])) console.log(`  ${n.padEnd(20)} ${String(rows.length).padStart(5)}`);
console.log(`  ${"── ANY signal".padEnd(20)} ${String(anyHit.size).padStart(5)}   (${(anyHit.size / beats * 100).toFixed(1)}% of the store)`);

// Who is pasting, and when
const all = [...new Set([...hits.values()].flat().map((r) => JSON.stringify([r.f, r.c, r.date, r.speaker])))].map((s) => JSON.parse(s));
const bySpeaker = new Map(), byDate = new Map();
for (const [, , date, sp] of all) {
  bySpeaker.set(sp, (bySpeaker.get(sp) ?? 0) + 1);
  byDate.set(String(date).slice(0, 7), (byDate.get(String(date).slice(0, 7)) ?? 0) + 1);
}
console.log("\nby speaker:"); for (const [k, v] of [...bySpeaker].sort((a,b)=>b[1]-a[1]).slice(0,8)) console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log("\nby month:");   for (const [k, v] of [...byDate].sort()) console.log(`  ${String(v).padStart(4)}  ${k}`);
