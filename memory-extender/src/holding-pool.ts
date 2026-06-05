// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Orphan-Beat Holding Pool
//
// When an import attributes a chunk to a speaker label that doesn't resolve to a
// known character (no exact alias, only a fuzzy suggestion, or nothing), the
// chunk lands here instead of being dropped. It stays until the user resolves it
// in the Pending-speakers UI (map / create card / ignore). Nothing expires
// automatically except the "ignored" bucket, which is hard-deleted after 30 days.
//
// We hold the *classification* (the chunk + cheap structural scores), NOT a fully
// analyzed beat: deep analysis is deferred to migration time so orphan speakers
// the user ends up ignoring never cost analyzer tokens. The deterministic beatId
// still lets dedup and idempotent migration work before analysis runs.

import { join } from "path";
import { getDataDir, readYamlFile, mutateYamlFile } from "./storage.js";
import {
  normalizeLabel,
  readAliasTable,
  findExactMatches,
  findFuzzySuggestion,
  bumpAliasUsage,
  removeAliasRecord,
  USER_IDENTITY_KEY,
} from "./aliases.js";
import { beatIdForChunk, encodeBeat, writeBeat, readAllBeats, clearBeats, companionEntryFromBeat } from "./sentiment/encoder.js";
import { analyzeChunks } from "./sentiment/analyzer.js";
import { createEntryIfUnique } from "./dedup.js";
import type { ClassificationResult, EmotionalBeat } from "./sentiment/types.js";

export const IGNORED_TTL_DAYS = 30;

export interface PendingSuggestion {
  identityKey: string;
  canonicalName: string;
  score: number;
}

export interface PendingBeat {
  beatId: string;                  // deterministic (beatIdForChunk) — dedup + idempotent migrate
  speaker: string;                 // original-case label as attributed
  sourceType: "chat" | "story";
  sourceChatId?: string;
  extractedAt: string;
  suggestion?: PendingSuggestion;  // fuzzy match, if any — never auto-routed
  // Payload — exactly one is set. `classification` is an import-time orphan whose
  // deep analysis is deferred until it's claimed. `analyzed` is an already-analyzed
  // beat being re-homed (e.g. a deleted character's beats cascading back) — it's
  // migrated by re-writing it under the new character, with no re-analysis.
  classification?: ClassificationResult;
  analyzed?: EmotionalBeat;
}

export interface HoldingPool {
  pendingBySpeaker: Record<string, PendingBeat[]>; // keyed by normalized label
}

export interface IgnoredEntry {
  ignoredAt: string;
  label: string;
  beats: PendingBeat[];
}
export interface IgnoredBucket {
  items: IgnoredEntry[];
}

function poolPath(): string {
  return join(getDataDir(), "holding-pool.yaml");
}
function ignoredPath(): string {
  return join(getDataDir(), "holding-pool-ignored.yaml");
}

function emptyPool(): HoldingPool {
  return { pendingBySpeaker: {} };
}

// ── Read ───────────────────────────────────────────────────────────────────────

export async function readHoldingPool(): Promise<HoldingPool> {
  return (await readYamlFile<HoldingPool>(poolPath())) ?? emptyPool();
}

export interface PendingSummary {
  label: string;            // display label (original case, from the latest beat)
  normalized: string;
  count: number;
  suggestion?: PendingSuggestion;
}

// One row per unresolved speaker label, for the Pending-speakers UI.
export async function listPendingSpeakers(): Promise<PendingSummary[]> {
  const pool = await readHoldingPool();
  return Object.entries(pool.pendingBySpeaker)
    .filter(([, beats]) => beats.length > 0)
    .map(([normalized, beats]) => ({
      normalized,
      label: beats[beats.length - 1]!.speaker,
      count: beats.length,
      // Surface the highest-scoring suggestion present across the group.
      suggestion: beats
        .map((b) => b.suggestion)
        .filter((s): s is PendingSuggestion => !!s)
        .sort((a, b) => b.score - a.score)[0],
    }))
    .sort((a, b) => b.count - a.count);
}

// ── Mutate ───────────────────────────────────────────────────────────────────

// Add one orphan classification to the pool. Idempotent: re-adding the same beat
// (same deterministic id) under the same speaker is a no-op, so re-running an
// import never double-stacks the pool.
export async function addPending(beat: Omit<PendingBeat, "beatId" | "extractedAt"> & {
  beatId?: string;
  extractedAt?: string;
}): Promise<void> {
  const beatId =
    beat.beatId ??
    beat.analyzed?.id ??
    (beat.classification ? beatIdForChunk(beat.classification.chunk) : undefined);
  if (!beatId) throw new Error("addPending: a classification or analyzed beat is required");
  const record: PendingBeat = {
    beatId,
    speaker: beat.speaker,
    classification: beat.classification,
    analyzed: beat.analyzed,
    sourceType: beat.sourceType,
    sourceChatId: beat.sourceChatId,
    extractedAt: beat.extractedAt ?? new Date().toISOString(),
    suggestion: beat.suggestion,
  };
  const key = normalizeLabel(beat.speaker);
  await mutateYamlFile<HoldingPool>(poolPath(), emptyPool, (pool) => {
    const list = (pool.pendingBySpeaker[key] ??= []);
    if (!list.some((b) => b.beatId === record.beatId)) list.push(record);
  });
}

// Pop all pending beats for a normalized label out of the pool (used by migrate
// and ignore). Returns [] if none.
async function takeSpeaker(normalized: string): Promise<PendingBeat[]> {
  let taken: PendingBeat[] = [];
  await mutateYamlFile<HoldingPool>(poolPath(), emptyPool, (pool) => {
    taken = pool.pendingBySpeaker[normalized] ?? [];
    delete pool.pendingBySpeaker[normalized];
  });
  return taken;
}

export async function getPending(normalized: string): Promise<PendingBeat[]> {
  const pool = await readHoldingPool();
  return pool.pendingBySpeaker[normalized] ?? [];
}

// ── Migration ──────────────────────────────────────────────────────────────────

export type AnalyzeFn = typeof analyzeChunks;

// Resolve a pending speaker label to a real character: run the deferred deep
// analysis on its held chunks and encode them as beats under identityKey, then
// clear the label from the pool. Idempotent — beat ids are deterministic, so a
// re-run overwrites the same files rather than duplicating, and a label already
// cleared resolves to a no-op (0 beats).
export async function migratePendingBeats(
  normalizedLabel: string,
  identityKey: string,
  opts: { analyze?: AnalyzeFn } = {},
): Promise<{ migrated: number }> {
  const analyze = opts.analyze ?? analyzeChunks;
  const pending = await takeSpeaker(normalizedLabel);
  if (pending.length === 0) return { migrated: 0 };

  let migrated = 0;

  // Every encoded beat also needs a companion character_topics ledger entry —
  // the loader reads entries, not the beats store, so without this a routed beat
  // is stored but never retrievable. Mirrors what the pipeline does on encode.
  const writeCompanion = async (beat: EmotionalBeat) => {
    const { summary, content } = companionEntryFromBeat(beat);
    if (summary) {
      await createEntryIfUnique("character", identityKey, {
        lane: "character_topics", summary, content, sourceChatId: beat.sourceChatId,
      });
    }
  };

  // Already-analyzed beats (cascade re-home) are re-written under the new
  // character directly — no LLM. Beat ids are deterministic, so this is idempotent.
  for (const p of pending) {
    if (!p.analyzed) continue;
    const beat: EmotionalBeat = { ...p.analyzed, ...(p.sourceChatId ? { sourceChatId: p.sourceChatId } : {}) };
    await writeBeat(identityKey, beat);
    await writeCompanion(beat);
    migrated++;
  }

  // Import-time orphans (deferred): run deep analysis now, then encode.
  const toAnalyze = pending.filter((p) => !p.analyzed && p.classification);
  if (toAnalyze.length) {
    const provenanceByBeat = new Map(toAnalyze.map((p) => [p.beatId, p] as const));
    const analyzed = await analyze(toAnalyze.map((p) => p.classification!));
    for (const a of analyzed) {
      const src = provenanceByBeat.get(beatIdForChunk(a.result.chunk));
      const beat = await encodeBeat(identityKey, a.result, a.analysis, src?.sourceType ?? "story", src?.sourceChatId);
      await writeCompanion(beat);
      migrated++;
    }
  }
  return { migrated };
}

// ── Orphan routing (import-time) ───────────────────────────────────────────────

export interface OrphanItem {
  classification: ClassificationResult;
  sourceType: "chat" | "story";
  sourceChatId?: string;
}

export interface RouteSummary {
  autoRouted: number;        // beats routed to an exact-alias character immediately
  held: number;              // beats placed in the holding pool for resolution
  pendingLabels: string[];   // distinct speaker labels now awaiting resolution
}

function isUserSpeaker(speaker: string): boolean {
  return normalizeLabel(speaker) === "user";
}

// Route chunks whose speaker matched no assigned character. Exact (single) alias
// hit → auto-route to that character now (the user already taught us this name).
// Collision (label maps to >1 character) → hold with no suggestion (manual per
// beat). Fuzzy near-miss → hold WITH a suggestion (never auto-routed). Miss →
// hold. User-attributed chunks are skipped (they aren't a character). Best-effort:
// callers wrap this so a holding-pool hiccup never fails the import.
export async function routeOrphans(
  orphans: OrphanItem[],
  opts: { analyze?: AnalyzeFn } = {},
): Promise<RouteSummary> {
  const table = await readAliasTable();
  const pendingLabels = new Set<string>();
  // Group by normalized label so each distinct speaker is decided once.
  const byLabel = new Map<string, OrphanItem[]>();
  for (const o of orphans) {
    if (isUserSpeaker(o.classification.chunk.speaker)) continue;
    const key = normalizeLabel(o.classification.chunk.speaker);
    if (!key) continue;
    (byLabel.get(key) ?? byLabel.set(key, []).get(key)!).push(o);
  }

  let autoRouted = 0;
  let held = 0;
  for (const [, items] of byLabel) {
    const label = items[0]!.classification.chunk.speaker;
    const exact = findExactMatches(table, label);

    if (exact.length === 1) {
      // Known character — route now (deferred analysis runs via migrate).
      const identityKey = exact[0]!.identityKey;
      if (identityKey === USER_IDENTITY_KEY) continue; // user's own — not a character beat
      for (const it of items) {
        await addPending({ speaker: it.classification.chunk.speaker, classification: it.classification, sourceType: it.sourceType, sourceChatId: it.sourceChatId });
      }
      const { migrated } = await migratePendingBeats(normalizeLabel(label), identityKey, opts);
      autoRouted += migrated;
      await bumpAliasUsage(identityKey, label);
      continue;
    }

    // Collision (>1) → no suggestion (force manual). Otherwise offer a fuzzy hint.
    const suggestion = exact.length > 1 ? undefined : findFuzzySuggestion(table, label) ?? undefined;
    for (const it of items) {
      await addPending({
        speaker: it.classification.chunk.speaker,
        classification: it.classification,
        sourceType: it.sourceType,
        sourceChatId: it.sourceChatId,
        suggestion: suggestion ? { identityKey: suggestion.identityKey, canonicalName: suggestion.canonicalName, score: suggestion.score } : undefined,
      });
      held++;
    }
    pendingLabels.add(normalizeLabel(label));
  }

  return { autoRouted, held, pendingLabels: [...pendingLabels] };
}

// Cascade for a deleted character: move all of its (already-analyzed) beats back
// into the holding pool under their original speaker labels so they can be
// re-mapped, then clear its beat store and drop its alias record. Idempotent —
// re-running on a character with no beats is a no-op. NOTE: companion ledger
// entries for the character are not touched here; deleting the character's scope
// dir is the caller's responsibility.
export async function orphanCharacterBeats(identityKey: string): Promise<{ orphaned: number }> {
  const beats = await readAllBeats(identityKey);
  for (const b of beats) {
    await addPending({ speaker: b.speaker, analyzed: b, sourceType: b.sourceType, sourceChatId: b.sourceChatId });
  }
  await clearBeats(identityKey);
  await removeAliasRecord(identityKey);
  return { orphaned: beats.length };
}

// ── Ignore bucket (30-day recoverable soft delete) ─────────────────────────────

export async function ignoreSpeaker(normalizedLabel: string): Promise<{ ignored: number }> {
  const pending = await takeSpeaker(normalizedLabel);
  if (pending.length === 0) return { ignored: 0 };
  await mutateYamlFile<IgnoredBucket>(ignoredPath(), () => ({ items: [] }), (bucket) => {
    bucket.items.push({
      ignoredAt: new Date().toISOString(),
      label: pending[pending.length - 1]!.speaker,
      beats: pending,
    });
  });
  return { ignored: pending.length };
}

// One row per ignored group, for an "undo" affordance in the UI.
export async function listIgnoredSpeakers(): Promise<Array<{ label: string; count: number; ignoredAt: string }>> {
  const bucket = (await readYamlFile<IgnoredBucket>(ignoredPath())) ?? { items: [] };
  return bucket.items
    .map((i) => ({ label: i.label, count: i.beats.length, ignoredAt: i.ignoredAt }))
    .sort((a, b) => b.ignoredAt.localeCompare(a.ignoredAt));
}

// Restore an ignored group back into the pending pool (user changed their mind).
export async function restoreIgnored(label: string): Promise<{ restored: number }> {
  const norm = normalizeLabel(label);
  let restored: PendingBeat[] = [];
  await mutateYamlFile<IgnoredBucket>(ignoredPath(), () => ({ items: [] }), (bucket) => {
    const keep: IgnoredEntry[] = [];
    for (const item of bucket.items) {
      if (normalizeLabel(item.label) === norm) restored.push(...item.beats);
      else keep.push(item);
    }
    bucket.items = keep;
  });
  for (const b of restored) await addPending(b);
  return { restored: restored.length };
}

// Hard-delete ignored groups older than the TTL. Call opportunistically.
export async function purgeExpiredIgnored(now = Date.now()): Promise<{ purged: number }> {
  const cutoff = now - IGNORED_TTL_DAYS * 24 * 60 * 60 * 1000;
  let purged = 0;
  await mutateYamlFile<IgnoredBucket>(ignoredPath(), () => ({ items: [] }), (bucket) => {
    const before = bucket.items.length;
    bucket.items = bucket.items.filter((i) => new Date(i.ignoredAt).getTime() >= cutoff);
    purged = before - bucket.items.length;
  });
  return { purged };
}
