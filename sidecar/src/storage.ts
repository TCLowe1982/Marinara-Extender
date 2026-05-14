import { readFile, writeFile, mkdir, access, unlink, readdir } from "fs/promises";
import { join, dirname } from "path";
import { parse, stringify } from "yaml";

// ── Types ────────────────────────────────────────────────────────────────────

export type Scope = "global" | "character" | "chat";
export type Lane = "open_threads" | "user_topics" | "character_topics";
export type EntryStatus = "open" | "in_progress" | "done" | "deferred";

export interface IndexEntry {
  id: string;
  path: string;       // relative to scope directory
  summary: string;
  tokens: number;
  lane: Lane;
  status?: EntryStatus;
  lastAccessed: string;
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
  return process.env.MARINARA_EXTENDER_DATA ?? join(process.cwd(), "data");
}

// ── Path helpers ─────────────────────────────────────────────────────────────

export function scopeDir(scope: Scope, scopeId: string): string {
  const base = getDataDir();
  if (scope === "global") return join(base, "global");
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
  return parse(raw) as T;
}

async function writeYaml(filePath: string, data: unknown): Promise<void> {
  await ensureDir(filePath);
  await writeFile(filePath, stringify(data), "utf8");
}

// ── Index operations ─────────────────────────────────────────────────────────

export async function readIndex(scope: Scope, scopeId: string): Promise<ScopeIndex | null> {
  return readYaml<ScopeIndex>(indexPath(scope, scopeId));
}

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
  const index = (await readIndex(scope, scopeId)) ?? emptyIndex(scope, scopeId);
  const i = index.entries.findIndex((e) => e.id === entry.id);
  if (i >= 0) index.entries[i] = entry;
  else index.entries.push(entry);
  index.lastUpdated = new Date().toISOString();
  await writeIndex(index);
}

export async function removeIndexEntry(
  scope: Scope,
  scopeId: string,
  entryId: string,
): Promise<void> {
  const index = await readIndex(scope, scopeId);
  if (!index) return;
  index.entries = index.entries.filter((e) => e.id !== entryId);
  index.lastUpdated = new Date().toISOString();
  await writeIndex(index);
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
  await writeYaml(entryPath(scope, scopeId, relative), entry);
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

export async function upsertBookmark(
  scope: Scope,
  scopeId: string,
  bookmark: Bookmark,
): Promise<void> {
  const bookmarks = await readBookmarks(scope, scopeId);
  const i = bookmarks.findIndex((b) => b.id === bookmark.id);
  if (i >= 0) bookmarks[i] = bookmark;
  else bookmarks.push(bookmark);
  await writeBookmarks(scope, scopeId, bookmarks);
}

// ── Token estimation ──────────────────────────────────────────────────────────

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
