// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Backfill durable facts from existing scenes (MarinaraExtender-1dn).
//
// Slice 1 (facts.ts) captures durable identity/lore facts on NEW imports — the
// ones that fall below the beat salience threshold. This recovers them from the
// scenes you already have: it replays each concluded scene's full transcript
// through the same fact pass, so a low-emotion fact ("Mari is a Pact of the Tome
// Warlock") that was dropped at import time gets captured now — by the system,
// not by hand.
//
// Reads the live Marinara Engine tables (read-only) the same way
// repair-recap-pairing.mjs does. Dry-run by default.
//
//   node scripts/backfill-scene-facts.mjs                         # audit ALL concluded scenes (dry run)
//   node scripts/backfill-scene-facts.mjs --scene <chatId>        # one scene (dry run)
//   node scripts/backfill-scene-facts.mjs --scene <chatId> --apply
//   node scripts/backfill-scene-facts.mjs --apply                 # write across all concluded scenes
//
// Run from the memory-extender/ directory (needs the built dist + Ollama up).

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const PKG = process.cwd(); // memory-extender
const DIST = join(PKG, "dist");
const TABLES = process.env.MARINARA_ENGINE_TABLES
  ?? join(process.env.LOCALAPPDATA ?? "", "MarinaraEngine", "packages", "server", "data", "storage", "tables");

const APPLY = process.argv.includes("--apply");
const sceneArgIdx = process.argv.indexOf("--scene");
const ONLY_SCENE = sceneArgIdx !== -1 ? process.argv[sceneArgIdx + 1] : null;
const passesArgIdx = process.argv.indexOf("--passes");
const PASSES = passesArgIdx !== -1 ? Math.max(1, Math.min(5, parseInt(process.argv[passesArgIdx + 1], 10) || 1)) : undefined;
// --judge-passes N: multi-pass durability-judge consensus (8jw). Set into the env
// the judge reads at call time; default 1 (single pass) leaves the path unchanged.
const judgePassesArgIdx = process.argv.indexOf("--judge-passes");
if (judgePassesArgIdx !== -1) process.env.MARINARA_EXTENDER_JUDGE_PASSES = String(process.argv[judgePassesArgIdx + 1] ?? "1");

// Load .env so the API key / upstream / model are available in this separate
// process — the sidecar does this at startup; the script is not the sidecar, so
// without it the external (strong) model path silently can't authenticate.
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
const { ingestSceneFacts, saveFact } = await imp("facts.js");
const { chunkMessages } = await imp("sentiment/chunker.js");
const { buildSubjectRoster } = await imp("identity.js");
const { getDataDir } = await imp("storage.js");
const { factsPreferExternal } = await imp("ambient.js");
const { externalModel, localModel } = await imp("llm-config.js");
console.log(`facts model: ${factsPreferExternal() ? `external (${externalModel()})` : `local (${localModel()})`}`);

// READ-ONLY identity resolution. resolveIdentity() would CREATE map entries and
// migrate data dirs for unknown IDs — unacceptable in a dry run — so we read the
// extender's identity-map.yaml directly and only act on IDs already mapped.
const idMapPath = join(getDataDir(), "identity-map.yaml");
const identityByCharId = new Map();
if (existsSync(idMapPath)) {
  for (const e of (parseYaml(readFileSync(idMapPath, "utf8")).entries ?? [])) {
    identityByCharId.set(String(e.characterId), { key: e.identityKey, name: e.name });
  }
}
const cleanName = (n, fallback) => (n && !/^_+|_+$/.test(n) ? n : fallback);

if (!existsSync(TABLES)) {
  console.error(`Engine tables not found at ${TABLES}. Set MARINARA_ENGINE_TABLES.`);
  process.exit(1);
}

function loadTable(name) {
  const j = JSON.parse(readFileSync(join(TABLES, name), "utf8"));
  return Array.isArray(j) ? j : (j.rows ?? Object.values(j));
}

const chats = loadTable("chats.json");
const messages = loadTable("messages.json");
const characters = loadTable("characters.json");

const meta = (c) => {
  const m = c?.metadata;
  if (typeof m === "string") { try { return JSON.parse(m); } catch { return {}; } }
  return m ?? {};
};
const nameOf = new Map(characters.map((c) => [String(c.id), c.name ?? c.title ?? String(c.id)]));

const msgsByChat = new Map();
for (const m of messages) {
  if (!msgsByChat.has(m.chatId)) msgsByChat.set(m.chatId, []);
  msgsByChat.get(m.chatId).push(m);
}

// Target set: one scene, or every concluded scene.
let scenes;
if (ONLY_SCENE) {
  const c = chats.find((x) => String(x.id) === ONLY_SCENE);
  if (!c) { console.error(`Scene ${ONLY_SCENE} not found.`); process.exit(1); }
  scenes = [c];
} else {
  scenes = chats.filter((c) => meta(c).sceneStatus === "concluded");
}
// The LEDGER (MarinaraExtender-1dn / Ledger Pattern): dry-run EXTRACTS + JUDGES
// and persists the durable facts to a per-scene file. --apply writes THAT file —
// it never re-extracts. LLM extraction is nondeterministic, so re-extracting on
// apply produced a different (noisier) set than the human reviewed; persisting
// the intermediate makes apply == the previewed result, and makes it resumable.
const LEDGER_DIR = join(getDataDir(), "fact-ledger");
const ledgerPath = (sceneId) => join(LEDGER_DIR, `${sceneId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

console.log(`${APPLY ? "APPLY (from ledger)" : "DRY RUN (builds ledger)"} — ${scenes.length} scene(s)\n`);

let totalFacts = 0;
let totalSaved = 0;

for (const scene of scenes) {
  const sceneId = String(scene.id);

  if (APPLY) {
    // Write exactly what the dry-run reviewed — read the ledger, never re-extract.
    const lp = ledgerPath(sceneId);
    if (!existsSync(lp)) {
      console.log(`(skip) ${scene.name ?? sceneId} — no ledger; run the dry-run first to build it.`);
      continue;
    }
    const ledger = JSON.parse(readFileSync(lp, "utf8"));
    const ctx = { identityKey: ledger.primaryKey, fallbackChatId: sceneId, characterName: ledger.primaryName };
    let written = 0;
    for (const fact of ledger.facts ?? []) {
      const entry = await saveFact(fact, ctx, sceneId);
      if (entry) written++;
    }
    totalFacts += (ledger.facts ?? []).length;
    totalSaved += written;
    console.log(`=== ${ledger.sceneName ?? sceneId} — ${(ledger.facts ?? []).length} from ledger, ${written} written ===`);
    continue;
  }

  // DRY RUN — extract, judge, persist the durable set to the ledger.
  const raw = (msgsByChat.get(sceneId) ?? [])
    .map((m) => ({ role: m.role ?? "assistant", content: typeof m.content === "string" ? m.content : "" }))
    .filter((m) => m.content.trim());
  if (raw.length === 0) continue;

  // Participants: scenes don't carry characterIds in metadata, but every message
  // is tagged with its characterId and the scene records its initiator. Resolve
  // those against the extender's identity map (read-only).
  const m = meta(scene);
  const msgCharIds = [...new Set((msgsByChat.get(sceneId) ?? []).map((x) => x.characterId).filter(Boolean).map(String))];
  const candidateIds = [...new Set([...msgCharIds, m.sceneInitiatorCharId, scene.characterId].filter(Boolean).map(String))];
  const participants = candidateIds.map((id) => identityByCharId.get(id)).filter(Boolean);
  if (participants.length === 0) {
    console.log(`(skip) ${scene.name ?? sceneId} — no mapped participants (ids: ${candidateIds.join(", ") || "none"})`);
    continue;
  }
  const primaryKey = participants[0].key;
  const primaryName = cleanName(participants[0].name, primaryKey);

  const chunks = await chunkMessages(raw.map((r) => ({ role: r.role, content: r.content })), primaryName);
  const roster = await buildSubjectRoster(primaryName);

  const res = await ingestSceneFacts({
    characterId: primaryKey, characterName: primaryName, chunks, roster, sourceChatId: sceneId,
    ...(PASSES ? { passes: PASSES } : {}), dryRun: true,
  });

  if (res.durable.length > 0) {
    mkdirSync(LEDGER_DIR, { recursive: true });
    writeFileSync(ledgerPath(sceneId), JSON.stringify({
      sceneId, sceneName: scene.name ?? sceneId, primaryKey, primaryName,
      builtAt: new Date().toISOString(), facts: res.durable,
    }, null, 2));
    totalFacts += res.durable.length;
    console.log(`=== ${scene.name ?? sceneId} (${sceneId}) — ${res.durable.length} durable fact(s) [ledger written] ===`);
    console.log(`    participants: ${participants.map((p) => cleanName(p.name, p.key)).join(", ")}`);
    for (const p of res.planned) {
      console.log(`    [${p.lane} · ${p.scope}:${p.scopeId}${p.subject ? ` · about:${p.subject}` : ""}] ${p.summary}`);
    }
    console.log();
  }
}

if (APPLY) {
  console.log(`\napplied: ${totalSaved} written from ledgers (${totalFacts} in ledgers; the rest deduped).`);
} else {
  console.log(`\nledger built: ${totalFacts} durable fact(s) across ${scenes.length} scene(s).`);
  if (totalFacts > 0) console.log("review the list above, then re-run with --apply to write EXACTLY these (no re-extraction).");
}
