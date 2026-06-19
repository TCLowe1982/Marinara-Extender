// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Supersession history + rollback (MarinaraExtender-3pl, FR4). The human-in-the-
// loop undo for the reconciliation curator: when a merge was wrong, surface a
// fact's supersession history and restore the retired fact.
//
// Rollback is ALWAYS user-initiated — never automatic. A rollback exists because
// the automation got a merge wrong; the system can't reliably detect its own bad
// merges (if it could, it wouldn't make them), and auto-undo would risk
// oscillation. The system's job is to make rollback POSSIBLE (the FR2 supersede
// links + restoreSupersededEntry) and INFORMED (this history view + the audit
// trail); the human decides and pulls the trigger.
//
// Two modes:
//   - undo (default): restore the retired fact to active; its replacement stays
//     active too (the "they were never duplicates" case). Both live.
//   - flip: restore the retired fact AND re-supersede its replacement by it (the
//     "curator picked the wrong canonical" case). The direction is swapped.

import type { Scope } from "./storage.js";
import { readIndex, readColdIndex, restoreSupersededEntry, supersedeEntry } from "./storage.js";
import { appendRollbackAudit } from "./reconcile-queue.js";

export interface SupersessionHistory {
  id: string;
  status: "active" | "superseded" | "missing";
  summary?: string;
  supersededBy?: string;        // if this entry was retired, the id that replaced it
  supersededAt?: string;
  superseded: { id: string; summary: string; supersededAt?: string }[]; // entries THIS one is the canonical of
}

// A fact's supersession history: whether it's active or retired, what retired it,
// and what it (as a canonical) retired. Reads both hot and cold indexes.
export async function factHistory(scope: Scope, scopeId: string, id: string): Promise<SupersessionHistory> {
  const hot = await readIndex(scope, scopeId);
  const cold = await readColdIndex(scope, scopeId);
  const all = [...(hot?.entries ?? []), ...(cold?.entries ?? [])];
  const self = all.find((e) => e.id === id);
  const superseded = all
    .filter((e) => e.supersededBy === id)
    .map((e) => ({ id: e.id, summary: e.summary, supersededAt: e.supersededAt }));
  return {
    id,
    status: !self ? "missing" : self.supersededBy ? "superseded" : "active",
    summary: self?.summary,
    supersededBy: self?.supersededBy,
    supersededAt: self?.supersededAt,
    superseded,
  };
}

// The retired (superseded) entries for a ledger, each with the fact that replaced
// it — the data the ledger UI's "Retired" section renders. Superseded entries
// live in cold; the replacement is usually active in hot (but may itself be cold
// if later superseded), so look in both.
export async function listRetired(
  scope: Scope,
  scopeId: string,
): Promise<{ id: string; summary: string; supersededAt?: string; replacedBy: { id: string; summary: string } | null }[]> {
  const hot = await readIndex(scope, scopeId);
  const cold = await readColdIndex(scope, scopeId);
  const byId = new Map([...(hot?.entries ?? []), ...(cold?.entries ?? [])].map((e) => [e.id, e]));
  return (cold?.entries ?? [])
    .filter((e) => e.supersededBy)
    .map((e) => {
      const rep = e.supersededBy ? byId.get(e.supersededBy) : undefined;
      return { id: e.id, summary: e.summary, supersededAt: e.supersededAt, replacedBy: rep ? { id: rep.id, summary: rep.summary } : null };
    })
    .sort((a, b) => (b.supersededAt ?? "").localeCompare(a.supersededAt ?? "")); // newest retirement first
}

// Roll back a supersession. `supersededId` is the RETIRED entry to bring back.
// undo (default): restore it; its replacement stays active. flip: also re-supersede
// the replacement by the restored entry. Returns null if `supersededId` isn't a
// superseded entry. Audited.
export async function rollback(
  scope: Scope,
  scopeId: string,
  supersededId: string,
  opts?: { flip?: boolean },
): Promise<{ restored: string; replacement: string | null; flipped: boolean } | null> {
  const res = await restoreSupersededEntry(scope, scopeId, supersededId);
  if (!res) return null; // not a superseded entry

  let flipped = false;
  if (opts?.flip && res.replacedBy) {
    // The "wrong canonical" case: retire the replacement in favour of the restored entry.
    flipped = await supersedeEntry(scope, scopeId, res.replacedBy, supersededId);
  }

  await appendRollbackAudit({
    scope, scopeId, restored: supersededId, replacement: res.replacedBy, flipped, at: new Date().toISOString(),
  });
  return { restored: supersededId, replacement: res.replacedBy, flipped };
}
