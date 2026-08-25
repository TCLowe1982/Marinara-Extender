// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Detected turn -> ingestion -> lorebook. The piece that makes the poller path
// actually do something.
//
// WHY THIS CALLS THE SIDECAR'S OWN HTTP ENDPOINT rather than importing the
// ingestion code: /api/process-turn is a large inline route handler that also
// kicks off several fire-and-forget tiers (sentiment, ambient facts, promotion,
// reconcile). Extracting it would be a risky refactor of an 83KB file for no
// behavioural gain. Going through the endpoint reuses the EXACT path the
// extension used and returns the same `memoryBlock` the extension wrote to the
// lorebook, so the poller reproduces the proven flow instead of a parallel
// implementation that can quietly drift. The call is loopback.
//
// The flow, unchanged from the extension:
//   POST /api/process-turn  ->  { memoryBlock }  ->  write to the lorebook
// The engine then injects that lorebook on the NEXT generation, which is why
// memory has always been one turn behind on this path.

import { listCharacters, listPersonas, parseData } from "./engine-client.js";
import { syncMemoryToLorebook } from "./lorebook-writer.js";
import { recordCapture } from "./capture-status.js";
import { swipeIndexOf, type DetectedTurn } from "./poller.js";

// The engine's message id. Reused from the raw record rather than added to
// DetectedTurn, so there is exactly one notion of "which message" and it is the
// same one the watermark and the regeneration check already use.
function messageIdOf(message: Record<string, unknown>): string | undefined {
  const id = message.id;
  return typeof id === "string" && id ? id : undefined;
}

function sidecarPort(): number {
  return parseInt(process.env.MARINARA_EXTENDER_PORT ?? "3001", 10);
}

function sidecarUrl(path: string): string {
  return `http://127.0.0.1:${sidecarPort()}${path}`;
}

// Character names change rarely; resolving one per turn would mean an extra
// engine round-trip on every reply. Cached, with an explicit reset for tests
// and a miss-triggered refresh so a newly-created character is still found.
let nameCache: Map<string, string> | null = null;

export function _resetCharacterCache(): void {
  nameCache = null;
}

async function loadNames(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const c of await listCharacters()) {
    const d = parseData(c);
    const id = String(c.id ?? d.id ?? "");
    const name = String(c.name ?? d.name ?? "");
    if (id && name) map.set(id, name);
  }
  return map;
}

// Personas resolve the same way and change even less often. Separate cache so a
// character refresh does not pay for a persona lookup or vice versa.
let personaCache: Map<string, string> | null = null;

export function _resetPersonaCache(): void {
  personaCache = null;
}

async function loadPersonas(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const p of await listPersonas()) {
    // Personas expose their fields at the TOP level — no nested `data` string.
    const id = String(p.id ?? "");
    const name = String(p.name ?? "");
    if (id && name) map.set(id, name);
  }
  return map;
}

export async function personaNameFor(personaId: string | undefined | null): Promise<string | null> {
  if (!personaId) return null;
  if (!personaCache) personaCache = await loadPersonas().catch(() => new Map());
  const hit = personaCache.get(personaId);
  if (hit) return hit;
  // Miss: the persona may have been created since the cache was built.
  personaCache = await loadPersonas().catch(() => personaCache ?? new Map());
  return personaCache.get(personaId) ?? null;
}

export async function characterNameFor(characterId: string): Promise<string | null> {
  if (!nameCache) nameCache = await loadNames().catch(() => new Map());
  const hit = nameCache.get(characterId);
  if (hit) return hit;
  // Miss: the character may have been created since the cache was built.
  nameCache = await loadNames().catch(() => nameCache ?? new Map());
  return nameCache.get(characterId) ?? null;
}

export interface ProcessTurnResult {
  memoryBlock?: string;
  created?: unknown;
  surfaced?: unknown;
}

/**
 * Run the sidecar's own ingestion for a turn and return its memory block.
 * Throws on a non-2xx so the caller can log it against the chat.
 */
export async function runProcessTurn(body: Record<string, unknown>): Promise<ProcessTurnResult> {
  const res = await fetch(sidecarUrl("/api/process-turn"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`process-turn returned ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as ProcessTurnResult;
  } catch {
    return {};
  }
}

export interface BridgeResult {
  ingested: boolean;
  lorebookId: string | null;
  skippedReason?: string;
}

export interface BridgeOptions {
  /**
   * Skip the per-turn lorebook write. For bulk replay (backfill.ts): syncing
   * after every one of hundreds of sequential turns rewrites the same lorebook
   * hundreds of times for one final state. The CALLER owns syncing at the end
   * when it sets this — a backfill that skips sync and never finishes with one
   * leaves the lorebook stale until the next live turn.
   */
  skipLorebookSync?: boolean;
  /** Stamped into capture-status so a backfill cannot masquerade as live capture health. */
  source?: "live" | "backfill";
}

/**
 * Handle one detected turn end to end.
 *
 * Never throws: the poller runs this on a timer and a single bad turn must not
 * stop the loop. Failures are logged and reported in the result.
 */
export async function handleDetectedTurn(turn: DetectedTurn, opts: BridgeOptions = {}): Promise<BridgeResult> {
  const messageText = String(turn.message.content ?? "");

  if (!turn.characterId) {
    return { ingested: false, lorebookId: null, skippedReason: "no characterId on the turn" };
  }
  // An empty reply carries nothing to remember, and would still cost a full
  // analysis pass plus a lorebook rewrite.
  if (!messageText.trim()) {
    return { ingested: false, lorebookId: null, skippedReason: "empty assistant message" };
  }

  const characterName = await characterNameFor(turn.characterId);
  // qhej: who the HUMAN is playing here. Never guessed — null when the chat
  // names no persona, which the routing reads as "unknown", not "no persona".
  const personaName = await personaNameFor(turn.personaId);

  let result: ProcessTurnResult;
  try {
    result = await runProcessTurn({
      characterId: turn.characterId,
      characterName,
      participantIds: turn.participantIds,
      chatId: turn.chatId,
      sceneTitle: turn.chatName,
      ...(personaName ? { personaName } : {}),
      messageText,
      userMessageText: turn.precedingUserText,
      // 06pq: which message, and which swipe of it. The poller sends no
      // turnNumber (there is none to send — it reads a 10-message tail, not an
      // absolute position), so without this every live turn stamps turnStart 0
      // and the same-moment dedup proof goes vacuous. The PAIR is what makes a
      // re-roll distinguishable from a re-read; see storage.ts.
      sourceMessageId: messageIdOf(turn.message),
      sourceSwipeIndex: swipeIndexOf(turn.message),
      // 2pbi: the OTHER half of the turn is a different message. Without its own
      // id the user chunk inherits the reply's, and both halves of one turn end
      // up claiming the same moment.
      userSourceMessageId: turn.precedingUserMessageId,
      regenerated: turn.regenerated,
    });
  } catch (e) {
    console.error(`[ME:bridge] ingestion failed for chat ${turn.chatId} — ${String(e)}`);
    return { ingested: false, lorebookId: null, skippedReason: "process-turn failed" };
  }

  // The EVENT signal: a turn really made it into memory, live or backfill.
  // Recorded before the lorebook write on purpose — capture is the ingest, and
  // a failed lorebook sync must not make a captured turn look uncaptured.
  void recordCapture({ chatId: turn.chatId, characterId: turn.characterId, source: opts.source ?? "live" });

  const memoryBlock = result.memoryBlock ?? "";
  if (!memoryBlock) {
    // Ingestion ran (facts may have been stored) but there is nothing to
    // inject yet — don't clear a populated lorebook over it.
    return { ingested: true, lorebookId: null, skippedReason: "no memory block to write" };
  }

  if (opts.skipLorebookSync) {
    return { ingested: true, lorebookId: null, skippedReason: "lorebook sync deferred by caller" };
  }

  const lorebookId = await syncMemoryToLorebook({
    characterId: turn.characterId,
    characterName,
    memoryBlock,
  });

  console.info(
    `[ME:bridge] turn ingested — chat="${turn.chatName}" character=${characterName ?? turn.characterId}` +
      `${turn.regenerated ? " (regenerated)" : ""} lorebook=${lorebookId ?? "none"}`,
  );

  return { ingested: true, lorebookId };
}
