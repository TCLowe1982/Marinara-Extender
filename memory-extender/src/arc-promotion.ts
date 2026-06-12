// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Through-line arc promotion — the recap layer CEILING (MarinaraExtender-ajb).
//
// Assign-on-promotion: arc identity is inferred with hindsight, off the hot
// path. The pass is cheap-then-confirm per the binding-signal stack:
//   CANDIDATE GENERATORS (union, no LLM): shared narrative threadId;
//   entity-name overlap (2+); embedding-kNN cosine over beat summaries.
//   CONFIRMATION: one renderer LLM call per touched arc decides final
//   membership (causal/topical), labels the arc, and renders the recap.
//
// MATCH-BEFORE-MINT (H1): clusters reconcile against existing arc signatures
// (threadIds > centroid > entities) before any new Arc.id is minted — the
// system accretes instead of re-summarizing. Dormant arcs only reactivate on
// a threadId hit or centroid match, never mere entity presence (H4).
// Edge salience = recency x entity-prominence x beat.salience, normalized,
// with a high-salience floor so turning points never decay away (Resolved #3).
// Centroids recompute once per pass, not per beat (Resolved #4).

import { join } from "path";
import {
  getDataDir,
  readYamlFile,
  mutateYamlFile,
  writeEntry,
  upsertIndexEntry,
  estimateTokens,
  assertSafeId,
} from "./storage.js";
import { readBeatIndex, type BeatIndexEntry } from "./sentiment/encoder.js";
import { readArcs, readArcMemberships, type Arc, type ArcMembership, type RecapEntry } from "./arcs.js";
import { buildSubjectRoster } from "./identity.js";
import { normalizeLabel } from "./aliases.js";
import { fetchEmbeddings, cosineSim, meanVector } from "./embeddings.js";
import { renderArc, type ArcRenderFn, type RenderBeat } from "./arc-renderer.js";
import { nanoid } from "./nanoid.js";

// ── Tuning knobs ──────────────────────────────────────────────────────────────

const CANDIDATE_SALIENCE_MIN = 0.55; // promotion-eligible: proven emotional weight
const CANDIDATE_CAP = 80;            // newest-first per pass — bounds LLM + embed cost
const MIN_CLUSTER_SIZE = 3;          // smaller clusters wait for more evidence
const EMBED_EDGE_TAU = 0.62;         // kNN pair edge threshold
const CENTROID_MATCH_TAU = 0.7;      // cluster→arc centroid match (also H4 reactivation)
const ENTITY_JACCARD_TAU = 0.5;      // cluster→arc entity match (active arcs only)
const ARC_DORMANT_DAYS = 21;         // untouched active arcs quiesce
const SALIENCE_RECENCY_HALFLIFE_DAYS = 30;
const SALIENCE_FLOOR_THRESHOLD = 0.8; // Resolved #3: high-salience floor…
const SALIENCE_FLOOR_RETAIN = 0.7;    // …keeps at least 70% of intrinsic salience

// ── Embedding cache (per character, newest-capped) ───────────────────────────

interface EmbedCache { model?: string; vectors: Record<string, number[]> }
const EMBED_CACHE_CAP = 600;

function embedCachePath(identityKey: string): string {
  assertSafeId(identityKey);
  return join(getDataDir(), "characters", identityKey, "beat-embeddings.yaml");
}

async function getEmbeddings(
  identityKey: string,
  beats: Array<{ id: string; text: string }>,
): Promise<Map<string, number[]>> {
  const cache = (await readYamlFile<EmbedCache>(embedCachePath(identityKey))) ?? { vectors: {} };
  const out = new Map<string, number[]>();
  const missing: Array<{ id: string; text: string }> = [];
  for (const b of beats) {
    const v = cache.vectors[b.id];
    if (v) out.set(b.id, v);
    else missing.push(b);
  }
  if (missing.length > 0) {
    const fetched = await fetchEmbeddings(missing.map((m) => m.text));
    if (fetched) {
      await mutateYamlFile<EmbedCache>(embedCachePath(identityKey), () => ({ vectors: {} }), (c) => {
        missing.forEach((m, i) => { c.vectors[m.id] = fetched[i]!; });
        // Cap: drop oldest-inserted overflow (object key order ≈ insertion).
        const keys = Object.keys(c.vectors);
        for (let i = 0; i < keys.length - EMBED_CACHE_CAP; i++) delete c.vectors[keys[i]!];
      });
      missing.forEach((m, i) => out.set(m.id, fetched[i]!));
    }
  }
  return out;
}

// ── Signals ───────────────────────────────────────────────────────────────────

function beatEntities(b: BeatIndexEntry, rosterNorms: Map<string, string>, beatText: string): string[] {
  const hay = normalizeLabel(`${b.speaker} ${beatText}`);
  const found: string[] = [];
  for (const [norm, display] of rosterNorms) {
    if (norm && hay.includes(norm)) found.push(display);
  }
  return found;
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a); const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

// Union-find clustering over the three cheap generators.
function clusterCandidates(
  beats: BeatIndexEntry[],
  entities: Map<string, string[]>,
  vectors: Map<string, number[]>,
): BeatIndexEntry[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => { parent.set(find(a), find(b)); };
  for (const b of beats) parent.set(b.id, b.id);

  for (let i = 0; i < beats.length; i++) {
    for (let j = i + 1; j < beats.length; j++) {
      const a = beats[i]!; const b = beats[j]!;
      const threadHit = !!a.threadId && a.threadId === b.threadId;
      const entityHit = jaccardOverlapCount(entities.get(a.id) ?? [], entities.get(b.id) ?? []) >= 2;
      const va = vectors.get(a.id); const vb = vectors.get(b.id);
      const knnHit = !!va && !!vb && cosineSim(va, vb) >= EMBED_EDGE_TAU;
      if (threadHit || entityHit || knnHit) union(a.id, b.id);
    }
  }

  const groups = new Map<string, BeatIndexEntry[]>();
  for (const b of beats) {
    const root = find(b.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(b);
  }
  return [...groups.values()];
}

function jaccardOverlapCount(a: string[], b: string[]): number {
  const sb = new Set(b);
  return a.filter((x) => sb.has(x)).length;
}

// Edge salience per Resolved #3.
function edgeSalience(b: BeatIndexEntry, arcEntities: string[], beatEnts: string[], now: number): number {
  const ageDays = Math.max(0, (now - Date.parse(b.created || "")) / 86_400_000) || 0;
  const recency = Math.pow(0.5, ageDays / SALIENCE_RECENCY_HALFLIFE_DAYS);
  const prominence = arcEntities.length > 0 && beatEnts.length > 0
    ? Math.min(1, jaccardOverlapCount(beatEnts, arcEntities) / Math.max(1, beatEnts.length))
    : 0.5;
  let s = recency * (0.5 + prominence / 2) * b.salience;
  if (b.salience > SALIENCE_FLOOR_THRESHOLD) {
    s = Math.max(s, b.salience * SALIENCE_FLOOR_RETAIN); // turning points never decay away
  }
  return Math.min(1, s);
}

// ── The pass ──────────────────────────────────────────────────────────────────

export interface ArcPromotionResult {
  candidates: number;
  clusters: number;
  extended: number;
  minted: number;
  rejectedByRenderer: number;
  dormanted: number;
}

export async function runArcPromotion(
  identityKey: string,
  characterName?: string,
  render: ArcRenderFn = renderArc,
): Promise<ArcPromotionResult> {
  const result: ArcPromotionResult = { candidates: 0, clusters: 0, extended: 0, minted: 0, rejectedByRenderer: 0, dormanted: 0 };
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const [beatIndex, arcFile, memberships, rosterNames] = await Promise.all([
    readBeatIndex(identityKey),
    readArcs(identityKey),
    readArcMemberships(identityKey),
    buildSubjectRoster(characterName),
  ]);
  if (!beatIndex || beatIndex.entries.length === 0) return result;

  const throughLines = arcFile.arcs.filter((a) => a.kind === "through_line");
  const boundBeatIds = new Set(
    memberships.filter((m) => throughLines.some((a) => a.id === m.arcId)).map((m) => m.beatId),
  );

  // Promotion-eligible candidates: salient, unbound, newest first, capped.
  const candidates = beatIndex.entries
    .filter((b) => b.salience >= CANDIDATE_SALIENCE_MIN && !boundBeatIds.has(b.id))
    .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
    .slice(0, CANDIDATE_CAP);
  result.candidates = candidates.length;

  // Dormancy sweep runs even when there is nothing new (H4 lifecycle).
  const dormantCutoff = now - ARC_DORMANT_DAYS * 86_400_000;
  for (const a of throughLines) {
    if (a.status === "active" && (Date.parse(a.lastPromotedAt) || 0) < dormantCutoff) {
      a.status = "dormant";
      result.dormanted++;
    }
  }

  if (candidates.length < MIN_CLUSTER_SIZE) {
    if (result.dormanted > 0) await persistArcs(identityKey, arcFile.arcs);
    return result;
  }

  // Signals. Beat "text" for embedding = the summary-style line the renderer
  // also sees (emotion + index summary surrogate: speaker + emotion + id text
  // is not available on the index row, so we embed what we have — the
  // companion summary equivalent lives on the beat file; index carries enough
  // for v1: emotion + speaker; refine post-tuning if surface-clustering bites).
  const rosterNorms = new Map(rosterNames.map((n) => [normalizeLabel(n), n] as const));
  const { readBeat } = await import("./sentiment/encoder.js");
  const texts = new Map<string, string>();
  const entities = new Map<string, string[]>();
  for (const b of candidates) {
    const beat = await readBeat(identityKey, b.id);
    const text = beat ? `[${b.emotion}] ${beat.motivation}` : `[${b.emotion}] ${b.speaker}`;
    texts.set(b.id, text);
    entities.set(b.id, beatEntities(b, rosterNorms, beat ? `${beat.motivation} ${beat.text}` : ""));
  }
  const vectors = await getEmbeddings(identityKey, candidates.map((b) => ({ id: b.id, text: texts.get(b.id)! })));

  const clusters = clusterCandidates(candidates, entities, vectors).filter((c) => c.length >= MIN_CLUSTER_SIZE);
  result.clusters = clusters.length;

  for (const cluster of clusters) {
    const clusterThreadIds = [...new Set(cluster.map((b) => b.threadId).filter((x): x is string => !!x))];
    const clusterEntities = [...new Set(cluster.flatMap((b) => entities.get(b.id) ?? []))];
    const clusterVectors = cluster.map((b) => vectors.get(b.id)).filter((v): v is number[] => !!v);
    const clusterCentroid = meanVector(clusterVectors);

    // MATCH-BEFORE-MINT. Dormant arcs need threadId or centroid (H4);
    // active arcs may also match on entities.
    let matched: Arc | null = null;
    for (const a of throughLines) {
      const threadHit = a.signature.threadIds.some((t) => clusterThreadIds.includes(t));
      const centroidHit = a.signature.centroid.length > 0 && clusterCentroid.length > 0 &&
        cosineSim(a.signature.centroid, clusterCentroid) >= CENTROID_MATCH_TAU;
      const entityHit = a.status === "active" && jaccard(a.signature.entities, clusterEntities) >= ENTITY_JACCARD_TAU;
      if (threadHit || centroidHit || entityHit) { matched = a; break; }
    }

    const arc: Arc = matched ?? {
      id: `arc-${nanoid(10)}`,
      kind: "through_line",
      origin: "promotion",
      lane: "character_topics",
      label: "",
      status: "active",
      scope: { characterId: identityKey },
      signature: { entities: [], threadIds: [], centroid: [] },
      watermark: { coveredThroughSeq: 0, version: 0 },
      created: nowIso,
      lastPromotedAt: nowIso,
    };

    // Renderer input: existing members (for accretion) + the cluster as candidates.
    const existingMemberIds = memberships.filter((m) => m.arcId === arc.id).map((m) => m.beatId);
    const renderBeats: RenderBeat[] = [];
    for (const id of [...existingMemberIds, ...cluster.map((b) => b.id)]) {
      const row = beatIndex.entries.find((e) => e.id === id);
      if (!row) continue;
      renderBeats.push({ beatId: id, date: row.created, summary: texts.get(id) ?? `[${row.emotion}] ${row.speaker}` });
    }
    renderBeats.sort((a, b) => a.date.localeCompare(b.date));
    const gaps = deriveGaps(renderBeats);

    const prior = matched ? await readPriorRecap(identityKey, arc.id) : null;
    const rendered = await render({
      characterName: characterName ?? identityKey,
      priorLabel: matched?.label || undefined,
      priorRecap: prior?.content,
      beats: renderBeats,
      candidateIds: cluster.map((b) => b.id),
      gaps,
    });
    if (!rendered) { result.rejectedByRenderer++; continue; }

    const kept = new Set(rendered.members.filter((m) => m.keep).map((m) => m.beatId));
    const newMembers = cluster.filter((b) => kept.has(b.id));
    if (!matched && newMembers.length < MIN_CLUSTER_SIZE) { result.rejectedByRenderer++; continue; }

    // Commit: arc signature/watermark/centroid (Resolved #4: once per pass),
    // memberships with heuristic edge salience, the recap entry (stable id).
    arc.label = rendered.label || arc.label || "unnamed arc";
    arc.status = "active";
    arc.signature.threadIds = [...new Set([...arc.signature.threadIds, ...clusterThreadIds])];
    arc.signature.entities = [...new Set([...arc.signature.entities, ...clusterEntities])];
    const allMemberVectors = [...clusterVectors, ...(arc.signature.centroid.length ? [arc.signature.centroid] : [])];
    arc.signature.centroid = meanVector(allMemberVectors);
    arc.watermark = {
      coveredThroughSeq: Math.max(arc.watermark.coveredThroughSeq, ...newMembers.map((b) => b.seq ?? 0)),
      version: arc.watermark.version + 1,
    };
    arc.lastPromotedAt = nowIso;
    if (matched) result.extended++; else { throughLines.push(arc); arcFile.arcs.push(arc); result.minted++; }

    const roleById = new Map(rendered.members.map((m) => [m.beatId, m.role] as const));
    const newEdges: ArcMembership[] = newMembers.map((b) => ({
      arcId: arc.id,
      beatId: b.id,
      role: roleById.get(b.id) ?? "minor",
      salience: edgeSalience(b, arc.signature.entities, entities.get(b.id) ?? [], now),
      addedAt: nowIso,
    }));
    await appendMemberships(identityKey, newEdges);
    memberships.push(...newEdges);
    for (const e of newEdges) boundBeatIds.add(e.beatId);

    await writeArcRecap(identityKey, arc, rendered.lead, rendered.body, memberships);
    console.info(
      `[ME:arcs] ${matched ? "extended" : "minted"} through-line "${arc.label}" (${arc.id}) — +${newMembers.length} beat(s), v${arc.watermark.version}`,
    );
  }

  await persistArcs(identityKey, arcFile.arcs);
  return result;
}

// ── Persistence helpers ───────────────────────────────────────────────────────

function arcsPath(identityKey: string): string {
  assertSafeId(identityKey);
  return join(getDataDir(), "characters", identityKey, "arcs.yaml");
}
function membershipsPath(identityKey: string): string {
  assertSafeId(identityKey);
  return join(getDataDir(), "characters", identityKey, "arc-memberships.yaml");
}

async function persistArcs(identityKey: string, arcs: Arc[]): Promise<void> {
  await mutateYamlFile<{ arcs: Arc[]; ingestedScenes: Record<string, string> }>(
    arcsPath(identityKey),
    () => ({ arcs: [], ingestedScenes: {} }),
    (f) => { f.arcs = arcs; },
  );
}

async function appendMemberships(identityKey: string, edges: ArcMembership[]): Promise<void> {
  if (edges.length === 0) return;
  await mutateYamlFile<{ memberships: ArcMembership[] }>(
    membershipsPath(identityKey),
    () => ({ memberships: [] }),
    (f) => { f.memberships.push(...edges); },
  );
}

async function readPriorRecap(identityKey: string, arcId: string): Promise<RecapEntry | null> {
  const { readIndex, readEntry } = await import("./storage.js");
  const idx = await readIndex("character", identityKey);
  const row = idx?.entries.find((e) => e.id === `recap-${arcId}`);
  if (!row) return null;
  return (await readEntry("character", identityKey, row.path)) as RecapEntry | null;
}

async function writeArcRecap(
  identityKey: string,
  arc: Arc,
  lead: string,
  body: string,
  memberships: ArcMembership[],
): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const footnotes = memberships
    .filter((m) => m.arcId === arc.id)
    .sort((a, b) => b.salience - a.salience)
    .slice(0, 8)
    .map((m) => m.beatId);
  const recap: RecapEntry = {
    id: `recap-${arc.id}`, // stable — the recap UPDATES in place as the arc accretes
    kind: "recap",
    arcId: arc.id,
    lane: arc.lane,
    summary: `[arc recap] ${arc.label} — ${lead}`.slice(0, 200),
    status: "open",
    created: date,
    lastAccessed: date,
    content: body,
    tokens: estimateTokens(body),
    footnoteBeatIds: footnotes,
  };
  const path = await writeEntry("character", identityKey, recap);
  await upsertIndexEntry("character", identityKey, {
    id: recap.id,
    path,
    summary: recap.summary,
    tokens: recap.tokens,
    lane: recap.lane,
    status: "open",
    lastAccessed: date,
  });
}

// Quiet periods between consecutive member beats (> 14 days) — renderer INPUT.
function deriveGaps(beats: RenderBeat[]): Array<{ from: string; to: string }> {
  const gaps: Array<{ from: string; to: string }> = [];
  for (let i = 1; i < beats.length; i++) {
    const prev = Date.parse(beats[i - 1]!.date);
    const cur = Date.parse(beats[i]!.date);
    if (Number.isFinite(prev) && Number.isFinite(cur) && cur - prev > 14 * 86_400_000) {
      gaps.push({ from: beats[i - 1]!.date, to: beats[i]!.date });
    }
  }
  return gaps;
}
