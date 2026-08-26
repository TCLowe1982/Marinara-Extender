// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// BOOKMARK SURFACING (7mb6) — the guard that ate every bookmark in the store.
//
// Found by Mari from her own loader logs: "bookmarks surfaced: 0/16 ... 0/15 ...
// 0/15 ... 0/13 ... 0/12. five loads. zero. ever." Her tell was statistical and
// exactly right — a probabilistic filter does not produce a clean zero five times
// running, so nothing was reaching the roll.
//
// The mechanism: bookmarks were minted with `lastSeenTurn: turnNumber`, and
// turnNumber is permanently 0 in poller mode (the poller reads a message tail,
// not an absolute position). So every bookmark was born carrying the value the
// guard compares against, `0 === 0` returned false, and the weight roll was never
// evaluated. 84 of 134 bookmarks store-wide carried lastSeenTurn: 0; in the chat
// that surfaced this, all eleven did.
//
// The fix is a SENTINEL, not a bigger number: 0 cannot mean both "turn zero" and
// "never", and a sentinel repairs this WITHOUT waiting on the turn counter.
//
// There were no bookmark tests before this file, which is how a guard that
// suppressed one hundred percent of a feature survived in the hot path.

import { describe, it, expect, vi, afterEach } from "vitest";
import { surfaceBookmarks } from "../loader.js";
import { NEVER_SURFACED } from "../writer.js";
import type { Bookmark } from "../storage.js";

const bm = (over: Partial<Bookmark> = {}): Bookmark =>
  ({
    id: "b1",
    topic: "sister-situation",
    summary: "unresolved",
    weight: 0.9,
    why: "unresolved",
    createdTurn: 0,
    lastSeenTurn: NEVER_SURFACED,
    decayRate: 0.97,
    ...over,
  }) as Bookmark;

afterEach(() => vi.restoreAllMocks());

describe("a bookmark minted in poller mode reaches the roll", () => {
  it("NEVER_SURFACED does not collide with turn 0 — the regression", () => {
    // Before the fix this bookmark was minted with lastSeenTurn: 0, the guard
    // compared 0 === 0, and it was dropped before Math.random() was consulted.
    vi.spyOn(Math, "random").mockReturnValue(0.0); // roll always passes
    const out = surfaceBookmarks([bm({ lastSeenTurn: NEVER_SURFACED })], 0);
    expect(out).toHaveLength(1);
  });

  it("a whole chat's worth is no longer suppressed wholesale", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.0);
    const many = Array.from({ length: 11 }, (_, i) =>
      bm({ id: `b${i}`, lastSeenTurn: NEVER_SURFACED, weight: 0.5 }),
    );
    expect(surfaceBookmarks(many, 0)).toHaveLength(11);
  });
});

describe("the weight roll still governs, once it is reached", () => {
  it("a low-weight bookmark loses the roll", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.95);
    expect(surfaceBookmarks([bm({ weight: 0.1 })], 0)).toHaveLength(0);
  });

  it("a high-weight bookmark wins it", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.05);
    expect(surfaceBookmarks([bm({ weight: 0.9 })], 0)).toHaveLength(1);
  });

  // Mari's own caveat, kept as a test so it cannot be forgotten: reaching the
  // roll is not the same as surfacing. Her bookmarks decayed while invisible and
  // now sit at 0.10-0.82, so several will still lose legitimately.
  it("decayed weights still fail — the fix does not resurrect them", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const decayed = [0.10, 0.11, 0.22, 0.82].map((w, i) => bm({ id: `d${i}`, weight: w }));
    expect(surfaceBookmarks(decayed, 0).map((b) => b.weight)).toEqual([0.82]);
  });
});

describe("a real turn index is still honoured", () => {
  it("a bookmark born on the CURRENT turn is held back", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.0);
    expect(surfaceBookmarks([bm({ lastSeenTurn: 42 })], 42)).toHaveLength(0);
  });

  it("a bookmark born on a DIFFERENT turn is not", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.0);
    expect(surfaceBookmarks([bm({ lastSeenTurn: 41 })], 42)).toHaveLength(1);
  });

  it("a legacy 0-stamped bookmark is only held back on a genuine turn 0", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.0);
    expect(surfaceBookmarks([bm({ lastSeenTurn: 0 })], 0)).toHaveLength(0);
    expect(surfaceBookmarks([bm({ lastSeenTurn: 0 })], 7)).toHaveLength(1);
  });
});

// THE ACTUAL GUARD. Everything above tests the surfacing rule; the bug was in the
// MINT, so a test that never mints cannot catch it. This one drives the real
// creation path with storage stubbed, and it FAILS against the old
// `lastSeenTurn: turnNumber` — verified by reverting that one line.
describe("the mint does not stamp a bookmark with the current turn", () => {
  it("a bookmark created at turn 0 is not born suppressed", async () => {
    const saved: Bookmark[] = [];
    vi.resetModules();
    vi.doMock("../storage.js", () => ({
      mutateBookmarks: async (_s: string, _id: string, fn: (cur: Bookmark[]) => Bookmark[]) => {
        saved.push(...fn([]));
      },
    }));
    const { processResponse } = await import("../writer.js");
    const { surfaceBookmarks: surface } = await import("../loader.js");

    await processResponse(
      "chat-1",
      0, // poller mode: the only turn number there is
      'text [bookmark: topic="sister-situation", weight=0.9, why="unresolved", summary="one line."]',
    );

    expect(saved).toHaveLength(1);
    // The bug in one assertion: minted with the turn it was born on, it can
    // never be surfaced on that turn — and in poller mode every turn is that turn.
    expect(saved[0]!.lastSeenTurn).not.toBe(0);

    vi.spyOn(Math, "random").mockReturnValue(0.0);
    expect(surface(saved, 0)).toHaveLength(1);
  });
});
