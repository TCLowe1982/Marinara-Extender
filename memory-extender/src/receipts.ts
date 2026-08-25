// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Retrieval receipts — the answer to "why didn't it remember X?"
//
// The three-cause triage (capture gap / retrieval invisibility / digest
// corruption) has always been run by hand: grep the store, guess which cause
// applies, grep again. The middle cause is the expensive one, because a memory
// that IS stored and DIDN'T surface leaves no trace anywhere — selection
// happens in memory and the losers are discarded silently.
//
// A receipt is that missing trace. Every turn records what was considered, what
// was chosen, and — the part that matters — what was REJECTED and why. A blank
// recall stops being ambiguous: either the entry is absent from the candidate
// list (capture gap) or it is present with a rejection reason (retrieval).
//
// Deliberately NOT a log. It is a small, overwritten, per-chat artefact holding
// the last turn only. Logs rot and nobody greps them; one current file per chat
// is cheap to write, cheap to read, and always describes the turn you just saw.
//
// NOTE ON SCOPE: this records the DECISION, not the ranking algorithm. Lane
// fusion and multi-signal ranking wait until the content-scoring fix lands
// (MarinaraExtender-tp5) — explaining a scorer we already know is wrong would
// only produce confident explanations of wrong answers.

import { createHash } from "crypto";
import { readdir } from "fs/promises";
import { join } from "path";
import { stringify } from "yaml";
import { atomicWriteFile_UNLOCKED_takeSerializedWriteYourself, getDataDir, assertSafeId, readYamlFile, type Scope } from "./storage.js";

// ── Reason vocabularies ──────────────────────────────────────────────────────
// Both are closed sets on purpose. A free-text reason is a reason nobody can
// count, and the first question asked of a receipt is always "how often".

/** Why a candidate was NOT surfaced this turn. */
export type RejectionReason =
  /** status === "done" — the thread it belonged to is resolved. */
  | "resolved"
  /** supersededBy set — a replacement fact exists (FR2). */
  | "superseded"
  /** provenance === "unplayed" — outline canon, never recallable. */
  | "unplayed"
  /** Ranked, but the scope's token budget was already full when its turn came. */
  | "budget_exhausted";

/** Why a candidate WAS surfaced this turn. Multiple may apply. */
export type SelectionReason =
  /** Its own summary shares terms with the recent conversation. */
  | "own_match"
  /** The conversation matched its narrative thread's LABEL, not its own text. */
  | "thread_label"
  /** A sibling in the same thread matched strongly and pulled it along. */
  | "thread_sibling"
  /** Scored zero; rode in on rank order because budget remained. */
  | "recency_rider"
  /** Pulled from the cold archive on a relevance miss. */
  | "cold_recall"
  /** Eidetic mode — budget bypassed, everything injected. */
  | "eidetic";

// A rejected list is unbounded in principle (a big store rejects thousands), so
// it is capped. Truncation is RECORDED rather than silent: a receipt that
// quietly dropped the entry you were looking for is worse than no receipt.
export const MAX_RECORDED_REJECTIONS = 60;

// ── Records ──────────────────────────────────────────────────────────────────

export interface CandidateTrace {
  id: string;
  scope: Scope;
  /** Truncated — a receipt is for identifying an entry, not for reading it. */
  summary: string;
  tokens: number;
  /** Final relevance after thread lifts, 0..1. */
  relevance: number;
  reasons: SelectionReason[];
}

export interface RejectedCandidate {
  id: string;
  scope: Scope;
  summary: string;
  tokens: number;
  relevance: number;
  rejection: RejectionReason;
}

/** Per-scope budget accounting, so "it didn't fit" is checkable, not asserted. */
export interface ScopeAccounting {
  scope: Scope;
  budget: number;
  used: number;
  candidates: number;
  selected: number;
  rejected: number;
}

/**
 * Whether the block we assembled actually reached the prompt.
 *
 * We assemble a block and hand it to the injection path; nothing today confirms
 * the two still agree. A stale lorebook entry, a failed write, or a truncating
 * consumer all present identically as "the character didn't remember" — and all
 * three would be misfiled as retrieval bugs. The hash makes the question
 * answerable: re-read what the prompt will actually carry and compare.
 */
export type InjectionStatus = "pending" | "confirmed" | "mismatch";

export interface InjectionRecord {
  status: InjectionStatus;
  /** SHA-256 of the assembled block. */
  hash: string;
  tokens: number;
  checkedAt?: string;
  /** Hash actually found downstream when status is "mismatch". */
  foundHash?: string;
}

export interface RetrievalReceipt {
  version: 1;
  chatId: string;
  characterId: string;
  turnNumber: number;
  createdAt: string;
  /** Recent-conversation text length; 0 means retrieval ran with no signal. */
  querySize: number;
  scopes: ScopeAccounting[];
  selected: CandidateTrace[];
  rejected: RejectedCandidate[];
  rejectedTruncated: boolean;
  injection: InjectionRecord;
}

// ── Hashing ──────────────────────────────────────────────────────────────────

export function hashBlock(block: string): string {
  return createHash("sha256").update(block, "utf8").digest("hex");
}

// ── Storage ──────────────────────────────────────────────────────────────────
// One file per chat, overwritten each turn. Written through atomicWriteFile_UNLOCKED_takeSerializedWriteYourself so
// a torn receipt can never be read back as truth — the same discipline the
// entry store uses, for the same reason.

export function receiptsDir(): string {
  return join(getDataDir(), "receipts");
}

export function receiptPath(chatId: string): string {
  assertSafeId(chatId);
  return join(receiptsDir(), `${chatId}.yaml`);
}

export async function writeReceipt(receipt: RetrievalReceipt): Promise<void> {
  await atomicWriteFile_UNLOCKED_takeSerializedWriteYourself(receiptPath(receipt.chatId), stringify(receipt));
}

export async function readReceipt(chatId: string): Promise<RetrievalReceipt | null> {
  return readYamlFile<RetrievalReceipt>(receiptPath(chatId));
}

/**
 * Chat ids that have a receipt, newest turn first.
 *
 * Reads each file rather than trusting mtime: a receipt carries its own
 * createdAt, and ordering by the recorded turn is what a reader actually wants.
 * Unreadable or half-written files are skipped — a corrupt diagnostic must not
 * take down the diagnostics view.
 */
export async function listReceipts(): Promise<Array<{ chatId: string; createdAt: string; status: InjectionStatus }>> {
  let files: string[];
  try {
    files = (await readdir(receiptsDir())).filter((name) => name.endsWith(".yaml"));
  } catch {
    return [];
  }
  const rows: Array<{ chatId: string; createdAt: string; status: InjectionStatus }> = [];
  for (const file of files) {
    const receipt = await readYamlFile<RetrievalReceipt>(join(receiptsDir(), file)).catch(() => null);
    if (!receipt?.chatId) continue;
    rows.push({ chatId: receipt.chatId, createdAt: receipt.createdAt, status: receipt.injection?.status ?? "pending" });
  }
  return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * Cap the rejected list without hiding the fact. Lowest-relevance candidates are
 * dropped first: a rejection at relevance 0 is the least surprising kind, while
 * a high-scoring entry that still lost is exactly the case someone is hunting.
 */
export function capRejections(
  rejected: RejectedCandidate[],
  limit = MAX_RECORDED_REJECTIONS,
): { rejected: RejectedCandidate[]; truncated: boolean } {
  if (rejected.length <= limit) return { rejected, truncated: false };
  const kept = [...rejected].sort((a, b) => b.relevance - a.relevance).slice(0, limit);
  return { rejected: kept, truncated: true };
}

/**
 * Record whether the assembled block survived to the prompt.
 *
 * Fail-loud by construction: a mismatch is persisted as a mismatch rather than
 * overwritten by the next turn's optimism, so the condition is visible after the
 * fact instead of only in the moment it happened.
 */
export async function confirmInjection(
  chatId: string,
  actualBlock: string | null,
): Promise<InjectionStatus> {
  const receipt = await readReceipt(chatId);
  if (!receipt) return "pending";
  const foundHash = actualBlock === null ? "" : hashBlock(actualBlock);
  const status: InjectionStatus = foundHash === receipt.injection.hash ? "confirmed" : "mismatch";
  receipt.injection.status = status;
  receipt.injection.checkedAt = new Date().toISOString();
  if (status === "mismatch") receipt.injection.foundHash = foundHash;
  await writeReceipt(receipt);
  return status;
}
