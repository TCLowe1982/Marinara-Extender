// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

import { readFile, writeFile, mkdir, access, unlink, readdir, rename } from "fs/promises";
import { join, dirname } from "path";
import { parse, stringify } from "yaml";
import { defaultDataDir } from "./paths.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type Scope = "global" | "character" | "chat";
export type Lane = "open_threads" | "user_topics" | "character_topics";
export type EntryStatus = "open" | "in_progress" | "done" | "deferred";
export type MemoryTier = "short" | "long" | "core" | "secondary_core";

// Tier thresholds — score = retrievalCount + (recitationCount × 3)
export const TIER_SCORE_LONG = 5;
export const TIER_SCORE_CORE = 25;
// Demotion: days without retrieval before dropping a tier
export const TIER_DAYS_LONG_DEMOTES = 30;
export const TIER_DAYS_SHORT_PRUNES = 14;
// Cycles before a memory becomes secondary_core (never pruned)
export const TIER_SECONDARY_CORE_CYCLES = 3;
// Days without retrieval before a non-core entry is moved to the COLD archive
// (out of the hot index the loader scans every turn). Not deleted — retained at
// full fidelity and brought back on a recall miss. "Haven't touched it in months."
export const TIER_DAYS_COLD = 90;

export interface IndexEntry {
  id: string;
  path: string;           // relative to scope directory
  summary: string;
  tokens: number;
  lane: Lane;
  status?: EntryStatus;
  lastAccessed: string;
  // Memory tier system (mirrored from Entry for fast loader access)
  tier?: MemoryTier;
  retrievalCount?: number;
  recitationCount?: number;
  cycleCount?: number;
  lastRetrievedAt?: string; // ISO datetime of last retrieval
  sourceChatId?: string;    // chat this entry was imported/derived from (for clean re-import)
}

export interface ScopeIndex {
  scope: Scope;
  scopeId: string;    // "global" | characterId | chatId
  lastUpdated: string;
  entries: IndexEntry[];
}

export interface Entry {
  id: string;
  lane: Lane;
  summary: string;
  status: EntryStatus;
  created: string;
  lastAccessed: string;
  content: string;
  tokens: number;
  // Memory tier system
  tier?: MemoryTier;
  retrievalCount?: number;
  recitationCount?: number;
  cycleCount?: number;
  lastRetrievedAt?: string; // ISO datetime of last retrieval
  sourceChatId?: string;    // chat this entry was imported/derived from (for clean re-import)
  // Soft clock context at time of encoding
  timeContext?: { timeOfDay: string; dayOfWeek: string; inferredFrom?: string };
}

export interface Bookmark {
  id: string;
  topic: string;
  summary: string;
  weight: number;     // 0.0–1.0; decays each turn by decayRate
  why: string;
  createdTurn: number;
  lastSeenTurn: number;
  decayRate: number;  // default 0.97
}

// ── Data directory ───────────────────────────────────────────────────────────

export function getDataDir(): string {
  // Explicit override wins; otherwise resolve relative to the install (not cwd)
  // so the data dir is found no matter where the server was launched from.
  return process.env.MARINARA_EXTENDER_DATA ?? defaultDataDir();
}

// ── Path helpers ─────────────────────────────────────────────────────────────

// Reject ids that would escape the data dir when joined into a path. Ids come
// from request input (scopeId/characterId/chatId) and are interpolated into
// filesystem paths, so an unsanitized "../.." traverses out. Legit ids are
// nanoid/uuid-style (letters, digits, _ and -); anything with a separator, "..",
// or a null byte is rejected. Throwing rejects the request rather than touching
// an out-of-bounds path.
export function assertSafeId(id: string): void {
  if (!id || /[/\\]|\.\.|\0/.test(id)) {
    throw new Error(`unsafe id: ${JSON.stringify(String(id)).slice(0, 48)}`);
  }
}

export function scopeDir(scope: Scope, scopeId: string): string {
  const base = getDataDir();
  if (scope === "global") return join(base, "global");
  assertSafeId(scopeId);
  if (scope === "character") return join(base, "characters", scopeId);
  return join(base, "chats", scopeId);
}

export function indexPath(scope: Scope, scopeId: string): string {
  return join(scopeDir(scope, scopeId), "index.yaml");
}

export function entryPath(scope: Scope, scopeId: string, relativePath: string): string {
  return join(scopeDir(scope, scopeId), relativePath);
}

export function bookmarksPath(scope: Scope, scopeId: string): string {
  return join(scopeDir(scope, scopeId), "bookmarks.yaml");
}

// Remove unpaired UTF-16 surrogates. Truncating a string mid-emoji (our 120/140/
// 600/700-char slices) can leave a lone surrogate, which is invalid Unicode and
// makes the whole LLM request body fail to JSON-encode ("invalid high surrogate")
// — silently breaking generations when the entry rides along in the prompt.
export function stripLoneSurrogates(s: string): string {
  if (!s) return s;
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "") // high not followed by low
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, ""); // low not preceded by high
}

// ── YAML helpers ─────────────────────────────────────────────────────────────

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true).catch(() => false);
}

async function readYaml<T>(filePath: string): Promise<T | null> {
  if (!(await exists(filePath))) return null;
  const raw = await readFile(filePath, "utf8");
  try {
    return parse(raw) as T;
  } catch (err) {
    console.error(`[ME:storage] corrupt YAML at ${filePath} — treating as empty:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// Atomic write: serialize to a temp file, then rename over the target. rename is
// atomic, so a concurrent reader (or a writer that lost the race) never sees a
// half-written / interleaved file — the file is always a complete prior or new
// version. Also protects against a process kill mid-write (the temp is orphaned,
// the real file stays intact). rename replaces an existing file on Windows too.
async function writeYaml(filePath: string, data: unknown): Promise<void> {
  await ensureDir(filePath);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await writeFile(tmp, stringify(data), "utf8");
  // rename is atomic, but on Windows it can transiently fail with EPERM/EBUSY/
  // EACCES when the target is briefly held — antivirus, the search indexer, a
  // reader, or another process writing the same file. Retry with backoff before
  // giving up; a final failure leaves the real file intact (no corruption).
  const transient = new Set(["EPERM", "EBUSY", "EACCES"]);
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, filePath);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      if (attempt >= 9 || !transient.has(code)) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
      await new Promise((r) => setTimeout(r, 30 * (attempt + 1))); // 30,60,…,300ms
    }
  }
}

// ── Write serialization ───────────────────────────────────────────────────────
// Concurrent upsertIndexEntry calls for the same file cause read-modify-write
// races that corrupt YAML. Serialize all writes per file path.

const _writeLocks = new Map<string, Promise<void>>();

function serializedWrite(filePath: string, fn: () => Promise<void>): Promise<void> {
  const prev = _writeLocks.get(filePath) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  _writeLocks.set(filePath, next);
  // Prune resolved locks to avoid unbounded growth.
  next.then(() => { if (_writeLocks.get(filePath) === next) _writeLocks.delete(filePath); });
  return next;
}

// ── Index operations ─────────────────────────────────────────────────────────

export async function readIndex(scope: Scope, scopeId: string): Promise<ScopeIndex | null> {
  return readYaml<ScopeIndex>(indexPath(scope, scopeId));
}

// writeIndex is intentionally NOT serialized — callers that need serialization
// (upsertIndexEntry, removeIndexEntry) use serializedWrite themselves and call
// writeYaml directly inside the lock to avoid deadlock.
export async function writeIndex(index: ScopeIndex): Promise<void> {
  await writeYaml(indexPath(index.scope, index.scopeId), index);
}

export function emptyIndex(scope: Scope, scopeId: string): ScopeIndex {
  return { scope, scopeId, lastUpdated: new Date().toISOString(), entries: [] };
}

export async function upsertIndexEntry(
  scope: Scope,
  scopeId: string,
  entry: IndexEntry,
): Promise<void> {
  const p = indexPath(scope, scopeId);
  return serializedWrite(p, async () => {
    const existing = await readIndex(scope, scopeId);
    // Guard: if the index file is present but unreadable, do NOT treat it as
    // empty — that would rebuild it from this one entry and orphan all the
    // others. Bail loudly; the file stays intact for the repair script.
    if (!existing && (await exists(p))) {
      throw new Error(`[storage] refusing to overwrite unreadable index ${p} — run scripts/repair-indexes.mjs`);
    }
    const index = existing ?? emptyIndex(scope, scopeId);
    const clean: IndexEntry = { ...entry, summary: stripLoneSurrogates(entry.summary) };
    const i = index.entries.findIndex((e) => e.id === clean.id);
    if (i >= 0) index.entries[i] = clean;
    else index.entries.push(clean);
    index.lastUpdated = new Date().toISOString();
    await writeYaml(p, index);
  });
}

// Serialized read-modify-write of a whole index. Use for updates that touch an
// existing entry in place (e.g. bumping recitationCount) so they share the same
// per-file lock as upsertIndexEntry and can't clobber concurrent writes. The
// mutator may return false to skip the write entirely (e.g. entry not found).
export async function mutateIndex(
  scope: Scope,
  scopeId: string,
  mutate: (index: ScopeIndex) => boolean | void,
): Promise<void> {
  const p = indexPath(scope, scopeId);
  return serializedWrite(p, async () => {
    const index = await readIndex(scope, scopeId);
    if (!index) return;
    if (mutate(index) === false) return;
    index.lastUpdated = new Date().toISOString();
    await writeYaml(p, index);
  });
}

// ── Cold archive index ────────────────────────────────────────────────────────
// A second per-scope index (index.cold.yaml) holding entries demoted out of the
// hot working set. The loader does NOT read it each turn — only on a recall miss
// — so the hot index (and the per-turn scan) stays bounded. Entry files are never
// moved or deleted; only the index ROW moves between hot and cold.

export function coldIndexPath(scope: Scope, scopeId: string): string {
  return join(scopeDir(scope, scopeId), "index.cold.yaml");
}

export async function readColdIndex(scope: Scope, scopeId: string): Promise<ScopeIndex | null> {
  return readYaml<ScopeIndex>(coldIndexPath(scope, scopeId));
}

// Move entries hot → cold. Adds to cold FIRST (a crash can never lose the row —
// at worst it's briefly in both, and the loader reads hot so it's still visible),
// then removes from hot. Entry files untouched. Returns how many moved.
export async function moveToCold(scope: Scope, scopeId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const idset = new Set(ids);
  const hot = await readIndex(scope, scopeId);
  if (!hot) return 0;
  const moving = hot.entries.filter((e) => idset.has(e.id));
  if (moving.length === 0) return 0;

  const coldPath = coldIndexPath(scope, scopeId);
  await serializedWrite(coldPath, async () => {
    const cold = (await readYaml<ScopeIndex>(coldPath)) ?? emptyIndex(scope, scopeId);
    const have = new Set(cold.entries.map((e) => e.id));
    for (const e of moving) if (!have.has(e.id)) cold.entries.push(e);
    cold.lastUpdated = new Date().toISOString();
    await writeYaml(coldPath, cold);
  });
  await serializedWrite(indexPath(scope, scopeId), async () => {
    const h = await readIndex(scope, scopeId);
    if (!h) return;
    h.entries = h.entries.filter((e) => !idset.has(e.id));
    h.lastUpdated = new Date().toISOString();
    await writeYaml(indexPath(scope, scopeId), h);
  });
  return moving.length;
}

// Bring one entry back from cold → hot (rehydrate on recall). Returns its row.
export async function promoteFromCold(scope: Scope, scopeId: string, id: string): Promise<IndexEntry | null> {
  const coldPath = coldIndexPath(scope, scopeId);
  let row: IndexEntry | null = null;
  await serializedWrite(coldPath, async () => {
    const cold = await readYaml<ScopeIndex>(coldPath);
    if (!cold) return;
    row = cold.entries.find((e) => e.id === id) ?? null;
    if (!row) return;
    cold.entries = cold.entries.filter((e) => e.id !== id);
    cold.lastUpdated = new Date().toISOString();
    await writeYaml(coldPath, cold);
  });
  if (row) await upsertIndexEntry(scope, scopeId, row);
  return row;
}

// ── Generic standalone-file YAML I/O ──────────────────────────────────────────
// For sidecar-owned files outside the scope/index model (alias table, holding
// pool). Reuses the same atomic-write + per-file lock so they get the same
// corruption-safety. Pass an absolute path (build it from getDataDir()).

export async function readYamlFile<T>(filePath: string): Promise<T | null> {
  return readYaml<T>(filePath);
}

// Serialized read-modify-write of a standalone YAML file. The file is created
// from init() if absent. Returns the post-mutation data. Concurrent callers for
// the same path are serialized; a half-written file is never observed.
export async function mutateYamlFile<T>(
  filePath: string,
  init: () => T,
  mutate: (data: T) => void | Promise<void>,
): Promise<T> {
  let out!: T;
  await serializedWrite(filePath, async () => {
    const data = (await readYaml<T>(filePath)) ?? init();
    await mutate(data);
    await writeYaml(filePath, data);
    out = data;
  });
  return out;
}

export async function removeIndexEntry(
  scope: Scope,
  scopeId: string,
  entryId: string,
): Promise<void> {
  const p = indexPath(scope, scopeId);
  return serializedWrite(p, async () => {
    const index = await readIndex(scope, scopeId);
    if (!index) return;
    index.entries = index.entries.filter((e) => e.id !== entryId);
    index.lastUpdated = new Date().toISOString();
    await writeYaml(p, index);
  });
}

// Remove every entry derived from a given chat (index rows + files). Used to
// cleanly replace a chat's import artifacts on re-import, so granular beats
// don't pile up alongside a prior run's entries. Returns the number removed.
export async function removeEntriesBySourceChat(
  scope: Scope,
  scopeId: string,
  sourceChatId: string,
): Promise<number> {
  const p = indexPath(scope, scopeId);
  const removed: IndexEntry[] = [];
  await serializedWrite(p, async () => {
    const index = await readIndex(scope, scopeId);
    if (!index) return;
    const keep: IndexEntry[] = [];
    for (const e of index.entries) {
      if (e.sourceChatId === sourceChatId) removed.push(e);
      else keep.push(e);
    }
    if (removed.length === 0) return;
    index.entries = keep;
    index.lastUpdated = new Date().toISOString();
    await writeYaml(p, index);
  });
  for (const e of removed) {
    await deleteEntryFile(scope, scopeId, e.path).catch(() => {});
  }
  return removed.length;
}

// ── Entry operations ──────────────────────────────────────────────────────────

export async function readEntry(
  scope: Scope,
  scopeId: string,
  relativePath: string,
): Promise<Entry | null> {
  return readYaml<Entry>(entryPath(scope, scopeId, relativePath));
}

export async function writeEntry(
  scope: Scope,
  scopeId: string,
  entry: Entry,
): Promise<string> {
  const laneDir = entry.lane === "open_threads"
    ? "threads"
    : entry.lane === "user_topics"
    ? "user-topics"
    : "char-topics";
  const relative = `${laneDir}/${entry.id}.yaml`;
  // Sanitize text so a truncation-split emoji can't poison the prompt later.
  const clean: Entry = { ...entry, summary: stripLoneSurrogates(entry.summary), content: stripLoneSurrogates(entry.content) };
  await writeYaml(entryPath(scope, scopeId, relative), clean);
  return relative;
}

export async function deleteEntryFile(
  scope: Scope,
  scopeId: string,
  relativePath: string,
): Promise<void> {
  const p = entryPath(scope, scopeId, relativePath);
  await unlink(p).catch(() => { /* already gone */ });
}

// ── Scope discovery ───────────────────────────────────────────────────────────

export async function listScopeIds(scope: Scope): Promise<string[]> {
  if (scope === "global") return ["global"];
  const base = getDataDir();
  const dir = scope === "character"
    ? join(base, "characters")
    : join(base, "chats");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

// ── Bookmark operations ───────────────────────────────────────────────────────

export async function readBookmarks(scope: Scope, scopeId: string): Promise<Bookmark[]> {
  return (await readYaml<Bookmark[]>(bookmarksPath(scope, scopeId))) ?? [];
}

export async function writeBookmarks(
  scope: Scope,
  scopeId: string,
  bookmarks: Bookmark[],
): Promise<void> {
  await writeYaml(bookmarksPath(scope, scopeId), bookmarks);
}

// Serialized read-modify-write of a scope's bookmarks. Use for any update that
// reads the current list and writes a modified one, so concurrent callers
// (per-turn decay, panel edits, ingest) share one per-file lock instead of
// racing and corrupting bookmarks.yaml. The mutator returns the new array.
export async function mutateBookmarks(
  scope: Scope,
  scopeId: string,
  mutate: (bookmarks: Bookmark[]) => Bookmark[],
): Promise<void> {
  const p = bookmarksPath(scope, scopeId);
  return serializedWrite(p, async () => {
    const current = (await readYaml<Bookmark[]>(p)) ?? [];
    await writeYaml(p, mutate(current));
  });
}

// ── Token estimation ──────────────────────────────────────────────────────────

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
