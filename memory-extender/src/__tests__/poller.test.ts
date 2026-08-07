// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Turn detection (MarinaraExtender-23i, epic hq7).
//
// The pure selection/extraction logic is where the correctness lives, so it is
// tested directly. The two behaviours that would cause real damage if wrong:
//   - a never-seen chat must be BASELINED, not ingested (otherwise a fresh
//     install replays every chat's entire history as if it just happened)
//   - a regenerated (swiped) reply must be detected, or memory keeps the text
//     the user just threw away

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  selectChangedChats,
  extractNewTurns,
  watermarkFrom,
  isAssistantTurn,
  getChatCharacterId,
  recordWatermark,
  loadPollerState,
  pollOnce,
  handleTurnNotification,
  _resetChatLocks,
  type PollerState,
  type DetectedTurn,
} from "../poller.js";

// Shapes mirror the live engine payloads verified 2026-07-23.
const chat = (id: string, lastMessageAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `chat-${id}`,
  lastMessageAt,
  characterIds: ["char1"],
  mode: "conversation",
  ...extra,
});

const msg = (
  id: string,
  createdAt: string,
  role: string,
  extra: Record<string, unknown> = {},
) => ({ id, createdAt, role, content: `text-${id}`, characterId: "char1", ...extra });

describe("selectChangedChats", () => {
  it("reports a never-seen chat as new (to be baselined, not ingested)", () => {
    const out = selectChangedChats([chat("c1", "2026-07-23T10:00:00Z")], null);
    expect(out).toHaveLength(1);
    expect(out[0].isNew).toBe(true);
  });

  it("reports a chat whose lastMessageAt advanced", () => {
    const state: PollerState = { chats: { c1: { lastMessageAt: "2026-07-23T10:00:00Z" } } };
    const out = selectChangedChats([chat("c1", "2026-07-23T11:00:00Z")], state);
    expect(out).toHaveLength(1);
    expect(out[0].isNew).toBe(false);
  });

  it("ignores an unchanged chat", () => {
    const state: PollerState = { chats: { c1: { lastMessageAt: "2026-07-23T10:00:00Z" } } };
    expect(selectChangedChats([chat("c1", "2026-07-23T10:00:00Z")], state)).toHaveLength(0);
  });

  it("ignores a chat that somehow went backwards", () => {
    const state: PollerState = { chats: { c1: { lastMessageAt: "2026-07-23T12:00:00Z" } } };
    expect(selectChangedChats([chat("c1", "2026-07-23T11:00:00Z")], state)).toHaveLength(0);
  });

  it("skips chats with no messages yet", () => {
    expect(selectChangedChats([{ id: "c1", name: "empty" }], null)).toHaveLength(0);
  });

  it("only returns the chats that moved, out of many", () => {
    // The efficiency claim: 91 chats, one moved, one message fetch.
    const state: PollerState = {
      chats: Object.fromEntries(
        Array.from({ length: 90 }, (_, i) => [`c${i}`, { lastMessageAt: "2026-07-23T10:00:00Z" }]),
      ),
    };
    const chats = Array.from({ length: 90 }, (_, i) => chat(`c${i}`, "2026-07-23T10:00:00Z"));
    chats[42] = chat("c42", "2026-07-23T12:00:00Z");
    const out = selectChangedChats(chats, state);
    expect(out.map((c) => c.chatId)).toEqual(["c42"]);
  });
});

describe("extractNewTurns", () => {
  const mark = { lastMessageAt: "2026-07-23T10:00:00Z", lastMessageId: "m1", lastSwipeIndex: 0 };

  it("returns messages newer than the watermark", () => {
    const { fresh } = extractNewTurns(
      [msg("m1", "2026-07-23T10:00:00Z", "assistant"), msg("m2", "2026-07-23T11:00:00Z", "assistant")],
      mark,
    );
    expect(fresh.map((m) => m.id)).toEqual(["m2"]);
  });

  it("returns nothing when nothing is newer", () => {
    const { fresh, regenerated } = extractNewTurns([msg("m1", "2026-07-23T10:00:00Z", "assistant")], mark);
    expect(fresh).toHaveLength(0);
    expect(regenerated).toBeNull();
  });

  it("detects a regeneration as a swipe on the SAME message id", () => {
    // The engine re-rolls in place: same id, same createdAt, new swipe index.
    // Missing this means memory keeps the reply the user discarded.
    const { fresh, regenerated } = extractNewTurns(
      [msg("m1", "2026-07-23T10:00:00Z", "assistant", { activeSwipeIndex: 1, swipeCount: 2 })],
      mark,
    );
    expect(fresh).toHaveLength(0);
    expect(regenerated?.id).toBe("m1");
  });

  it("does not call an unchanged swipe index a regeneration", () => {
    const { regenerated } = extractNewTurns(
      [msg("m1", "2026-07-23T10:00:00Z", "assistant", { activeSwipeIndex: 0 })],
      mark,
    );
    expect(regenerated).toBeNull();
  });

  it("does not invent a regeneration when the message carries no swipe index", () => {
    // Regression: defaulting a missing activeSwipeIndex to -1 made every
    // unchanged message compare unequal to a recorded index of 0, so the same
    // turn was re-ingested on every tick — duplicating memory indefinitely.
    const { fresh, regenerated } = extractNewTurns(
      [msg("m1", "2026-07-23T10:00:00Z", "assistant")],
      mark,
    );
    expect(fresh).toHaveLength(0);
    expect(regenerated).toBeNull();
  });

  it("does not invent a regeneration when the watermark predates swipe tracking", () => {
    const { regenerated } = extractNewTurns(
      [msg("m1", "2026-07-23T10:00:00Z", "assistant", { activeSwipeIndex: 3 })],
      { lastMessageAt: "2026-07-23T10:00:00Z", lastMessageId: "m1" },
    );
    expect(regenerated).toBeNull();
  });

  it("prefers genuinely new messages over a regeneration check", () => {
    const { fresh, regenerated } = extractNewTurns(
      [
        msg("m1", "2026-07-23T10:00:00Z", "assistant", { activeSwipeIndex: 1 }),
        msg("m2", "2026-07-23T11:00:00Z", "assistant"),
      ],
      mark,
    );
    expect(fresh.map((m) => m.id)).toEqual(["m2"]);
    expect(regenerated).toBeNull();
  });

  it("returns nothing when there is no watermark (baseline case)", () => {
    const { fresh } = extractNewTurns([msg("m1", "2026-07-23T10:00:00Z", "assistant")], undefined);
    expect(fresh).toHaveLength(0);
  });
});

describe("watermarkFrom", () => {
  it("takes the last message of an ascending tail", () => {
    const wm = watermarkFrom([
      msg("m1", "2026-07-23T10:00:00Z", "user"),
      msg("m2", "2026-07-23T11:00:00Z", "assistant", { activeSwipeIndex: 2 }),
    ]);
    expect(wm).toEqual({
      lastMessageAt: "2026-07-23T11:00:00Z",
      lastMessageId: "m2",
      lastSwipeIndex: 2,
    });
  });

  it("returns null for an empty tail", () => {
    expect(watermarkFrom([])).toBeNull();
  });
});

describe("role + character helpers", () => {
  it("only assistant messages count as a finished turn", () => {
    expect(isAssistantTurn(msg("m1", "t", "assistant"))).toBe(true);
    expect(isAssistantTurn(msg("m1", "t", "user"))).toBe(false);
  });

  it("reads characterIds arrays used by conversation-mode chats", () => {
    expect(getChatCharacterId({ characterIds: ["cA"] })).toBe("cA");
  });

  it("reads a scalar characterId", () => {
    expect(getChatCharacterId({ characterId: "cB" })).toBe("cB");
  });

  it("reads a stringified characterIds array", () => {
    expect(getChatCharacterId({ characterIds: '["cC"]' })).toBe("cC");
  });

  it("returns null when no character can be determined", () => {
    expect(getChatCharacterId({ id: "c1" })).toBeNull();
  });
});

describe("pollOnce — integration over stubbed engine", () => {
  let dir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "me-poller-"));
    process.env.MARINARA_EXTENDER_DATA = dir;
    process.env.MARINARA_EXTENDER_ENGINE_URL = "http://engine.test:7860";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.MARINARA_EXTENDER_DATA;
    delete process.env.MARINARA_EXTENDER_ENGINE_URL;
    await rm(dir, { recursive: true, force: true });
  });

  const json = (b: unknown) =>
    new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

  function engine(chats: unknown[], messagesByChat: Record<string, unknown[]>) {
    fetchMock.mockImplementation((url: string) => {
      if (/\/chats$/.test(url)) return Promise.resolve(json(chats));
      const m = /\/chats\/([^/?]+)\/messages/.exec(url);
      if (m) return Promise.resolve(json(messagesByChat[m[1]] ?? []));
      return Promise.resolve(json([]));
    });
  }

  it("baselines every chat on first run and ingests NOTHING", async () => {
    // The damage case: 91 existing chats would otherwise all replay at once.
    engine(
      [chat("c1", "2026-07-23T10:00:00Z"), chat("c2", "2026-07-23T09:00:00Z")],
      { c1: [msg("m1", "2026-07-23T10:00:00Z", "assistant")] },
    );
    const seen: string[] = [];
    const turns = await pollOnce({ onTurn: (t) => void seen.push(t.chatId) });

    expect(turns).toHaveLength(0);
    expect(seen).toHaveLength(0);
    const state = await loadPollerState();
    expect(Object.keys(state!.chats).sort()).toEqual(["c1", "c2"]);
    // No message fetch needed to baseline — only the chat list.
    expect(fetchMock.mock.calls.filter(([u]) => /messages/.test(u as string))).toHaveLength(0);
  });

  it("detects a new assistant turn after the baseline", async () => {
    await recordWatermark("c1", { lastMessageAt: "2026-07-23T10:00:00Z", lastMessageId: "m1", lastSwipeIndex: 0 });
    engine([chat("c1", "2026-07-23T11:00:00Z")], {
      c1: [msg("m1", "2026-07-23T10:00:00Z", "assistant"), msg("m2", "2026-07-23T11:00:00Z", "assistant")],
    });

    const turns = await pollOnce();
    expect(turns).toHaveLength(1);
    expect(turns[0].message.id).toBe("m2");
    expect(turns[0].regenerated).toBe(false);
    expect(turns[0].characterId).toBe("char1");
  });

  it("does not re-detect the same turn on the next pass", async () => {
    await recordWatermark("c1", { lastMessageAt: "2026-07-23T10:00:00Z", lastMessageId: "m1", lastSwipeIndex: 0 });
    engine([chat("c1", "2026-07-23T11:00:00Z")], {
      c1: [msg("m1", "2026-07-23T10:00:00Z", "assistant"), msg("m2", "2026-07-23T11:00:00Z", "assistant")],
    });

    expect(await pollOnce()).toHaveLength(1);
    expect(await pollOnce()).toHaveLength(0);
  });

  it("ignores a user message as a finished turn but still advances the watermark", async () => {
    // Otherwise the same tail is re-read on every tick forever.
    await recordWatermark("c1", { lastMessageAt: "2026-07-23T10:00:00Z", lastMessageId: "m1" });
    engine([chat("c1", "2026-07-23T11:00:00Z")], {
      c1: [msg("m1", "2026-07-23T10:00:00Z", "assistant"), msg("m2", "2026-07-23T11:00:00Z", "user")],
    });

    expect(await pollOnce()).toHaveLength(0);
    const state = await loadPollerState();
    expect(state!.chats.c1.lastMessageAt).toBe("2026-07-23T11:00:00Z");
  });

  it("surfaces a regeneration as regenerated:true", async () => {
    await recordWatermark("c1", {
      lastMessageAt: "2026-07-23T10:00:00Z",
      lastMessageId: "m1",
      lastSwipeIndex: 0,
    });
    // lastMessageAt advanced (the engine touches the chat on a re-roll) but the
    // message id is unchanged — only the swipe moved.
    engine([chat("c1", "2026-07-23T10:30:00Z")], {
      c1: [msg("m1", "2026-07-23T10:00:00Z", "assistant", { activeSwipeIndex: 1, swipeCount: 2 })],
    });

    const turns = await pollOnce();
    expect(turns).toHaveLength(1);
    expect(turns[0].regenerated).toBe(true);
    expect(turns[0].message.id).toBe("m1");
  });

  it("a throwing onTurn handler does not abort the pass", async () => {
    await recordWatermark("c1", { lastMessageAt: "2026-07-23T10:00:00Z" });
    engine([chat("c1", "2026-07-23T11:00:00Z")], {
      c1: [msg("m2", "2026-07-23T11:00:00Z", "assistant")],
    });
    await expect(pollOnce({ onTurn: () => { throw new Error("handler blew up"); } })).resolves.toHaveLength(1);
  });

  it("a failed message fetch skips that chat without losing the others", async () => {
    await recordWatermark("c1", { lastMessageAt: "2026-07-23T10:00:00Z" });
    await recordWatermark("c2", { lastMessageAt: "2026-07-23T10:00:00Z" });
    fetchMock.mockImplementation((url: string) => {
      if (/\/chats$/.test(url))
        return Promise.resolve(json([chat("c1", "2026-07-23T11:00:00Z"), chat("c2", "2026-07-23T11:00:00Z")]));
      if (/\/chats\/c1\/messages/.test(url)) return Promise.reject(new Error("boom"));
      return Promise.resolve(json([msg("m9", "2026-07-23T11:00:00Z", "assistant")]));
    });

    const turns = await pollOnce();
    expect(turns.map((t) => t.chatId)).toEqual(["c2"]);
  });

  it("bounds the message fetch — never requests unbounded history", async () => {
    // Unbounded returns the FULL history (195 messages on a real chat).
    await recordWatermark("c1", { lastMessageAt: "2026-07-23T10:00:00Z" });
    engine([chat("c1", "2026-07-23T11:00:00Z")], { c1: [] });
    await pollOnce({ tailSize: 7 });
    const call = fetchMock.mock.calls.find(([u]) => /messages/.test(u as string))![0] as string;
    expect(call).toContain("limit=7");
  });
});

// ── Notification-driven detection (MarinaraExtender-4kbt) ────────────────────
// The bug this path exists to fix: a regeneration rewrites the assistant
// message IN PLACE. Measured against a live engine 2026-07-30 — neither the
// message's createdAt nor the chat's lastMessageAt moves, so selectChangedChats
// never reports the chat and the poller's own swipe branch is unreachable.

describe("handleTurnNotification — push detection over stubbed engine", () => {
  let dir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "me-hook-"));
    process.env.MARINARA_EXTENDER_DATA = dir;
    process.env.MARINARA_EXTENDER_ENGINE_URL = "http://engine.test:7860";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    _resetChatLocks();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.MARINARA_EXTENDER_DATA;
    delete process.env.MARINARA_EXTENDER_ENGINE_URL;
    await rm(dir, { recursive: true, force: true });
  });

  const json = (b: unknown) =>
    new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

  function engine(chats: unknown[], messagesByChat: Record<string, unknown[]>) {
    fetchMock.mockImplementation((url: string) => {
      if (/\/chats$/.test(url)) return Promise.resolve(json(chats));
      const m = /\/chats\/([^/?]+)\/messages/.exec(url);
      if (m) return Promise.resolve(json(messagesByChat[m[1]] ?? []));
      return Promise.resolve(json([]));
    });
  }

  it("detects a swipe that polling structurally cannot see", async () => {
    // The chat's lastMessageAt is IDENTICAL before and after the re-roll.
    const at = "2026-07-23T10:00:00Z";
    await recordWatermark("c1", { lastMessageAt: at, lastMessageId: "m1", lastSwipeIndex: 0 });
    engine([chat("c1", at)], {
      c1: [msg("m1", at, "assistant", { activeSwipeIndex: 1, swipeCount: 2, content: "re-rolled" })],
    });

    // Polling sees nothing at all — lastMessageAt never moved.
    expect(await pollOnce()).toHaveLength(0);

    const seen: DetectedTurn[] = [];
    const turns = await handleTurnNotification(
      { chatId: "c1", assistantMessageId: "m1" },
      { onTurn: (t) => void seen.push(t) },
    );

    expect(turns).toHaveLength(1);
    expect(turns[0].regenerated).toBe(true);
    expect(turns[0].message.content).toBe("re-rolled");
    expect(seen).toHaveLength(1);
  });

  it("ingests a genuinely new turn once, not marked as a re-roll", async () => {
    await recordWatermark("c1", {
      lastMessageAt: "2026-07-23T10:00:00Z",
      lastMessageId: "m1",
      lastSwipeIndex: 0,
    });
    engine([chat("c1", "2026-07-23T11:00:00Z")], {
      c1: [
        msg("m1", "2026-07-23T10:00:00Z", "assistant", { activeSwipeIndex: 0 }),
        msg("u2", "2026-07-23T10:59:00Z", "user"),
        msg("m2", "2026-07-23T11:00:00Z", "assistant", { activeSwipeIndex: 0 }),
      ],
    });

    const turns = await handleTurnNotification({ chatId: "c1", assistantMessageId: "m2" });
    expect(turns).toHaveLength(1);
    expect(turns[0].regenerated).toBe(false);
    // Both halves of the turn reach ingestion, not just the reply.
    expect(turns[0].precedingUserText).toBe("text-u2");
    // 2pbi: and the user half brings its OWN message id. It was always in the
    // tail and always discarded, so the user's line was stamped with the reply's
    // id — which made the two halves one moment for dedup, and let a re-roll
    // retire an entry the user never retracted.
    expect(turns[0].precedingUserMessageId).toBe("u2");
    expect(turns[0].precedingUserMessageId).not.toBe(turns[0].message.id);
  });

  it("is a no-op on a repeated notification for the same message and swipe", async () => {
    // The engine is fire-and-forget; a retry or a duplicate must not double-ingest.
    engine([chat("c1", "2026-07-23T11:00:00Z")], {
      c1: [msg("m2", "2026-07-23T11:00:00Z", "assistant", { activeSwipeIndex: 0 })],
    });
    expect(await handleTurnNotification({ chatId: "c1", assistantMessageId: "m2" })).toHaveLength(1);
    expect(await handleTurnNotification({ chatId: "c1", assistantMessageId: "m2" })).toHaveLength(0);
  });

  it("skips a turn the poller already ingested", async () => {
    // Both detectors run against one engine; whichever wins, the other stands down.
    await recordWatermark("c1", { lastMessageAt: "2026-07-23T10:00:00Z" });
    engine([chat("c1", "2026-07-23T11:00:00Z")], {
      c1: [msg("m2", "2026-07-23T11:00:00Z", "assistant", { activeSwipeIndex: 0 })],
    });

    expect(await pollOnce()).toHaveLength(1);
    expect(await handleTurnNotification({ chatId: "c1", assistantMessageId: "m2" })).toHaveLength(0);
  });

  it("declines a message older than the tail rather than blaming the wrong turn", async () => {
    // Misattributing a swipe to the newest message would corrupt a good memory.
    await recordWatermark("c1", { lastMessageAt: "2026-07-23T11:00:00Z", lastMessageId: "m2" });
    engine([chat("c1", "2026-07-23T11:00:00Z")], {
      c1: [msg("m2", "2026-07-23T11:00:00Z", "assistant", { activeSwipeIndex: 0 })],
    });

    const turns = await handleTurnNotification({ chatId: "c1", assistantMessageId: "ancient" });
    expect(turns).toHaveLength(0);
  });

  it("ingests the first turn of an unseen chat instead of baselining it", async () => {
    // Deliberately unlike the poller. A poll sweep sees every chat's whole
    // history at once and must baseline; a notification is evidence that THIS
    // turn finished just now, so dropping it would silently lose a real turn.
    engine([chat("c1", "2026-07-23T11:00:00Z")], {
      c1: [msg("m1", "2026-07-23T11:00:00Z", "assistant", { activeSwipeIndex: 0 })],
    });

    const turns = await handleTurnNotification({ chatId: "c1", assistantMessageId: "m1" });
    expect(turns).toHaveLength(1);
    expect(turns[0].regenerated).toBe(false);
  });

  it("ignores a notification naming a user message", async () => {
    engine([chat("c1", "2026-07-23T11:00:00Z")], {
      c1: [msg("u1", "2026-07-23T11:00:00Z", "user")],
    });
    expect(await handleTurnNotification({ chatId: "c1", assistantMessageId: "u1" })).toHaveLength(0);
  });

  it("survives an unreachable engine without throwing at the HTTP caller", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error("engine down")));
    await expect(
      handleTurnNotification({ chatId: "c1", assistantMessageId: "m1" }),
    ).resolves.toEqual([]);
  });

  it("serialises concurrent notifications for one chat", async () => {
    // Without the per-chat lock both passes read the same watermark and both
    // conclude the turn is new.
    engine([chat("c1", "2026-07-23T11:00:00Z")], {
      c1: [msg("m2", "2026-07-23T11:00:00Z", "assistant", { activeSwipeIndex: 0 })],
    });

    const [a, b] = await Promise.all([
      handleTurnNotification({ chatId: "c1", assistantMessageId: "m2" }),
      handleTurnNotification({ chatId: "c1", assistantMessageId: "m2" }),
    ]);
    expect(a.length + b.length).toBe(1);
  });
});
