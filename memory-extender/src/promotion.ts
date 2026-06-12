// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Memory Tier Promotion / Demotion Engine
//
// Runs periodically (every 20 turns) during process-turn to keep memory tiers
// accurate. Promotion is score-driven; demotion is time-driven (days since
// last retrieval). Core and secondary_core entries are never touched.
//
// Call runPromotion(scope, scopeId) from process-turn for each active scope.

import {
  mutateIndex,
  readIndex,
  deleteEntryFile,
  moveToCold,
  promoteFromCold,
  listScopeIds,
  type Scope,
  type IndexEntry,
  type MemoryTier,
  TIER_SCORE_LONG,
  TIER_SCORE_CORE,
  TIER_DAYS_LONG_DEMOTES,
  TIER_DAYS_SHORT_PRUNES,
  TIER_DAYS_COLD,
  TIER_SECONDARY_CORE_CYCLES,
} from "./storage.js";
import { readThreadRegistry } from "./threads.js";

// ── Score ──────────────────────────────────────────────────────────────────────

export function computeScore(entry: IndexEntry): number {
  return (entry.retrievalCount ?? 0) + ((entry.recitationCount ?? 0) * 3);
}

// ── Demotion staleness check ──────────────────────────────────────────────────

function daysSinceRetrieval(entry: IndexEntry): number {
  const lastStr = entry.lastRetrievedAt ?? entry.lastAccessed;
  if (!lastStr) return Infinity;
  const last = new Date(lastStr).getTime();
  return (Date.now() - last) / (1000 * 60 * 60 * 24);
}

// ── Tier transition for a single entry ───────────────────────────────────────

function nextTier(entry: IndexEntry): {
  tier: MemoryTier;
  cycleCount: number;
  prune: boolean;
} {
  const current: MemoryTier = entry.tier ?? "short";
  const cycles = entry.cycleCount ?? 0;
  const score = computeScore(entry);
  const stale = daysSinceRetrieval(entry);

  // Permanent tiers are never touched.
  if (current === "core" || current === "secondary_core") {
    return { tier: current, cycleCount: cycles, prune: false };
  }

  if (current === "short") {
    // Skip directly to core if score is already high enough.
    if (score >= TIER_SCORE_CORE) {
      return { tier: "core", cycleCount: cycles, prune: false };
    }
    if (score >= TIER_SCORE_LONG) {
      return { tier: "long", cycleCount: cycles, prune: false };
    }
    // Only prune if the entry has been SUMMONED at least once (retrievalCount is
    // now relevance-gated in the loader — see loader.ts). This means an entry
    // that was pulled in by topic, given its chance, and still went stale is
    // prunable; an entry that was never once topically relevant is left alone
    // rather than deleted (it may simply be waiting for its subject to come up).
    if (stale > TIER_DAYS_SHORT_PRUNES && (entry.retrievalCount ?? 0) > 0) {
      return { tier: "short", cycleCount: cycles, prune: true };
    }
    return { tier: "short", cycleCount: cycles, prune: false };
  }

  if (current === "long") {
    if (score >= TIER_SCORE_CORE) {
      return { tier: "core", cycleCount: cycles, prune: false };
    }
    if (stale > TIER_DAYS_LONG_DEMOTES) {
      const newCycles = cycles + 1;
      if (newCycles >= TIER_SECONDARY_CORE_CYCLES) {
        // Cycled enough times to earn permanent secondary status.
        return { tier: "secondary_core", cycleCount: newCycles, prune: false };
      }
      return { tier: "short", cycleCount: newCycles, prune: false };
    }
    return { tier: "long", cycleCount: cycles, prune: false };
  }

  return { tier: current, cycleCount: cycles, prune: false };
}

// ── Public: run promotion pass for one scope ──────────────────────────────────

export async function runPromotion(scope: Scope, scopeId: string): Promise<void> {
  const coldIds: string[] = [];

  // Narrative threads archive as UNITS (MarinaraExtender-pln): members of an
  // ACTIVE thread never go cold (the arc is still alive), and a closed
  // thread's members go together — only once every member is stale — so the
  // arc is never split across hot and cold storage.
  const registry = await readThreadRegistry().catch(() => ({ threads: [] }));
  const threadStatus = new Map(registry.threads.map((t) => [t.id, t.status]));
  const threadMembers = new Map<string, { stale: number; total: number; ids: string[] }>();

  // Serialized read-modify-write so the promotion pass can't collide with the
  // Tier-2/Tier-3/retrieval writes that run concurrently on the same index.
  await mutateIndex(scope, scopeId, (index) => {
    if (index.entries.length === 0) return false;
    let changed = false;

    for (const entry of index.entries) {
      if (entry.status === "done") continue;
      const { tier, cycleCount } = nextTier(entry);

      // Archive (don't delete) stale, non-permanent entries to the cold tier.
      // This bounds the hot index without losing anything — a recall miss brings
      // them back. Core/secondary_core stay hot forever.
      if (tier !== "core" && tier !== "secondary_core" && daysSinceRetrieval(entry) > TIER_DAYS_COLD) {
        // Thread members are decided as a group below, not individually.
        if (entry.threadId && threadStatus.has(entry.threadId)) {
          const g = threadMembers.get(entry.threadId) ?? { stale: 0, total: 0, ids: [] };
          g.stale++; g.total++; g.ids.push(entry.id);
          threadMembers.set(entry.threadId, g);
          continue;
        }
        coldIds.push(entry.id);
        continue; // leave the row in place; moveToCold relocates it after the write
      }

      // Fresh thread members still count toward their group's total, so a
      // half-stale closed thread stays hot as a unit.
      if (entry.threadId && threadStatus.has(entry.threadId)) {
        const g = threadMembers.get(entry.threadId) ?? { stale: 0, total: 0, ids: [] };
        g.total++; g.ids.push(entry.id);
        threadMembers.set(entry.threadId, g);
      }

      if (tier !== (entry.tier ?? "short") || cycleCount !== (entry.cycleCount ?? 0)) {
        const oldTier = entry.tier ?? "short";
        entry.tier = tier;
        entry.cycleCount = cycleCount;
        changed = true;
        console.info(
          `[promotion] ${scope}:${scopeId} — ${entry.id} ${oldTier} → ${tier}` +
          (cycleCount > 0 ? ` (cycle ${cycleCount})` : ""),
        );
      }
    }

    if (!changed) return false;
  });

  // Thread-unit decision: a CLOSED thread whose every member is stale archives
  // whole; anything less (active, or any member still fresh) stays hot intact.
  for (const [threadId, g] of threadMembers) {
    if (threadStatus.get(threadId) === "closed" && g.stale === g.total && g.total > 0) {
      coldIds.push(...g.ids);
      console.info(`[promotion] ${scope}:${scopeId} — thread ${threadId} archived as a unit (${g.total} entries)`);
    }
  }

  if (coldIds.length > 0) {
    const moved = await moveToCold(scope, scopeId, coldIds);
    if (moved > 0) {
      console.info(`[promotion] ${scope}:${scopeId} — archived ${moved} stale entr${moved === 1 ? "y" : "ies"} to cold storage`);
    }
  }
}

// ── Public: backfill all scopes ───────────────────────────────────────────────
// Runs promotion across every character, chat, and global scope at once.
// Use after adding the tier system to catch up pre-existing entries.

export async function runPromotionAll(): Promise<{ scopes: number; promoted: number; pruned: number }> {
  const scopes: Array<{ scope: Scope; id: string }> = [{ scope: "global", id: "global" }];
  const [charIds, chatIds] = await Promise.all([
    listScopeIds("character"),
    listScopeIds("chat"),
  ]);
  for (const id of charIds) scopes.push({ scope: "character", id });
  for (const id of chatIds) scopes.push({ scope: "chat", id });

  console.info(`[promotion:backfill] scanning ${scopes.length} scopes`);

  let promoted = 0;
  let pruned = 0;
  let archived = 0;

  for (const { scope, id } of scopes) {
    const toRemove: IndexEntry[] = [];
    const coldIds: string[] = [];

    await mutateIndex(scope, id, (index) => {
      if (index.entries.length === 0) return false;
      console.info(`[promotion:backfill] ${scope}:${id} — ${index.entries.length} entries`);
      let changed = false;

      for (const entry of index.entries) {
        if (entry.status === "done") continue;
        // Delete only ghost entries — empty summary (junk, not real memory).
        if (!entry.summary?.trim()) {
          toRemove.push(entry);
          changed = true;
          pruned++;
          console.info(`[promotion:backfill] deleted ghost entry ${entry.id} (empty summary)`);
          continue;
        }
        const { tier, cycleCount } = nextTier(entry);

        // Stale, non-permanent → cold archive (retained, not deleted).
        if (tier !== "core" && tier !== "secondary_core" && daysSinceRetrieval(entry) > TIER_DAYS_COLD) {
          coldIds.push(entry.id);
          continue;
        }

        if (tier !== (entry.tier ?? "short") || cycleCount !== (entry.cycleCount ?? 0)) {
          const oldTier = entry.tier ?? "short";
          entry.tier = tier;
          entry.cycleCount = cycleCount;
          changed = true;
          promoted++;
          console.info(`[promotion:backfill] ${scope}:${id} — ${entry.id} ${oldTier} → ${tier}`);
        }
      }

      if (!changed && toRemove.length === 0) return false;
      const removeIds = new Set(toRemove.map((e) => e.id));
      index.entries = index.entries.filter((e) => !removeIds.has(e.id));
    });

    for (const entry of toRemove) {
      await deleteEntryFile(scope, id, entry.path).catch(() => {});
    }
    if (coldIds.length > 0) archived += await moveToCold(scope, id, coldIds);
  }

  console.info(`[promotion:backfill] done — ${scopes.length} scopes, ${promoted} promoted, ${archived} archived, ${pruned} ghosts deleted`);
  return { scopes: scopes.length, promoted, pruned };
}

// ── Public: increment recitationCount for an entry ───────────────────────────

export async function recordRecitation(
  scope: Scope,
  scopeId: string,
  entryId: string,
): Promise<void> {
  // If the entry was archived to cold, demonstrable use brings it back to the
  // hot set first (reaching for a memory strengthens it). Safety net — the loader
  // already rehydrates on a cold recall hit; this covers any other recital path.
  const hot = await readIndex(scope, scopeId);
  if (hot && !hot.entries.some((e) => e.id === entryId)) {
    await promoteFromCold(scope, scopeId, entryId);
  }

  // Serialized read-modify-write so this can't clobber the retrieval-count
  // stamping that process-turn fires for the same (sticky) entries.
  await mutateIndex(scope, scopeId, (index) => {
    const entry = index.entries.find((e) => e.id === entryId);
    if (!entry) return false;

    entry.recitationCount = (entry.recitationCount ?? 0) + 1;
    // Demonstrable use IS retrieval — stamp the honest recency signal here, not
    // in the loader (which only knows the entry was loaded, not used). This is
    // what drives demotion-by-staleness and the Current cache's recency.
    const now = new Date().toISOString();
    entry.lastRetrievedAt = now;
    entry.lastAccessed = now.slice(0, 10);

    // Check if recitation tips the entry into the next tier immediately.
    const { tier, cycleCount } = nextTier(entry);
    if (tier !== (entry.tier ?? "short")) {
      console.info(`[promotion] recitation triggered: ${entry.id} → ${tier}`);
      entry.tier = tier;
      entry.cycleCount = cycleCount;
    }
  });
}
