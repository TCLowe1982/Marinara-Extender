// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// THE DECAY CLOCK MUST NOT BE RESET BY MERE EXPOSURE (MarinaraExtender-gwny).
//
// promotion.ts decides staleness with `lastRetrievedAt ?? lastAccessed`, and
// lastRetrievedAt is written only on demonstrable use (recordRecitation). Measured on
// the live store, 87% of hot entries had no lastRetrievedAt at all — so for seven
// entries in eight, lastAccessed IS the decay clock.
//
// The loader used to stamp lastAccessed on every loaded entry, including entries that
// merely rode in on the recency fallback. That made those entries immortal: loaded as
// filler, clock reset, therefore still available as filler. 8,320 hot against 420
// cold, with 4,242 entries that had never been summoned and never been used and still
// could not age out.
//
// THE BUG WAS SILENT IN EVERY DIRECTION, which is why these tests exist. Nothing
// failed when the behaviour was wrong and nothing failed when it was fixed — the
// whole suite passed either way, because no test had ever pinned who is allowed to
// touch the clock. The assertions below are deliberately about WHICH FIELD MOVED,
// not about any tier outcome, since the tier outcome is 90 days downstream of it.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  upsertIndexEntry,
  writeEntry,
  readIndex,
  type IndexEntry,
} from "../storage.js";
import { awaitPendingCredit, loadContext } from "../loader.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-decay-"));
  process.env.MARINARA_EXTENDER_DATA = dir;
});
afterEach(async () => {
  await awaitPendingCredit();
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true });
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function seed(
  characterId: string,
  id: string,
  summary: string,
  body: string,
  over: Partial<IndexEntry> = {},
) {
  await writeEntry("character", characterId, {
    id, lane: "character_topics", summary, content: body,
    status: "open", created: daysAgo(80), lastAccessed: daysAgo(80), tokens: 20,
  } as never);
  await upsertIndexEntry("character", characterId, {
    id, path: `char-topics/${id}.yaml`, summary,
    tokens: 20, lane: "character_topics", status: "open",
    lastAccessed: daysAgo(80),
    ...over,
  });
}

const rowFor = async (characterId: string, id: string) =>
  (await readIndex("character", characterId))!.entries.find((e) => e.id === id)!;

describe("gwny — only a SUMMONED entry may refresh the decay clock", () => {
  it("leaves lastAccessed alone on an entry that merely rode along", async () => {
    // Two entries, one of which the conversation is plainly about. The other is
    // present in the same index and gets loaded as recency filler.
    const ch = "c-filler";
    await seed(ch, "ctopic-relevant", "The Hargrove case verdict", "Details of the Hargrove case verdict.");
    await seed(ch, "ctopic-filler", "Kayaking on the lake in June", "A morning spent kayaking.");

    await loadContext({
      characterId: ch, chatId: "chat-1", turnNumber: 1,
      recentText: "what finally happened with the hargrove case verdict?",
    });
    await awaitPendingCredit();

    const filler = await rowFor(ch, "ctopic-filler");
    // THE ASSERTION THE BUG WOULD HAVE FAILED: an entry nobody asked for keeps its
    // original date, so it continues ageing toward cold.
    expect(filler.lastAccessed).toBe(daysAgo(80));
    expect(filler.retrievalCount ?? 0).toBe(0);
  });

  it("refreshes lastAccessed and credits the entry the conversation summoned", async () => {
    const ch = "c-summoned";
    await seed(ch, "ctopic-relevant", "The Hargrove case verdict", "Details of the Hargrove case verdict.");
    await seed(ch, "ctopic-filler", "Kayaking on the lake in June", "A morning spent kayaking.");

    const res = await loadContext({
      characterId: ch, chatId: "chat-2", turnNumber: 1,
      recentText: "what finally happened with the hargrove case verdict?",
    });
    await awaitPendingCredit();

    // Guard the premise: if nothing was surfaced, the test below proves nothing.
    expect(res.surfaced.some((s) => s.id === "ctopic-relevant")).toBe(true);

    const relevant = await rowFor(ch, "ctopic-relevant");
    expect(relevant.lastAccessed).toBe(daysAgo(0));
    expect(relevant.retrievalCount ?? 0).toBeGreaterThan(0);
  });

  it("never writes lastRetrievedAt from the loader, summoned or not", async () => {
    // Being loaded is not being used. lastRetrievedAt stays recordRecitation's to
    // write — if the loader ever stamps it, the honest-use signal is lost and the
    // clock becomes untrustworthy in the other direction.
    const ch = "c-noretr";
    await seed(ch, "ctopic-relevant", "The Hargrove case verdict", "Details of the Hargrove case verdict.");
    await seed(ch, "ctopic-filler", "Kayaking on the lake in June", "A morning spent kayaking.");

    await loadContext({
      characterId: ch, chatId: "chat-3", turnNumber: 1,
      recentText: "what finally happened with the hargrove case verdict?",
    });
    await awaitPendingCredit();

    for (const id of ["ctopic-relevant", "ctopic-filler"]) {
      expect((await rowFor(ch, id)).lastRetrievedAt).toBeUndefined();
    }
  });

  it("does not resurrect an already-stale entry by loading it repeatedly", async () => {
    // The self-sustaining loop, reproduced: an entry that is nearly cold-eligible
    // must not be pushed back from the edge just by being in the room several turns
    // running. This is the shape that produced 48.7% of the live store massed in the
    // 60-90 day band.
    const ch = "c-loop";
    await seed(ch, "ctopic-relevant", "The Hargrove case verdict", "Details of the Hargrove case verdict.");
    await seed(ch, "ctopic-old", "Kayaking on the lake in June", "A morning spent kayaking.", {
      lastAccessed: daysAgo(89),
    });

    for (let turn = 1; turn <= 3; turn++) {
      await loadContext({
        characterId: ch, chatId: "chat-4", turnNumber: turn,
        recentText: "what finally happened with the hargrove case verdict?",
      });
      await awaitPendingCredit();
    }

    expect((await rowFor(ch, "ctopic-old")).lastAccessed).toBe(daysAgo(89));
  });
});
