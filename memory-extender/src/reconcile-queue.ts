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
import { appendFile, mkdir } from "node:fs/promises";
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
