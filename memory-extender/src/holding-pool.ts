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
import { normalizeLabel } from "./aliases.js";
import { beatIdForChunk, encodeBeat } from "./sentiment/encoder.js";
import { analyzeChunks } from "./sentiment/analyzer.js";
import type { ClassificationResult } from "./sentiment/types.js";

export const IGNORED_TTL_DAYS = 30;

export interface PendingSuggestion {
  identityKey: string;
  canonicalName: string;
  score: number;
}

export interface PendingBeat {
  beatId: string;                  // deterministic (beatIdForChunk) — dedup + idempotent migrate
  speaker: string;                 // original-case label as attributed
  classification: ClassificationResult;
  sourceType: "chat" | "story";
  sourceChatId?: string;
  extractedAt: string;
  suggestion?: PendingSuggestion;  // fuzzy match, if any — never auto-routed
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
  const record: PendingBeat = {
    beatId: beat.beatId ?? beatIdForChunk(beat.classification.chunk),
    speaker: beat.speaker,
    classification: beat.classification,
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

  const classifications: ClassificationResult[] = pending.map((p) => p.classification);
  const provenanceByBeat = new Map(pending.map((p) => [p.beatId, p] as const));

  const analyzed = await analyze(classifications);
  let migrated = 0;
  for (const a of analyzed) {
    const src = provenanceByBeat.get(beatIdForChunk(a.result.chunk));
    await encodeBeat(identityKey, a.result, a.analysis, src?.sourceType ?? "story", src?.sourceChatId);
    migrated++;
  }
  return { migrated };
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
