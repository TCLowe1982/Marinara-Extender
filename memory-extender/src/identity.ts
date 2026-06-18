// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Character Identity System (Phase 3)
//
// Translates ephemeral Marinara card instance IDs to stable slugs so memories
// survive card deletion and recreation.
//
// data/identity-map.yaml  — persisted mapping (not git-tracked, lives in data/)
// Each identity key is used as the scopeId for "character" scope storage, so
// data/characters/<key>/ holds that character's memories across all card IDs.
//
// Typical flows:
//   First use: resolveIdentity("cm7x...", "Lara") → creates "lara", migrates dir
//   Card recreated: relinkIdentity("cm8y...", "lara") → points new ID at old data
//   Key conflict: renameIdentityKey("lara", "lara_morrigan")

import { readFile, rename, access } from "fs/promises";
import { join } from "path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import {
  getDataDir,
  readIndex,
  readEntry,
  writeEntry,
  upsertIndexEntry,
  atomicWriteFile,
  type Entry,
} from "./storage.js";
import { readBeatIndex, readBeat, writeBeat, type BeatIndex } from "./sentiment/encoder.js";
import type { EmotionalBeat } from "./sentiment/types.js";
import { readAliasTable, findExactMatches, normalizeLabel, tokenContainment, jaroWinkler } from "./aliases.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IdentityEntry {
  characterId: string;
  identityKey: string;
  name: string;
  created: string;
}

interface IdentityMapFile {
  entries: IdentityEntry[];
}

export interface IdentityExportBundle {
  version: 1;
  identityKey: string;
  name: string;
  exported: string;
  entries: Entry[];
  beats: EmotionalBeat[];
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function identityMapPath(): string {
  return join(getDataDir(), "identity-map.yaml");
}

function characterDir(key: string): string {
  return join(getDataDir(), "characters", key);
}

// ── File I/O ──────────────────────────────────────────────────────────────────

async function readMapFile(): Promise<IdentityMapFile> {
  try {
    const raw = await readFile(identityMapPath(), "utf8");
    const parsed = parseYaml(raw) as IdentityMapFile | null;
    return parsed ?? { entries: [] };
  } catch {
    return { entries: [] };
  }
}

async function writeMapFile(map: IdentityMapFile): Promise<void> {
  await atomicWriteFile(identityMapPath(), toYaml(map));
}

async function dirExists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

// ── Slug generation ───────────────────────────────────────────────────────────

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return slug || "character";
}

async function uniqueSlug(base: string, taken: Set<string>): Promise<string> {
  if (!taken.has(base) && !(await dirExists(characterDir(base)))) return base;
  for (let n = 2; n <= 99; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate) && !(await dirExists(characterDir(candidate)))) return candidate;
  }
  return `${base}_${Date.now()}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getIdentityMap(): Promise<IdentityEntry[]> {
  return (await readMapFile()).entries;
}

// ── Subject attribution (live-turn beat routing) ──────────────────────────────
// In multi-character RP the whole assistant message carries one speaker label,
// so the analyzer attributes each beat to a `subject` name. These helpers turn
// that name into an identity key — or refuse, so the caller can park the beat
// in the holding pool instead of guessing.

// Names to show the analyzer as the known-character roster: alias-table
// canonical names win, identity-map names fill in the rest. Raw card-ID
// "names" are skipped — they'd teach the model to answer with IDs.
//
// When participantCharacterIds is provided (the extension sends the chat's
// characterIds), the roster is RESTRICTED to characters actually in the
// scene — otherwise the model assigns narration-voice trivia to whichever
// global name looks narrator-shaped (observed: Aurora, via her "Narrator"
// alias, collecting in-scene junk from scenes she was not in).
export async function buildSubjectRoster(
  sessionCharacterName?: string,
  participantCharacterIds?: string[],
): Promise<string[]> {
  const [map, aliases] = await Promise.all([readMapFile(), readAliasTable()]);
  const names = new Set<string>();
  if (sessionCharacterName?.trim()) names.add(sessionCharacterName.trim());

  const restrictToKeys = participantCharacterIds?.length
    ? new Set(
        map.entries
          .filter((e) => participantCharacterIds.includes(e.characterId))
          .map((e) => e.identityKey),
      )
    : null;

  for (const [key, rec] of Object.entries(aliases)) {
    if (restrictToKeys && !restrictToKeys.has(key)) continue;
    if (rec.canonicalName?.trim()) names.add(rec.canonicalName.trim());
  }
  for (const e of map.entries) {
    if (restrictToKeys && !restrictToKeys.has(e.identityKey)) continue;
    if (e.name && e.name !== e.characterId && !/^_|^[A-Za-z0-9_-]{18,}$/.test(e.name)) names.add(e.name);
  }
  return [...names];
}

// Resolve a subject name to an identity key. Checks the alias table (canonical
// names + aliases), then identity-map names, exact normalized match only —
// no fuzzy guessing here; an unresolved name belongs in the holding pool.
export async function resolveNameToKey(label: string): Promise<string | null> {
  const normalized = normalizeLabel(label);
  if (!normalized) return null;
  const aliases = await readAliasTable();
  const exact = findExactMatches(aliases, label);
  if (exact.length === 1) return exact[0]!.identityKey;
  if (exact.length > 1) return null; // ambiguous — let the pool/user decide
  const map = await readMapFile();
  const byName = map.entries.filter((e) => normalizeLabel(e.name) === normalized);
  const keys = new Set(byName.map((e) => e.identityKey));
  if (keys.size === 1) return byName[0]!.identityKey;
  if (keys.size > 1) return null;

  // Token-containment fallback: a name variant like "Mari Zielińska" should
  // resolve to "Dr. Mari Zielińska". Routes ONLY when exactly one character's
  // labels contain the query's significant tokens — never guesses between two
  // people (an ambiguous match returns null and falls to the holding pool).
  const contained = new Set<string>();
  for (const [identityKey, rec] of Object.entries(aliases)) {
    const labels = [rec.canonicalName, ...(rec.aliases ?? [])];
    if (labels.some((l) => tokenContainment(normalized, normalizeLabel(l)))) contained.add(identityKey);
  }
  return contained.size === 1 ? [...contained][0]! : null;
}

// Does a subject name refer to the session character? Exact normalized match,
// significant-token containment ("Mari" ⊂ "Dr. Mari Zielińska"), or a high
// jaro-winkler score — models stumble on diacritics ("Zieliöska" for
// "Zielińska") and a near-miss spelling of the session name shouldn't park a
// beat in the holding pool. Fuzzy matching is safe to auto-route ONLY here,
// because the candidate set has exactly one member.
export function matchesSessionName(subject: string, sessionCharacterName?: string): boolean {
  if (!sessionCharacterName) return false;
  const a = normalizeLabel(subject);
  const b = normalizeLabel(sessionCharacterName);
  if (!a || !b) return false;
  return a === b || tokenContainment(a, b) || jaroWinkler(a, b) >= 0.9;
}

// Resolve a Marinara card ID to its stable identity key.
// On first encounter, auto-creates a mapping using characterName as the slug.
// If data already exists under the raw characterId, migrates the directory.
export async function resolveIdentity(
  characterId: string,
  characterName?: string,
): Promise<string> {
  const map = await readMapFile();
  const existing = map.entries.find((e) => e.characterId === characterId);
  if (existing) {
    // Opportunistically fix name if it's still a raw ID and we now have a real name.
    if (characterName && characterName !== existing.name && existing.name === characterId) {
      existing.name = characterName;
      await writeMapFile(map);
      console.info(`[identity] updated name for ${characterId}: "${characterName}"`);
    }
    return existing.identityKey;
  }

  const base = slugify(characterName ?? characterId);
  const taken = new Set(map.entries.map((e) => e.identityKey));
  const identityKey = await uniqueSlug(base, taken);

  // Migrate existing data directory if it was stored under the raw card ID.
  const oldDir = characterDir(characterId);
  const newDir = characterDir(identityKey);
  if ((await dirExists(oldDir)) && !(await dirExists(newDir))) {
    await rename(oldDir, newDir);
    console.info(`[identity] migrated data dir: ${characterId} → ${identityKey}`);
  }

  map.entries.push({
    characterId,
    identityKey,
    name: characterName ?? characterId,
    created: new Date().toISOString().slice(0, 10),
  });
  await writeMapFile(map);
  console.info(`[identity] registered: ${characterId} → "${identityKey}"`);

  return identityKey;
}

// Link characterId to an existing identity key (card recreation scenario).
// Merges any data from the new card's directory into the identity's directory.
export async function relinkIdentity(characterId: string, identityKey: string): Promise<void> {
  const map = await readMapFile();
  const target = map.entries.find((e) => e.identityKey === identityKey);
  if (!target) throw new Error(`Identity key "${identityKey}" not found.`);

  // Drop any previous mapping for this characterId.
  map.entries = map.entries.filter((e) => e.characterId !== characterId);

  // If the new card already has some data stored under its raw ID, move it.
  const oldDir = characterDir(characterId);
  const newDir = characterDir(identityKey);
  if ((await dirExists(oldDir)) && !(await dirExists(newDir))) {
    await rename(oldDir, newDir);
  }

  map.entries.push({
    characterId,
    identityKey,
    name: target.name,
    created: new Date().toISOString().slice(0, 10),
  });
  await writeMapFile(map);
  console.info(`[identity] relinked: ${characterId} → "${identityKey}"`);
}

// Rename an identity key. Updates all card-ID mappings that point to it
// and renames the data directory.
export async function renameIdentityKey(oldKey: string, newKey: string): Promise<void> {
  const newSlug = slugify(newKey);
  const map = await readMapFile();
  const taken = new Set(map.entries.map((e) => e.identityKey));

  if (taken.has(newSlug)) throw new Error(`Identity key "${newSlug}" already exists.`);

  let found = false;
  for (const e of map.entries) {
    if (e.identityKey === oldKey) {
      e.identityKey = newSlug;
      found = true;
    }
  }
  if (!found) throw new Error(`Identity key "${oldKey}" not found.`);

  const oldDir = characterDir(oldKey);
  const newDir = characterDir(newSlug);
  if ((await dirExists(oldDir)) && !(await dirExists(newDir))) {
    await rename(oldDir, newDir);
  }

  await writeMapFile(map);
  console.info(`[identity] renamed: "${oldKey}" → "${newSlug}"`);
}

// Update the display name for all entries that share an identity key.
export async function updateIdentityName(identityKey: string, name: string): Promise<void> {
  const map = await readMapFile();
  let found = false;
  for (const e of map.entries) {
    if (e.identityKey === identityKey) {
      e.name = name;
      found = true;
    }
  }
  if (!found) throw new Error(`Identity key "${identityKey}" not found.`);
  await writeMapFile(map);
  console.info(`[identity] name updated for key "${identityKey}": "${name}"`);
}

// ── Export / Import ───────────────────────────────────────────────────────────

// Export all memories for an identity key as a portable JSON bundle.
export async function exportIdentity(identityKey: string): Promise<IdentityExportBundle> {
  const map = await readMapFile();
  const entry = map.entries.find((e) => e.identityKey === identityKey);
  if (!entry) throw new Error(`Identity key "${identityKey}" not found.`);

  // Read all character-scope entries.
  const index = await readIndex("character", identityKey);
  const entryRecords: Entry[] = [];
  if (index) {
    const loaded = await Promise.all(
      index.entries.map((ie) => readEntry("character", identityKey, ie.path)),
    );
    for (const e of loaded) {
      if (e) entryRecords.push(e);
    }
  }

  // Read all emotional beats.
  const beatIndex = await readBeatIndex(identityKey);
  const beats: EmotionalBeat[] = [];
  if (beatIndex) {
    const loaded = await Promise.all(
      beatIndex.entries.map((be) => readBeat(identityKey, be.id)),
    );
    for (const b of loaded) {
      if (b) beats.push(b);
    }
  }

  return {
    version: 1,
    identityKey,
    name: entry.name,
    exported: new Date().toISOString(),
    entries: entryRecords,
    beats,
  };
}

// Import a bundle, writing all data under the target identity key.
// If targetKey is omitted, uses the bundle's own identityKey (creating if needed).
export async function importIdentity(
  bundle: IdentityExportBundle,
  targetKey?: string,
): Promise<string> {
  if (bundle.version !== 1) throw new Error("Unsupported bundle version.");

  const map = await readMapFile();
  const taken = new Set(map.entries.map((e) => e.identityKey));

  let key = targetKey ?? bundle.identityKey;
  if (!targetKey) {
    // Ensure the key is available; if not, generate a unique one.
    if (taken.has(key) || (await dirExists(characterDir(key)))) {
      key = await uniqueSlug(key, taken);
    }
  }

  // Write character-scope entries.
  for (const entry of bundle.entries) {
    const relativePath = await writeEntry("character", key, entry);
    await upsertIndexEntry("character", key, {
      id: entry.id,
      path: relativePath,
      summary: entry.summary,
      tokens: entry.tokens,
      lane: entry.lane,
      status: entry.status ?? "open",
      lastAccessed: entry.lastAccessed,
    });
  }

  // Write beats.
  for (const beat of bundle.beats) {
    await writeBeat(key, beat);
  }

  // Register mapping if not already present.
  const existing = map.entries.find((e) => e.identityKey === key);
  if (!existing) {
    map.entries.push({
      characterId: key,
      identityKey: key,
      name: bundle.name,
      created: new Date().toISOString().slice(0, 10),
    });
    await writeMapFile(map);
  }

  console.info(
    `[identity] imported bundle "${bundle.identityKey}" → "${key}" (${bundle.entries.length} entries, ${bundle.beats.length} beats)`,
  );
  return key;
}
