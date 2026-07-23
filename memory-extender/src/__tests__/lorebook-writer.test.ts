// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Lorebook write-back (MarinaraExtender-lxp, epic hq7) — the extension's
// ensureLorebook / writeMemoryToLorebook cycle ported server-side.
//
// The behaviours pinned hardest here are the ones that caused real, silent
// production failures: the forced token budget (e87), unlock-before-delete
// (stale entries surviving a write), and per-character serialization (axu).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  splitMemoryBlock,
  lorebookNameFor,
  ensureLorebook,
  writeMemoryToLorebook,
  syncMemoryToLorebook,
  _resetChains,
  ME_LOREBOOK_TOKEN_BUDGET,
} from "../lorebook-writer.js";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.MARINARA_EXTENDER_ENGINE_URL = "http://engine.test:7860";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  _resetChains();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.MARINARA_EXTENDER_ENGINE_URL;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Route stubbed fetch by method + path so tests read as engine behaviour. */
function routeFetch(handlers: Array<[RegExp, string, () => Response]>) {
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    for (const [re, m, res] of handlers) {
      if (m === method && re.test(url)) return Promise.resolve(res());
    }
    return Promise.resolve(json({}, 404));
  });
}

const calls = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    url: url as string,
    method: (init as { method?: string })?.method ?? "GET",
    body: (init as { body?: string })?.body ? JSON.parse((init as { body: string }).body) : undefined,
  }));

describe("splitMemoryBlock", () => {
  it("splits on the \\n\\n<memory> marker", () => {
    const r = splitMemoryBlock("How to use memory.\n\n<memory>\nfacts here\n</memory>");
    expect(r.instructions).toBe("How to use memory.");
    expect(r.content).toBe("<memory>\nfacts here\n</memory>");
  });

  it("treats a block with no marker as instructions with empty content", () => {
    const r = splitMemoryBlock("just instructions");
    expect(r.instructions).toBe("just instructions");
    expect(r.content).toBe("");
  });

  it("handles an empty block", () => {
    expect(splitMemoryBlock("")).toEqual({ instructions: "", content: "" });
  });
});

describe("lorebookNameFor", () => {
  it("prefers the character name", () => {
    expect(lorebookNameFor("c1", "Rin")).toBe("Marinara Extender — Rin");
  });
  it("falls back to the id when the name is missing or blank", () => {
    expect(lorebookNameFor("c1")).toBe("Marinara Extender — c1");
    expect(lorebookNameFor("c1", "")).toBe("Marinara Extender — c1");
  });
});

describe("ensureLorebook", () => {
  it("reuses an existing Extender lorebook for the character", async () => {
    routeFetch([
      [/\/lorebooks$/, "GET", () =>
        json([{ id: "lb1", name: "Marinara Extender — Rin", characterId: "c1", tokenBudget: ME_LOREBOOK_TOKEN_BUDGET }]),
      ],
    ]);
    await expect(ensureLorebook("c1", "Rin")).resolves.toBe("lb1");
    expect(calls().some((c) => c.method === "POST")).toBe(false);
  });

  it("heals an under-budget lorebook (e87 guard)", async () => {
    // The engine default is 2048 and it SILENTLY drops entries above it. A
    // pre-existing lorebook must be raised, not just used as-is.
    routeFetch([
      [/\/lorebooks$/, "GET", () =>
        json([{ id: "lb1", name: "Marinara Extender — Rin", characterId: "c1", tokenBudget: 2048 }]),
      ],
      [/\/lorebooks\/lb1$/, "PATCH", () => json({})],
    ]);
    await ensureLorebook("c1", "Rin");
    const patch = calls().find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ tokenBudget: ME_LOREBOOK_TOKEN_BUDGET });
  });

  it("does not adopt another character's Extender lorebook", async () => {
    routeFetch([
      [/\/lorebooks$/, "GET", () =>
        json([{ id: "lbOther", name: "Marinara Extender — Someone", characterId: "c2" }]),
      ],
      [/\/lorebooks$/, "POST", () => json({ id: "lbNew" })],
    ]);
    await expect(ensureLorebook("c1", "Rin")).resolves.toBe("lbNew");
  });

  it("does not adopt a non-Extender lorebook belonging to the character", async () => {
    routeFetch([
      [/\/lorebooks$/, "GET", () => json([{ id: "lbUser", name: "My Worldbook", characterId: "c1" }])],
      [/\/lorebooks$/, "POST", () => json({ id: "lbNew" })],
    ]);
    await expect(ensureLorebook("c1", "Rin")).resolves.toBe("lbNew");
  });

  it("creates with the forced token budget", async () => {
    routeFetch([
      [/\/lorebooks$/, "GET", () => json([])],
      [/\/lorebooks$/, "POST", () => json({ id: "lbNew" })],
    ]);
    await ensureLorebook("c1", "Rin");
    const post = calls().find((c) => c.method === "POST");
    expect(post?.body).toEqual({
      name: "Marinara Extender — Rin",
      characterId: "c1",
      enabled: true,
      tokenBudget: ME_LOREBOOK_TOKEN_BUDGET,
    });
  });

  it("reads ids out of a stringified data envelope", async () => {
    routeFetch([
      [/\/lorebooks$/, "GET", () =>
        json([{ data: JSON.stringify({ id: "lb9", name: "Marinara Extender — Rin", characterId: "c1", tokenBudget: 99999 }) }]),
      ],
    ]);
    await expect(ensureLorebook("c1", "Rin")).resolves.toBe("lb9");
  });

  it("returns null rather than throwing when create fails", async () => {
    routeFetch([
      [/\/lorebooks$/, "GET", () => json([])],
      [/\/lorebooks$/, "POST", () => json({ error: "nope" }, 500)],
    ]);
    await expect(ensureLorebook("c1", "Rin")).resolves.toBeNull();
  });
});

describe("writeMemoryToLorebook", () => {
  function stubWriteCycle(existingEntries: unknown[]) {
    routeFetch([
      [/\/lorebooks\/lb1\/entries$/, "GET", () => json(existingEntries)],
      [/\/lorebooks\/lb1\/entries\/\w+$/, "PATCH", () => json({})],
      [/\/lorebooks\/lb1\/entries\/\w+$/, "DELETE", () => new Response(null, { status: 204 })],
      [/\/lorebooks\/lb1\/entries$/, "POST", () => json({ id: "new" })],
    ]);
  }

  it("unlocks each entry BEFORE deleting it", async () => {
    // A locked entry refuses deletion and silently survives the write, leaving
    // stale memory behind. Order matters, so assert the order.
    stubWriteCycle([{ id: "e1", name: "Memory System — Instructions" }]);
    await writeMemoryToLorebook("lb1", "instr\n\n<memory>\nx\n</memory>");

    const seq = calls().filter((c) => /entries\/e1$/.test(c.url));
    expect(seq.map((c) => c.method)).toEqual(["PATCH", "DELETE"]);
    expect(seq[0].body).toEqual({ locked: false });
  });

  it("deletes every pre-existing entry, not just the two it knows about", async () => {
    stubWriteCycle([{ id: "e1" }, { id: "e2" }, { id: "e3" }]);
    await writeMemoryToLorebook("lb1", "instr");
    const deleted = calls().filter((c) => c.method === "DELETE").map((c) => c.url.split("/").pop());
    expect(deleted.sort()).toEqual(["e1", "e2", "e3"]);
  });

  it("creates exactly two constant system entries in order", async () => {
    stubWriteCycle([]);
    await writeMemoryToLorebook("lb1", "instructions here\n\n<memory>\nfacts\n</memory>");

    const posts = calls().filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);

    const instr = posts.find((p) => p.body.name === "Memory System — Instructions")!;
    const active = posts.find((p) => p.body.name === "Memory System — Active Context")!;

    expect(instr.body).toMatchObject({ order: 0, enabled: true, content: "instructions here" });
    expect(active.body).toMatchObject({ order: 1, enabled: true, content: "<memory>\nfacts\n</memory>" });
    // constant:true is what makes the engine inject these on every generation.
    for (const p of posts) {
      expect(p.body).toMatchObject({ constant: true, role: "system", noVector: true, keys: [] });
    }
  });

  it("disables the Active Context entry when there is no memory yet", async () => {
    // Otherwise a brand-new character injects an empty system entry every turn.
    stubWriteCycle([]);
    await writeMemoryToLorebook("lb1", "instructions only");
    const active = calls()
      .filter((c) => c.method === "POST")
      .find((p) => p.body.name === "Memory System — Active Context")!;
    expect(active.body.enabled).toBe(false);
    expect(active.body.content).toBe("");
  });

  it("still recreates entries when the sweep fails", async () => {
    // A failed sweep must not cost the user their memory injection entirely.
    routeFetch([
      [/\/entries$/, "GET", () => json({ error: "boom" }, 500)],
      [/\/entries$/, "POST", () => json({ id: "new" })],
    ]);
    await writeMemoryToLorebook("lb1", "instr\n\n<memory>\nx\n</memory>");
    expect(calls().filter((c) => c.method === "POST")).toHaveLength(2);
  });
});

describe("syncMemoryToLorebook — serialization (axu guard)", () => {
  it("does not create two lorebooks when called concurrently for one character", async () => {
    // The extension serialized only the entry write, so two concurrent
    // refreshes could each look up, each find nothing, and each create.
    let created = 0;
    const lorebooks: Record<string, unknown>[] = [];
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (/\/lorebooks$/.test(url) && method === "GET") return Promise.resolve(json([...lorebooks]));
      if (/\/lorebooks$/.test(url) && method === "POST") {
        created++;
        const lb = { id: "lb1", name: "Marinara Extender — Rin", characterId: "c1", tokenBudget: ME_LOREBOOK_TOKEN_BUDGET };
        lorebooks.push(lb);
        return Promise.resolve(json(lb));
      }
      if (/\/entries$/.test(url) && method === "GET") return Promise.resolve(json([]));
      if (/\/entries$/.test(url) && method === "POST") return Promise.resolve(json({ id: "e" }));
      return Promise.resolve(json({}));
    });

    const args = { characterId: "c1", characterName: "Rin", memoryBlock: "i\n\n<memory>\nm\n</memory>" };
    await Promise.all([syncMemoryToLorebook(args), syncMemoryToLorebook(args), syncMemoryToLorebook(args)]);

    expect(created).toBe(1);
  });

  it("lets different characters proceed in parallel", async () => {
    const createdFor: string[] = [];
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (/\/lorebooks$/.test(url) && method === "GET") return Promise.resolve(json([]));
      if (/\/lorebooks$/.test(url) && method === "POST") {
        const body = JSON.parse((init as { body: string }).body);
        createdFor.push(body.characterId);
        return Promise.resolve(json({ id: `lb-${body.characterId}` }));
      }
      if (/\/entries$/.test(url) && method === "GET") return Promise.resolve(json([]));
      return Promise.resolve(json({ id: "e" }));
    });

    await Promise.all([
      syncMemoryToLorebook({ characterId: "c1", memoryBlock: "a" }),
      syncMemoryToLorebook({ characterId: "c2", memoryBlock: "b" }),
    ]);
    expect(createdFor.sort()).toEqual(["c1", "c2"]);
  });

  it("a failed write does not poison later writes for that character", async () => {
    // The chain must not stay rejected — otherwise one bad turn kills memory
    // for that character until restart.
    let attempt = 0;
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (/\/lorebooks$/.test(url) && method === "GET") {
        attempt++;
        if (attempt === 1) return Promise.reject(new Error("network blip"));
        return Promise.resolve(json([{ id: "lb1", name: "Marinara Extender — Rin", characterId: "c1", tokenBudget: ME_LOREBOOK_TOKEN_BUDGET }]));
      }
      if (/\/lorebooks$/.test(url) && method === "POST") return Promise.resolve(json({ error: "x" }, 500));
      if (/\/entries$/.test(url) && method === "GET") return Promise.resolve(json([]));
      return Promise.resolve(json({ id: "e" }));
    });

    const args = { characterId: "c1", characterName: "Rin", memoryBlock: "i" };
    await expect(syncMemoryToLorebook(args)).resolves.toBeNull(); // first fails
    await expect(syncMemoryToLorebook(args)).resolves.toBe("lb1"); // second recovers
  });

  it("writes nothing when the lorebook cannot be resolved", async () => {
    routeFetch([
      [/\/lorebooks$/, "GET", () => json([])],
      [/\/lorebooks$/, "POST", () => json({ error: "nope" }, 500)],
    ]);
    await expect(
      syncMemoryToLorebook({ characterId: "c1", memoryBlock: "i" }),
    ).resolves.toBeNull();
    expect(calls().some((c) => /entries/.test(c.url))).toBe(false);
  });
});
