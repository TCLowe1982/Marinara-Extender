// One-time memory pool cleanup.
// Runs three passes across every scope:
//   1. Ghost prune    — delete entries with empty summary or zero content
//   2. Dedup          — mark lower-value duplicates as "done" (Jaccard on summary)
//   3. Transient mark — character-scope entries with time-bound content → "done"
//
// Safe to run multiple times — idempotent.

import {
  readIndex,
  writeIndex,
  deleteEntryFile,
  listScopeIds,
  type Scope,
  type IndexEntry,
} from "./storage.js";

// ── Jaccard ───────────────────────────────────────────────────────────────────

function wordSet(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean));
}

function jaccard(a: string, b: string): number {
  const wa = wordSet(a);
  const wb = wordSet(b);
  const intersection = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union === 0 ? 0 : intersection / union;
}

const DEDUP_THRESHOLD = 0.35;

// ── Transient markers ─────────────────────────────────────────────────────────
// Patterns that indicate a character-scope entry should only matter now.

const TRANSIENT_RE = [
  /\btoday\b/i,
  /\btonight\b/i,
  /\bthis morning\b/i,
  /\bthis afternoon\b/i,
  /\bthis evening\b/i,
  /\btomorrow\b/i,
  /\bright now\b/i,
  /\bat the moment\b/i,
  /\bcurrently\b/i,
  /\bat \d+(?::\d+)?\s*(?:am|pm)\b/i,
  /until \d+/i,
  /\bscheduled (?:for|until|at)\b/i,
  /\bhas a meeting\b/i,
  /\bgets paid\b/i,
  /\bis waiting for\b/i,
  /\bis working on\b/i,
  /\bworking on (?:the |a |an )?\w+ (?:today|right now|at the moment)\b/i,
];

function isLikelyTransient(entry: IndexEntry): boolean {
  const text = `${entry.summary} ${entry.path}`.toLowerCase();
  return TRANSIENT_RE.some((re) => re.test(text));
}

// ── Result ────────────────────────────────────────────────────────────────────

export interface CleanupResult {
  scopes:     number;
  pruned:     number;  // ghost entries hard-deleted
  deduped:    number;  // duplicates marked done
  transients: number;  // transient entries marked done
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function runCleanup(): Promise<CleanupResult> {
  const scopes: Array<{ scope: Scope; id: string }> = [{ scope: "global", id: "global" }];
  const [charIds, chatIds] = await Promise.all([
    listScopeIds("character"),
    listScopeIds("chat"),
  ]);
  for (const id of charIds) scopes.push({ scope: "character", id });
  for (const id of chatIds) scopes.push({ scope: "chat", id });

  let pruned = 0, deduped = 0, transients = 0;

  for (const { scope, id } of scopes) {
    const index = await readIndex(scope, id);
    if (!index || index.entries.length === 0) continue;

    const toDelete: IndexEntry[] = [];
    let changed = false;

    // ── Pass 1: ghost prune ───────────────────────────────────────────────────
    const live: IndexEntry[] = [];
    for (const entry of index.entries) {
      if (!entry.summary?.trim()) {
        toDelete.push(entry);
        changed = true;
        pruned++;
        console.info(`[cleanup] ghost → delete ${entry.id} (empty summary, score=${
          (entry.retrievalCount ?? 0) + (entry.recitationCount ?? 0) * 3
        })`);
      } else {
        live.push(entry);
      }
    }

    // ── Pass 2: dedup within each lane ───────────────────────────────────────
    // Group by lane. For each pair, if Jaccard >= threshold keep the one with
    // higher score; mark the other done.
    const byLane = new Map<string, IndexEntry[]>();
    for (const entry of live) {
      const list = byLane.get(entry.lane) ?? [];
      list.push(entry);
      byLane.set(entry.lane, list);
    }

    const markedDone = new Set<string>();
    for (const [, entries] of byLane) {
      for (let i = 0; i < entries.length; i++) {
        const a = entries[i]!;
        if (markedDone.has(a.id) || a.status === "done") continue;
        for (let j = i + 1; j < entries.length; j++) {
          const b = entries[j]!;
          if (markedDone.has(b.id) || b.status === "done") continue;
          if (jaccard(a.summary, b.summary) < DEDUP_THRESHOLD) continue;

          // Keep the higher-scored entry; mark the other done.
          const scoreA = (a.retrievalCount ?? 0) + (a.recitationCount ?? 0) * 3;
          const scoreB = (b.retrievalCount ?? 0) + (b.recitationCount ?? 0) * 3;
          const loser  = scoreA >= scoreB ? b : a;
          loser.status = "done";
          markedDone.add(loser.id);
          changed = true;
          deduped++;
          console.info(`[cleanup] dedup → done ${loser.id} "${loser.summary.slice(0, 50)}"`);
        }
      }
    }

    // ── Pass 3: transient detection (character scope only) ───────────────────
    // Entries that are clearly time-bound and have low score get marked done.
    if (scope === "character") {
      for (const entry of live) {
        if (markedDone.has(entry.id) || entry.status === "done") continue;
        if ((entry.tier === "core" || entry.tier === "secondary_core")) continue;
        const score = (entry.retrievalCount ?? 0) + (entry.recitationCount ?? 0) * 3;
        if (score > 5) continue; // if it's been useful, leave it alone
        if (isLikelyTransient(entry)) {
          entry.status = "done";
          changed = true;
          transients++;
          console.info(`[cleanup] transient → done ${entry.id} "${entry.summary.slice(0, 60)}"`);
        }
      }
    }

    if (!changed) continue;

    // Apply hard deletes.
    const deleteIds = new Set(toDelete.map((e) => e.id));
    index.entries = index.entries.filter((e) => !deleteIds.has(e.id));
    index.lastUpdated = new Date().toISOString();
    await writeIndex(index);

    for (const entry of toDelete) {
      await deleteEntryFile(scope, id, entry.path).catch(() => {});
    }
  }

  console.info(`[cleanup] done — ${scopes.length} scopes | ${pruned} pruned | ${deduped} deduped | ${transients} transients marked done`);
  return { scopes: scopes.length, pruned, deduped, transients };
}
