// Calibrate MIRROR_COVERAGE on the live store. Per the house law: rank your
// KNOWN POSITIVES first — a detector that cannot rank its own examples is
// measuring something else.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const { detectMirror } = await import(pathToFileURL(join(PKG, "dist/sentiment/mirror.js")).href);

const rows = [];
const root = join(PKG, "data/characters");
for (const c of readdirSync(root)) {
  const bd = join(root, c, "beats");
  if (!existsSync(bd)) continue;
  for (const f of readdirSync(bd)) {
    if (!f.endsWith(".yaml")) continue;
    let d; try { d = YAML.parse(readFileSync(join(bd, f), "utf8")); } catch { continue; }
    const t = String(d?.text ?? "");
    const hit = detectMirror(t);
    if (hit) rows.push({ f, t, hit, speaker: d.speaker, date: d.created });
  }
}
rows.sort((a, b) => b.hit.coverage - a.hit.coverage);
console.log(`chunks with ANY mirror line: ${rows.length}\n`);

console.log("COVERAGE DISTRIBUTION");
const buckets = [[0.9,1.01],[0.7,0.9],[0.5,0.7],[0.4,0.5],[0.3,0.4],[0.2,0.3],[0.1,0.2],[0,0.1]];
for (const [lo,hi] of buckets) {
  const n = rows.filter(r => r.hit.coverage >= lo && r.hit.coverage < hi).length;
  console.log(`  ${lo.toFixed(2)}–${hi >= 1 ? "1.00" : hi.toFixed(2)}  ${String(n).padStart(4)}  ${"█".repeat(Math.min(50, n))}`);
}
for (const thr of [0.3, 0.4, 0.5, 0.6]) {
  console.log(`\n  @${thr}: would REFUSE ${rows.filter(r => r.hit.coverage >= thr).length}, keep ${rows.filter(r => r.hit.coverage < thr).length}`);
}
console.log("\n── TOP 5 BY COVERAGE (should be pure paste) ──");
for (const r of rows.slice(0, 5)) console.log(`  cov=${r.hit.coverage.toFixed(2)} [${r.hit.signals}] ${r.speaker}\n     ${r.t.replace(/\s+/g," ").slice(0,120)}\n`);
console.log("── JUST BELOW 0.4 (must be real conversation) ──");
for (const r of rows.filter(r=>r.hit.coverage<0.4).slice(0,5)) console.log(`  cov=${r.hit.coverage.toFixed(2)} [${r.hit.signals}] ${r.speaker}\n     ${r.t.replace(/\s+/g," ").slice(0,120)}\n`);
