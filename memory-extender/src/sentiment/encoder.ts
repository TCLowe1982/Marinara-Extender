// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Stage 3: Memory Encoding
//
// Writes analyzed emotional beats to disk as YAML under:
//   data/characters/<characterId>/beats/<id>.yaml
//
// A separate beats/index.yaml tracks summary metadata for fast retrieval
// without reading every beat file. The beats store is intentionally separate
// from the main entries/ index so the existing memory UI is unaffected.

import { readFile, access, rm } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { getDataDir, assertSafeId, atomicWriteFile_UNLOCKED_takeSerializedWriteYourself, readIndex, retireEntries } from "../storage.js";
import type { Emotion } from "./types.js";
import type { EmotionalBeat, ClassificationResult, BeatAnalysis, Chunk } from "./types.js";
import type { AnalyzedBeat } from "./analyzer.js";

// Deterministic beat id derived from the source chunk. Re-encoding the same
// chunk yields the same id (idempotent overwrite), and it lets the pipeline skip
// chunks whose beat already exists on disk — the basis for resumable imports.
//
// IT HASHES INTERPRETATIONS, WHICH IS THE BUG r0kc IS ABOUT. `speaker` and `text`
// are both things this system keeps getting better at — 5dqr unmangled 171
// names, 4ghy stopped minting phantoms, hjt9 reduces `text` before chunking —
// and every one of those improvements changes the hash, so a re-import stops
// recognising its own stored beats and writes them again. Duplicates then read
// as independent corroborations of one utterance.
//
// It is NOT being changed, and not for compatibility: it is the only identity
// pre-2pbi beats will ever have, since nothing recorded which message they came
// from. It stays the filename. `provenanceKeyForChunk` below is what MATCHING
// now prefers, and the id is demoted to a name.
export function beatIdForChunk(chunk: Pick<Chunk, "speaker" | "text" | "turnStart" | "turnEnd">): string {
  const h = createHash("sha1")
    .update(`${chunk.turnStart}:${chunk.turnEnd}:${chunk.speaker}\n${chunk.text}`)
    .digest("hex");
  return `beat-${h.slice(0, 12)}`;
}

/**
 * WHERE THIS BEAT CAME FROM — nothing that can be improved (r0kc).
 *
 * "An id must be derivable from things that cannot be improved" (Mari). Three
 * facts qualify: which message, which swipe of it, and which turn within it.
 * Everything else on a Chunk is a reading of the text rather than a fact about
 * its origin, including `text` itself — hjt9's ops routing and pe4o's
 * self-prompt gate both rewrite it, so filtering better would move ids exactly
 * the way attributing better does. Same bug, one layer down.
 *
 * NOT HASHED, deliberately. This is a field, not a filename, and provenance you
 * can read is provenance you can verify — `grep` it against a chat export and
 * the answer is right there. Hashing would buy nothing but opacity.
 *
 * THE PAIR STAYS A PAIR: a re-roll keeps the message id and moves only the swipe
 * index, so a key without it would call the kept reply and the discarded one the
 * same moment. `-` means the source had no swipes (the user's half of a turn),
 * which is a fact, not a gap.
 *
 * ordinalEnd is left OUT. Where a chunk starts is provenance; how far it runs is
 * the chunker's current merge settings, i.e. an interpretation. No two chunks of
 * one run start at the same (message, ordinal), so the extent buys no uniqueness
 * and would only reintroduce the churn this exists to stop.
 *
 * Undefined whenever the source carried no message id: the story importer, and
 * every beat written before 2pbi. Those keep matching on beatIdForChunk.
 */
export function provenanceKeyForChunk(
  chunk: Pick<Chunk, "messageId" | "swipeIndex" | "ordinalStart">,
): string | undefined {
  if (!chunk.messageId) return undefined;
  const swipe = typeof chunk.swipeIndex === "number" ? String(chunk.swipeIndex) : "-";
  const ordinal = typeof chunk.ordinalStart === "number" ? String(chunk.ordinalStart) : "-";
  return `${chunk.messageId}:${swipe}:${ordinal}`;
}

/**
 * The filename for a beat: derived from provenance when there is any, from the
 * legacy content hash when there is not.
 *
 * WHY THE FILENAME HAD TO MOVE TOO, though the plan was to leave it alone. The
 * legacy hash covers turn range, speaker and text and nothing else — so two
 * genuinely different moments that happen to READ the same collapse onto one
 * name. Someone saying "I know." twice in a chat is one file. That went
 * unnoticed while the id was also the match key, because resume skipped the
 * second one and the loss looked like successful deduplication. Matching on
 * provenance exposes it: both chunks are now correctly seen as distinct, get
 * analysed separately, and then overwrite each other on disk.
 *
 * So provenance names the file when provenance exists. Hashed only to keep
 * filenames a uniform safe shape — the readable key lives in the beat's
 * `provenanceKey` field, which is where anyone verifying it will look.
 *
 * NOTHING STORED IS RENAMED. Every beat written before 2pbi has no message id,
 * so it falls through to the same legacy hash it was written under, and a
 * re-import still recognises it. New beats simply start out with an identity
 * that later corrections cannot move.
 */
export function beatIdFor(chunk: Pick<Chunk, "speaker" | "text" | "turnStart" | "turnEnd" | "messageId" | "swipeIndex" | "ordinalStart">): string {
  const key = provenanceKeyForChunk(chunk);
  if (!key) return beatIdForChunk(chunk);
  return `beat-${createHash("sha1").update(key).digest("hex").slice(0, 12)}`;
}

// Build the retrievable ledger entry (summary + content) for a beat. The loader
// reads ledger entries, not the beats store, so every beat that should be
// recallable needs one of these. Shared by the import pipeline and the backfill.
export function companionEntryFromBeat(beat: EmotionalBeat): { summary: string; content: string } {
  const primary = beat.emotions?.[0]?.emotion?.trim() || beat.emotion;
  const summary = `[${primary}] ${beat.motivation}`.replace(/\s+/g, " ").trim().slice(0, 140);
  const content = [
    `Emotion: ${primary}${beat.subpattern ? ` (${beat.subpattern})` : ""}`,
    `Motivation: ${beat.motivation}`,
    `Relational dynamics: ${beat.relationalDynamics}`,
    `Outcome: ${beat.outcome}`,
    ...(beat.subtext ? [`Subtext: ${beat.subtext}`] : []),
  ].join("\n").slice(0, 700);
  return { summary, content };
}

// ── Path helpers ───────────────────────────────────────────────────────────

function beatsDir(characterId: string): string {
  assertSafeId(characterId); // characterId originates from request input
  return join(getDataDir(), "characters", characterId, "beats");
}

function beatIndexPath(characterId: string): string {
  return join(beatsDir(characterId), "index.yaml");
}

function beatFilePath(characterId: string, beatId: string): string {
  return join(beatsDir(characterId), `${beatId}.yaml`);
}

// ── YAML helpers ───────────────────────────────────────────────────────────

async function fileExists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true).catch(() => false);
}

async function readYaml<T>(filePath: string): Promise<T | null> {
  if (!(await fileExists(filePath))) return null;
  return parseYaml(await readFile(filePath, "utf8")) as T;
}

async function writeYaml(filePath: string, data: unknown): Promise<void> {
  await atomicWriteFile_UNLOCKED_takeSerializedWriteYourself(filePath, toYaml(data));
}

// ── Beat index ─────────────────────────────────────────────────────────────

export interface BeatIndexEntry {
  id: string;
  /**
   * Mirrored from the beat so resume can match on provenance without opening
   * 8,000 files (r0kc) — same reason retiredAt is mirrored here.
   */
  provenanceKey?: string;
  emotion: Emotion;
  subpattern?: string;
  salience: number;
  speaker: string;
  created: string;
  sourceType: "chat" | "story";
  sourceChatId?: string;
  threadId?: string;  // narrative thread membership (nthr-* — see threads.ts)
  // Per-character monotonic sequence (recap watermark ordering — see
  // recap-ceiling-data-model.md Resolved #1). Assigned once on first insert
  // under the per-character write lock; never reassigned on re-encode.
  seq?: number;
  turnStart: number;
  turnEnd: number;
  tokens: number;
  // Machine-driven retirement (s8qe) — mirrored from the beat so a consumer
  // reading only the index can honour it without opening 8,000 files.
  retiredAt?: string;
  retiredReason?: string;
}

export interface BeatIndex {
  characterId: string;
  lastUpdated: string;
  // Next seq to assign — persisted so ordering survives restarts.
  nextSeq?: number;
  entries: BeatIndexEntry[];
}

export async function readBeatIndex(characterId: string): Promise<BeatIndex | null> {
  return readYaml<BeatIndex>(beatIndexPath(characterId));
}

// Serialize beat-index writes per character so concurrent encodeBeat calls
// (e.g. live Tier 2 while a story ingest runs) can't clobber each other's
// read-modify-write and corrupt the index.
const _beatIndexLocks = new Map<string, Promise<void>>();

function serializeBeatWrite(characterId: string, fn: () => Promise<void>): Promise<void> {
  const prev = _beatIndexLocks.get(characterId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  _beatIndexLocks.set(characterId, next);
  next.then(() => { if (_beatIndexLocks.get(characterId) === next) _beatIndexLocks.delete(characterId); });
  return next;
}

async function upsertBeatIndex(characterId: string, entry: BeatIndexEntry): Promise<void> {
  return serializeBeatWrite(characterId, async () => {
    const index = (await readBeatIndex(characterId)) ?? {
      characterId,
      lastUpdated: new Date().toISOString(),
      entries: [],
    };
    const i = index.entries.findIndex((e) => e.id === entry.id);
    if (i >= 0) {
      // seq is write-once: a re-encode (idempotent import resume) must not
      // renumber history.
      index.entries[i] = { ...entry, seq: index.entries[i]!.seq ?? entry.seq };
    } else {
      const seq = index.nextSeq ?? (index.entries.length > 0
        ? Math.max(...index.entries.map((e) => e.seq ?? 0)) + 1
        : 1);
      index.nextSeq = seq + 1;
      index.entries.push({ ...entry, seq });
    }
    index.lastUpdated = new Date().toISOString();
    await writeYaml(beatIndexPath(characterId), index);
  });
}

// ── Beat read ──────────────────────────────────────────────────────────────

export async function readBeat(
  characterId: string,
  beatId: string,
): Promise<EmotionalBeat | null> {
  return readYaml<EmotionalBeat>(beatFilePath(characterId, beatId));
}

/**
 * Every live beat for a character.
 *
 * EXCLUDES RETIRED BEATS BY DEFAULT, and that default is load-bearing rather
 * than tidy: /api/beats-to-entries rebuilds companion ledger entries FROM this
 * list, so a retired beat that leaked through here would silently resurrect the
 * entry its retirement just removed. Pass includeRetired for evidence reads —
 * audits, historical curves, anything that must see what was taken out.
 */
export async function readAllBeats(
  characterId: string,
  opts: { includeRetired?: boolean } = {},
): Promise<EmotionalBeat[]> {
  const index = await readBeatIndex(characterId);
  if (!index) return [];
  const rows = opts.includeRetired
    ? index.entries
    : index.entries.filter((e) => !e.retiredAt);
  const beats = await Promise.all(rows.map((e) => readBeat(characterId, e.id)));
  return beats
    .filter((b): b is EmotionalBeat => b !== null)
    .filter((b) => opts.includeRetired || !b.retiredAt);
}

/**
 * Retire beats: mark, never delete (s8qe).
 *
 * Writes the mark to BOTH the beat file and its index row — the file so the
 * record is self-describing if the index is ever rebuilt, the row so consumers
 * can honour it without opening every file. Takes the same per-character write
 * lock as encodeBeat, so a live Tier-2 write cannot interleave and clobber it.
 *
 * Returns the ids actually marked: already-retired beats are skipped rather than
 * re-stamped, so a re-run cannot rewrite history with a later date.
 *
 * THE COMPANION ENTRY RETIRES WITH THE BEAT (41uo). The loader never reads the
 * beat store for recall — it ranks over the ENTRY index, and retiredAt is not
 * among its exclusions because it cannot be: it lives on the beat. So a beat
 * retirement that stops here removes the record from statistics and arc
 * promotion and leaves the recallable copy in place. That is not a
 * hypothetical: EVERY caller of this function forgot the companion (24 of 24
 * pe4o, 366 of 517 s8qe), because "retire the beat" reads like it retires the
 * memory and did not. The function now does what its name says.
 *
 * THE VETO RIDES ALONG, because the join is a summary match and summaries are
 * NOT unique — the pifl illustration is byte-identical across dozens of live
 * beats. A companion entry is retired ONLY when no beat that survives this
 * retirement would produce the same summary; anything ambiguous is left alone
 * and logged. Machine text left in recall is recoverable; a real memory
 * removed is not. (On pe4o's first dry run the naive join would have retired
 * 32 entries belonging to beats nobody was retiring.)
 *
 * Pass { companions: false } only when the caller handles entries itself with
 * different reasons per entry — never because the companion "doesn't matter".
 */
export async function retireBeats(
  characterId: string,
  beatIds: string[],
  reason: string,
  opts: { companions?: boolean } = {},
): Promise<string[]> {
  const targets = new Set(beatIds);
  const marked: string[] = [];
  const retiredAt = new Date().toISOString();

  await serializeBeatWrite(characterId, async () => {
    const index = await readBeatIndex(characterId);
    if (!index) return;
    for (const row of index.entries) {
      if (!targets.has(row.id) || row.retiredAt) continue;
      row.retiredAt = retiredAt;
      row.retiredReason = reason;
      marked.push(row.id);

      const beat = await readBeat(characterId, row.id);
      if (beat) {
        await writeYaml(beatFilePath(characterId, row.id), { ...beat, retiredAt, retiredReason: reason });
      }
    }
    if (marked.length === 0) return;
    index.lastUpdated = retiredAt;
    await writeYaml(beatIndexPath(characterId), index);
  });

  if (marked.length > 0 && opts.companions !== false) {
    await retireCompanionEntries(characterId, marked, reason);
  }

  return marked;
}

const collapseSummary = (s: string): string => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * The entry-side half of retireBeats — see its header. Runs AFTER the beats are
 * marked, so "a beat that survives" is simply "a beat still live now", and the
 * veto set cannot drift from what was actually retired. Outside the beat write
 * lock deliberately: retireEntries takes the entry index's own mutateIndex
 * path, and holding both locks at once is how deadlocks are built.
 */
async function retireCompanionEntries(
  characterId: string,
  retiredBeatIds: string[],
  reason: string,
): Promise<void> {
  // Every summary a surviving beat would produce. Rendered through
  // companionEntryFromBeat at READ time — if rendering has drifted since the
  // entry was written, the drifted summary just won't match anything, and the
  // entry is left alone rather than mis-joined (r0kc's lesson, inverted).
  const kept = new Set<string>();
  for (const b of await readAllBeats(characterId, { includeRetired: false })) {
    kept.add(collapseSummary(companionEntryFromBeat(b).summary));
  }

  const wanted = new Map<string, string>(); // collapsed summary -> beatId (first)
  let vetoed = 0;
  for (const id of retiredBeatIds) {
    const beat = await readBeat(characterId, id);
    if (!beat) continue;
    const want = collapseSummary(companionEntryFromBeat(beat).summary);
    if (!want) continue;
    if (kept.has(want)) { vetoed++; continue; }
    if (!wanted.has(want)) wanted.set(want, id);
  }
  if (vetoed > 0) {
    console.info(`[ME:retire] ${characterId} — ${vetoed} companion(s) VETOED: summary shared with a surviving beat, entry left alone`);
  }
  if (wanted.size === 0) return;

  const index = await readIndex("character", characterId).catch(() => null);
  const ids = (index?.entries ?? [])
    .filter((e) => !e.discardedAt && !e.deletedAt && wanted.has(collapseSummary(e.summary)))
    .map((e) => e.id);
  if (ids.length > 0) {
    await retireEntries("character", characterId, ids, reason);
  }
}

// ── Beat write ─────────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function writeBeat(
  characterId: string,
  beat: EmotionalBeat,
): Promise<void> {
  await writeYaml(beatFilePath(characterId, beat.id), beat);
  await upsertBeatIndex(characterId, {
    id:           beat.id,
    provenanceKey: beat.provenanceKey,
    emotion:      beat.emotion,
    subpattern:   beat.subpattern,
    salience:     beat.salience,
    speaker:      beat.speaker,
    created:      beat.created,
    sourceType:   beat.sourceType,
    sourceChatId: beat.sourceChatId,
    threadId:     beat.threadId,
    turnStart:    beat.turnStart,
    turnEnd:      beat.turnEnd,
    tokens:     estimateTokens(
      `${beat.motivation} ${beat.relationalDynamics} ${beat.outcome} ${beat.text}`,
    ),
  });
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function encodeBeat(
  characterId: string,
  result: ClassificationResult,
  analysis: BeatAnalysis,
  sourceType: "chat" | "story",
  sourceChatId?: string,
  threadId?: string,
  // r0kc: write over the beat this chunk's PROVENANCE already produced, instead
  // of minting a new name because the reading of it improved. The caller supplies
  // it because the caller is the one holding the index; encodeBeat is called from
  // the live path too, where there is nothing to look up.
  reuseId?: string,
): Promise<EmotionalBeat> {
  const provenanceKey = provenanceKeyForChunk(result.chunk);
  const beat: EmotionalBeat = {
    id:                reuseId ?? beatIdFor(result.chunk),
    ...(provenanceKey ? { provenanceKey } : {}),
    speaker:           result.chunk.speaker,
    emotion:           result.primaryEmotion!,
    subpattern:        analysis.subpattern,
    emotions:          analysis.emotions,
    subtext:           analysis.subtext,
    text:              result.chunk.text,
    motivation:        analysis.motivation,
    relationalDynamics: analysis.relationalDynamics,
    outcome:           analysis.outcome,
    salience:          analysis.salience,
    turnStart:         result.chunk.turnStart,
    turnEnd:           result.chunk.turnEnd,
    created:           new Date().toISOString().slice(0, 10),
    sourceType,
    ...(sourceChatId ? { sourceChatId } : {}),
    ...(threadId ? { threadId } : {}),
  };

  await writeBeat(characterId, beat);
  return beat;
}

// ── Beat clear ─────────────────────────────────────────────────────────────

export async function clearBeats(characterId: string): Promise<number> {
  const index = await readBeatIndex(characterId);
  if (!index) return 0;

  let deleted = 0;
  for (const entry of index.entries) {
    try {
      await rm(beatFilePath(characterId, entry.id));
      deleted++;
    } catch { /* file already gone */ }
  }
  try {
    await rm(beatIndexPath(characterId));
  } catch { /* already gone */ }

  return deleted;
}

export async function encodeBeats(
  characterId: string,
  analyzed: AnalyzedBeat[],
  sourceType: "chat" | "story",
): Promise<EmotionalBeat[]> {
  const results: EmotionalBeat[] = [];
  for (const { result, analysis } of analyzed) {
    results.push(await encodeBeat(characterId, result, analysis, sourceType));
  }
  return results;
}
