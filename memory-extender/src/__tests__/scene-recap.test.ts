// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Recap-layer FLOOR (MarinaraExtender-2cu): scene-conclude summaries become
// scene arcs + retrievable recap entries; member beats cite as footnotes;
// the scene's threads close (pln unit-archival then ages members together);
// ingestion is idempotent per (character, scene).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ingestSceneRecap, readArcs, readArcMemberships } from "../arcs.js";
import { writeBeat, readBeatIndex } from "../sentiment/encoder.js";
import { readIndex } from "../storage.js";
import { resolveOrMintThread, listActiveThreads } from "../threads.js";
import { loadContext } from "../loader.js";
import type { EmotionalBeat } from "../sentiment/types.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-recap-"));
  process.env.MARINARA_EXTENDER_DATA = join(dir, "data");
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function beat(id: string, over: Partial<EmotionalBeat> = {}): EmotionalBeat {
  return {
    id, speaker: "Priya", emotion: "joy", text: `text of ${id}`,
    motivation: "m", relationalDynamics: "r", outcome: "o",
    salience: 0.5, turnStart: 1, turnEnd: 1, created: "2026-06-01",
    sourceType: "chat", ...over,
  };
}

const SCENE = "chat-scene-1";

describe("ingestSceneRecap", () => {
  it("mints a scene arc, writes a retrievable recap, cites footnotes, closes threads", async () => {
    const t = await resolveOrMintThread(SCENE, "test drive", "priya");
    await writeBeat("priya", beat("beat-a", { threadId: t!.id, salience: 0.9 }));
    await writeBeat("priya", beat("beat-b", { sourceChatId: SCENE, salience: 0.4 }));
    await writeBeat("priya", beat("beat-x", { sourceChatId: "other-chat" })); // not a member

    const r = await ingestSceneRecap({
      identityKey: "priya",
      summary: "Priya and Mari took the Porsche out; trust deepened over the hour they spent together.",
      sceneChatId: SCENE,
      sceneName: "Scene: Test Drive",
      concludedAt: "2026-06-11T23:00:00.000Z",
    });
    expect(r).not.toBeNull();
    expect(r!.alreadyIngested).toBe(false);
    expect(r!.footnotes).toBe(2);
    expect(r!.threadsClosed).toBe(1);

    // Arc + memberships persisted; watermark covers the members' seqs.
    const arcs = (await readArcs("priya")).arcs;
    expect(arcs).toHaveLength(1);
    expect(arcs[0]!.kind).toBe("scene");
    expect(arcs[0]!.status).toBe("resolved");
    expect(arcs[0]!.label).toBe("Test Drive");
    const beatIdx = await readBeatIndex("priya");
    const maxSeq = Math.max(...beatIdx!.entries.filter((b) => b.id !== "beat-x").map((b) => b.seq ?? 0));
    expect(arcs[0]!.watermark.coveredThroughSeq).toBe(maxSeq);
    const members = await readArcMemberships("priya");
    expect(members.map((m) => m.beatId).sort()).toEqual(["beat-a", "beat-b"]);

    // The recap is a hot-index entry the loader can surface.
    const hot = (await readIndex("character", "priya"))!;
    const row = hot.entries.find((e) => e.id === r!.entryId)!;
    expect(row.summary).toContain("[scene recap] Test Drive");
    const res = await loadContext({
      characterId: "priya", chatId: "chat-now", turnNumber: 1,
      recentText: "remember the porsche and how trust deepened?",
    });
    expect(res.surfaced.some((s) => s.id === r!.entryId)).toBe(true);

    // The scene's thread is closed.
    expect(await listActiveThreads(SCENE)).toHaveLength(0);
  });

  it("is idempotent per (character, scene)", async () => {
    const input = {
      identityKey: "priya",
      summary: "A summary long enough to pass the minimum ingestion length check.",
      sceneChatId: SCENE,
      sceneName: "Scene: Once",
    };
    const first = await ingestSceneRecap(input);
    const second = await ingestSceneRecap(input);
    expect(second!.alreadyIngested).toBe(true);
    expect(second!.arcId).toBe(first!.arcId);
    expect((await readArcs("priya")).arcs).toHaveLength(1);
    const hot = (await readIndex("character", "priya"))!;
    expect(hot.entries.filter((e) => e.summary.includes("[scene recap]"))).toHaveLength(1);
  });

  it("ingests without chat linkage (no footnotes, keyed by summary)", async () => {
    const r = await ingestSceneRecap({
      identityKey: "priya",
      summary: "An orphan summary with no scene chat id but plenty of length to ingest.",
    });
    expect(r).not.toBeNull();
    expect(r!.footnotes).toBe(0);
    const again = await ingestSceneRecap({
      identityKey: "priya",
      summary: "An orphan summary with no scene chat id but plenty of length to ingest.",
    });
    expect(again!.alreadyIngested).toBe(true);
  });

  it("rejects blank/too-short summaries", async () => {
    expect(await ingestSceneRecap({ identityKey: "priya", summary: "  " })).toBeNull();
    expect(await ingestSceneRecap({ identityKey: "priya", summary: "too short" })).toBeNull();
  });
});
