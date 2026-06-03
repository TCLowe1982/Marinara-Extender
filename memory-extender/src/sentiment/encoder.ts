// Stage 3: Memory Encoding
//
// Writes analyzed emotional beats to disk as YAML under:
//   data/characters/<characterId>/beats/<id>.yaml
//
// A separate beats/index.yaml tracks summary metadata for fast retrieval
// without reading every beat file. The beats store is intentionally separate
// from the main entries/ index so the existing memory UI is unaffected.

import { readFile, writeFile, mkdir, access, rm } from "fs/promises";
import { join, dirname } from "path";
import { createHash } from "crypto";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { getDataDir } from "../storage.js";
import type { Emotion } from "./types.js";
import type { EmotionalBeat, ClassificationResult, BeatAnalysis, Chunk } from "./types.js";
import type { AnalyzedBeat } from "./analyzer.js";

// Deterministic beat id derived from the source chunk. Re-encoding the same
// chunk yields the same id (idempotent overwrite), and it lets the pipeline skip
// chunks whose beat already exists on disk — the basis for resumable imports.
export function beatIdForChunk(chunk: Pick<Chunk, "speaker" | "text" | "turnStart" | "turnEnd">): string {
  const h = createHash("sha1")
    .update(`${chunk.turnStart}:${chunk.turnEnd}:${chunk.speaker}\n${chunk.text}`)
    .digest("hex");
  return `beat-${h.slice(0, 12)}`;
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
  return join(getDataDir(), "characters", characterId, "beats");
}

function beatIndexPath(characterId: string): string {
  return join(beatsDir(characterId), "index.yaml");
}

function beatFilePath(characterId: string, beatId: string): string {
  return join(beatsDir(characterId), `${beatId}.yaml`);
}

// ── YAML helpers ───────────────────────────────────────────────────────────

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

async function fileExists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true).catch(() => false);
}

async function readYaml<T>(filePath: string): Promise<T | null> {
  if (!(await fileExists(filePath))) return null;
  return parseYaml(await readFile(filePath, "utf8")) as T;
}

async function writeYaml(filePath: string, data: unknown): Promise<void> {
  await ensureDir(filePath);
  await writeFile(filePath, toYaml(data), "utf8");
}

// ── Beat index ─────────────────────────────────────────────────────────────

export interface BeatIndexEntry {
  id: string;
  emotion: Emotion;
  subpattern?: string;
  salience: number;
  speaker: string;
  created: string;
  sourceType: "chat" | "story";
  sourceChatId?: string;
  turnStart: number;
  turnEnd: number;
  tokens: number;
}

export interface BeatIndex {
  characterId: string;
  lastUpdated: string;
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
    if (i >= 0) index.entries[i] = entry;
    else index.entries.push(entry);
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

export async function readAllBeats(characterId: string): Promise<EmotionalBeat[]> {
  const index = await readBeatIndex(characterId);
  if (!index) return [];
  const beats = await Promise.all(
    index.entries.map((e) => readBeat(characterId, e.id)),
  );
  return beats.filter((b): b is EmotionalBeat => b !== null);
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
    emotion:      beat.emotion,
    subpattern:   beat.subpattern,
    salience:     beat.salience,
    speaker:      beat.speaker,
    created:      beat.created,
    sourceType:   beat.sourceType,
    sourceChatId: beat.sourceChatId,
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
): Promise<EmotionalBeat> {
  const beat: EmotionalBeat = {
    id:                beatIdForChunk(result.chunk),
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
