// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Shared deduplicated entry creation.
//
// Every automatic capture path (Tier 1 digest/snapshot, Tier 2 sentiment,
// Tier 3 ambient) and the manual [remember:] paths must avoid re-saving a fact
// that already exists in the same lane. Previously only the command paths
// deduped, so the automated tiers regenerated duplicates faster than cleanup
// could remove them. This module is the single source of truth for the check.

import {
  readIndex,
  writeEntry,
  upsertIndexEntry,
  estimateTokens,
  type Scope,
  type Lane,
  type EntryStatus,
  type Entry,
  type IndexEntry,
} from "./storage.js";
import { nanoid } from "./nanoid.js";

export const DEDUP_SIMILARITY_THRESHOLD = 0.35;

// Jaccard similarity on word bags.
export function jaccardSimilarity(a: string, b: string): number {
  const words = (s: string) =>
    new Set(s.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean));
  const wa = words(a);
  const wb = words(b);
  const intersection = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union === 0 ? 0 : intersection / union;
}

// True if summary OR content is too similar to an existing entry's summary.
export function isDuplicate(
  summary: string,
  content: string,
  existing: IndexEntry[],
): boolean {
  return existing.some(
    (e) =>
      jaccardSimilarity(e.summary, summary) >= DEDUP_SIMILARITY_THRESHOLD ||
      (content.length > 20 &&
        jaccardSimilarity(e.summary, content) >= DEDUP_SIMILARITY_THRESHOLD),
  );
}

function idPrefix(lane: Lane): string {
  if (lane === "open_threads") return "thread";
  if (lane === "user_topics") return "utopic";
  return "ctopic";
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface CreateEntryInput {
  lane: Lane;
  summary: string;
  content: string;
  status?: EntryStatus;
  timeContext?: Entry["timeContext"];
  sourceChatId?: string; // tag for clean per-chat re-import
}

// Create an entry only if no sufficiently similar entry already exists in the
// same lane of the target scope. Returns the created Entry, or null if it was a
// duplicate (or the summary was blank). Used by every capture tier.
export async function createEntryIfUnique(
  scope: Scope,
  scopeId: string,
  input: CreateEntryInput,
): Promise<Entry | null> {
  const summary = input.summary.trim();
  if (!summary) return null;
  const content = (input.content ?? "").trim();

  const idx = await readIndex(scope, scopeId);
  const existingInLane = (idx?.entries ?? []).filter((e) => e.lane === input.lane);
  if (isDuplicate(summary, content, existingInLane)) {
    console.info(`[ME:dedup] skipped duplicate (${input.lane}/${scope}:${scopeId}): "${summary.slice(0, 60)}"`);
    return null;
  }

  const id = `${idPrefix(input.lane)}-${nanoid(8)}`;
  const now = today();
  const status: EntryStatus = input.status ?? "open";
  const entry: Entry = {
    id,
    lane: input.lane,
    summary,
    status,
    created: now,
    lastAccessed: now,
    content,
    tokens: estimateTokens(`${summary} ${content}`),
    ...(input.timeContext ? { timeContext: input.timeContext } : {}),
    ...(input.sourceChatId ? { sourceChatId: input.sourceChatId } : {}),
  };

  const relativePath = await writeEntry(scope, scopeId, entry);
  await upsertIndexEntry(scope, scopeId, {
    id,
    path: relativePath,
    summary,
    tokens: entry.tokens,
    lane: input.lane,
    status,
    lastAccessed: now,
    ...(input.sourceChatId ? { sourceChatId: input.sourceChatId } : {}),
  });

  return entry;
}
