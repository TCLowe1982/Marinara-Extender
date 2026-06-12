// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Backfill for MarinaraExtender-6qx: re-attribute existing beats that were
// captured before subject routing existed. For every beat whose sourceChatId
// is in the given chat list, re-run the tier-2 analyzer (with the known-
// character roster) to get a `subject`, then apply the same routing rules as
// the live path:
//   subject = user / session character  -> beat stays where it is
//   subject = known co-star             -> beat + companion entry MOVE to that
//                                          identity's ledger; originals removed
//   subject = unknown                   -> beat parked in the holding pool;
//                                          original removed (never guessed)
//
// Also supports --purge <identityKey>:<beatId> for meta-pollution (beats whose
// text is pasted logs/analysis rather than scene content).
//
// SAFETY: dry-run by default — prints every decision, writes nothing. Pass
// --apply to execute. Take a quarantine copy of data/ first. Do NOT run while
// the sidecar is up (both processes mutate the same index files).
//
// Usage:
//   node scripts/backfill-attribution.mjs --chat <chatId> [--chat ...] \
//     --session-name "Dr. Mari Zielińska" [--purge key:beatId ...] [--apply]

import { readFileSync, existsSync } from "fs";
import { unlink } from "fs/promises";
import { join, dirname, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

// ── Load .env BEFORE importing dist modules (they read env lazily, but be safe)
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const envPath = join(pkgRoot, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const distUrl = (rel) => pathToFileURL(join(pkgRoot, rel)).href;
const { analyzeChunk } = await import(distUrl("dist/sentiment/analyzer.js"));
const { readBeatIndex, readBeat, writeBeat, beatIdForChunk, companionEntryFromBeat } =
  await import(distUrl("dist/sentiment/encoder.js"));
const { buildSubjectRoster, resolveNameToKey, matchesSessionName } =
  await import(distUrl("dist/identity.js"));
const { normalizeLabel } = await import(distUrl("dist/aliases.js"));
const { addPending } = await import(distUrl("dist/holding-pool.js"));
const { createEntryIfUnique } = await import(distUrl("dist/dedup.js"));
const storage = await import(distUrl("dist/storage.js"));
const { readIndex, removeIndexEntry, deleteEntryFile, listScopeIds, getDataDir, atomicWriteFile } = storage;
const { stringify: toYaml } = await import("yaml");

// ── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const chats = [];
const purges = [];
let sessionName = "";
let apply = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--chat") chats.push(args[++i]);
  else if (args[i] === "--session-name") sessionName = args[++i];
  else if (args[i] === "--purge") purges.push(args[++i]);
  else if (args[i] === "--apply") apply = true;
  else { console.error(`unknown arg: ${args[i]}`); process.exit(1); }
}
if (chats.length === 0 && purges.length === 0) {
  console.error("nothing to do: pass --chat <id> and/or --purge key:beatId");
  process.exit(1);
}
if (chats.length > 0 && !sessionName) {
  console.error("--session-name is required when re-attributing chats");
  process.exit(1);
}

const dataDir = getDataDir();
console.log(`data dir: ${dataDir}`);
console.log(`mode: ${apply ? "APPLY" : "DRY RUN (pass --apply to execute)"}`);

// ── Beat removal (no remove primitive in encoder — direct index edit) ────────
async function removeBeatRow(identityKey, beatId) {
  const index = await readBeatIndex(identityKey);
  if (!index) return false;
  const before = index.entries.length;
  index.entries = index.entries.filter((e) => e.id !== beatId);
  if (index.entries.length === before) return false;
  index.lastUpdated = new Date().toISOString();
  await atomicWriteFile(join(dataDir, "characters", identityKey, "beats", "index.yaml"), toYaml(index));
  await unlink(join(dataDir, "characters", identityKey, "beats", `${beatId}.yaml`)).catch(() => {});
  return true;
}

// Find the beat's companion ledger entry at an identity by exact normalized
// summary match. Ambiguity (0 or 2+ matches) -> null; the caller skips + warns.
const collapse = (s) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
async function findCompanionEntry(identityKey, beat) {
  const { summary } = companionEntryFromBeat(beat);
  const idx = await readIndex("character", identityKey);
  if (!idx) return null;
  const target = collapse(summary).slice(0, 100);
  const hits = idx.entries.filter(
    (e) => e.lane === "character_topics" && collapse(e.summary).slice(0, 100) === target,
  );
  return hits.length === 1 ? hits[0] : null;
}

async function removeCompanionEntry(identityKey, beat, label) {
  const hit = await findCompanionEntry(identityKey, beat);
  if (!hit) {
    console.log(`    ~ companion entry at ${identityKey}: no unique match — left in place (${label})`);
    return false;
  }
  console.log(`    - companion ${hit.id} removed from ${identityKey}`);
  if (apply) {
    await removeIndexEntry("character", identityKey, hit.id);
    await deleteEntryFile("character", identityKey, hit.path);
  }
  return true;
}

// ── Purges (meta-pollution) ──────────────────────────────────────────────────
for (const spec of purges) {
  const [key, beatId] = spec.split(":");
  const beat = await readBeat(key, beatId);
  console.log(`PURGE ${key}:${beatId} ${beat ? `(speaker ${beat.speaker}, ${beat.emotion})` : "(beat file missing — removing row only)"}`);
  if (beat) await removeCompanionEntry(key, beat, "purge");
  if (apply) {
    const removed = await removeBeatRow(key, beatId);
    console.log(`    beat row ${removed ? "removed" : "NOT FOUND in index"}`);
  }
}

// ── Re-attribution ───────────────────────────────────────────────────────────
if (chats.length > 0) {
  const chatSet = new Set(chats);
  const roster = await buildSubjectRoster(sessionName);
  console.log(`roster: ${roster.join(", ")}`);

  const stats = { examined: 0, kept: 0, moved: 0, pooled: 0, failed: 0 };
  for (const identityKey of await listScopeIds("character")) {
    const index = await readBeatIndex(identityKey);
    if (!index) continue;
    const targets = index.entries.filter((e) => e.sourceChatId && chatSet.has(e.sourceChatId));
    if (targets.length === 0) continue;
    console.log(`\n== ${identityKey}: ${targets.length} beat(s) from target chat(s)`);

    for (const row of targets) {
      const beat = await readBeat(identityKey, row.id);
      if (!beat) { console.log(`  ? ${row.id}: file missing — skipped`); continue; }
      stats.examined++;

      // Reconstruct the classification the analyzer expects.
      const result = {
        chunk: { speaker: beat.speaker, text: beat.text, turnStart: beat.turnStart, turnEnd: beat.turnEnd },
        scores: { [beat.emotion]: beat.salience },
        primaryEmotion: beat.emotion,
        salience: beat.salience,
        structuralMatches: [],
        passesThreshold: true,
      };

      let analysis = null;
      try { analysis = await analyzeChunk(result, undefined, roster); } catch { /* counted below */ }
      if (!analysis) { stats.failed++; console.log(`  ! ${beat.id}: analyzer returned nothing — kept as-is`); continue; }

      const subject = analysis.subject?.trim();
      const isUser = !subject || normalizeLabel(subject) === "user";
      let decision;
      if (isUser || matchesSessionName(subject, sessionName)) {
        decision = "KEEP";
      } else {
        const targetKey = await resolveNameToKey(subject);
        decision = targetKey ? (targetKey === identityKey ? "KEEP" : `MOVE → ${targetKey}`) : "POOL";
      }
      console.log(`  ${beat.id} [${beat.emotion}] speaker=${beat.speaker} subject="${subject ?? "(none)"}" → ${decision}`);

      if (decision === "KEEP") { stats.kept++; continue; }

      if (decision === "POOL") {
        stats.pooled++;
        if (apply) {
          await addPending({
            speaker: subject,
            sourceType: beat.sourceType,
            sourceChatId: beat.sourceChatId,
            analyzed: { ...beat, speaker: subject },
          });
          await removeCompanionEntry(identityKey, beat, "pooled");
          await removeBeatRow(identityKey, beat.id);
        }
        continue;
      }

      // MOVE
      stats.moved++;
      const targetKey = decision.slice("MOVE → ".length);
      if (apply) {
        const newChunk = { speaker: subject, text: beat.text, turnStart: beat.turnStart, turnEnd: beat.turnEnd };
        const moved = { ...beat, id: beatIdForChunk(newChunk), speaker: subject };
        await writeBeat(targetKey, moved);
        const { summary, content } = companionEntryFromBeat(moved);
        await createEntryIfUnique("character", targetKey, {
          lane: "character_topics", summary, content, sourceChatId: beat.sourceChatId,
        });
        await removeCompanionEntry(identityKey, beat, "moved");
        await removeBeatRow(identityKey, beat.id);
      }
    }
  }
  console.log(`\nSUMMARY: examined ${stats.examined} | kept ${stats.kept} | moved ${stats.moved} | pooled ${stats.pooled} | analyzer-failed ${stats.failed}`);
}
console.log(apply ? "done (APPLIED)." : "done (dry run — nothing written).");
