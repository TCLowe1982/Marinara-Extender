// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Ledger hygiene sweep (MarinaraExtender-0kk). Clusters a ledger's existing FACT
// entries by similarity and lets the curator retire intra-ledger duplicates that
// the live path (b4n) never sees because both sides were already stored.
//
//   node scripts/reconcile-sweep.mjs --scopeId professor_mari                 # SHADOW (log proposed merges, apply nothing)
//   node scripts/reconcile-sweep.mjs --scopeId professor_mari --limit 5       # only the first N clusters
//   node scripts/reconcile-sweep.mjs --scopeId professor_mari --threshold 0.6 # tighter clustering
//   node scripts/reconcile-sweep.mjs --scopeId professor_mari --apply         # execute the supersessions
//
// --scope defaults to "character". Shadow is the rollout gate: review
// data/reconcile-queue/sweep-audit.jsonl before --apply. Needs the built dist +
// a logged-in `claude` CLI session. Superseded entries are recoverable (cold).

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PKG = process.cwd();
const arg = (name, def) => { const i = process.argv.indexOf(name); return i !== -1 ? process.argv[i + 1] : def; };
const APPLY = process.argv.includes("--apply");
const SCOPE = arg("--scope", "character");
const SCOPE_ID = arg("--scopeId", null);
const THRESHOLD = arg("--threshold", null);
const LIMIT = arg("--limit", null);

if (!SCOPE_ID) { console.error("Required: --scopeId <id> (e.g. professor_mari). Optional: --scope, --threshold, --limit, --apply."); process.exit(1); }

const envPath = join(PKG, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !(k in process.env)) process.env[k] = v;
  }
}

const imp = (p) => import(pathToFileURL(join(PKG, "dist", p)).href);
const { buildSweepLedger, applySweepLedger } = await imp("sweep.js");
const { sweepAuditFilePath } = await imp("reconcile-queue.js");
const { loginHint } = await imp("reconcile.js");

if (APPLY) {
  // Replay the reviewed ledger verbatim — no curator re-run (preview == apply).
  console.log(`APPLY (replay reviewed merges) — sweep ${SCOPE}:${SCOPE_ID}\n`);
  const res = await applySweepLedger(SCOPE, SCOPE_ID);
  if (!res) { console.error("No sweep ledger — run the shadow build first (without --apply) to produce it."); process.exit(1); }
  console.log(`applied ${res.merges} merge(s): superseded ${res.superseded} redundant entr(ies) (recoverable from cold).`);
  process.exit(0);
}

// SHADOW build: curate clusters, write the reviewable ledger + audit, mutate nothing.
console.log(`SHADOW (build reviewable ledger, apply nothing) — sweep ${SCOPE}:${SCOPE_ID}`);
console.log(`curator: Claude Agent SDK (CLI-session auth) · audit -> ${sweepAuditFilePath()}\n`);
let res;
try {
  res = await buildSweepLedger(SCOPE, SCOPE_ID, {
    ...(THRESHOLD ? { threshold: Number(THRESHOLD) } : {}),
    ...(LIMIT ? { limit: Math.max(1, parseInt(LIMIT, 10) || 0) } : {}),
  });
} catch (e) {
  console.error(`\nSweep failed: ${e?.message ?? e}\n${loginHint?.() ?? ""}`);
  process.exit(1);
}
console.log(`clusters: ${res.clusters} adjudicated (${res.oversizedSkipped} oversized skipped) · proposed merges: ${res.merges}`);
console.log("review the proposed merges in sweep-audit.jsonl (and the sweep-ledger), then re-run with --apply to execute EXACTLY those.");
