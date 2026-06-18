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

import { readFileSync, existsSync } from "node:fs";
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
const { ingestSceneFacts } = await imp("facts.js");
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
console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${scenes.length} scene(s)\n`);

let totalPlanned = 0;
let totalSaved = 0;

for (const scene of scenes) {
  const sceneId = String(scene.id);
  const raw = (msgsByChat.get(sceneId) ?? [])
    .map((m) => ({
      role: m.role ?? "assistant",
      content: typeof m.content === "string" ? m.content : "",
      createdAt: m.createdAt ?? "",
    }))
    .filter((m) => m.content.trim());
  if (raw.length === 0) continue;

  // Participants: scenes don't carry characterIds in metadata, but every
  // message is tagged with its characterId and the scene records its initiator.
  // Resolve those against the extender's identity map (read-only).
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
  const participantNames = participants.map((p) => cleanName(p.name, p.key));

  const digestMsgs = raw.map((r) => ({ role: r.role, content: r.content }));
  const chunks = await chunkMessages(digestMsgs, primaryName);
  // Rich roster (cast + aliases) so subjects resolve to the right ledgers.
  const roster = await buildSubjectRoster(primaryName);

  const res = await ingestSceneFacts({
    characterId: primaryKey,
    characterName: primaryName,
    chunks,
    roster,
    sourceChatId: sceneId,
    dryRun: !APPLY,
  });

  if (res.planned.length > 0) {
    totalPlanned += res.planned.length;
    totalSaved += res.saved;
    console.log(`=== ${scene.name ?? sceneId} (${sceneId}) — ${res.planned.length} fact(s)${APPLY ? `, ${res.saved} written` : ""} ===`);
    console.log(`    participants: ${participantNames.join(", ") || "(none)"}`);
    for (const p of res.planned) {
      console.log(`    [${p.lane} · ${p.scope}:${p.scopeId}${p.subject ? ` · about:${p.subject}` : ""}] ${p.summary}`);
    }
    console.log();
  }
}

console.log(`\n${APPLY ? "applied" : "would capture"}: ${totalPlanned} fact(s) across ${scenes.length} scene(s)${APPLY ? ` (${totalSaved} newly written, the rest deduped)` : ""}`);
if (!APPLY && totalPlanned > 0) console.log("dry run — re-run with --apply to write (idempotent: createEntryIfUnique dedups).");
