// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Agentic fact reconciliation (MarinaraExtender-5ny / FR3 of 2r3).
//
// backfill-scene-facts.mjs builds a per-scene fact-ledger of DURABLE candidate
// facts. Applying that ledger blindly (its own --apply) just saves each fact and
// lets dedup collapse exact repeats — it does NOT reconcile a candidate against
// what's already stored (UPDATE / NEGATE / EXPAND / DISTINCT). This script does:
// it runs the curator agent (Claude Agent SDK, on your logged-in Claude CLI
// session) over each candidate, records the verdict to a reconcile-ledger, and
// --apply replays EXACTLY those verdicts.
//
// Pipeline:
//   node scripts/backfill-scene-facts.mjs --scene <id>          # build fact-ledger
//   node scripts/reconcile-facts.mjs --scene <id>               # curator -> reconcile-ledger (dry)
//   node scripts/reconcile-facts.mjs --scene <id> --apply       # replay verdicts (writes)
//   node scripts/reconcile-facts.mjs                            # every scene that has a fact-ledger (dry)
//
// Ledger discipline (same reason as backfill): an agent loop is even less
// deterministic than single-pass extraction, so the dry-run PERSISTS the
// curator's verdicts and --apply never re-runs the agent — preview == apply.
//
// Run from memory-extender/ (needs the built dist + a logged-in `claude` CLI).

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PKG = process.cwd();
const DIST = join(PKG, "dist");

const APPLY = process.argv.includes("--apply");
const sceneArgIdx = process.argv.indexOf("--scene");
const ONLY_SCENE = sceneArgIdx !== -1 ? process.argv[sceneArgIdx + 1] : null;

// Load .env so the Agent SDK inherits the same environment the sidecar would
// (and any ANTHROPIC_API_KEY override). Without a key it falls back to the
// logged-in CLI session, which is the intended path.
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

const imp = (p) => import(pathToFileURL(join(DIST, p)).href);
const { runCurator, applyDecision, loginHint } = await imp("reconcile.js");
const { getDataDir } = await imp("storage.js");

const FACT_LEDGER_DIR = join(getDataDir(), "fact-ledger");
const RECON_LEDGER_DIR = join(getDataDir(), "reconcile-ledger");
const reconPath = (sceneId) => join(RECON_LEDGER_DIR, `${sceneId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
const factPath = (sceneId) => join(FACT_LEDGER_DIR, `${sceneId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

if (!existsSync(FACT_LEDGER_DIR) && !APPLY) {
  console.error(`No fact-ledger directory at ${FACT_LEDGER_DIR}. Run backfill-scene-facts.mjs (dry run) first to build candidates.`);
  process.exit(1);
}

// Target set: one scene, or every scene that has a (fact- or reconcile-) ledger.
let sceneIds;
if (ONLY_SCENE) {
  sceneIds = [ONLY_SCENE.replace(/[^A-Za-z0-9_-]/g, "_")];
} else {
  const dir = APPLY ? RECON_LEDGER_DIR : FACT_LEDGER_DIR;
  sceneIds = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))
    : [];
}
if (sceneIds.length === 0) {
  console.error(`No ${APPLY ? "reconcile" : "fact"}-ledgers found. Nothing to do.`);
  process.exit(1);
}

console.log(`${APPLY ? "APPLY (replay verdicts)" : "DRY RUN (curator -> reconcile-ledger)"} — ${sceneIds.length} scene(s)`);
if (!APPLY) console.log(`curator model: ${process.env.MARINARA_EXTENDER_RECONCILE_MODEL?.trim() || "opus"} (Claude Agent SDK, CLI-session auth)\n`);

const VERDICT_NOTE = {
  CREATE: "new", UPDATE: "supersedes", NEGATE: "disproves", EXPAND: "keep both (complementary)",
  DISTINCT: "keep both (look-alike)", DUPLICATE: "drop (already stored)",
};

let totalDecided = 0;
let totalCreated = 0;
let totalSuperseded = 0;
let probedLogin = false;

for (const sceneId of sceneIds) {
  if (APPLY) {
    const rp = reconPath(sceneId);
    if (!existsSync(rp)) { console.log(`(skip) ${sceneId} — no reconcile-ledger; run the dry-run first.`); continue; }
    const led = JSON.parse(readFileSync(rp, "utf8"));
    const ctx = { identityKey: led.primaryKey, fallbackChatId: led.sceneId, characterName: led.primaryName };
    let created = 0, superseded = 0;
    for (const item of led.items ?? []) {
      const r = await applyDecision(item, ctx, led.sceneId);
      if (r.createdId) created++;
      if (r.supersededId) superseded++;
    }
    totalCreated += created; totalSuperseded += superseded;
    console.log(`=== ${led.sceneName ?? sceneId} — ${(led.items ?? []).length} verdict(s): +${created} created, ${superseded} superseded ===`);
    continue;
  }

  // DRY RUN — load the backfill fact-ledger, run the curator per candidate.
  const fp = factPath(sceneId);
  if (!existsSync(fp)) { console.log(`(skip) ${sceneId} — no fact-ledger.`); continue; }
  const fl = JSON.parse(readFileSync(fp, "utf8"));
  const facts = fl.facts ?? [];
  if (facts.length === 0) continue;
  const ctx = { identityKey: fl.primaryKey, fallbackChatId: fl.sceneId ?? sceneId, characterName: fl.primaryName };

  const items = [];
  for (const candidate of facts) {
    let decision;
    try {
      decision = await runCurator(candidate, ctx);
    } catch (e) {
      if (!probedLogin) { console.error(`\nCurator could not run: ${e?.message ?? e}\n${loginHint()}`); probedLogin = true; }
      decision = null;
    }
    if (!decision) continue;
    items.push({ candidate, decision });
    console.log(`    [${decision.verdict} · ${VERDICT_NOTE[decision.verdict]}]${decision.targetId ? ` (#${decision.targetId})` : ""} ${candidate.fact}`);
    if (decision.rationale) console.log(`        ↳ ${decision.rationale}`);
  }

  if (items.length > 0) {
    mkdirSync(RECON_LEDGER_DIR, { recursive: true });
    writeFileSync(reconPath(sceneId), JSON.stringify({
      sceneId: fl.sceneId ?? sceneId, sceneName: fl.sceneName ?? sceneId,
      primaryKey: fl.primaryKey, primaryName: fl.primaryName,
      builtAt: new Date().toISOString(), items,
    }, null, 2));
    totalDecided += items.length;
    console.log(`=== ${fl.sceneName ?? sceneId} — ${items.length} verdict(s) [reconcile-ledger written] ===\n`);
  }
}

if (APPLY) {
  console.log(`\napplied: +${totalCreated} created, ${totalSuperseded} superseded across ${sceneIds.length} scene(s).`);
} else {
  console.log(`\nreconcile-ledger built: ${totalDecided} verdict(s).`);
  if (totalDecided > 0) console.log("review the verdicts above, then re-run with --apply to execute EXACTLY these (no re-run of the curator).");
}
