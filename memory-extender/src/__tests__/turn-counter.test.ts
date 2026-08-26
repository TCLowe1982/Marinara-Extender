// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// THE INGEST ORDINAL (7mb6) — belt and braces with the NEVER_SURFACED sentinel.
//
// The engine cannot always say which turn this is: the poller reads a 10-message
// tail, not an absolute position, so it sends no turnNumber. That used to default
// to 0, which silently disabled tier promotion, stale-thread closing and arc
// promotion (all gated on `turnNumber % N`), stamped user chunks turnStart -1,
// and gave the bookmark guard a constant to compare against.
//
// The two fixes are deliberately independent. The sentinel keeps bookmarks
// correct even if this counter is absent or wrong; this counter keeps the % N
// gates firing even if some future mint forgets the sentinel. Neither alone
// covers both failures, which is the whole point of asking for both.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "me-turn-"));
  process.env.MARINARA_EXTENDER_DATA = dir;
});
afterEach(() => {
  delete process.env.MARINARA_EXTENDER_DATA;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows */ }
});

async function mod() {
  // Re-imported per test so the data dir env is read fresh.
  return await import("../storage.js");
}

describe("the ordinal advances and persists", () => {
  it("a chat with no counter starts at 0 and is not advanced by reading", async () => {
    const { currentTurn } = await mod();
    expect(await currentTurn("chat-a")).toBe(0);
    expect(await currentTurn("chat-a")).toBe(0);
  });

  it("nextTurn increments monotonically", async () => {
    const { nextTurn } = await mod();
    expect(await nextTurn("chat-a")).toBe(1);
    expect(await nextTurn("chat-a")).toBe(2);
    expect(await nextTurn("chat-a")).toBe(3);
  });

  it("the advanced value survives being read back", async () => {
    const { nextTurn, currentTurn } = await mod();
    await nextTurn("chat-a");
    await nextTurn("chat-a");
    expect(await currentTurn("chat-a")).toBe(2);
  });

  it("counters are per chat and do not bleed", async () => {
    const { nextTurn, currentTurn } = await mod();
    await nextTurn("chat-a");
    await nextTurn("chat-a");
    await nextTurn("chat-b");
    expect(await currentTurn("chat-a")).toBe(2);
    expect(await currentTurn("chat-b")).toBe(1);
  });
});

describe("concurrent ingests never share a number", () => {
  it("ten overlapping advances yield ten distinct ordinals", async () => {
    // The poller fires every 5s and can overlap itself. A read-modify-write race
    // here would hand two turns the same ordinal — which is precisely the class
    // of bug this ticket exists to kill, so it gets a test rather than a comment.
    const { nextTurn } = await mod();
    const got = await Promise.all(Array.from({ length: 10 }, () => nextTurn("chat-race")));
    expect(new Set(got).size).toBe(10);
    expect(got.slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe("a corrupt or hostile counter degrades to 0 rather than throwing", () => {
  it("garbage in the file reads as 0 and the next advance is 1", async () => {
    const { turnCounterPath, currentTurn, nextTurn } = await mod();
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const p = turnCounterPath("chat-bad");
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "turn: not-a-number\n", "utf8");
    expect(await currentTurn("chat-bad")).toBe(0);
    expect(await nextTurn("chat-bad")).toBe(1);
  });

  it("a negative value is refused, not trusted", async () => {
    const { turnCounterPath, currentTurn } = await mod();
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const p = turnCounterPath("chat-neg");
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "turn: -5\n", "utf8");
    // -1 is the bookmark sentinel; a counter must never emit one.
    expect(await currentTurn("chat-neg")).toBe(0);
  });
});
