// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// IDENTITY FORK (yi70) — two cards that were the same person until a date.
//
// TC's case: "Professor Mari" was the original card and was READ-ONLY; it
// reverted version changes, so "Dr. Mari Zielinska" was built from it. Both map
// to identityKey professor_mari, which is correct for a card REPLACEMENT and
// wrong here, because the old card is still played. Ten chats still use it — a
// card the Engine no longer has — and one of them ran a month past the split,
// loading the current character's whole memory.
//
// TC's ruling: "They should read more as sisters who shared the same household,
// ie, the pre-split memories, rather than be shared."
//
// ── WHY A UNION AND NOT A CUTOFF ─────────────────────────────────────────────
// Measured before this was designed: of 7,052 beats, 6,983 (99.0%) postdate the
// split and 69 predate it. A plain "ignore everything after splitAt" leaves the
// retired card with ONE PERCENT of its memory — that is amnesia, not separation.
// So a card sees: the shared past, PLUS its own continued life.
//
//     admit  if  created <= splitAt                     (shared childhood)
//       or  if  the entry came from one of MY chats     (my own life since)
//
// ── THE 42.9% ────────────────────────────────────────────────────────────────
// Nearly half the entries carry no sourceChatId (the legacy unprovenanced
// population), so their branch cannot be derived. They go to the PRIMARY branch:
// the retired fork gets nothing it cannot prove, and the live character loses
// nothing. Absent provenance means "unknown", never "shared" — the same rule
// bodyTerms and subjects already follow.

import { listChats } from "./engine-client.js";
import { forkConfigFor, anyForkConfigured } from "./identity.js";
import type { IndexEntry } from "./storage.js";

// Which CARD owns a chat. Chats change owner never, so this is cached like the
// character/persona name caches, with a miss-triggered refresh for new chats.
let chatOwner: Map<string, string> | null = null;

export function _resetChatOwnerCache(): void {
  chatOwner = null;
}

async function loadChatOwners(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const c of await listChats()) {
    const id = String(c.id ?? "");
    const ids = Array.isArray(c.characterIds) ? c.characterIds : [];
    // A group chat has several; the fork question only ever needs "is this MINE",
    // so every participant is recorded and membership is tested by lookup.
    if (id) map.set(id, ids.map(String).join(","));
  }
  return map;
}

/** Card ids owning this chat, or [] when the chat is unknown. */
export async function ownersOfChat(chatId: string | undefined | null): Promise<string[]> {
  if (!chatId) return [];
  if (!chatOwner) chatOwner = await loadChatOwners().catch(() => new Map());
  let hit = chatOwner.get(chatId);
  if (hit === undefined) {
    chatOwner = await loadChatOwners().catch(() => chatOwner ?? new Map());
    hit = chatOwner.get(chatId);
  }
  return hit ? hit.split(",").filter(Boolean) : [];
}

export interface ForkFilter {
  splitAt: string;
  primary: boolean;
  /** Card ids whose chats count as "mine" - ALL of this sister's cards. */
  mine: string[];
  /** Chats both sisters keep, named explicitly. Empty when none are declared. */
  sharedChats?: string[];
}

/**
 * Build the filter for the card that owns `chatId`, or null when that card is
 * not forked — in which case NOTHING changes and the loader behaves as before.
 */
export async function forkFilterForChat(chatId: string | undefined | null): Promise<ForkFilter | null> {
  if (!chatId) return null;

  // CHEAP LOCAL CHECK FIRST, AND IT IS NOT AN OPTIMISATION.
  //
  // ownersOfChat asks the ENGINE for the chat list. Calling that before knowing
  // whether any fork exists put a network round-trip on the loader's hot path
  // for every character — which hung the test suite (no Engine to answer) and
  // would have blocked the first load of every process in production, or worse
  // stalled it whenever the Engine was slow. A .catch() handles a rejection; it
  // does not handle a HANG.
  //
  // The identity map is a local file that is already cached, so "is anything
  // forked at all" costs nothing. Almost always the answer is no, and this
  // returns before any I/O.
  if (!(await anyForkConfigured())) return null;

  const owners = await ownersOfChat(chatId);
  for (const cardId of owners) {
    const cfg = await forkConfigFor(cardId);
    if (cfg) return { splitAt: cfg.splitAt, primary: cfg.primary, mine: cfg.branchCardIds, sharedChats: cfg.sharedChats };
  }
  return null;
}

/**
 * Does this row belong to the branch being loaded?
 *
 * `created` is the date the memory was recorded. Rows with neither a date nor a
 * source chat are treated as post-split and unattributable, so they follow the
 * primary rule above.
 */
export async function rowInBranch(row: Pick<IndexEntry, "sourceChatId" | "citesChatId" | "lastAccessed"> & { created?: string }, f: ForkFilter): Promise<boolean> {
  const chat = row.sourceChatId ?? row.citesChatId;

  // THE SHARED CHILDHOOD, NAMED BY CHAT. Checked first because it is the only
  // rule here that rests on something recorded rather than inferred.
  if (chat && f.sharedChats?.includes(chat)) return true;

  // The date rule stays as a second gate for stores that have honest creation
  // dates. NOTE THE ABSENT FALLBACK: this used to read
  // `row.created ?? row.lastAccessed`, and since IndexEntry carried no `created`
  // at all it silently became "has not been READ since the split" — admitting 17
  // of 175 genuinely pre-split rows, and dropping precisely the memories that
  // were used most (dqs1). A missing creation date means UNKNOWN, so fall
  // through to ownership; it never means "use the retrieval timestamp".
  const created = String(row.created ?? "");
  if (created && created <= f.splitAt) return true;

  if (!chat) return f.primary;              // unattributable -> primary branch

  const owners = await ownersOfChat(chat);
  if (!owners.length) return f.primary;     // chat gone from the Engine -> primary
  return owners.some((o) => f.mine.includes(o));
}

/** Filter a scope's index rows to the branch that owns `chatId`. */
export async function applyForkFilter<T extends Pick<IndexEntry, "sourceChatId" | "citesChatId" | "lastAccessed"> & { created?: string }>(
  rows: T[],
  f: ForkFilter | null,
): Promise<T[]> {
  if (!f) return rows;
  const keep: T[] = [];
  for (const r of rows) if (await rowInBranch(r, f)) keep.push(r);
  return keep;
}
