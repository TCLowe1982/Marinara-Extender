// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Memory block -> Marinara lorebook, server-side.
//
// This is the extension's ensureLorebook / writeMemoryToLorebook cycle ported
// out of the browser (extensions were removed in Engine v2.3.4). The mechanism
// is deliberately unchanged — it is the part of the old integration that
// actually worked — but two things are tightened, both marked FIX below.
//
// The injection contract, unchanged: the engine injects a lorebook's constant
// entries into every generation for that character. We own one lorebook per
// character entirely, so each write nukes it and recreates exactly two entries.
// Absolute correctness every cycle beats caching and dedup logic here; the
// entries are small and the write is off the hot path.

import {
  listLorebooks,
  createLorebook,
  patchLorebook,
  listLorebookEntries,
  createLorebookEntry,
  patchLorebookEntry,
  deleteLorebookEntry,
  parseData,
} from "./engine-client.js";

/**
 * The engine enforces a per-lorebook injection budget — default **2048** — and
 * SILENTLY DROPS entries that exceed it. A memory block that grew past ~2300
 * tokens simply stopped being injected while every upstream signal stayed
 * green. That is bug e87, and it is the single most expensive failure mode in
 * this integration, so the budget is guaranteed rather than assumed: set on
 * create, and healed on every lookup of a pre-existing lorebook.
 */
export const ME_LOREBOOK_TOKEN_BUDGET = 16384;

const LOREBOOK_PREFIX = "Marinara Extender";

/** Field set every entry shares. `constant: true` is what makes it always-injected. */
const ENTRY_BASE = {
  keys: [] as string[],
  constant: true,
  locked: false,
  role: "system",
  noVector: true,
  sticky: 0,
  cooldown: 0,
  delay: 0,
  ephemeral: 0,
};

export interface SplitBlock {
  instructions: string;
  content: string;
}

/**
 * Split the memory block into the static how-to-use-memory preamble and the
 * live memory. The marker is a literal "\n\n<memory>"; everything before it is
 * instructions, everything from `<memory>` on is content.
 */
export function splitMemoryBlock(memoryBlock: string): SplitBlock {
  const idx = memoryBlock.indexOf("\n\n<memory>");
  if (idx === -1) return { instructions: memoryBlock.trim(), content: "" };
  return {
    instructions: memoryBlock.slice(0, idx).trim(),
    // +2 skips the two newlines so content begins at "<memory>".
    content: memoryBlock.slice(idx + 2).trim(),
  };
}

export function lorebookNameFor(characterId: string, characterName?: string | null): string {
  return `${LOREBOOK_PREFIX} — ${characterName || characterId}`;
}

function idOf(obj: Record<string, unknown> | undefined): string | null {
  if (!obj) return null;
  const d = parseData(obj);
  for (const key of ["id", "uid", "_id"]) {
    const v = obj[key] ?? d[key];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

// FIX (axu — duplicate Extender lorebooks): the extension serialized only the
// entry WRITE, not the lorebook lookup-or-create. Two concurrent refreshes
// could therefore both look up, both find nothing, and both create a lorebook
// for the same character. Serializing per character across the whole
// ensure+write cycle removes that race at the source. Keyed per character so
// unrelated characters still proceed in parallel.
const _chains = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = _chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Swallow rejections on the CHAIN only — the caller still sees the real
  // error from `next`. Without this an failed write would poison every
  // subsequent write for that character.
  _chains.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

/** Test seam: drop the per-character serialization chains. */
export function _resetChains(): void {
  _chains.clear();
}

/**
 * Find (or create) this character's Extender lorebook and return its id.
 *
 * No caching — always a fresh lookup, so a lorebook the user deleted by hand is
 * recreated rather than written to by a stale id (that is bug s19).
 */
export async function ensureLorebook(
  characterId: string,
  characterName?: string | null,
): Promise<string | null> {
  try {
    const existing = await listLorebooks();
    for (const lb of existing) {
      const d = parseData(lb);
      const name = String(lb.name ?? d.name ?? "");
      const charId = String(lb.characterId ?? d.characterId ?? "");
      if (!name.startsWith(LOREBOOK_PREFIX) || charId !== String(characterId)) continue;

      const lorebookId = idOf(lb);
      if (!lorebookId) continue;

      const budget = Number(lb.tokenBudget ?? d.tokenBudget ?? 0);
      if (budget < ME_LOREBOOK_TOKEN_BUDGET) {
        await patchLorebook(lorebookId, { tokenBudget: ME_LOREBOOK_TOKEN_BUDGET }).catch(() => {});
        console.info(
          `[ME:lorebook] ${lorebookId} tokenBudget raised ${budget} -> ${ME_LOREBOOK_TOKEN_BUDGET} (the engine silently drops entries above the budget)`,
        );
      }
      return lorebookId;
    }
  } catch (e) {
    console.warn(`[ME:lorebook] lookup failed, will try to create — ${String(e)}`);
  }

  try {
    const created = await createLorebook({
      name: lorebookNameFor(characterId, characterName),
      characterId: String(characterId),
      enabled: true,
      tokenBudget: ME_LOREBOOK_TOKEN_BUDGET,
    });
    const lorebookId = idOf((created ?? undefined) as Record<string, unknown> | undefined);
    if (!lorebookId) {
      console.error("[ME:lorebook] create returned no usable id");
      return null;
    }
    console.info(`[ME:lorebook] created for ${characterName || characterId} — id=${lorebookId}`);
    return lorebookId;
  } catch (e) {
    console.error(`[ME:lorebook] create failed — ${String(e)}`);
    return null;
  }
}

/**
 * Replace the lorebook's contents with exactly two entries.
 *
 * Callers should prefer `syncMemoryToLorebook`, which serializes this per
 * character. Calling it directly concurrently for one lorebook re-opens the
 * race where each pass sees a half-emptied lorebook.
 */
export async function writeMemoryToLorebook(lorebookId: string, memoryBlock: string): Promise<void> {
  const { instructions, content } = splitMemoryBlock(memoryBlock);

  // Step 1 — clear. This lorebook belongs entirely to us.
  try {
    const entries = await listLorebookEntries(lorebookId);
    for (const entry of entries) {
      const entryId = idOf(entry);
      if (!entryId) continue;
      // Unlock first: a locked entry REFUSES deletion and silently survives,
      // which is how stale memory used to linger across writes.
      await patchLorebookEntry(lorebookId, entryId, { locked: false }).catch(() => {});
      await deleteLorebookEntry(lorebookId, entryId).catch((e) =>
        console.warn(`[ME:lorebook] entry ${entryId} delete failed — ${String(e)}`),
      );
    }
  } catch (e) {
    console.error(`[ME:lorebook] entry sweep failed — ${String(e)}`);
  }

  // Step 2 — recreate. Instructions first (order 0) so the model reads how to
  // use memory before the memory itself.
  await Promise.all([
    createLorebookEntry(lorebookId, {
      ...ENTRY_BASE,
      name: "Memory System — Instructions",
      content: instructions,
      order: 0,
      enabled: true,
    }).catch((e) => console.error(`[ME:lorebook] instructions create failed — ${String(e)}`)),
    createLorebookEntry(lorebookId, {
      ...ENTRY_BASE,
      name: "Memory System — Active Context",
      content,
      // An empty block would otherwise inject a useless empty system entry.
      enabled: content !== "",
      order: 1,
    }).catch((e) => console.error(`[ME:lorebook] content create failed — ${String(e)}`)),
  ]);
}

/**
 * Ensure the character's lorebook exists and write the memory block into it,
 * serialized per character. This is the entry point the poller should call.
 *
 * Returns the lorebook id on success, or null if the lorebook could not be
 * resolved (in which case nothing was written).
 */
export function syncMemoryToLorebook(args: {
  characterId: string;
  characterName?: string | null;
  memoryBlock: string;
}): Promise<string | null> {
  const { characterId, characterName, memoryBlock } = args;
  return serialize(String(characterId), async () => {
    const lorebookId = await ensureLorebook(characterId, characterName);
    if (!lorebookId) return null;
    await writeMemoryToLorebook(lorebookId, memoryBlock);
    return lorebookId;
  });
}
