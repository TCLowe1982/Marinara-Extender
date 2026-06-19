// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Read the reconciliation audit logs as tallies, not soup (MarinaraExtender-mjp).
//
//   node scripts/reconcile-audit.mjs            # summary of live + sweep audits + held lane
//   node scripts/reconcile-audit.mjs --held     # also list the held items awaiting review
//
// Read-only. Points at the live data dir (data/reconcile-queue/*).

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SHOW_HELD = process.argv.includes("--held");
const imp = (p) => import(pathToFileURL(join(process.cwd(), "dist", p)).href);
const { auditFilePath, sweepAuditFilePath, heldFilePath } = await imp("reconcile-queue.js");

const read = (p) => (existsSync(p)
  ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : []);
const tally = (rows, key) => rows.reduce((m, r) => { const k = (typeof key === "function" ? key(r) : r[key]) ?? "—"; m[k] = (m[k] || 0) + 1; return m; }, {});
const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ") || "(none)";

const live = read(auditFilePath());
const sweep = read(sweepAuditFilePath());
const held = read(heldFilePath());

console.log("=== LIVE reconciliation audit (b4n) ===");
console.log(`records: ${live.length}`);
if (live.length) {
  console.log(`  mode:       ${fmt(tally(live, "mode"))}`);
  console.log(`  verdict:    ${fmt(tally(live, (r) => r.verdict))}`);
  console.log(`  confidence: ${fmt(tally(live, "confidence"))}`);
}

console.log("\n=== SWEEP audit (0kk) ===");
console.log(`records: ${sweep.length}`);
if (sweep.length) {
  console.log(`  mode:       ${fmt(tally(sweep, "mode"))}`);
  console.log(`  verdict:    ${fmt(tally(sweep, (r) => r.verdict))}`);
  console.log(`  confidence: ${fmt(tally(sweep, "confidence"))}`);
  const applied = sweep.filter((r) => r.mode === "apply" && (r.applied?.supersededIds?.length ?? 0) > 0).length;
  console.log(`  applied merges (superseded >0): ${applied}`);
}

console.log("\n=== HELD review lane (mjp) ===");
console.log(`held items awaiting review: ${held.length}`);
if (held.length) {
  console.log(`  source:  ${fmt(tally(held, "source"))}`);
  console.log(`  reasons: ${fmt(tally(held, (r) => (r.reasons ?? []).join("+")))}`);
  if (SHOW_HELD) {
    console.log("");
    for (const h of held) console.log(`  [${(h.reasons ?? []).join(", ")}] ${h.summary}`);
  } else {
    console.log("  (run with --held to list them)");
  }
}
