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
import { harvestBodyTerms } from "./relevance.js";
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
import { queueEnabled, enqueueReconcileTask } from "./reconcile-queue.js";

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
  citesChatId?: string;  // chat cited as the receipt (fqnl) — purge never reads this; see storage.ts
  threadId?: string;     // narrative thread membership, inherited from the beat
  turnStart?: number;    // where in the source chat the moment happened
  sourceMessageId?: string;  // which message this came from (06pq) — see storage.ts
  sourceSwipeIndex?: number; // which swipe OF that message; the pair is the identity
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

/**
 * Are these two beats the SAME moment — the proof that licenses a skip?
 *
 * TWO KEYS, AND THE PREFERENCE ORDER MATTERS (06pq).
 *
 * 1. MESSAGE + SWIPE, when both sides carry it. This is exact. Crucially it is
 *    the PAIR: a re-roll keeps the message id and moves only the swipe index, so
 *    matching on the id alone would declare the re-rolled reply "the same
 *    moment" as the one the user threw away — and the KEPT text would be skipped
 *    as a duplicate while the DISCARDED text stayed. Silently inverted, and it
 *    reads as an ordinary "skipped duplicate" in the log. A differing swipe is
 *    therefore NOT the same moment; it is a supersession, which is s2lw's job.
 *
 * 2. CHAT + TURN NEIGHBOURHOOD, as the fallback. Correct for the IMPORT path and
 *    for legacy rows written before the pair existed, where a real turn number
 *    flows. It is what the live path used to rely on — and could not, because the
 *    poller sends no turnNumber, so every live turn stamped turnStart 0 and
 *    |0-0| <= window made this test vacuously true for any two beats in a chat.
 *    That defeated the guard entirely on the path that matters most.
 *
 * Requiring the fallback's turnStart to be a real number is not enough to fix
 * that on its own: 0 IS a real number, and a genuine first turn is 0 too. Only
 * per-message identity separates them.
 */
function sameMoment(
  input: { sourceChatId?: string; turnStart?: number; sourceMessageId?: string; sourceSwipeIndex?: number },
  e: IndexEntry,
): boolean {
  if (input.sourceMessageId && e.sourceMessageId) {
    return input.sourceMessageId === e.sourceMessageId &&
           input.sourceSwipeIndex === e.sourceSwipeIndex;
  }
  return (
    !!input.sourceChatId && input.sourceChatId === e.sourceChatId &&
    typeof input.turnStart === "number" && typeof e.turnStart === "number" &&
    Math.abs(input.turnStart - e.turnStart) <= SAME_MOMENT_TURN_WINDOW
  );
}

function decide(
  input: { lane: Lane; summary: string; content: string; kind?: EntryKind; sourceChatId?: string; turnStart?: number; sourceMessageId?: string; sourceSwipeIndex?: number },
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
      // Without positive proof that two beats are the same moment, both persist.
      if (sameMoment(input, e)) return { action: "skip", against: e };
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

// Create an entry UNCONDITIONALLY — no dedup gate. The caller has already
// decided this entry should exist; the reconciliation curator (FR3) uses this
// because it adjudicates collisions the structural Jaccard gate cannot (and the
// gate would otherwise re-collapse a curator-approved UPDATE/EXPAND/DISTINCT into
// the very fact it was meant to supersede or sit beside). Assumes a non-blank
// summary (the caller ensures it). createEntryIfUnique wraps this behind the gate
// for the capture tiers.
export async function createEntry(
  scope: Scope,
  scopeId: string,
  input: CreateEntryInput,
): Promise<Entry> {
  const summary = input.summary.trim();
  const content = (input.content ?? "").trim();
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
    ...(input.citesChatId ? { citesChatId: input.citesChatId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(typeof input.turnStart === "number" ? { turnStart: input.turnStart } : {}),
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    ...(typeof input.sourceSwipeIndex === "number" ? { sourceSwipeIndex: input.sourceSwipeIndex } : {}),
  };

  const relativePath = await writeEntry(scope, scopeId, entry);
  await upsertIndexEntry(scope, scopeId, {
    id,
    path: relativePath,
    summary,
    tokens: entry.tokens,
    bodyTerms: harvestBodyTerms(entry.content, summary),
    lane: input.lane,
    status,
    lastAccessed: now,
    ...(input.sourceChatId ? { sourceChatId: input.sourceChatId } : {}),
    ...(input.citesChatId ? { citesChatId: input.citesChatId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(typeof input.turnStart === "number" ? { turnStart: input.turnStart } : {}),
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    ...(typeof input.sourceSwipeIndex === "number" ? { sourceSwipeIndex: input.sourceSwipeIndex } : {}),
  });
  return entry;
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
    {
      lane: input.lane, summary, content, kind: input.kind,
      sourceChatId: input.sourceChatId, turnStart: input.turnStart,
      sourceMessageId: input.sourceMessageId, sourceSwipeIndex: input.sourceSwipeIndex,
    },
    existingInLane,
  );
  if (verdict.action === "skip") {
    console.info(`[ME:dedup] skipped duplicate (${input.lane}/${scope}:${scopeId}): "${summary.slice(0, 60)}"`);
    // FR1 live reconciliation hook (b4n): structural dedup is about to DROP this
    // as a duplicate, but it may actually be an UPDATE/EXPAND/DISTINCT the curator
    // would keep. Queue the collision for out-of-band curation — but ONLY for
    // durable FACTS (the curator's domain), never beats/incidents/threads, and
    // only when the queue is enabled. Fire-and-forget: advisory, never blocks the
    // save (mirrors recordSupersessionCandidate below).
    const isFactCollision = input.lane === "user_topics" || (input.lane === "character_topics" && input.kind === "trait");
    if (queueEnabled() && isFactCollision) {
      void enqueueReconcileTask({
        scope, scopeId, lane: input.lane, summary, content,
        againstId: verdict.against.id, againstSummary: verdict.against.summary,
        structuralAction: "skip", sourceChatId: input.sourceChatId,
      }).catch(() => { /* advisory — a queue hiccup never fails a save */ });
    }
    return null;
  }

  const entry = await createEntry(scope, scopeId, input);
  const id = entry.id;

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
