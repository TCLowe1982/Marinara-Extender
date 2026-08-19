// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Replay a window of engine history through the live ingestion path (c1w-class
// recovery utility, born from the 08-04→08-10 poller outage).
//
// WHY THIS EXISTS. The poller cannot recover its own outages, by design twice
// over: a chat first seen after the gap gets a baseline and ingests NOTHING
// (the fresh-install guard), and a known chat's catch-up reads a 10-message
// tail then advances the watermark to now — sealing everything older behind
// it. Six days of real play (274 assistant turns, including the actual Green
// Boat Christening scene the bait cleanup went looking for and rightly could
// not find) sat on the engine, permanently invisible to the poller.
//
// THE SHAPE: same turns, same path. Turns are assembled by the poller's own
// buildTurns and ingested by the bridge's own handleDetectedTurn — no second
// implementation of "which user line prompted this reply" or of ingestion.
// Idempotency is structural, not checked here: beat ids are provenance
// (messageId + swipeIndex, 2pbi/r0kc), so replaying a turn the live path
// already captured lands on the same beat and resumes; entries dedupe in
// createEntryIfUnique. Overlapping the window with captured time is SAFE and
// the default posture — generous windows beat exact ones.
//
// IN-PROCESS ONLY, and this is load-bearing (1akw): the per-character write
// chains and chat locks are per-process, so a backfill running as a separate
// script beside the live sidecar would be a second uncoordinated writer to
// the same store and lorebooks. This runs inside the sidecar via
// POST /api/backfill, sharing every lock the live path holds.
//
// WATERMARKS ARE NEVER TOUCHED. The window is behind them; moving them is the
// live detectors' job alone.
//
// LOREBOOKS SYNC ONCE PER CHARACTER, not once per turn: each sync nukes and
// recreates the lorebook wholesale, so only each character's LAST turn in the
// window syncs — the final state is identical, minus hundreds of rewrites.

import { listChats, listMessages } from "./engine-client.js";
import { buildTurns, isAssistantTurn, type DetectedTurn } from "./poller.js";
import { handleDetectedTurn } from "./turn-bridge.js";

export interface BackfillOptions {
  /** ISO lower bound (inclusive) on message createdAt. */
  from: string;
  /** ISO upper bound (exclusive). Default: now. */
  to?: string;
  /** Restrict to one chat. */
  chatId?: string;
  /** Count and report only — ingest nothing. */
  dryRun?: boolean;
}

export interface BackfillChatReport {
  chatId: string;
  chatName: string;
  messagesInWindow: number;
  assistantTurns: number;
  ingested: number;
  skipped: number;
  failed: number;
}

export interface BackfillReport {
  from: string;
  to: string;
  dryRun: boolean;
  chats: BackfillChatReport[];
  totals: { assistantTurns: number; ingested: number; skipped: number; failed: number };
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface BackfillProgress {
  running: boolean;
  report: BackfillReport | null;
  /** Turn currently being analyzed, of totalTurns — the local model makes this minutes-long. */
  turnsDone: number;
  totalTurns: number;
}

// One job at a time. A second concurrent backfill would interleave two
// chronological replays of possibly-overlapping windows for no benefit.
let current: BackfillProgress = { running: false, report: null, turnsDone: 0, totalTurns: 0 };

export function backfillProgress(): BackfillProgress {
  return current;
}

/** The window filter, exported for tests: [from, to) on createdAt. */
export function inWindow(message: Record<string, unknown>, from: string, to: string): boolean {
  const at = String(message.createdAt ?? "");
  return !!at && at >= from && at < to;
}

/**
 * Index of each characterId's final assistant turn — the one whose lorebook
 * sync carries the whole backfill's final state for that character.
 */
export function lastTurnPerCharacter(turns: DetectedTurn[]): Set<number> {
  const last = new Map<string, number>();
  turns.forEach((t, i) => { if (t.characterId) last.set(t.characterId, i); });
  return new Set(last.values());
}

export async function runBackfill(opts: BackfillOptions): Promise<BackfillReport> {
  if (current.running) throw new Error("a backfill is already running — poll GET /api/backfill first");
  const from = opts.from;
  const to = opts.to ?? new Date().toISOString();
  const report: BackfillReport = {
    from, to, dryRun: !!opts.dryRun, chats: [],
    totals: { assistantTurns: 0, ingested: 0, skipped: 0, failed: 0 },
    startedAt: new Date().toISOString(),
  };
  current = { running: true, report, turnsDone: 0, totalTurns: 0 };

  try {
    const chats = (await listChats()).filter((c) => {
      const id = String(c.id ?? "");
      if (!id) return false;
      if (opts.chatId && id !== opts.chatId) return false;
      // A chat untouched since before the window has nothing in it.
      const last = String(c.lastMessageAt ?? c.updatedAt ?? "");
      return !last || last >= from;
    });

    // Assemble every turn first so progress has a real denominator and the
    // per-character final-sync set covers the WHOLE window, not one chat.
    const perChat: { chat: Record<string, unknown>; chatId: string; turns: DetectedTurn[]; messagesInWindow: number }[] = [];
    for (const chat of chats) {
      const chatId = String(chat.id);
      const all = await listMessages(chatId); // full history — bounded by the window filter below
      const windowed = all.filter((m) => inWindow(m, from, to));
      if (windowed.length === 0) continue;
      const candidates = windowed.filter((m) => isAssistantTurn(m));
      // buildTurns locates each reply's preceding user line within the tail it
      // is given — hand it the FULL history so a reply at the window's edge
      // still finds its user half even when that half is outside the window.
      const turns = buildTurns(chat, chatId, all, candidates, false);
      perChat.push({ chat, chatId, turns, messagesInWindow: windowed.length });
    }

    const flat = perChat.flatMap((c) => c.turns);
    current.totalTurns = flat.length;
    const finalSync = lastTurnPerCharacter(flat);

    let i = 0;
    for (const { chat, chatId, turns, messagesInWindow } of perChat) {
      const row: BackfillChatReport = {
        chatId, chatName: String(chat.name ?? chatId),
        messagesInWindow, assistantTurns: turns.length,
        ingested: 0, skipped: 0, failed: 0,
      };
      report.chats.push(row);
      report.totals.assistantTurns += turns.length;

      for (const turn of turns) {
        const flatIndex = i++;
        if (opts.dryRun) { current.turnsDone = i; continue; }
        try {
          const r = await handleDetectedTurn(turn, {
            source: "backfill",
            skipLorebookSync: !finalSync.has(flatIndex),
          });
          if (r.ingested) row.ingested++; else row.skipped++;
        } catch {
          row.failed++; // handleDetectedTurn shouldn't throw; belt and braces
        }
        current.turnsDone = i;
      }
      report.totals.ingested += row.ingested;
      report.totals.skipped += row.skipped;
      report.totals.failed += row.failed;
      console.info(`[ME:backfill] ${row.chatName}: ${row.ingested}/${row.assistantTurns} ingested (${row.skipped} skipped, ${row.failed} failed)`);
    }
  } catch (e) {
    report.error = String(e);
    throw e;
  } finally {
    report.finishedAt = new Date().toISOString();
    current = { ...current, running: false };
  }
  return report;
}
