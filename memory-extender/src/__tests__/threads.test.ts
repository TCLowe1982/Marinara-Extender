// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Narrative thread registry (MarinaraExtender-pln). Threads are minted at
// ingest from analyzer-proposed labels; resolution must absorb label drift
// within a chat, never match across chats, and never double-mint under
// concurrent turns.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveOrMintThread,
  listActiveThreads,
  closeThread,
  readThreadRegistry,
  relabelThread,
  looksCastList,
  threadRegistryHealth,
} from "../threads.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-threads-"));
  process.env.MARINARA_EXTENDER_DATA = join(dir, "data");
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true });
});

describe("resolveOrMintThread", () => {
  it("mints a new thread and records the participant", async () => {
    const r = await resolveOrMintThread("chat-1", "Porsche test drive", "k6cq");
    expect(r).not.toBeNull();
    expect(r!.isNew).toBe(true);
    expect(r!.id).toMatch(/^nthr-/);
    const threads = await listActiveThreads("chat-1");
    expect(threads).toHaveLength(1);
    expect(threads[0]!.participants).toEqual(["k6cq"]);
    expect(threads[0]!.beatCount).toBe(1);
  });

  it("resolves drifted labels to the same thread instead of minting", async () => {
    const a = await resolveOrMintThread("chat-1", "Porsche test drive", "mari");
    const b = await resolveOrMintThread("chat-1", "the Porsche test drive", "k6cq"); // containment
    const c = await resolveOrMintThread("chat-1", "Porsche test drvie", "user");     // typo (jaro-winkler)
    expect(b!.id).toBe(a!.id);
    expect(c!.id).toBe(a!.id);
    const threads = await listActiveThreads("chat-1");
    expect(threads).toHaveLength(1);
    expect(threads[0]!.beatCount).toBe(3);
    expect(threads[0]!.participants.sort()).toEqual(["k6cq", "mari", "user"]);
  });

  it("never matches threads across chats", async () => {
    const a = await resolveOrMintThread("chat-1", "Porsche test drive", "mari");
    const b = await resolveOrMintThread("chat-2", "Porsche test drive", "mari");
    expect(b!.id).not.toBe(a!.id);
  });

  it("mints distinct threads for genuinely different labels", async () => {
    const a = await resolveOrMintThread("chat-1", "Porsche test drive", "mari");
    const b = await resolveOrMintThread("chat-1", "Hargrove investigation", "mari");
    expect(b!.id).not.toBe(a!.id);
    expect(await listActiveThreads("chat-1")).toHaveLength(2);
  });

  it("does not double-mint under concurrent resolution of the same label", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => resolveOrMintThread("chat-1", "Porsche test drive", "mari")),
    );
    const ids = new Set(results.map((r) => r!.id));
    expect(ids.size).toBe(1);
    expect((await readThreadRegistry()).threads).toHaveLength(1);
  });

  it("returns null for blank labels", async () => {
    expect(await resolveOrMintThread("chat-1", "   ", "mari")).toBeNull();
  });
});

describe("registry health (rfx)", () => {
  const names = ["Dr. Mari Zielińska", "Dr. Priya Chandrasekaran", "Aurora", "Professor Mari"];

  it("looksCastList flags participant-only labels and passes event labels", () => {
    expect(looksCastList("professor mari and priya", names)).toBe(true);
    expect(looksCastList("mari", names)).toBe(true);
    expect(looksCastList("Porsche test drive", names)).toBe(false);
    expect(looksCastList("jurisprudence soft launch", names)).toBe(false);
    expect(looksCastList("mari confronts the provost", names)).toBe(false); // event words save it
  });

  it("threadRegistryHealth reports counts, fragmentation, and suspects", async () => {
    const a = await resolveOrMintThread("chat-1", "Porsche test drive", "mari");
    await resolveOrMintThread("chat-1", "Porsche test drive", "k6cq"); // second beat, same thread
    await resolveOrMintThread("chat-2", "professor mari and priya", "mari"); // 1-beat suspect
    const h = await threadRegistryHealth(names);
    expect(h.total).toBe(2);
    expect(h.threadsPerChat["chat-1"]).toBe(1);
    expect(h.singleBeatThreads).toBe(1);
    expect(h.castListSuspects.map((s) => s.label)).toEqual(["professor mari and priya"]);
    expect(a).not.toBeNull();
  });

  it("relabelThread renames without touching the id; sanitizes identifiers", async () => {
    const t = await resolveOrMintThread("chat-1", "professor_mari_and_priya", "mari");
    expect(await relabelThread(t!.id, "jurisprudence soft launch")).toBe(true);
    const reg = await readThreadRegistry();
    const row = reg.threads.find((x) => x.id === t!.id)!;
    expect(row.label).toBe("jurisprudence soft launch");
    expect(await relabelThread("nthr-missing", "x")).toBe(false);
  });
});

describe("closeThread", () => {
  it("closed threads leave the active roster and do not absorb new labels", async () => {
    const a = await resolveOrMintThread("chat-1", "Porsche test drive", "mari");
    expect(await closeThread(a!.id)).toBe(true);
    expect(await listActiveThreads("chat-1")).toHaveLength(0);
    // Same label after close mints a fresh thread (a new arc revisiting the topic).
    const b = await resolveOrMintThread("chat-1", "Porsche test drive", "mari");
    expect(b!.id).not.toBe(a!.id);
  });
});
