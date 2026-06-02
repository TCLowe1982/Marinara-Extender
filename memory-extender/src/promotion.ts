// Memory Tier Promotion / Demotion Engine
//
// Runs periodically (every 20 turns) during process-turn to keep memory tiers
// accurate. Promotion is score-driven; demotion is time-driven (days since
// last retrieval). Core and secondary_core entries are never touched.
//
// Call runPromotion(scope, scopeId) from process-turn for each active scope.

import {
  readIndex,
  writeIndex,
  deleteEntryFile,
  listScopeIds,
  type Scope,
  type IndexEntry,
  type MemoryTier,
  TIER_SCORE_LONG,
  TIER_SCORE_CORE,
  TIER_DAYS_LONG_DEMOTES,
  TIER_DAYS_SHORT_PRUNES,
  TIER_SECONDARY_CORE_CYCLES,
} from "./storage.js";

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
    // Only prune if the entry has been retrieved at least once — brand-new
    // entries that haven't been surfaced yet shouldn't be pruned immediately.
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
  const index = await readIndex(scope, scopeId);
  if (!index || index.entries.length === 0) return;

  const toRemove: IndexEntry[] = [];
  let changed = false;

  for (const entry of index.entries) {
    if (entry.status === "done") continue;
    const { tier, cycleCount, prune } = nextTier(entry);

    if (prune) {
      toRemove.push(entry);
      changed = true;
      continue;
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

  if (!changed) return;

  // Remove pruned entries from the index and delete their files.
  const removeIds = new Set(toRemove.map((e) => e.id));
  index.entries = index.entries.filter((e) => !removeIds.has(e.id));
  index.lastUpdated = new Date().toISOString();
  await writeIndex(index);

  for (const entry of toRemove) {
    await deleteEntryFile(scope, scopeId, entry.path).catch(() => {});
    console.info(`[promotion] pruned stale entry ${entry.id} (${entry.summary.slice(0, 50)})`);
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

  for (const { scope, id } of scopes) {
    const index = await readIndex(scope, id);
    if (!index || index.entries.length === 0) continue;
    console.info(`[promotion:backfill] ${scope}:${id} — ${index.entries.length} entries`);

    const toRemove: IndexEntry[] = [];
    let changed = false;

    for (const entry of index.entries) {
      if (entry.status === "done") continue;
      const { tier, cycleCount, prune } = nextTier(entry);

      if (prune) {
        toRemove.push(entry);
        changed = true;
        pruned++;
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

    if (!changed) continue;

    const removeIds = new Set(toRemove.map((e) => e.id));
    index.entries = index.entries.filter((e) => !removeIds.has(e.id));
    index.lastUpdated = new Date().toISOString();
    await writeIndex(index);

    for (const entry of toRemove) {
      await deleteEntryFile(scope, id, entry.path).catch(() => {});
    }
  }

  console.info(`[promotion:backfill] done — ${scopes.length} scopes, ${promoted} promoted, ${pruned} pruned`);
  return { scopes: scopes.length, promoted, pruned };
}

// ── Public: increment recitationCount for an entry ───────────────────────────

export async function recordRecitation(
  scope: Scope,
  scopeId: string,
  entryId: string,
): Promise<void> {
  const index = await readIndex(scope, scopeId);
  if (!index) return;

  const entry = index.entries.find((e) => e.id === entryId);
  if (!entry) return;

  entry.recitationCount = (entry.recitationCount ?? 0) + 1;

  // Check if recitation tips the entry into the next tier immediately.
  const { tier, cycleCount } = nextTier(entry);
  if (tier !== (entry.tier ?? "short")) {
    console.info(`[promotion] recitation triggered: ${entry.id} → ${tier}`);
    entry.tier = tier;
    entry.cycleCount = cycleCount;
  }

  index.lastUpdated = new Date().toISOString();
  await writeIndex(index);
}
