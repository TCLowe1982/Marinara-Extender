// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Repair scene-recap pairing (MarinaraExtender — recap floor, 2cu lineage).
//
// The engine's "returned from their scene" narrator message never names the
// scene, so syncSceneRecaps originally paired scenes with summaries by
// nearest timestamp. Two scenes concluding the same day in the same origin
// chat could swap summaries (found live: "Test Drive Transgression" carrying
// the couch-morning recap). This script recomputes the correct pairing from
// the engine's own tables using content-word overlap — a summary shares
// distinctive vocabulary with its scene's transcript — then audits every
// character store and (with --apply) replaces mispaired recaps.
//
// Usage (sidecar should be STOPPED for --apply; dry-run is read-only):
//   node scripts/repair-recap-pairing.mjs           # audit only
//   node scripts/repair-recap-pairing.mjs --apply   # fix mismatches
//
// Run from the repo root. Reads the engine tables at the default install
// location; override with MARINARA_ENGINE_TABLES.

import { readFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.cwd();
const DIST = join(REPO, "memory-extender", "dist");
const DATA = process.env.MARINARA_EXTENDER_DATA ?? join(REPO, "memory-extender", "data");
const TABLES = process.env.MARINARA_ENGINE_TABLES
  ?? join(process.env.LOCALAPPDATA ?? "", "MarinaraEngine", "packages", "server", "data", "storage", "tables");
const APPLY = process.argv.includes("--apply");

const storage = await import(pathToFileURL(join(DIST, "storage.js")).href);
const arcsMod = await import(pathToFileURL(join(DIST, "arcs.js")).href);
const yaml = (await import(pathToFileURL(join(REPO, "memory-extender", "node_modules", "yaml", "dist", "index.js")).href)).default
  ?? await import(pathToFileURL(join(REPO, "memory-extender", "node_modules", "yaml", "dist", "index.js")).href);
const { writeFileSync } = await import("node:fs");

// ── Engine tables ─────────────────────────────────────────────────────────────

function loadTable(name) {
  const j = JSON.parse(readFileSync(join(TABLES, name), "utf8"));
  return Array.isArray(j) ? j : (j.rows ?? Object.values(j));
}

const chats = loadTable("chats.json");
const messages = loadTable("messages.json");

const meta = (c) => {
  const m = c?.metadata;
  if (typeof m === "string") { try { return JSON.parse(m); } catch { return {}; } }
  return m ?? {};
};

const concluded = chats.filter((c) => meta(c).sceneStatus === "concluded");
const msgsByChat = new Map();
for (const m of messages) {
  if (!msgsByChat.has(m.chatId)) msgsByChat.set(m.chatId, []);
  msgsByChat.get(m.chatId).push(m);
}

// ── Pairing by content-word overlap ───────────────────────────────────────────

const STOP = new Set(("the and that with from their them they this have been were into your what when where while would could " +
  "should about after before then than because both each other some more very over under again still just like only also back " +
  "down onto him her his hers had has was are not for you she it of in on at to we us our as is be by or an so no do did does " +
  "my me one two out off up all can will who how why said says say there here them what something nothing").split(/\s+/));

function contentWords(text) {
  const words = String(text).toLowerCase().match(/[a-z]{4,}/g) ?? [];
  return new Set(words.filter((w) => !STOP.has(w)));
}

function overlapScore(summary, sceneText) {
  const sw = contentWords(summary);
  if (sw.size === 0) return 0;
  let hit = 0;
  for (const w of sw) if (sceneText.includes(w)) hit++;
  return hit / sw.size;
}

const stripLead = (t) => String(t).replace(/^\*[^*]*\*\s*/s, "").replace(/\s+/g, " ").trim();

// correct[sceneChatId] = { summary, score, sceneName, concludedAt }
const correct = new Map();
const byOrigin = new Map();
for (const s of concluded) {
  const origin = meta(s).sceneOriginChatId;
  if (!origin) continue;
  if (!byOrigin.has(origin)) byOrigin.set(origin, []);
  byOrigin.get(origin).push(s);
}

for (const [originId, scenes] of byOrigin) {
  const returns = (msgsByChat.get(originId) ?? [])
    .filter((m) => m.role === "narrator" && /returned from .{0,30}scene/i.test(String(m.content ?? "").slice(0, 120)))
    .map((m) => ({ summary: stripLead(m.content), createdAt: m.createdAt ?? "" }))
    .filter((r) => r.summary.length >= 20);
  if (returns.length === 0) continue;

  // Score every (scene, return) pair, assign greedily best-first so each
  // return message is claimed by exactly one scene.
  const scored = [];
  for (const scene of scenes) {
    const sceneText = (msgsByChat.get(scene.id) ?? []).map((m) => String(m.content ?? "")).join("\n").toLowerCase();
    for (let i = 0; i < returns.length; i++) {
      scored.push({ scene, ri: i, score: sceneText ? overlapScore(returns[i].summary, sceneText) : 0 });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const takenScene = new Set(), takenReturn = new Set();
  for (const { scene, ri, score } of scored) {
    if (score < 0.25) break; // below this, content gives no verdict — leave unpaired
    if (takenScene.has(scene.id) || takenReturn.has(ri)) continue;
    takenScene.add(scene.id); takenReturn.add(ri);
    correct.set(scene.id, {
      summary: returns[ri].summary,
      score,
      sceneName: scene.name ?? "",
      concludedAt: returns[ri].createdAt,
    });
  }
}

console.log(`engine: ${concluded.length} concluded scene(s); content pairing resolved ${correct.size}`);

// ── Audit every character store ───────────────────────────────────────────────

const charsDir = join(DATA, "characters");
const characterKeys = existsSync(charsDir) ? readdirSync(charsDir) : [];
let mismatches = 0, ok = 0, unresolved = 0, repaired = 0;

for (const key of characterKeys) {
  const idx = await storage.readIndex("character", key);
  const recaps = idx.entries.filter((e) => e.id.startsWith("recap-") && !e.id.startsWith("recap-arc-") && e.sourceChatId);
  for (const r of recaps) {
    const want = correct.get(r.sourceChatId);
    if (!want) { unresolved++; continue; }
    const entry = await storage.readEntry("character", key, r.path);
    const have = String(entry?.content ?? "").replace(/\s+/g, " ").trim();
    if (have === want.summary) { ok++; continue; }

    mismatches++;
    console.log(`\nMISMATCH ${key} ${r.id} — scene "${want.sceneName}" (pairing score ${want.score.toFixed(2)})`);
    console.log(`  stored : ${have.slice(0, 110)}…`);
    console.log(`  correct: ${want.summary.slice(0, 110)}…`);

    if (!APPLY) continue;

    // 1. Remove the recap entry (file + index row).
    await storage.deleteEntryFile("character", key, r.path).catch(() => {});
    await storage.removeIndexEntry("character", key, r.id);

    // 2. Remove the bogus arc, its memberships, and the idempotency marker.
    const arcsFile = join(charsDir, key, "arcs.yaml");
    if (existsSync(arcsFile)) {
      const af = yaml.parse(readFileSync(arcsFile, "utf8"));
      const arcId = af.ingestedScenes?.[r.sourceChatId];
      if (arcId) {
        af.arcs = (af.arcs ?? []).filter((a) => a.id !== arcId);
        delete af.ingestedScenes[r.sourceChatId];
        writeFileSync(arcsFile, yaml.stringify(af));
        const memFile = join(charsDir, key, "arc-memberships.yaml");
        if (existsSync(memFile)) {
          const mf = yaml.parse(readFileSync(memFile, "utf8"));
          mf.memberships = (mf.memberships ?? []).filter((m) => m.arcId !== arcId);
          writeFileSync(memFile, yaml.stringify(mf));
        }
      }
    }

    // 3. Re-ingest with the correct summary.
    const res = await arcsMod.ingestSceneRecap({
      identityKey: key,
      summary: want.summary,
      sceneChatId: r.sourceChatId,
      sceneName: want.sceneName,
      concludedAt: want.concludedAt,
    });
    if (res && !res.alreadyIngested) { repaired++; console.log(`  → repaired as ${res.entryId} (arc ${res.arcId})`); }
    else console.log(`  → RE-INGEST FAILED (${JSON.stringify(res)})`);
  }
}

console.log(`\naudit: ${ok} correct, ${mismatches} mispaired, ${unresolved} unresolvable from content`);
if (APPLY) console.log(`applied: ${repaired} repaired`);
else if (mismatches > 0) console.log("dry run — re-run with --apply to fix (stop the sidecar first)");
