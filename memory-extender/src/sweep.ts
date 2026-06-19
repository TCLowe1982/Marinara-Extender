// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Ledger hygiene sweep (MarinaraExtender-0kk). The live curator (b4n) catches new
// facts colliding at the door; this sweeps EXISTING intra-ledger duplicates that
// accumulated before reconciliation existed (and from force-creates). It clusters
// stored FACT entries by lexical similarity and hands each multi-member cluster to
// the cluster-adjudication curator (reconcile.ts clusterCurator) to pick a
// canonical entry and retire the redundant ones — CLUSTER-AT-ONCE, because the
// measured max fact-cluster on a real 1.3k-fact ledger is 4 (incident boilerplate,
// which blows up to ~900, is excluded — not the curator's domain).
//
// Shadow-first like b4n: logs proposed merges, applies nothing; --apply executes
// the supersessions (FR2 tier move, recoverable from cold).

import { join, dirname } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { Scope } from "./storage.js";
import { readIndex, readEntry, supersedeEntry, getDataDir, readYamlFile } from "./storage.js";
import { clusterCurator, type ClusterMember, type ClusterVerdict } from "./reconcile.js";
import { appendSweepAudit } from "./reconcile-queue.js";

export const SWEEP_THRESHOLD = 0.5; // jaccard; the curator is the precision gate, so this trades recall vs cost
export const SWEEP_CLUSTER_CAP = 12; // guardrail — skip pathological clusters (current data maxes at 4)

// A fact the sweep may touch: active, durable, NOT a thread or anything with a
// bracket-tag summary prefix. The broad `^[` test (not dedup's looksIncident,
// which is `^\[\w+\]` and misses "[scene recap]" because of the space) excludes
// BOTH incident beats ("[emotion] …") and scene recaps ("[scene recap] …") — both
// of which boilerplate-cluster and are handled by other layers, not the fact
// sweep. This matches the population the cluster-size measurement was taken on.
export function isFactEntry(e: { lane: string; summary: string; supersededBy?: string }): boolean {
  return !e.supersededBy && e.lane !== "open_threads" && !/^\s*\[/.test(e.summary);
}

const tokensOf = (s: string): Set<string> =>
  new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3));
const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

// Union-find cluster the FACT entries by summary-token jaccard. Returns
// multi-member clusters only; clusters over `cap` are flagged oversized so the
// sweep can skip them (guardrail). Pure + exported for offline tests.
export function clusterFacts(
  entries: { id: string; lane: string; summary: string; supersededBy?: string }[],
  opts?: { threshold?: number; cap?: number },
): { memberIds: string[]; oversized: boolean }[] {
  const T = opts?.threshold ?? SWEEP_THRESHOLD;
  const cap = opts?.cap ?? SWEEP_CLUSTER_CAP;
  const facts = entries.filter(isFactEntry);
  const toks = facts.map((e) => tokensOf(e.summary));

  // Inverted index: only entries sharing a token are candidate pairs.
  const byTok = new Map<string, number[]>();
  toks.forEach((s, i) => s.forEach((tk) => { const a = byTok.get(tk); if (a) a.push(i); else byTok.set(tk, [i]); }));

  const parent = facts.map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]!; } return x; };
  const seen = new Set<number>();
  for (const arr of byTok.values()) {
    for (let a = 0; a < arr.length; a++) {
      for (let b = a + 1; b < arr.length; b++) {
        const i = arr[a]!, j = arr[b]!;
        const key = i < j ? i * 1e6 + j : j * 1e6 + i;
        if (seen.has(key)) continue;
        seen.add(key);
        if (jaccard(toks[i]!, toks[j]!) >= T) parent[find(i)] = find(j);
      }
    }
  }

  const groups = new Map<number, string[]>();
  facts.forEach((e, i) => { const r = find(i); const g = groups.get(r); if (g) g.push(e.id); else groups.set(r, [e.id]); });
  return [...groups.values()].filter((m) => m.length > 1).map((memberIds) => ({ memberIds, oversized: memberIds.length > cap }));
}

export type ClusterCurateFn = (members: ClusterMember[]) => Promise<ClusterVerdict | null>;

// One reviewed merge in the sweep ledger.
export interface SweepMerge {
  clusterIds: string[];
  canonicalId: string;
  redundantIds: string[];
  rationale: string;
  confidence?: string;
}
interface SweepLedgerFile { scope: Scope; scopeId: string; builtAt: string; merges: SweepMerge[] }

const sweepLedgerPath = (scope: Scope, scopeId: string): string =>
  join(getDataDir(), "reconcile-queue", "sweep-ledger", `${scope}__${scopeId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

export async function readSweepLedger(scope: Scope, scopeId: string): Promise<SweepLedgerFile | null> {
  return readYamlFile<SweepLedgerFile>(sweepLedgerPath(scope, scopeId));
}

// SHADOW / build: cluster the ledger, adjudicate each cluster, and PERSIST the
// proposed merges to a reviewable ledger (+ audit). Applies NOTHING. The ledger is
// the replayable artifact — apply replays it verbatim, so what you review is what
// gets written (the preview==apply guarantee; an agent loop is non-deterministic,
// so re-running on apply would diverge from review). `curate` is injectable.
export async function buildSweepLedger(
  scope: Scope,
  scopeId: string,
  opts?: { threshold?: number; cap?: number; limit?: number; curate?: ClusterCurateFn },
): Promise<{ clusters: number; oversizedSkipped: number; adjudicated: number; merges: number }> {
  const curate = opts?.curate ?? clusterCurator;
  const idx = await readIndex(scope, scopeId);
  const entries = idx?.entries ?? [];

  const all = clusterFacts(entries, { threshold: opts?.threshold, cap: opts?.cap });
  const oversizedSkipped = all.filter((c) => c.oversized).length;
  let clusters = all.filter((c) => !c.oversized);
  if (opts?.limit && opts.limit > 0) clusters = clusters.slice(0, opts.limit);

  let adjudicated = 0;
  const merges: SweepMerge[] = [];

  for (const c of clusters) {
    const members: ClusterMember[] = [];
    for (const id of c.memberIds) {
      const row = entries.find((e) => e.id === id);
      if (!row) continue;
      const entry = await readEntry(scope, scopeId, row.path);
      members.push({ id, summary: row.summary, content: entry?.content ?? row.summary });
    }
    if (members.length < 2) continue;

    let verdict: ClusterVerdict | null = null;
    try {
      verdict = await curate(members);
    } catch {
      verdict = null; // one cluster failing never aborts the sweep
    }
    if (verdict) adjudicated++;
    if (verdict?.verdict === "merge" && verdict.canonicalId && verdict.redundantIds?.length) {
      merges.push({ clusterIds: c.memberIds, canonicalId: verdict.canonicalId, redundantIds: verdict.redundantIds, rationale: verdict.rationale, confidence: verdict.confidence });
    }

    await appendSweepAudit({
      mode: "shadow", scope, scopeId,
      clusterIds: c.memberIds,
      verdict: verdict?.verdict ?? null,
      canonicalId: verdict?.canonicalId,
      redundantIds: verdict?.redundantIds,
      confidence: verdict?.confidence,
      rationale: verdict?.rationale,
      at: new Date().toISOString(),
    });
  }

  await mkdir(dirname(sweepLedgerPath(scope, scopeId)), { recursive: true });
  await writeFile(sweepLedgerPath(scope, scopeId), JSON.stringify({ scope, scopeId, builtAt: new Date().toISOString(), merges }, null, 2), "utf8");
  return { clusters: clusters.length, oversizedSkipped, adjudicated, merges: merges.length };
}

// APPLY / replay: execute EXACTLY the merges in the ledger a prior build produced
// — no curator re-run. Supersedes each redundant entry by its canonical (FR2 tier
// move, recoverable from cold). The ledger is hand-editable between build and
// apply, so you can drop a merge you don't trust before running this.
export async function applySweepLedger(scope: Scope, scopeId: string): Promise<{ merges: number; superseded: number } | null> {
  const led = await readSweepLedger(scope, scopeId);
  if (!led) return null;
  let superseded = 0;
  for (const m of led.merges) {
    const done: string[] = [];
    for (const rid of m.redundantIds) {
      if (await supersedeEntry(scope, scopeId, rid, m.canonicalId)) { done.push(rid); superseded++; }
    }
    await appendSweepAudit({
      mode: "apply", scope, scopeId,
      clusterIds: m.clusterIds, verdict: "merge",
      canonicalId: m.canonicalId, redundantIds: m.redundantIds,
      confidence: m.confidence, rationale: m.rationale,
      applied: { supersededIds: done }, at: new Date().toISOString(),
    });
  }
  return { merges: led.merges.length, superseded };
}
