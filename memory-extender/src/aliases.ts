// Speaker Alias Table
//
// Maps the speaker labels that show up in imports ("Priya", "Dr. Chandrasekaran")
// to a stable character identityKey. Lives in a single sidecar-owned file,
// data/aliases.yaml, keyed by identityKey — NOT by name — so a character can be
// renamed without any migration (the aliases stay attached to the key).
//
// Matching is two-tier: an exact (case-insensitive) hit routes immediately; a
// jaro-winkler near-miss (>= 0.85) is offered as a *suggestion* only and never
// auto-routes, to avoid false positives like "Mari" → "Maria".

import { join } from "path";
import { getDataDir, readYamlFile, mutateYamlFile } from "./storage.js";

// Reserved identityKey for the human user's persona names. Beats whose speaker
// resolves here are the user's own — they route to user_topics, not a character.
export const USER_IDENTITY_KEY = "user";

export const FUZZY_THRESHOLD = 0.85;

export interface AliasMeta {
  addedAt: string;
  uses: number;
}

export interface AliasRecord {
  canonicalName: string;
  aliases: string[];                       // original-case labels, canonicalName implicitly included
  aliasMeta?: Record<string, AliasMeta>;   // keyed by normalized alias
}

// identityKey → record. The reserved USER_IDENTITY_KEY may appear here too.
export type AliasTable = Record<string, AliasRecord>;

function aliasTablePath(): string {
  return join(getDataDir(), "aliases.yaml");
}

// Compare-only normalization. The original case is preserved in the stored
// alias list; this is used solely for matching and as the dedup key.
export function normalizeLabel(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

// ── Jaro-Winkler ─────────────────────────────────────────────────────────────
// Pure, no dependency. Returns 0–1; 1 is identical. Winkler boost rewards a
// common prefix, which suits names ("Dr. Mari" vs "Dr. Mary").

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array(a.length).fill(false);
  const bMatched = new Array(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - matchWindow);
    const hi = Math.min(i + matchWindow + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  // Count transpositions.
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions) / m) / 3;

  // Winkler prefix boost (up to 4 chars, scaling 0.1).
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

// ── Read ───────────────────────────────────────────────────────────────────────

export async function readAliasTable(): Promise<AliasTable> {
  return (await readYamlFile<AliasTable>(aliasTablePath())) ?? {};
}

export interface AliasMatch {
  identityKey: string;
  canonicalName: string;
  matchedAlias: string;
}

// Every (normalized) label a record answers to: its canonical name + aliases.
function recordLabels(rec: AliasRecord): Set<string> {
  const s = new Set<string>([normalizeLabel(rec.canonicalName)]);
  for (const a of rec.aliases ?? []) s.add(normalizeLabel(a));
  return s;
}

// Exact (case-insensitive) match. Returns ALL records that claim the label —
// normally one; more than one is a collision the caller must resolve.
export function findExactMatches(table: AliasTable, label: string): AliasMatch[] {
  const norm = normalizeLabel(label);
  const out: AliasMatch[] = [];
  for (const [identityKey, rec] of Object.entries(table)) {
    if (recordLabels(rec).has(norm)) {
      out.push({ identityKey, canonicalName: rec.canonicalName, matchedAlias: label });
    }
  }
  return out;
}

export interface FuzzySuggestion extends AliasMatch {
  score: number;
}

// Best jaro-winkler match at or above threshold, or null. Never auto-routes —
// the caller surfaces this as a "suggested mapping" for the user to confirm.
export function findFuzzySuggestion(
  table: AliasTable,
  label: string,
  threshold = FUZZY_THRESHOLD,
): FuzzySuggestion | null {
  const norm = normalizeLabel(label);
  let best: FuzzySuggestion | null = null;
  for (const [identityKey, rec] of Object.entries(table)) {
    for (const candidate of recordLabels(rec)) {
      const score = jaroWinkler(norm, candidate);
      if (score >= threshold && (!best || score > best.score)) {
        best = { identityKey, canonicalName: rec.canonicalName, matchedAlias: candidate, score };
      }
    }
  }
  return best;
}

// ── Mutate ───────────────────────────────────────────────────────────────────

// Add a label as an alias of identityKey (creating the record if new). Dedups
// on normalized form; bumps nothing if already present. canonicalName sets/keeps
// the display name.
export async function addAlias(
  identityKey: string,
  canonicalName: string,
  label: string,
): Promise<void> {
  await mutateYamlFile<AliasTable>(aliasTablePath(), () => ({}), (table) => {
    const rec = (table[identityKey] ??= { canonicalName, aliases: [], aliasMeta: {} });
    rec.canonicalName = canonicalName || rec.canonicalName;
    const norm = normalizeLabel(label);
    const known = recordLabels(rec);
    if (!known.has(norm)) {
      rec.aliases.push(label.trim());
      (rec.aliasMeta ??= {})[norm] = { addedAt: new Date().toISOString(), uses: 0 };
    }
  });
}

// Increment usage count for a label under identityKey (best-effort accounting).
export async function bumpAliasUsage(identityKey: string, label: string): Promise<void> {
  const norm = normalizeLabel(label);
  await mutateYamlFile<AliasTable>(aliasTablePath(), () => ({}), (table) => {
    const rec = table[identityKey];
    if (!rec) return;
    (rec.aliasMeta ??= {})[norm] = {
      addedAt: rec.aliasMeta?.[norm]?.addedAt ?? new Date().toISOString(),
      uses: (rec.aliasMeta?.[norm]?.uses ?? 0) + 1,
    };
  });
}

// Remove a label from a record (manual maintenance only). The canonical name is
// never removed this way.
export async function removeAlias(identityKey: string, label: string): Promise<void> {
  const norm = normalizeLabel(label);
  await mutateYamlFile<AliasTable>(aliasTablePath(), () => ({}), (table) => {
    const rec = table[identityKey];
    if (!rec) return;
    if (normalizeLabel(rec.canonicalName) === norm) return; // never drop canonical
    rec.aliases = (rec.aliases ?? []).filter((a) => normalizeLabel(a) !== norm);
    if (rec.aliasMeta) delete rec.aliasMeta[norm];
  });
}

// Cascade for a deleted character: drop its alias record entirely. The caller is
// responsible for orphaning that character's beats back to the holding pool.
export async function removeAliasRecord(identityKey: string): Promise<AliasRecord | null> {
  let removed: AliasRecord | null = null;
  await mutateYamlFile<AliasTable>(aliasTablePath(), () => ({}), (table) => {
    removed = table[identityKey] ?? null;
    delete table[identityKey];
  });
  return removed;
}
