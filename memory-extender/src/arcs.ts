// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Recap layer — FLOOR tier (MarinaraExtender-2cu, parent cz3).
//
// A scene-arc recap is the engine's own /api/scene/conclude prose summary,
// ingested as a first-class memory: an Arc (kind "scene") whose members are
// the scene's beats, rendered as a RecapEntry in the SAME hot index the
// loader already scans. No LLM cost, no clustering — 1:1 with an engine
// scene. The ceiling tier (through-line arcs, MarinaraExtender-ajb) shares
// these types; see docs/recap-ceiling-data-model.md for the reviewed
// contract this implements (beat seq watermarks, standalone memberships,
// ArcStatus deliberately separate from EntryStatus).
//
// Displacement composition: ingesting a scene recap closes the scene's
// narrative threads (threads.ts), and the pln thread-unit archival then ages
// the member beats' entries to cold together — the recap becomes the hot
// retrieval unit without any bespoke eviction mechanism.

import { join } from "path";
import {
  getDataDir,
  readYamlFile,
  mutateYamlFile,
  writeEntry,
  upsertIndexEntry,
  estimateTokens,
  assertSafeId,
  type Entry,
  type Lane,
} from "./storage.js";
import { readBeatIndex } from "./sentiment/encoder.js";
import { listActiveThreads, closeThread } from "./threads.js";
import { nanoid } from "./nanoid.js";

// ── Types (mirroring docs/recap-ceiling-data-model.md) ───────────────────────

export type ArcKind = "scene" | "through_line";
export type ArcOrigin = "engine" | "promotion";
export type ArcStatus = "active" | "dormant" | "resolved";

export interface ArcMembership {
  arcId: string;
  beatId: string;
  role: string;       // BeatRole vocabulary; floor uses "scene_member"
  salience: number;   // within-arc salience; floor mirrors beat.salience
  addedAt: string;
}

export interface ArcSignature {
  entities: string[];
  threadIds: string[];
  centroid: number[]; // empty until the kNN tier lands (ceiling)
}

export interface Arc {
  id: string;                  // PERMANENT
  kind: ArcKind;
  origin: ArcOrigin;
  lane: Lane;
  label: string;
  status: ArcStatus;
  scope: { characterId?: string; chatId?: string };
  signature: ArcSignature;
  watermark: { coveredThroughSeq: number; version: number };
  gaps?: Array<{ from: string; to: string }>;
  created: string;
  lastPromotedAt: string;
}

export interface RecapEntry extends Entry {
  kind: "recap";
  arcId: string;
  footnoteBeatIds: string[];
}

interface ArcFile {
  arcs: Arc[];
  // sceneKey (chatId, or summary-hash when no chat link) → arcId. Idempotency.
  ingestedScenes: Record<string, string>;
}

interface MembershipFile {
  memberships: ArcMembership[];
}

// ── Storage (per character, standalone membership collection) ────────────────

function arcsPath(identityKey: string): string {
  assertSafeId(identityKey);
  return join(getDataDir(), "characters", identityKey, "arcs.yaml");
}
function membershipsPath(identityKey: string): string {
  assertSafeId(identityKey);
  return join(getDataDir(), "characters", identityKey, "arc-memberships.yaml");
}

const emptyArcs = (): ArcFile => ({ arcs: [], ingestedScenes: {} });
const emptyMemberships = (): MembershipFile => ({ memberships: [] });

export async function readArcs(identityKey: string): Promise<ArcFile> {
  return (await readYamlFile<ArcFile>(arcsPath(identityKey))) ?? emptyArcs();
}
export async function readArcMemberships(identityKey: string): Promise<ArcMembership[]> {
  return ((await readYamlFile<MembershipFile>(membershipsPath(identityKey))) ?? emptyMemberships()).memberships;
}

// Render only the highest-salience members as citations (H3: a long scene
// surfaces as a handful of footnotes, not two hundred).
const MAX_FOOTNOTES = 8;

export interface SceneRecapInput {
  identityKey: string;          // participant whose ledger gets the recap
  summary: string;              // the engine's prose summary
  sceneChatId?: string;         // the scene chat (for beat linkage + threads)
  sceneName?: string;           // e.g. "Scene: Jurisprudence, Soft Launch"
  concludedAt?: string;         // ISO — when the return message landed
}

export interface SceneRecapResult {
  arcId: string;
  entryId: string;
  footnotes: number;
  threadsClosed: number;
  alreadyIngested: boolean;
}

// Ingest one scene-conclude summary for one participant. Idempotent per
// (character, scene): re-ingesting returns the existing arc untouched.
export async function ingestSceneRecap(input: SceneRecapInput): Promise<SceneRecapResult | null> {
  const summary = input.summary?.replace(/\s+/g, " ").trim();
  if (!summary || summary.length < 20) return null;
  const { identityKey } = input;

  const sceneKey = input.sceneChatId ?? `sum-${hashish(summary)}`;
  const existing = await readArcs(identityKey);
  const already = existing.ingestedScenes[sceneKey];
  if (already) return { arcId: already, entryId: "", footnotes: 0, threadsClosed: 0, alreadyIngested: true };

  // Member beats: everything this character captured from the scene — by
  // provenance (sourceChatId) or by narrative thread minted in that chat.
  const beatIndex = await readBeatIndex(identityKey);
  const sceneThreads = input.sceneChatId ? await listActiveThreads(input.sceneChatId) : [];
  const threadIds = new Set(sceneThreads.map((t) => t.id));
  const members = (beatIndex?.entries ?? []).filter((b) =>
    (input.sceneChatId && b.sourceChatId === input.sceneChatId) ||
    (b.threadId && threadIds.has(b.threadId)),
  );

  const now = new Date().toISOString();
  const label = (input.sceneName ?? `Scene concluded ${String(input.concludedAt ?? now).slice(0, 10)}`)
    .replace(/^Scene:\s*/i, "").trim();
  const arc: Arc = {
    id: `arc-${nanoid(10)}`,
    kind: "scene",
    origin: "engine",
    lane: "character_topics",
    label,
    status: "resolved", // a concluded scene is a closed chapter
    scope: { characterId: identityKey, ...(input.sceneChatId ? { chatId: input.sceneChatId } : {}) },
    signature: {
      entities: [],
      threadIds: [...threadIds],
      centroid: [],
    },
    watermark: {
      coveredThroughSeq: members.reduce((max, b) => Math.max(max, b.seq ?? 0), 0),
      version: 1,
    },
    created: now,
    lastPromotedAt: now,
  };

  const memberships: ArcMembership[] = members.map((b) => ({
    arcId: arc.id,
    beatId: b.id,
    role: "scene_member",
    salience: b.salience,
    addedAt: now,
  }));
  const footnoteBeatIds = [...members]
    .sort((a, b) => b.salience - a.salience)
    .slice(0, MAX_FOOTNOTES)
    .map((b) => b.id);

  // The retrievable recap — a first-class hot-index entry. Written directly
  // (never through dedup): the recap IS the canonical unit.
  const entryId = `recap-${nanoid(8)}`;
  const date = String(input.concludedAt ?? now).slice(0, 10);
  const recap: RecapEntry = {
    id: entryId,
    kind: "recap",
    arcId: arc.id,
    lane: "character_topics",
    summary: `[scene recap] ${label} (${date})`,
    status: "open",
    created: date,
    lastAccessed: date,
    content: summary,
    tokens: estimateTokens(summary),
    footnoteBeatIds,
    ...(input.sceneChatId ? { sourceChatId: input.sceneChatId } : {}),
  };
  const path = await writeEntry("character", identityKey, recap);
  await upsertIndexEntry("character", identityKey, {
    id: entryId,
    path,
    summary: recap.summary,
    tokens: recap.tokens,
    lane: "character_topics",
    status: "open",
    lastAccessed: date,
    ...(input.sceneChatId ? { sourceChatId: input.sceneChatId } : {}),
  });

  // Persist arc + memberships, mark the scene ingested.
  await mutateYamlFile<ArcFile>(arcsPath(identityKey), emptyArcs, (f) => {
    f.arcs.push(arc);
    f.ingestedScenes[sceneKey] = arc.id;
  });
  if (memberships.length > 0) {
    await mutateYamlFile<MembershipFile>(membershipsPath(identityKey), emptyMemberships, (f) => {
      f.memberships.push(...memberships);
    });
  }

  // Scene over → its narrative threads close; pln's thread-unit archival
  // will age the member entries to cold together while the recap stays hot.
  let threadsClosed = 0;
  for (const t of sceneThreads) {
    if (await closeThread(t.id)) threadsClosed++;
  }

  console.info(
    `[ME:recap] scene "${label}" ingested for ${identityKey} — arc ${arc.id}, ${members.length} member beat(s), ${footnoteBeatIds.length} footnote(s), ${threadsClosed} thread(s) closed`,
  );
  return { arcId: arc.id, entryId, footnotes: footnoteBeatIds.length, threadsClosed, alreadyIngested: false };
}

// Tiny non-crypto content key for scenes with no chat linkage.
function hashish(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
