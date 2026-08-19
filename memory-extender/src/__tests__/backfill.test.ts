// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Backfill — replaying an outage window through the live path (the 08-04→08-10
// poller outage's recovery utility).
//
// The poller cannot recover its own outages BY DESIGN, twice over: a chat first
// seen after the gap is baselined without ingesting, and a known chat's
// catch-up reads a 10-message tail then advances the watermark over everything
// older. Both behaviours are correct for live detection and both seal an
// outage permanently — so recovery has to be a separate, window-shaped replay.
//
// What is worth pinning here is the pure logic the replay's correctness rides
// on: the window filter's boundary semantics, the one-sync-per-character set,
// and the window-edge case where a reply's user half lies OUTSIDE the window
// (buildTurns must see full history, or edge replies lose their user line —
// the exact class of half-turn bug 2pbi existed to kill).

import { describe, it, expect } from "vitest";
import { inWindow, lastTurnPerCharacter } from "../backfill.js";
import { buildTurns, isAssistantTurn, type DetectedTurn } from "../poller.js";

const msg = (id: string, createdAt: string, role: string, extra: Record<string, unknown> = {}) =>
  ({ id, createdAt, role, content: `text-${id}`, characterId: "char1", ...extra });

describe("inWindow", () => {
  it("is inclusive at from, exclusive at to — adjacent windows cannot double-ingest a boundary message", () => {
    const at = "2026-08-05T00:00:00Z";
    expect(inWindow(msg("m", at, "assistant"), at, "2026-08-06T00:00:00Z")).toBe(true);
    expect(inWindow(msg("m", at, "assistant"), "2026-08-04T00:00:00Z", at)).toBe(false);
  });

  it("rejects a message with no createdAt rather than guessing", () => {
    expect(inWindow({ id: "m", role: "assistant" }, "2026-08-04T00:00:00Z", "2026-08-10T00:00:00Z")).toBe(false);
  });
});

describe("lastTurnPerCharacter", () => {
  it("marks exactly each character's final turn — the one whose lorebook sync carries the end state", () => {
    const turns = [
      { characterId: "mari" }, { characterId: "priya" },
      { characterId: "mari" }, { characterId: "priya" }, { characterId: "mari" },
    ] as DetectedTurn[];
    expect(lastTurnPerCharacter(turns)).toEqual(new Set([3, 4]));
  });

  it("ignores turns with no characterId instead of syncing a lorebook for nobody", () => {
    const turns = [{ characterId: null }, { characterId: "mari" }] as unknown as DetectedTurn[];
    expect(lastTurnPerCharacter(turns)).toEqual(new Set([1]));
  });
});

describe("window-edge turn assembly", () => {
  it("a reply at the window's start still finds its user line from before the window", () => {
    // The user asked at 23:59, capture died at midnight, the reply landed at
    // 00:01. The reply is in the recovery window; its user half is not. Handing
    // buildTurns only the windowed slice would assemble a half-turn.
    const all = [
      msg("u1", "2026-08-04T23:59:00Z", "user"),
      msg("a1", "2026-08-05T00:01:00Z", "assistant"),
    ];
    const from = "2026-08-05T00:00:00Z";
    const windowed = all.filter((m) => inWindow(m, from, "2026-08-10T00:00:00Z"));
    const candidates = windowed.filter((m) => isAssistantTurn(m));
    expect(candidates).toHaveLength(1);

    const turns = buildTurns({ id: "c1", name: "chat", characterIds: ["char1"] }, "c1", all, candidates, false);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.precedingUserText).toBe("text-u1");
    expect(turns[0]!.precedingUserMessageId).toBe("u1");
  });
});
