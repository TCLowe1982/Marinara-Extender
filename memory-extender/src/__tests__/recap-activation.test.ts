// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Recap activation (cz3 Stage 2): recaps are surfaced by semantic closeness of
// their PROSE to the recent conversation, not just lexical label overlap.
// Embeddings are mocked to deterministic basis vectors keyed by a marker word, so
// the test exercises the cosine ranking / threshold / lazy cache — not Ollama.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../embeddings.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../embeddings.js")>();
  const vec = (t: string): number[] =>
    /porsche/i.test(t) ? [1, 0, 0] : /library/i.test(t) ? [0, 1, 0] : [0, 0, 1];
  return { ...real, fetchEmbeddings: vi.fn(async (texts: string[]) => texts.map(vec)) };
});

import { writeEntry } from "../storage.js";
import { activateRecaps } from "../recap-activation.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "me-recapact-")); process.env.MARINARA_EXTENDER_DATA = join(dir, "data"); });
afterEach(async () => { delete process.env.MARINARA_EXTENDER_DATA; await rm(dir, { recursive: true, force: true }); });

async function recap(id: string, content: string): Promise<{ id: string; path: string }> {
  const path = await writeEntry("character", "mari", {
    id, kind: "recap", arcId: `arc-${id}`, lane: "character_topics",
    summary: `[scene recap] ${id}`, status: "open", created: "2026-06-01",
    lastAccessed: "2026-06-01", content, tokens: 10, footnoteBeatIds: [],
  } as never);
  return { id, path };
}

describe("activateRecaps", () => {
  it("surfaces the recap whose prose embeds closest to the moment", async () => {
    const a = await recap("r-porsche", "They took the Porsche out and trust deepened over the hour.");
    const b = await recap("r-library", "A quiet afternoon in the library with old casebooks.");
    const got = await activateRecaps("mari", [a, b], "remember the porsche?");
    expect(got.has("r-porsche")).toBe(true);
    expect(got.has("r-library")).toBe(false);
  });

  it("caches recap embeddings (second call needs no re-embed)", async () => {
    const mod = await import("../embeddings.js");
    const a = await recap("r-porsche", "The Porsche again.");
    await activateRecaps("mari", [a], "porsche");
    const callsAfterFirst = (mod.fetchEmbeddings as ReturnType<typeof vi.fn>).mock.calls.length;
    await activateRecaps("mari", [a], "porsche");
    const callsAfterSecond = (mod.fetchEmbeddings as ReturnType<typeof vi.fn>).mock.calls.length;
    // Second call embeds only the query (1 call), not the already-cached recap.
    expect(callsAfterSecond - callsAfterFirst).toBe(1);
  });

  it("returns nothing for an empty query or no recaps", async () => {
    expect((await activateRecaps("mari", [], "porsche")).size).toBe(0);
    const a = await recap("r-x", "content");
    expect((await activateRecaps("mari", [a], "   ")).size).toBe(0);
  });
});
