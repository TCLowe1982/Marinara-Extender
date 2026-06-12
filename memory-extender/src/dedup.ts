// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Shared deduplicated entry creation.
//
// Every automatic capture path (Tier 1 digest/snapshot, Tier 2 sentiment,
// Tier 3 ambient) and the manual [remember:] paths must avoid re-saving a fact
// that already exists in the same lane. Previously only the command paths
// deduped, so the automated tiers regenerated duplicates faster than cleanup
// could remove them. This module is the single source of truth for the check.
//
// The decision is LANE- and KIND-aware (MarinaraExtender-ef6 + 4eu/FR1):
//
//   character_topics — feelings ACCUMULATE. An INCIDENT (a beat-bound moment,
//   kind:"incident", summaries start "[emotion] ...") never collapses into a
//   TRAIT entry: an event resembling a standing pattern is the arc growing,
//   not a duplicate. Incident-vs-incident dedups at a HIGHER bar — the real
//   duplicate is the same moment re-captured (swipe/regen), which is
//   near-identical; merely-similar moments both persist. Traits keep the
//   aggressive default against everything.
//
//   user_topics — facts SUPERSEDE. A similarity hit whose symmetric difference
//   is one-to-few content words is the CORRECTION signature ("sister is Mei"
//   -> "sister is Lin"): the meaning-carrying token is exactly what Jaccard
//   ignores. Corrections are CREATED, not dropped, and the collision pair is
//   recorded to data/supersession-candidates.yaml — the queue FR2 (supersede)
//   and FR3 (LLM reconciliation) consume. Plain restatements still dedup.

import { join } from "path";
import {
  readIndex,
  writeEntry,
  upsertIndexEntry,
  estimateTokens,
  getDataDir,
  mutateYamlFile,
  readYamlFile,
  supersedeEntry,
  type Scope,
  type Lane,
  type EntryStatus,
  type Entry,
  type IndexEntry,
} from "./storage.js";
import { nanoid } from "./nanoid.js";

export const DEDUP_SIMILARITY_THRESHOLD = 0.35;
// Incident-vs-incident: only a re-capture of the SAME moment should collapse.
export const INCIDENT_DEDUP_THRESHOLD = 0.6;
// …and "same moment" must be proven: same source chat, within this many turns.
export const SAME_MOMENT_TURN_WINDOW = 5;
// Correction signature needs high structural overlap to be a correction rather
// than a coincidentally-similar different fact.
export const CORRECTION_MIN_JACCARD = 0.5;

export type EntryKind = "incident" | "trait";

function wordBag(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean));
}

// Jaccard similarity on word bags.
export function jaccardSimilarity(a: string, b: string): number {
  const wa = wordBag(a);
  const wb = wordBag(b);
  const intersection = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union === 0 ? 0 : intersection / union;
}

// Tier-2 beat companions are always "[emotion] motivation" — a reliable
// incident marker for the thousands of legacy entries that predate the stored
// kind field.
export function looksIncident(summary: string): boolean {
  return /^\[\w+\]/.test(summary.trim());
}

// Function words can differ between restatements of the SAME fact ("the
// user's sister" vs "user's sister") — they never carry a correction. Length
// can't separate them: "the" and "Mei" are both three letters.
const FUNCTION_WORDS = new Set([
  "the", "and", "was", "has", "had", "are", "but", "for", "not", "with",
  "that", "this", "his", "her", "its", "their", "they", "she", "him", "who",
  "now", "then", "also", "very", "into", "from", "about", "been", "will",
]);

// "sister is Mei" vs "sister is Lin": high structural overlap, and the tokens
// that differ are few and content-bearing.
export function correctionSignature(a: string, b: string): boolean {
  const wa = wordBag(a);
  const wb = wordBag(b);
  if (jaccardSimilarity(a, b) < CORRECTION_MIN_JACCARD) return false;
  const symdiff = [
    ...[...wa].filter((w) => !wb.has(w)),
    ...[...wb].filter((w) => !wa.has(w)),
  ].filter((w) => w.length >= 3 && !FUNCTION_WORDS.has(w));
  return symdiff.length >= 1 && symdiff.length <= 4;
}

// True if summary OR content is too similar to an existing entry's summary.
// Kind-blind — kept for the explicit [remember:] command path; the capture
// tiers use createEntryIfUnique, which applies the lane/kind matrix.
export function isDuplicate(
  summary: string,
  content: string,
  existing: IndexEntry[],
): boolean {
  return existing.some((e) => similarityHit(summary, content, e));
}

function similarityHit(summary: string, content: string, e: IndexEntry, threshold = DEDUP_SIMILARITY_THRESHOLD): boolean {
  return (
    jaccardSimilarity(e.summary, summary) >= threshold ||
    (content.length > 20 && jaccardSimilarity(e.summary, content) >= threshold)
  );
}

// ── Supersession candidates (FR1 output, FR2/FR3 input) ─────────────────────

export interface SupersessionCandidate {
  scope: Scope;
  scopeId: string;
  existingId: string;
  existingSummary: string;
  newId: string;
  newSummary: string;
  recordedAt: string;
  // FR2: true when the old entry was actually superseded (pointer set + moved
  // to cold). False/absent = recorded only — FR3's adjudication input.
  applied?: boolean;
}

interface CandidateFile {
  candidates: SupersessionCandidate[];
}

function candidatesPath(): string {
  return join(getDataDir(), "supersession-candidates.yaml");
}

async function recordSupersessionCandidate(c: SupersessionCandidate): Promise<void> {
  await mutateYamlFile<CandidateFile>(candidatesPath(), () => ({ candidates: [] }), (f) => {
    if (!f.candidates.some((x) => x.existingId === c.existingId && x.newId === c.newId)) {
      f.candidates.push(c);
    }
  });
}

export async function readSupersessionCandidates(): Promise<SupersessionCandidate[]> {
  return (await readYamlFile<CandidateFile>(candidatesPath()))?.candidates ?? [];
}

function idPrefix(lane: Lane): string {
  if (lane === "open_threads") return "thread";
  if (lane === "user_topics") return "utopic";
  return "ctopic";
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface CreateEntryInput {
  lane: Lane;
  summary: string;
  content: string;
  status?: EntryStatus;
  timeContext?: Entry["timeContext"];
  sourceChatId?: string; // tag for clean per-chat re-import
  threadId?: string;     // narrative thread membership, inherited from the beat
  turnStart?: number;    // where in the source chat the moment happened
  // What the entry IS: an incident (a beat-bound moment) or a trait (a
  // standing pattern/fact about who someone is). Drives the character_topics
  // dedup matrix; omitted = legacy behavior (aggressive dedup).
  kind?: EntryKind;
}

// Lane/kind-aware duplicate decision. Returns the blocking entry, or a
// correction-candidate marker, or null (no block — create).
type DedupVerdict =
  | { action: "create" }
  | { action: "skip"; against: IndexEntry }
  | { action: "create-correction"; against: IndexEntry };

function decide(
  input: { lane: Lane; summary: string; content: string; kind?: EntryKind; sourceChatId?: string; turnStart?: number },
  existing: IndexEntry[],
): DedupVerdict {
  const { lane, summary, content, kind } = input;

  if (lane === "character_topics" && kind === "incident") {
    for (const e of existing) {
      const existingIsIncident = looksIncident(e.summary);
      // Incidents never collapse into traits — the arc accumulates.
      if (!existingIsIncident) continue;
      if (!similarityHit(summary, content, e, INCIDENT_DEDUP_THRESHOLD)) continue;
      // A similar summary is NOT sufficient: the analyzer emits identical
      // genre boilerplate for genuinely distinct moments (measured: 37% of
      // Mari's vulnerability beats collapsed, 78 byte-identical summaries).
      // A true recapture (swipe/regen) is the SAME moment — same source chat,
      // same turn neighborhood. Without that proof, the moments both persist.
      const sameMoment =
        !!input.sourceChatId && input.sourceChatId === e.sourceChatId &&
        typeof input.turnStart === "number" && typeof e.turnStart === "number" &&
        Math.abs(input.turnStart - e.turnStart) <= SAME_MOMENT_TURN_WINDOW;
      if (sameMoment) return { action: "skip", against: e };
    }
    return { action: "create" };
  }

  if (lane === "user_topics") {
    for (const e of existing) {
      if (!similarityHit(summary, content, e)) continue;
      // A hit that differs by a few content words is a CORRECTION — the new
      // fact must land (FR1). Everything else is a restatement.
      if (correctionSignature(e.summary, summary)) return { action: "create-correction", against: e };
      return { action: "skip", against: e };
    }
    return { action: "create" };
  }

  // Traits, open_threads, and legacy (kind-less) entries: aggressive default.
  for (const e of existing) {
    if (similarityHit(summary, content, e)) return { action: "skip", against: e };
  }
  return { action: "create" };
}

// Create an entry only if no sufficiently similar entry already exists in the
// same lane of the target scope. Returns the created Entry, or null if it was a
// duplicate (or the summary was blank). Used by every capture tier.
export async function createEntryIfUnique(
  scope: Scope,
  scopeId: string,
  input: CreateEntryInput,
): Promise<Entry | null> {
  const summary = input.summary.trim();
  if (!summary) return null;
  const content = (input.content ?? "").trim();

  const idx = await readIndex(scope, scopeId);
  const existingInLane = (idx?.entries ?? []).filter((e) => e.lane === input.lane);
  const verdict = decide(
    { lane: input.lane, summary, content, kind: input.kind, sourceChatId: input.sourceChatId, turnStart: input.turnStart },
    existingInLane,
  );
  if (verdict.action === "skip") {
    console.info(`[ME:dedup] skipped duplicate (${input.lane}/${scope}:${scopeId}): "${summary.slice(0, 60)}"`);
    return null;
  }

  const id = `${idPrefix(input.lane)}-${nanoid(8)}`;
  const now = today();
  const status: EntryStatus = input.status ?? "open";
  const entry: Entry = {
    id,
    lane: input.lane,
    summary,
    status,
    created: now,
    lastAccessed: now,
    content,
    tokens: estimateTokens(`${summary} ${content}`),
    ...(input.timeContext ? { timeContext: input.timeContext } : {}),
    ...(input.sourceChatId ? { sourceChatId: input.sourceChatId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(typeof input.turnStart === "number" ? { turnStart: input.turnStart } : {}),
  };

  const relativePath = await writeEntry(scope, scopeId, entry);
  await upsertIndexEntry(scope, scopeId, {
    id,
    path: relativePath,
    summary,
    tokens: entry.tokens,
    lane: input.lane,
    status,
    lastAccessed: now,
    ...(input.sourceChatId ? { sourceChatId: input.sourceChatId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(typeof input.turnStart === "number" ? { turnStart: input.turnStart } : {}),
  });

  if (verdict.action === "create-correction") {
    // FR2: facts supersede. The newer fact replaces the older one — the old
    // entry gets a pointer to its replacement and a tier move to cold (never
    // a delete). The candidate file keeps the audit trail for FR3/FR4.
    const applied = await supersedeEntry(scope, scopeId, verdict.against.id, id).catch(() => false);
    await recordSupersessionCandidate({
      scope,
      scopeId,
      existingId: verdict.against.id,
      existingSummary: verdict.against.summary,
      newId: id,
      newSummary: summary,
      recordedAt: new Date().toISOString(),
      applied,
    }).catch(() => { /* candidate file is advisory — never block the save */ });
    console.info(
      `[ME:dedup] correction (${scope}:${scopeId}): "${verdict.against.summary.slice(0, 50)}" ← "${summary.slice(0, 50)}"${applied ? " [superseded]" : ""}`,
    );
  }

  return entry;
}
