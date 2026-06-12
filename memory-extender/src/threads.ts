// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Narrative threads as first-class objects (MarinaraExtender-pln).
//
// A narrative thread is a topic/arc the scene is living through — "the Porsche
// test drive" — with member beats and participating characters. Threads are
// minted at INGEST: the tier-2 analyzer (the same LLM call that attributes
// `subject`) picks an active thread label or proposes a new one, and the beat
// is tagged with the resolved threadId. The promotion-time recap/arc layer
// (recap-ceiling-data-model.md) consumes these ids via ArcSignature.threadIds —
// ingest mints scene-scoped threads; cross-scene ARC identity stays a
// promotion decision.
//
// NOT the same thing as the `open_threads` LANE (`thread-*` ledger entries =
// unresolved topics). Narrative threads use the `nthr-*` prefix and live in
// their own registry, outside the scope/index model.
//
// Label drift guard: the model returns LABELS, not ids ("Porsche test drive"
// vs "test drive at the dealership"), so resolution fuzzy-matches against the
// chat's active threads before minting. Resolution + mint happen inside one
// serialized registry mutation, so concurrent turns can't double-mint.

import { join } from "path";
import { getDataDir, readYamlFile, mutateYamlFile } from "./storage.js";
import { normalizeLabel, tokenContainment, jaroWinkler } from "./aliases.js";
import { nanoid } from "./nanoid.js";

export type ThreadStatus = "active" | "closed";

export interface NarrativeThread {
  id: string;               // nthr-<nanoid> — permanent
  label: string;            // display label (latest phrasing wins on match)
  chatId: string;           // the scene that minted it (scene-scoped at ingest)
  status: ThreadStatus;
  participants: string[];   // identity keys whose beats joined the thread
  beatCount: number;
  created: string;          // ISO
  lastActiveAt: string;     // ISO — bumped on every member beat
}

export interface ThreadRegistry {
  threads: NarrativeThread[];
}

function registryPath(): string {
  return join(getDataDir(), "threads", "registry.yaml");
}

const emptyRegistry = (): ThreadRegistry => ({ threads: [] });

export async function readThreadRegistry(): Promise<ThreadRegistry> {
  return (await readYamlFile<ThreadRegistry>(registryPath())) ?? emptyRegistry();
}

// Active threads for one chat — the roster shown to the analyzer.
export async function listActiveThreads(chatId: string): Promise<NarrativeThread[]> {
  const reg = await readThreadRegistry();
  return reg.threads.filter((t) => t.status === "active" && t.chatId === chatId);
}

// Same-thread test for a model-returned label against an existing thread label:
// exact normalized match, significant-token containment, or high jaro-winkler.
// Safe to fuzzy-match here because candidates are scoped to ONE chat's active
// threads (a handful), not the global registry.
function labelsMatch(a: string, b: string): boolean {
  const na = normalizeLabel(a);
  const nb = normalizeLabel(b);
  if (!na || !nb) return false;
  return na === nb || tokenContainment(na, nb) || jaroWinkler(na, nb) >= 0.85;
}

export interface ThreadResolution {
  id: string;
  label: string;
  isNew: boolean;
}

// Resolve a model-proposed label to this chat's thread, minting when it is
// genuinely new. Also records the member beat (participant + count + bump).
// One serialized registry mutation end-to-end — no resolve/mint race.
export async function resolveOrMintThread(
  chatId: string,
  label: string,
  participantKey: string,
): Promise<ThreadResolution | null> {
  // Models sometimes emit identifier-style labels ("mari_and_priya") despite
  // the prompt — normalize separators to spaces so display and fuzzy matching
  // both see natural phrases.
  const clean = label.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!clean || !chatId) return null;
  let resolution: ThreadResolution | null = null;
  await mutateYamlFile<ThreadRegistry>(registryPath(), emptyRegistry, (reg) => {
    const now = new Date().toISOString();
    const candidates = reg.threads.filter((t) => t.status === "active" && t.chatId === chatId);
    let hit = candidates.find((t) => labelsMatch(t.label, clean)) ?? null;
    if (!hit) {
      hit = {
        id: `nthr-${nanoid(8)}`,
        label: clean,
        chatId,
        status: "active",
        participants: [],
        beatCount: 0,
        created: now,
        lastActiveAt: now,
      };
      reg.threads.push(hit);
    }
    if (!hit.participants.includes(participantKey)) hit.participants.push(participantKey);
    hit.beatCount += 1;
    hit.lastActiveAt = now;
    resolution = { id: hit.id, label: hit.label, isNew: hit.beatCount === 1 };
  });
  return resolution;
}

// Close a thread (scene concluded / arc resolved). Closed threads leave the
// analyzer roster; the promotion-time cold-archival pass will treat them as
// complete units. No-op if the id is unknown.
export async function closeThread(threadId: string): Promise<boolean> {
  let closed = false;
  await mutateYamlFile<ThreadRegistry>(registryPath(), emptyRegistry, (reg) => {
    const t = reg.threads.find((x) => x.id === threadId);
    if (t && t.status !== "closed") { t.status = "closed"; closed = true; }
  });
  return closed;
}

// Idle threads close themselves: a scene nobody has touched in maxIdleDays is
// over, whether or not anyone said so. Keeps the analyzer roster from growing
// unbounded and lets the promotion pass eventually archive the arc as a unit.
// (A scene-conclude hook from the engine would close threads sooner — tracked
// in rfx — this is the floor that works without any engine integration.)
export const THREAD_AUTO_CLOSE_DAYS = 14;

export async function autoCloseStaleThreads(
  maxIdleDays = THREAD_AUTO_CLOSE_DAYS,
  now = Date.now(),
): Promise<number> {
  let closed = 0;
  const cutoff = now - maxIdleDays * 24 * 60 * 60 * 1000;
  await mutateYamlFile<ThreadRegistry>(registryPath(), emptyRegistry, (reg) => {
    for (const t of reg.threads) {
      if (t.status !== "active") continue;
      const last = Date.parse(t.lastActiveAt || t.created || "");
      if (Number.isFinite(last) && last < cutoff) {
        t.status = "closed";
        closed++;
        console.info(`[threads] auto-closed "${t.label}" (${t.id}) — idle ${maxIdleDays}+ days`);
      }
    }
  });
  return closed;
}
