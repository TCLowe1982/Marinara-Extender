// READ-ONLY (cye6 slice 1). What would admitting SECOND PERSON actually add?
//
// The house rule is measure before you wire. Admitting these is a large increase
// in candidate volume and every downstream precision figure was measured without
// them, so this reports the delta and its ATTRIBUTION — it feeds nothing to a
// model and writes nothing.
//
// Direction is the whole point: "you're from Independence" said BY a character is
// about the USER; said BY the user it is about the CHARACTER.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const { extractCandidates, secondPersonSubject, isSecondPerson } =
  await import(pathToFileURL(join(PKG, "dist/ambient.js")).href);

const root = join(PKG, "data/characters");
let beats = 0, baseline = 0, widened = 0;
const added = { user: [], character: [] };
const bySpeaker = new Map();

for (const c of readdirSync(root)) {
  const bd = join(root, c, "beats");
  if (!existsSync(bd)) continue;
  for (const f of readdirSync(bd)) {
    if (!f.endsWith(".yaml") || f === "index.yaml") continue;
    let b; try { b = YAML.parse(readFileSync(join(bd, f), "utf8")); } catch { continue; }
    if (b.retiredAt) continue;
    beats++;
    const text = String(b.text ?? "");
    // A beat has ONE speaker, which is exactly the signal the live path has as
    // userText vs characterText.
    const speaker = String(b.speaker ?? "") === "user" ? "user" : "character";
    const before = extractCandidates(text);
    const after = extractCandidates(text, { admitSecondPerson: true });
    baseline += before.length; widened += after.length;
    const seen = new Set(before);
    for (const s of after) {
      if (seen.has(s)) continue;
      const subject = secondPersonSubject(speaker);
      bySpeaker.set(speaker, (bySpeaker.get(speaker) ?? 0) + 1);
      if (added[subject].length < 400) added[subject].push({ s, speaker, sp: isSecondPerson(s) });
    }
  }
}
const total = [...bySpeaker.values()].reduce((a, b) => a + b, 0);
console.log(`live beats scanned            ${beats}`);
console.log(`candidates today (baseline)   ${baseline}`);
console.log(`candidates if widened         ${widened}`);
console.log(`NEW candidates admitted       ${total}   (+${(total / Math.max(1, baseline) * 100).toFixed(1)}% volume)`);
console.log();
console.log("ATTRIBUTION — who each new candidate is ABOUT, from who said it:");
for (const [sp, n] of [...bySpeaker].sort((a, b) => b[1] - a[1])) {
  console.log(`  spoken by ${sp.padEnd(10)} ${String(n).padStart(6)}  -> about the ${secondPersonSubject(sp)}`);
}
console.log();
console.log("SAMPLE — new candidates ABOUT THE USER (character speaking):");
for (const r of added.user.slice(0, 8)) console.log(`   ${r.s.slice(0, 110)}`);
console.log();
console.log("SAMPLE — new candidates ABOUT THE CHARACTER (user speaking):");
for (const r of added.character.slice(0, 8)) console.log(`   ${r.s.slice(0, 110)}`);
