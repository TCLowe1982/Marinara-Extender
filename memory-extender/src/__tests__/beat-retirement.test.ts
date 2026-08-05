// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Beat retirement — mark, never delete (s8qe).
//
// The sub-floor retirement removed 517 beats whose chunk text was a bare token
// ("open", from a `status: open` line parsed as dialogue). Unlike the 0y2i echo
// cleanup, which retired entries and KEPT beats because the beat still tracked
// real text, these had nothing underneath — so beats retire too.
//
// THE TEST THAT MATTERS MOST is the resurrection guard. /api/beats-to-entries
// rebuilds companion ledger entries FROM the beat store. If a retired beat is
// visible to that read, running the endpoint silently recreates the entry the
// retirement just removed, and the cleanup undoes itself with no error anywhere.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { writeBeat, readBeat, readBeatIndex, readAllBeats, retireBeats } from "../sentiment/encoder.js";
import { recordStatsEvent, readStatsEvents } from "../stats-events.js";
import type { EmotionalBeat } from "../sentiment/types.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-retire-"));
  process.env.MARINARA_EXTENDER_DATA = join(dir, "data");
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function beat(id: string, over: Partial<EmotionalBeat> = {}): EmotionalBeat {
  return {
    id, speaker: "Mari", emotion: "vulnerability", text: `text of ${id}`,
    motivation: "m", relationalDynamics: "r", outcome: "o",
    salience: 0.6, turnStart: 1, turnEnd: 1, created: "2026-06-03",
    sourceType: "chat", ...over,
  };
}

const REASON = "sub-floor chunk — no analysable content (s8qe)";

describe("retireBeats", () => {
  it("marks without deleting — the beat and its index row both survive", async () => {
    await writeBeat("mari", beat("beat-open", { text: "open" }));
    await writeBeat("mari", beat("beat-real", { text: "I love you," }));

    const marked = await retireBeats("mari", ["beat-open"], REASON);
    expect(marked).toEqual(["beat-open"]);

    // Still on disk, at full fidelity, saying why.
    const stored = await readBeat("mari", "beat-open");
    expect(stored).not.toBeNull();
    expect(stored!.text).toBe("open");
    expect(stored!.retiredReason).toBe(REASON);
    expect(stored!.retiredAt).toBeTruthy();

    // The index row carries the mark too, so a consumer reading only the index
    // can honour it without opening every beat file.
    const idx = await readBeatIndex("mari");
    expect(idx!.entries).toHaveLength(2);
    const row = idx!.entries.find((e) => e.id === "beat-open")!;
    expect(row.retiredAt).toBeTruthy();
    expect(row.retiredReason).toBe(REASON);
  });

  it("excludes retired beats from readAllBeats — the resurrection guard", async () => {
    // /api/beats-to-entries rebuilds entries from exactly this list.
    await writeBeat("mari", beat("beat-open", { text: "open" }));
    await writeBeat("mari", beat("beat-real", { text: "I love you," }));
    await retireBeats("mari", ["beat-open"], REASON);

    const live = await readAllBeats("mari");
    expect(live.map((b) => b.id)).toEqual(["beat-real"]);
  });

  it("includeRetired returns them, so audits and historical curves can see what went", async () => {
    await writeBeat("mari", beat("beat-open", { text: "open" }));
    await retireBeats("mari", ["beat-open"], REASON);

    const all = await readAllBeats("mari", { includeRetired: true });
    expect(all.map((b) => b.id)).toEqual(["beat-open"]);
    expect(all[0]!.retiredReason).toBe(REASON);
  });

  it("is idempotent and never re-stamps an earlier retirement with a later date", async () => {
    await writeBeat("mari", beat("beat-open", { text: "open" }));
    const first = await retireBeats("mari", ["beat-open"], REASON);
    const firstAt = (await readBeat("mari", "beat-open"))!.retiredAt;

    const second = await retireBeats("mari", ["beat-open"], "a different reason");
    expect(second).toEqual([]);   // nothing newly marked

    const stored = await readBeat("mari", "beat-open");
    expect(stored!.retiredAt).toBe(firstAt);       // history not rewritten
    expect(stored!.retiredReason).toBe(REASON);    // original reason preserved
    expect(first).toEqual(["beat-open"]);
  });

  it("leaves unrelated beats untouched", async () => {
    await writeBeat("mari", beat("beat-a"));
    await writeBeat("mari", beat("beat-b"));
    await retireBeats("mari", ["beat-a"], REASON);

    const b = await readBeat("mari", "beat-b");
    expect(b!.retiredAt).toBeUndefined();
    expect(b!.retiredReason).toBeUndefined();
  });

  it("tolerates ids that do not exist without throwing or marking anything else", async () => {
    await writeBeat("mari", beat("beat-a"));
    const marked = await retireBeats("mari", ["beat-nope"], REASON);
    expect(marked).toEqual([]);
    expect((await readBeat("mari", "beat-a"))!.retiredAt).toBeUndefined();
  });
});

describe("stats events", () => {
  it("records a bulk change so a later curve cannot mistake it for a trend", async () => {
    const ev = await recordStatsEvent({
      kind: "retirement",
      issue: "MarinaraExtender-s8qe",
      reason: "sub-floor beats",
      selector: "meetsContentFloor(beat.text, 2) === false",
      counts: { beats: 517, entries: 12 },
      affectsHistoricalCurves: true,
    });
    expect(ev.id).toMatch(/^stev-/);
    expect(ev.at).toBeTruthy();

    const all = await readStatsEvents();
    expect(all).toHaveLength(1);
    expect(all[0]!.counts).toEqual({ beats: 517, entries: 12 });
    expect(all[0]!.affectsHistoricalCurves).toBe(true);
  });

  it("appends rather than replaces — the record must outlive what it records", async () => {
    await recordStatsEvent({ kind: "retirement", reason: "first" });
    await recordStatsEvent({ kind: "correction", reason: "second" });
    const all = await readStatsEvents();
    expect(all.map((e) => e.reason)).toEqual(["first", "second"]);
  });

  it("returns empty when nothing has ever been recorded, rather than throwing", async () => {
    expect(await readStatsEvents()).toEqual([]);
  });
});
