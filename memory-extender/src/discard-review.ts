// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Deferred reconciliation for ENTANGLED discarded swipes (MarinaraExtender-a90l).
//
// s2lw's deterministic half retires everything derived from a losing swipe. That
// is sufficient for a clean case and insufficient for the rest, because retracting
// a source does not unwind what it already caused:
//
//   "The ambiguity is not at capture, it is downstream. A confirmation gate is
//    worth its friction only where the machine genuinely cannot act: when a fact
//    from the discarded text has ALREADY been digested and propagated."
//
// The design ruling is that this is a LANE, not a modal. Nothing here interrupts a
// scene, blocks a turn, or asks the user to re-state a choice the UI already
// recorded — the swipe index is their vote and capture follows it mechanically.
// Entangled cases are written where withheld decisions already go (the mjp held
// lane) and wait for a human.
//
// NOT GATED behind MARINARA_EXTENDER_RECONCILE. That flag exists to keep the
// CURATOR's agent spend off the always-on sidecar. This lane spends nothing — it is
// a human surface, and an entangled discard is worth recording whether or not the
// curator is running.

import type { IndexEntry, Scope } from "./storage.js";
import { appendHeld } from "./reconcile-queue.js";

/**
 * Why retiring this entry does not settle the matter, in the order the evidence
 * is worth. Empty = a clean discard; retirement is the whole fix and nothing is
 * queued.
 *
 * Every signal here is read off the index row or its siblings — no LLM, no extra
 * I/O beyond the cold index the caller already has. A detector that costs a model
 * call per re-roll would not survive contact with the live path.
 */
export function entanglementReasons(row: IndexEntry, coldRows: IndexEntry[]): string[] {
  const reasons: string[] = [];

  // The character SAID it. Strongest signal there is: the memory is already in the
  // conversation, and no amount of retiring the source retracts what was spoken.
  if ((row.recitationCount ?? 0) > 0) {
    reasons.push(`recited:${row.recitationCount}`);
  }
  // Weaker but real — it reached the prompt, so it had the chance to steer a reply
  // even if no recitation was detected.
  else if ((row.retrievalCount ?? 0) > 0) {
    reasons.push(`retrieved:${row.retrievalCount}`);
  }

  // A thread outlives the turn that seeded it. Retiring a member silently changes
  // the shape of a narrative the user can see.
  if (row.threadId) reasons.push(`thread:${row.threadId}`);

  // THE CONCRETE ORPHAN. This fact displaced an older one (FR2: facts supersede).
  // Retire it and the older fact stays dead in cold, superseded by an entry that is
  // itself retired — a dangling chain with no live fact at the end of it. Nothing
  // downstream can repair that by itself, which is exactly the design note's case.
  const displaced = coldRows.filter((c) => c.supersededBy === row.id);
  for (const d of displaced) reasons.push(`orphans:${d.id}`);

  return reasons;
}

/**
 * Record the entangled ones. Returns how many were queued.
 *
 * Never throws: this runs inside turn ingestion, and a review lane that can fail a
 * turn is worse than one that occasionally misses a record.
 */
export async function reviewDiscardedEntries(
  scope: Scope,
  scopeId: string,
  retired: IndexEntry[],
  coldRows: IndexEntry[],
): Promise<number> {
  let queued = 0;
  for (const row of retired) {
    const reasons = entanglementReasons(row, coldRows);
    if (reasons.length === 0) continue; // clean — retirement settled it
    try {
      await appendHeld({
        // Deliberately "live", not a new source value. HeldRecord.source is a
        // serialized union and widening those has bitten this codebase twice
        // (see the EntryStatus audit). The specifics live in reasons/detail,
        // which are free-form by design.
        source: "live",
        scope,
        scopeId,
        summary: `Discarded re-roll left a derivative: "${row.summary.slice(0, 120)}"`,
        reasons: ["discarded-swipe", ...reasons],
        detail: {
          entryId: row.id,
          lane: row.lane,
          sourceMessageId: row.sourceMessageId,
          sourceSwipeIndex: row.sourceSwipeIndex,
          discardedAt: row.discardedAt,
        },
        at: new Date().toISOString(),
      });
      queued++;
    } catch (e) {
      console.warn(`[ME:discard-review] could not record ${row.id} —`, e);
    }
  }
  if (queued > 0) {
    console.info(
      `[ME:discard-review] ${scope}:${scopeId} — ${queued} discarded entr${queued === 1 ? "y" : "ies"} had derivatives; queued for review`,
    );
  }
  return queued;
}
