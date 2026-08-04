// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Live FR1 reconciliation queue (MarinaraExtender-b4n). When the live save path's
// structural dedup (dedup.ts `decide()`) is about to DROP a new durable fact as a
// duplicate of an existing same-subject one, it appends the collision here — a
// cheap, SDK-free, fire-and-forget write. A SEPARATE drain (scripts/reconcile-
// queue.mjs -> reconcile.ts drainReconcileQueue) runs the curator over the queue
// out-of-band, so the agentic loop and its subscription spend never touch the
// always-on sidecar or add turn latency.
//
// Gated by MARINARA_EXTENDER_RECONCILE: with the flag unset the live path never
// enqueues, the queue never grows, and behaviour is byte-identical to today.
//
// This module depends ONLY on storage (no Agent SDK, no cycle) so dedup.ts can
// import it without dragging the curator into the live bundle.

import { join } from "node:path";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import type { Scope, Lane } from "./storage.js";
import { getDataDir, mutateYamlFile, readYamlFile } from "./storage.js";

export function queueEnabled(): boolean {
  const v = process.env.MARINARA_EXTENDER_RECONCILE?.trim();
  return v === "1" || v?.toLowerCase() === "on";
}

// A collision flagged by the live FR1 detector, awaiting curation.
export interface ReconcileTask {
  id: string;
  scope: Scope;
  scopeId: string;          // the ledger the collision happened in
  lane: Lane;
  summary: string;          // the candidate fact (what the structural rule dropped)
  content: string;
  againstId: string;        // the stored entry the structural rule matched it to
  againstSummary: string;
  structuralAction: "skip"; // v1 enqueues only the drop-as-dup case
  sourceChatId?: string;
  enqueuedAt: string;
}

interface QueueFile { tasks: ReconcileTask[] }

const QUEUE_DIR = (): string => join(getDataDir(), "reconcile-queue");
const queuePath = (): string => join(QUEUE_DIR(), "pending.yaml");
const auditPath = (): string => join(QUEUE_DIR(), "audit.jsonl");

let seq = 0;
const newTaskId = (): string => `rq-${Date.now().toString(36)}-${(seq++).toString(36)}`;

// Append a collision for later curation. Advisory: callers fire-and-forget so a
// queue hiccup never blocks or fails a live save (mirrors recordSupersessionCandidate).
export async function enqueueReconcileTask(t: Omit<ReconcileTask, "id" | "enqueuedAt">): Promise<void> {
  await mutateYamlFile<QueueFile>(queuePath(), () => ({ tasks: [] }), (q) => {
    // Coalesce: the same candidate against the same stored entry shouldn't queue
    // twice while still pending (a regen/swipe restating the same fact).
    const dup = q.tasks.some(
      (x) => x.scope === t.scope && x.scopeId === t.scopeId && x.againstId === t.againstId && x.summary === t.summary,
    );
    if (!dup) q.tasks.push({ ...t, id: newTaskId(), enqueuedAt: new Date().toISOString() });
  });
}

export async function readQueue(): Promise<ReconcileTask[]> {
  return (await readYamlFile<QueueFile>(queuePath()))?.tasks ?? [];
}

// Remove handled tasks by id (the drain calls this after recording each batch).
export async function removeTasks(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const set = new Set(ids);
  await mutateYamlFile<QueueFile>(queuePath(), () => ({ tasks: [] }), (q) => {
    q.tasks = q.tasks.filter((t) => !set.has(t.id));
  });
}

// Append-only audit of every curated task (shadow or apply). Pairs with FR4/3pl.
export interface AuditRecord {
  taskId: string;
  mode: "shadow" | "apply";
  scope: Scope;
  scopeId: string;
  candidate: string;
  againstId: string;
  verdict: string | null;   // CuratorDecision.verdict, or null if the curator declined/failed
  confidence?: string;      // high | medium | low — the lever for the apply gate (see b4n)
  targetId?: string;
  rationale?: string;
  applied?: { createdId?: string; supersededId?: string };
  at: string;
}

export async function appendAudit(rec: AuditRecord): Promise<void> {
  await mkdir(QUEUE_DIR(), { recursive: true });
  await appendFile(auditPath(), JSON.stringify(rec) + "\n", "utf8");
}

export function auditFilePath(): string {
  return auditPath();
}

// ── Ledger hygiene sweep audit (0kk) ─────────────────────────────────────────
// Cluster-level decisions go to a SEPARATE log so a grep of sweep activity isn't
// tangled with live-collision (b4n) decisions.
const sweepAuditPath = (): string => join(QUEUE_DIR(), "sweep-audit.jsonl");

export interface SweepAuditRecord {
  mode: "shadow" | "apply";
  scope: Scope;
  scopeId: string;
  clusterIds: string[];
  verdict: string | null;   // merge | distinct | null (curator failed)
  canonicalId?: string;
  redundantIds?: string[];
  confidence?: string;
  rationale?: string;
  applied?: { supersededIds: string[] };
  at: string;
}

export async function appendSweepAudit(rec: SweepAuditRecord): Promise<void> {
  await mkdir(QUEUE_DIR(), { recursive: true });
  await appendFile(sweepAuditPath(), JSON.stringify(rec) + "\n", "utf8");
}

export function sweepAuditFilePath(): string {
  return sweepAuditPath();
}

// ── Held review lane (mjp) ───────────────────────────────────────────────────
// When the apply gate withholds a verdict (domain-sensitive, or below the
// confidence bar), it is NOT applied and NOT dropped — it lands here with the
// reasons, for a human to confirm or discard.
const heldPath = (): string => join(QUEUE_DIR(), "held.jsonl");

export interface HeldRecord {
  source: "sweep" | "live";
  scope: Scope;
  scopeId: string;
  summary: string;       // human-readable description of what was withheld
  confidence?: string;
  reasons: string[];     // why held — e.g. ["domain:trauma", "confidence:medium"]
  detail?: unknown;      // ids etc., enough to act on if a human promotes it
  at: string;
  /**
   * Stable handle, so a reader can act on one record (4z0h). Assigned on append
   * when the caller does not supply one; records written before this existed
   * have none and are addressed by their `at` timestamp instead.
   */
  id?: string;
  /**
   * ISO datetime the human settled it. The lane holds what is OUTSTANDING, so a
   * resolved record drops out of readHeld — but it is stamped rather than
   * deleted, because this file is also the only record that the withholding
   * happened at all.
   */
  resolvedAt?: string;
}

export async function appendHeld(rec: HeldRecord): Promise<void> {
  await mkdir(QUEUE_DIR(), { recursive: true });
  const withId: HeldRecord = { ...rec, id: rec.id ?? `hl-${Date.now().toString(36)}-${(seq++).toString(36)}` };
  await appendFile(heldPath(), JSON.stringify(withId) + "\n", "utf8");
}

/**
 * Outstanding held records, newest first. Unparseable lines are skipped rather
 * than throwing: this is an append-only log written by several producers, and one
 * torn line must not take down the whole lane.
 */
export async function readHeld(): Promise<HeldRecord[]> {
  let raw: string;
  try {
    raw = await readFile(heldPath(), "utf8");
  } catch {
    return [];
  }
  const out: HeldRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as HeldRecord;
      if (!rec.resolvedAt) out.push(rec);
    } catch { /* torn line — skip it, keep the lane */ }
  }
  return out.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
}

/**
 * Mark held records settled. Returns how many were stamped.
 *
 * Rewrites the file rather than appending a tombstone: the lane is small by
 * design (only entangled cases reach it) and a single pass keeps "what is
 * outstanding" a property of the file itself rather than of a replay.
 */
export async function resolveHeld(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const want = new Set(ids);
  const now = new Date().toISOString();
  let raw: string;
  try {
    raw = await readFile(heldPath(), "utf8");
  } catch {
    return 0;
  }
  let stamped = 0;
  const lines: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as HeldRecord;
      if (rec.id && want.has(rec.id) && !rec.resolvedAt) {
        rec.resolvedAt = now;
        stamped++;
      }
      lines.push(JSON.stringify(rec));
    } catch {
      lines.push(line); // preserve what we could not parse
    }
  }
  if (stamped > 0) await writeFile(heldPath(), lines.join("\n") + "\n", "utf8");
  return stamped;
}

export function heldFilePath(): string {
  return heldPath();
}

// ── Rollback audit (3pl) ─────────────────────────────────────────────────────
// Human-initiated rollbacks are recorded too, so the audit trail covers undo as
// well as apply.
const rollbackAuditPath = (): string => join(QUEUE_DIR(), "rollback.jsonl");

export interface RollbackRecord {
  scope: Scope;
  scopeId: string;
  restored: string;        // the entry brought back to active
  replacement: string | null; // the entry that had superseded it
  flipped: boolean;        // true = the replacement was re-superseded by the restored entry
  at: string;
}

export async function appendRollbackAudit(rec: RollbackRecord): Promise<void> {
  await mkdir(QUEUE_DIR(), { recursive: true });
  await appendFile(rollbackAuditPath(), JSON.stringify(rec) + "\n", "utf8");
}

export function rollbackAuditFilePath(): string {
  return rollbackAuditPath();
}
