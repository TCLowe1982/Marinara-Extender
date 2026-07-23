// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Detected turn -> ingestion -> lorebook (epic hq7 integration).
//
// The behaviours worth pinning are the refusals: this runs on a timer against
// live memory, so the expensive or destructive paths must not fire on junk
// input, and one bad turn must never stop the loop.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleDetectedTurn, characterNameFor, _resetCharacterCache } from "../turn-bridge.js";
import { _resetChains } from "../lorebook-writer.js";
import type { DetectedTurn } from "../poller.js";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.MARINARA_EXTENDER_ENGINE_URL = "http://engine.test:7860";
  process.env.MARINARA_EXTENDER_PORT = "3001";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  _resetCharacterCache();
  _resetChains();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.MARINARA_EXTENDER_ENGINE_URL;
  delete process.env.MARINARA_EXTENDER_PORT;
});

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

const turn = (over: Partial<DetectedTurn> = {}): DetectedTurn => ({
  chatId: "chat1",
  chatName: "Priya",
  characterId: "char1",
  message: { id: "m2", role: "assistant", content: "the reply text" },
  regenerated: false,
  precedingUserText: "the user line",
  participantIds: ["char1"],
  ...over,
});

/** Stub the sidecar + engine surfaces a full happy path touches. */
function happyPath(memoryBlock = "instr\n\n<memory>\n- fact\n</memory>") {
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    if (/:3001\/api\/process-turn$/.test(url)) return Promise.resolve(json({ memoryBlock }));
    if (/\/api\/characters$/.test(url)) return Promise.resolve(json([{ id: "char1", name: "Dr. Priya" }]));
    if (/\/api\/lorebooks$/.test(url) && method === "GET") return Promise.resolve(json([]));
    if (/\/api\/lorebooks$/.test(url) && method === "POST") return Promise.resolve(json({ id: "lb1" }));
    if (/\/entries$/.test(url) && method === "GET") return Promise.resolve(json([]));
    if (/\/entries$/.test(url) && method === "POST") return Promise.resolve(json({ id: "e" }));
    return Promise.resolve(json({}));
  });
}

const callsTo = (re: RegExp) => fetchMock.mock.calls.filter(([u]) => re.test(u as string));

describe("characterNameFor", () => {
  it("resolves a name and caches it across calls", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json([{ id: "char1", name: "Dr. Priya" }])));
    await expect(characterNameFor("char1")).resolves.toBe("Dr. Priya");
    await expect(characterNameFor("char1")).resolves.toBe("Dr. Priya");
    // One engine round-trip, not one per turn.
    expect(callsTo(/\/characters$/)).toHaveLength(1);
  });

  it("refreshes on a miss so a newly-created character is still found", async () => {
    let names = [{ id: "char1", name: "Dr. Priya" }];
    fetchMock.mockImplementation(() => Promise.resolve(json(names)));
    await characterNameFor("char1");
    names = [...names, { id: "char2", name: "New Face" }];
    await expect(characterNameFor("char2")).resolves.toBe("New Face");
  });

  it("returns null rather than throwing when the engine is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(characterNameFor("char1")).resolves.toBeNull();
  });
});

describe("handleDetectedTurn — refusals", () => {
  it("skips a turn with no characterId", async () => {
    happyPath();
    const r = await handleDetectedTurn(turn({ characterId: null }));
    expect(r.ingested).toBe(false);
    expect(r.skippedReason).toMatch(/characterId/);
    expect(callsTo(/process-turn/)).toHaveLength(0);
  });

  it("skips an empty assistant message without running ingestion", async () => {
    // An empty reply has nothing to remember but would still cost a full
    // analysis pass and a lorebook rewrite.
    happyPath();
    const r = await handleDetectedTurn(turn({ message: { id: "m2", role: "assistant", content: "   " } }));
    expect(r.ingested).toBe(false);
    expect(callsTo(/process-turn/)).toHaveLength(0);
    expect(callsTo(/lorebooks/)).toHaveLength(0);
  });

  it("does NOT touch the lorebook when ingestion returns no memory block", async () => {
    // Writing an empty block would wipe a populated lorebook — the failure
    // would look like "memory suddenly forgot everything".
    happyPath("");
    const r = await handleDetectedTurn(turn());
    expect(r.ingested).toBe(true);
    expect(r.lorebookId).toBeNull();
    expect(callsTo(/lorebooks/)).toHaveLength(0);
  });

  it("does not write the lorebook when ingestion fails", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (/process-turn$/.test(url)) return Promise.resolve(json({ error: "boom" }, 500));
      if (/\/characters$/.test(url)) return Promise.resolve(json([{ id: "char1", name: "Dr. Priya" }]));
      return Promise.resolve(json({}));
    });
    const r = await handleDetectedTurn(turn());
    expect(r.ingested).toBe(false);
    expect(callsTo(/lorebooks/)).toHaveLength(0);
  });

  it("never throws — the poller loop must survive a bad turn", async () => {
    fetchMock.mockRejectedValue(new Error("everything is down"));
    await expect(handleDetectedTurn(turn())).resolves.toMatchObject({ ingested: false });
  });
});

describe("handleDetectedTurn — happy path", () => {
  it("passes both halves of the turn to ingestion", async () => {
    happyPath();
    await handleDetectedTurn(turn());
    const body = JSON.parse(callsTo(/process-turn/)[0][1].body as string);
    expect(body).toMatchObject({
      characterId: "char1",
      chatId: "chat1",
      messageText: "the reply text",
      // The assistant text alone is only half the turn.
      userMessageText: "the user line",
      sceneTitle: "Priya",
      participantIds: ["char1"],
    });
  });

  it("resolves and forwards the character name", async () => {
    happyPath();
    await handleDetectedTurn(turn());
    const body = JSON.parse(callsTo(/process-turn/)[0][1].body as string);
    expect(body.characterName).toBe("Dr. Priya");
  });

  it("writes the returned memory block to the character's lorebook", async () => {
    happyPath();
    const r = await handleDetectedTurn(turn());
    expect(r).toMatchObject({ ingested: true, lorebookId: "lb1" });

    const entryPosts = callsTo(/\/entries$/).filter(([, i]) => (i as { method?: string })?.method === "POST");
    expect(entryPosts).toHaveLength(2);
    const contents = entryPosts.map(([, i]) => JSON.parse((i as { body: string }).body).content);
    expect(contents.some((c: string) => c.includes("- fact"))).toBe(true);
  });

  it("handles a regenerated turn the same way (supersede, not duplicate)", async () => {
    happyPath();
    const r = await handleDetectedTurn(turn({ regenerated: true }));
    expect(r).toMatchObject({ ingested: true, lorebookId: "lb1" });
  });

  it("forwards every participant of a group scene", async () => {
    happyPath();
    await handleDetectedTurn(turn({ participantIds: ["char1", "char2", "char3"] }));
    const body = JSON.parse(callsTo(/process-turn/)[0][1].body as string);
    expect(body.participantIds).toEqual(["char1", "char2", "char3"]);
  });
});
