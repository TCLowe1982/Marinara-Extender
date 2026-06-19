// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Drain the live FR1 reconciliation queue (MarinaraExtender-b4n).
//
// During play, the sidecar enqueues durable-fact collisions (a new fact the
// structural dedup dropped as a duplicate) when MARINARA_EXTENDER_RECONCILE=1.
// This drains that queue through the curator, OUT-OF-BAND from the sidecar.
//
//   node scripts/reconcile-queue.mjs                 # SHADOW: curate + log proposed verdicts, apply nothing
//   node scripts/reconcile-queue.mjs --limit 10      # only the first N queued
//   node scripts/reconcile-queue.mjs --apply         # execute verdicts (once you trust the shadow log)
//
// Shadow is the default rollout gate: review data/reconcile-queue/audit.jsonl to
// see what the curator WOULD do before letting it touch live memory. Needs the
// built dist + a logged-in `claude` CLI session (the curator's auth).

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PKG = process.cwd();
const APPLY = process.argv.includes("--apply");
const limitIdx = process.argv.indexOf("--limit");
const LIMIT = limitIdx !== -1 ? Math.max(1, parseInt(process.argv[limitIdx + 1], 10) || 0) : undefined;

// Load .env (harmless; the curator authenticates via the CLI session, but this
// keeps the env consistent with the other scripts).
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
const { drainReconcileQueue, loginHint } = await imp("reconcile.js");
const { readQueue, auditFilePath } = await imp("reconcile-queue.js");

const pending = await readQueue();
if (pending.length === 0) {
  console.log("Queue is empty — nothing to reconcile. (Is MARINARA_EXTENDER_RECONCILE=1 set on the sidecar?)");
  process.exit(0);
}

console.log(`${APPLY ? "APPLY" : "SHADOW (curate + log, apply nothing)"} — ${LIMIT ? `up to ${LIMIT} of ` : ""}${pending.length} queued collision(s)`);
console.log(`curator: Claude Agent SDK (CLI-session auth) · audit -> ${auditFilePath()}\n`);

let res;
try {
  res = await drainReconcileQueue({ apply: APPLY, limit: LIMIT });
} catch (e) {
  console.error(`\nDrain failed: ${e?.message ?? e}\n${loginHint?.() ?? ""}`);
  process.exit(1);
}

console.log(`\nprocessed ${res.processed} · curator decided ${res.decided}${APPLY ? ` · applied ${res.applied}` : " · (shadow: applied 0)"}`);
console.log(APPLY
  ? "verdicts executed; superseded entries are recoverable from cold storage."
  : "review the proposed verdicts in audit.jsonl, then re-run with --apply when you trust them.");
