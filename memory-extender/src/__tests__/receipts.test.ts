// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Retrieval receipts (MarinaraExtender-sph8): every turn records what it chose
// AND what it rejected, so "why didn't it remember X?" stops being answered by
// hand-grepping the store. The cases below are the ones that actually get asked.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { upsertIndexEntry, writeEntry, type IndexEntry, type Entry } from "../storage.js";
import { loadContext } from "../loader.js";
import { capRejections, confirmInjection, hashBlock, readReceipt, type RejectedCandidate } from "../receipts.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-receipt-"));
  process.env.MARINARA_EXTENDER_DATA = dir;
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  delete process.env.MARINARA_EXTENDER_BUDGET_CHARACTER;
  await rm(dir, { recursive: true, force: true });
});

const today = new Date().toISOString().slice(0, 10);

function row(id: string, over: Partial<IndexEntry> = {}): IndexEntry {
  return {
    id, path: `char-topics/${id}.yaml`, summary: `summary for ${id}`,
    tokens: 20, lane: "character_topics", lastAccessed: today,
    ...over,
  };
}

// writeEntry derives its own relative path from the lane, so the index row's
// `path` must agree with it or loadSelectedEntries reads a file that isn't there.
async function seed(charId: string, r: IndexEntry, body = "body text"): Promise<void> {
  const relative = await writeEntry("character", charId, {
    id: r.id, summary: r.summary, content: body, lane: r.lane,
  } as unknown as Entry);
  await upsertIndexEntry("character", charId, { ...r, path: relative });
}

describe("rejection reasons", () => {
  it("records each exclusion under its own reason, one reason per row", async () => {
    const c = "char-reasons";
    await seed(c, row("kept"));
    await seed(c, row("done-row", { status: "done" }));
    await seed(c, row("superseded-row", { supersededBy: "kept" }));
    await seed(c, row("outline-row", { provenance: "unplayed" }));

    const { receipt } = await loadContext({ characterId: c, chatId: "chat-r", turnNumber: 1, recentText: "" });
    const byId = new Map(receipt.rejected.map((r) => [r.id, r.rejection]));

    expect(byId.get("done-row")).toBe("resolved");
    expect(byId.get("superseded-row")).toBe("superseded");
    expect(byId.get("outline-row")).toBe("unplayed");
    expect(byId.has("kept")).toBe(false);
    expect(receipt.selected.map((s) => s.id)).toContain("kept");
  });

  it("a row with two disqualifiers is counted once, under the first", async () => {
    // Reasons are a closed set meant to be TALLIED. One row contributing to two
    // counts would make every count wrong, so precedence must be exclusive.
    const c = "char-double";
    await seed(c, row("both", { status: "done", supersededBy: "x" }));
    const { receipt } = await loadContext({ characterId: c, chatId: "chat-d", turnNumber: 1, recentText: "" });
    const hits = receipt.rejected.filter((r) => r.id === "both");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.rejection).toBe("resolved");
  });

  it("records budget_exhausted for a stored entry that simply did not fit", async () => {
    // The case that used to vanish without trace, and the one most often
    // misfiled as "it was never captured".
    process.env.MARINARA_EXTENDER_BUDGET_CHARACTER = "30";
    const c = "char-budget";
    await seed(c, row("fits", { tokens: 25, summary: "the hargrove verdict landed" }));
    await seed(c, row("crowded-out", { tokens: 25, summary: "unrelated kitchen renovation" }));

    const { receipt } = await loadContext({
      characterId: c, chatId: "chat-b", turnNumber: 1, recentText: "what happened with the hargrove verdict?",
    });

    expect(receipt.selected.map((s) => s.id)).toEqual(["fits"]);
    const loser = receipt.rejected.find((r) => r.id === "crowded-out");
    expect(loser?.rejection).toBe("budget_exhausted");
    // Present in the store, present in the receipt: provably a retrieval miss,
    // not a capture gap. That distinction is the whole feature.
    expect(loser).toBeDefined();
  });
});

describe("selection reasons", () => {
  it("distinguishes a topical match from a recency rider", async () => {
    const c = "char-why";
    await seed(c, row("matched", { summary: "the hargrove verdict landed badly" }));
    await seed(c, row("rider", { summary: "unrelated kitchen renovation" }));

    const { receipt } = await loadContext({
      characterId: c, chatId: "chat-w", turnNumber: 1, recentText: "tell me about the hargrove verdict",
    });
    const byId = new Map(receipt.selected.map((s) => [s.id, s]));

    expect(byId.get("matched")!.reasons).toContain("own_match");
    expect(byId.get("matched")!.relevance).toBeGreaterThan(0);
    expect(byId.get("rider")!.reasons).toEqual(["recency_rider"]);
    expect(byId.get("rider")!.relevance).toBe(0);
  });

  it("credits thread_sibling when a beat rode in on a sibling's match", async () => {
    const c = "char-thread";
    await seed(c, row("direct", { summary: "the porsche test drive on the coast road", threadId: "t1" }));
    await seed(c, row("sibling", { summary: "he mentioned the dealership called back", threadId: "t1" }));

    const { receipt } = await loadContext({
      characterId: c, chatId: "chat-t", turnNumber: 1, recentText: "remember the porsche test drive?",
    });
    const sibling = receipt.selected.find((s) => s.id === "sibling");

    expect(sibling?.reasons).toContain("thread_sibling");
    // It did not match on its own words — that is precisely what makes the
    // reason worth recording rather than inferring from the score.
    expect(sibling?.reasons).not.toContain("own_match");
  });
});

describe("receipt persistence and injection confirmation", () => {
  it("writes the receipt to disk with a hash of the assembled block", async () => {
    const c = "char-persist";
    await seed(c, row("e1"));
    const { contextBlock, receipt } = await loadContext({
      characterId: c, chatId: "chat-p", turnNumber: 4, recentText: "anything",
    });

    const onDisk = await readReceipt("chat-p");
    expect(onDisk).not.toBeNull();
    expect(onDisk!.turnNumber).toBe(4);
    expect(onDisk!.injection.hash).toBe(hashBlock(contextBlock));
    expect(onDisk!.injection.status).toBe("pending");
    expect(onDisk!.scopes.map((s) => s.scope).sort()).toEqual(["character", "chat", "global"]);
    expect(receipt.injection.hash).toBe(onDisk!.injection.hash);
  });

  it("confirms a matching block and flags a divergent one", async () => {
    const c = "char-confirm";
    await seed(c, row("e1"));
    const { contextBlock } = await loadContext({
      characterId: c, chatId: "chat-c", turnNumber: 1, recentText: "anything",
    });

    expect(await confirmInjection("chat-c", contextBlock)).toBe("confirmed");
    expect((await readReceipt("chat-c"))!.injection.status).toBe("confirmed");

    // A truncated or stale block downstream must read as a mismatch, not as a
    // quiet success — otherwise a broken injection looks like a retrieval miss.
    expect(await confirmInjection("chat-c", `${contextBlock} tampered`)).toBe("mismatch");
    const after = await readReceipt("chat-c");
    expect(after!.injection.status).toBe("mismatch");
    expect(after!.injection.foundHash).toBe(hashBlock(`${contextBlock} tampered`));
  });

  it("treats a missing block as a mismatch rather than a pass", async () => {
    const c = "char-missing";
    await seed(c, row("e1"));
    await loadContext({ characterId: c, chatId: "chat-m", turnNumber: 1, recentText: "anything" });
    expect(await confirmInjection("chat-m", null)).toBe("mismatch");
  });
});

describe("capRejections", () => {
  const cand = (id: string, relevance: number): RejectedCandidate => ({
    id, scope: "character", summary: id, tokens: 10, relevance, rejection: "budget_exhausted",
  });

  it("keeps the highest-relevance rejections and admits the truncation", () => {
    const input = [cand("low", 0), cand("high", 0.9), cand("mid", 0.5)];
    const { rejected, truncated } = capRejections(input, 2);
    expect(rejected.map((r) => r.id)).toEqual(["high", "mid"]);
    expect(truncated).toBe(true);
  });

  it("does not report truncation when everything fits", () => {
    const { rejected, truncated } = capRejections([cand("a", 0.1)], 2);
    expect(rejected).toHaveLength(1);
    expect(truncated).toBe(false);
  });
});
