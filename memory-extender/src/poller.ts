// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Turn detection — the replacement for the extension's per-turn hook.
//
// The extension knew a turn had finished because it lived in the browser and
// saw the response. Extensions were removed in Engine v2.3.4, so the sidecar
// has to notice from the outside.
//
// HOW: poll GET /api/chats once per tick. Every chat carries `lastMessageAt`,
// so one cheap call tells us which chats advanced; only those get a message
// fetch. With 91 chats a quiet tick is a single request.
//
// WHY NOT fs.watch on the engine's data dir (the original plan): it would be
// lower latency, but it binds us to the engine's internal on-disk layout, and
// its atomic write-and-rename pattern makes the events noisy. `lastMessageAt`
// is a stable public field that answers the question directly. fs.watch remains
// available later as a pure *trigger* that still reads through this same path
// — a latency optimisation, not a different design.
//
// Verified against a live engine (2026-07-23):
//   - GET /chats/:id/messages?limit=N returns the NEWEST N, ascending.
//     Unbounded it returns the entire history (195 messages on a real chat), so
//     the limit is not optional.
//   - messages carry their own `characterId` — in group scenes each message
//     names its own speaker, so we never have to guess from the chat.
//   - regeneration is a SWIPE: `activeSwipeIndex` / `swipeCount` change on the
//     SAME message id. That is the supersede signal, not a new message.

import { join } from "path";
import { getDataDir } from "./storage.js";
import { mutateYamlFile, readYamlFile } from "./storage.js";
import { listChats, listMessages, parseData } from "./engine-client.js";

export interface ChatWatermark {
  /** ISO timestamp of the newest message we have already handled. */
  lastMessageAt: string;
  /** Id of that message — lets us spot a regeneration of the same turn. */
  lastMessageId?: string;
  /** Swipe index of that message; a change means it was re-rolled. */
  lastSwipeIndex?: number;
}

export interface PollerState {
  chats: Record<string, ChatWatermark>;
}

export interface DetectedTurn {
  chatId: string;
  chatName: string;
  characterId: string | null;
  message: Record<string, unknown>;
  /** True when this is a re-roll of a turn we already saw (supersede, don't duplicate). */
  regenerated: boolean;
  /**
   * The user message immediately preceding this reply, if there is one.
   * Ingestion analyses both halves of a turn, so the assistant text alone is
   * only half the input.
   */
  precedingUserText: string;
  /** All participants of the chat — group scenes have several. */
  participantIds: string[];
}

/** Text of the last user message before `index` in an ascending tail. */
export function precedingUserTextFor(
  messages: Record<string, unknown>[],
  index: number,
): string {
  for (let i = index - 1; i >= 0; i--) {
    if (str(messages[i], "role") === "user") return str(messages[i], "content") ?? "";
  }
  return "";
}

/** Participant ids of a chat, tolerating the array / scalar / stringified forms. */
export function getChatParticipantIds(chat: Record<string, unknown>): string[] {
  const d = parseData(chat);
  let arr: unknown = chat.characterIds ?? d.characterIds;
  if (typeof arr === "string") {
    try {
      arr = JSON.parse(arr);
    } catch {
      arr = null;
    }
  }
  if (Array.isArray(arr)) return arr.filter(Boolean).map(String);
  const single = str(chat, "characterId", "character_id");
  return single ? [single] : [];
}

export function pollerStatePath(): string {
  return join(getDataDir(), "poller-state.yaml");
}

const emptyState = (): PollerState => ({ chats: {} });

export function loadPollerState(): Promise<PollerState | null> {
  return readYamlFile<PollerState>(pollerStatePath());
}

/** Persist a watermark. Serialized + atomic via storage.ts — never a raw write. */
export function recordWatermark(chatId: string, mark: ChatWatermark): Promise<PollerState> {
  return mutateYamlFile<PollerState>(pollerStatePath(), emptyState, (state) => {
    state.chats ??= {};
    state.chats[chatId] = mark;
  });
}

// ── Pure helpers (no I/O — the interesting logic lives here) ──────────────────

function str(obj: Record<string, unknown> | undefined, ...names: string[]): string | null {
  if (!obj) return null;
  const d = parseData(obj);
  for (const n of names) {
    const v = obj[n] ?? d[n];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

/**
 * A chat's character. Conversation-mode chats use a `characterIds` ARRAY rather
 * than a scalar `characterId` (the extension hit this too); prefer the message's
 * own characterId when you have one.
 */
export function getChatCharacterId(chat: Record<string, unknown>): string | null {
  const d = parseData(chat);
  const direct = str(chat, "characterId", "character_id");
  if (direct) return direct;
  const arr = (chat.characterIds ?? d.characterIds) as unknown;
  if (Array.isArray(arr) && arr.length > 0 && arr[0]) return String(arr[0]);
  if (typeof arr === "string") {
    try {
      const parsed = JSON.parse(arr);
      if (Array.isArray(parsed) && parsed[0]) return String(parsed[0]);
    } catch {
      /* not JSON */
    }
  }
  return null;
}

export interface ChatChange {
  chat: Record<string, unknown>;
  chatId: string;
  lastMessageAt: string;
  /** No watermark yet: record a baseline and ingest NOTHING. */
  isNew: boolean;
}

/**
 * Which chats advanced since we last looked.
 *
 * A chat we have never seen is reported with `isNew: true`. That case must
 * record a baseline WITHOUT ingesting: on a fresh install this runs against
 * every existing chat at once, and ingesting them would replay years of history
 * as if it had just happened.
 */
export function selectChangedChats(
  chats: Record<string, unknown>[],
  state: PollerState | null,
): ChatChange[] {
  const known = state?.chats ?? {};
  const out: ChatChange[] = [];

  for (const chat of chats) {
    const chatId = str(chat, "id");
    if (!chatId) continue;
    const lastMessageAt = str(chat, "lastMessageAt", "updatedAt");
    if (!lastMessageAt) continue; // a chat with no messages yet

    const mark = known[chatId];
    if (!mark) {
      out.push({ chat, chatId, lastMessageAt, isNew: true });
      continue;
    }
    if (lastMessageAt > mark.lastMessageAt) {
      out.push({ chat, chatId, lastMessageAt, isNew: false });
    }
  }
  return out;
}

/**
 * Split a freshly-fetched message tail into the turns we have not handled.
 *
 * Two distinct cases:
 *  - genuinely newer messages (`createdAt` beyond the watermark)
 *  - a REGENERATION: same message id as the watermark, but a different swipe
 *    index. The engine re-rolls in place rather than appending, so without this
 *    a re-rolled reply would be silently ignored — the memory would keep the
 *    text the user just threw away.
 */
export function extractNewTurns(
  messages: Record<string, unknown>[],
  mark: ChatWatermark | undefined,
): { fresh: Record<string, unknown>[]; regenerated: Record<string, unknown> | null } {
  if (!mark) return { fresh: [], regenerated: null };

  const fresh = messages.filter((m) => {
    const at = str(m, "createdAt");
    return !!at && at > mark.lastMessageAt;
  });

  let regenerated: Record<string, unknown> | null = null;
  if (fresh.length === 0 && mark.lastMessageId) {
    const same = messages.find((m) => str(m, "id") === mark.lastMessageId);
    // BOTH sides must actually carry a swipe index. Defaulting a missing field
    // to -1 made every unchanged message look re-rolled (-1 !== 0), which would
    // re-ingest the same turn on every tick and duplicate memory forever. If we
    // cannot compare, we do not claim a regeneration.
    if (same && same.activeSwipeIndex !== undefined && mark.lastSwipeIndex !== undefined) {
      if (Number(same.activeSwipeIndex) !== mark.lastSwipeIndex) regenerated = same;
    }
  }
  return { fresh, regenerated };
}

/** Watermark describing the newest message in a tail. */
export function watermarkFrom(messages: Record<string, unknown>[]): ChatWatermark | null {
  if (messages.length === 0) return null;
  const last = messages[messages.length - 1];
  const at = str(last, "createdAt");
  if (!at) return null;
  return {
    lastMessageAt: at,
    lastMessageId: str(last, "id") ?? undefined,
    lastSwipeIndex: last.activeSwipeIndex === undefined ? undefined : Number(last.activeSwipeIndex),
  };
}

/** Only assistant turns drive ingestion; a user message alone is not a finished turn. */
export function isAssistantTurn(message: Record<string, unknown>): boolean {
  return str(message, "role") === "assistant";
}

// ── Polling loop ──────────────────────────────────────────────────────────────

export interface PollOptions {
  /** How many trailing messages to inspect per changed chat. */
  tailSize?: number;
  /** Called once per detected assistant turn. Errors are logged, never fatal. */
  onTurn?: (turn: DetectedTurn) => Promise<void> | void;
}

/**
 * One polling pass. Returns the turns detected (also passed to `onTurn`).
 *
 * Safe to call repeatedly; all state lives in poller-state.yaml.
 */
export async function pollOnce(opts: PollOptions = {}): Promise<DetectedTurn[]> {
  const tailSize = opts.tailSize ?? 10;
  const state = await loadPollerState();
  const chats = await listChats();
  const changed = selectChangedChats(chats, state);
  const detected: DetectedTurn[] = [];

  for (const change of changed) {
    // First sighting: establish a baseline, ingest nothing. Without this a
    // fresh install would replay every existing chat's history on tick one.
    if (change.isNew) {
      await recordWatermark(change.chatId, { lastMessageAt: change.lastMessageAt });
      continue;
    }

    let tail: Record<string, unknown>[];
    try {
      tail = await listMessages(change.chatId, { limit: tailSize });
    } catch (e) {
      console.warn(`[ME:poller] could not read messages for ${change.chatId} — ${String(e)}`);
      continue;
    }

    const mark = state?.chats?.[change.chatId];
    const { fresh, regenerated } = extractNewTurns(tail, mark);

    const candidates = regenerated ? [regenerated] : fresh;
    for (const message of candidates) {
      if (!isAssistantTurn(message)) continue;
      // Locate the reply within the full tail so we can find the user line that
      // prompted it — ingestion needs both halves of the turn.
      const idx = tail.findIndex((m) => str(m, "id") === str(message, "id"));
      detected.push({
        chatId: change.chatId,
        chatName: str(change.chat, "name") ?? change.chatId,
        // Prefer the message's own characterId — in a group scene it names the
        // actual speaker, where the chat only lists participants.
        characterId: str(message, "characterId") ?? getChatCharacterId(change.chat),
        message,
        regenerated: regenerated !== null,
        precedingUserText: idx >= 0 ? precedingUserTextFor(tail, idx) : "",
        participantIds: getChatParticipantIds(change.chat),
      });
    }

    // Advance the watermark even when nothing was ingestable (e.g. the user
    // just sent a message and the reply has not landed) — otherwise the same
    // tail is re-examined every tick.
    const next = watermarkFrom(tail);
    if (next) await recordWatermark(change.chatId, next);
  }

  for (const turn of detected) {
    try {
      await opts.onTurn?.(turn);
    } catch (e) {
      console.error(`[ME:poller] onTurn handler failed for chat ${turn.chatId} — ${String(e)}`);
    }
  }

  return detected;
}

let timer: NodeJS.Timeout | null = null;

/** Start the polling loop. Idempotent — calling twice does not stack timers. */
export function startPoller(opts: PollOptions & { intervalMs?: number } = {}): void {
  if (timer) return;
  const intervalMs = opts.intervalMs ?? 5000;
  let running = false;

  timer = setInterval(async () => {
    // Never overlap passes: a slow engine would otherwise queue ticks and
    // double-ingest the same turn.
    if (running) return;
    running = true;
    try {
      await pollOnce(opts);
    } catch (e) {
      console.warn(`[ME:poller] poll failed — ${String(e)}`);
    } finally {
      running = false;
    }
  }, intervalMs);

  // Do not hold the process open on our account.
  timer.unref?.();
  console.info(`[ME:poller] started — every ${intervalMs}ms`);
}

export function stopPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.info("[ME:poller] stopped");
  }
}
