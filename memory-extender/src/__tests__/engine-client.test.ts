// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Engine REST client (MarinaraExtender-7nx, epic hq7) — the sidecar's
// server-to-server channel to Marinara Engine, replacing the removed
// extension's marinara.apiFetch.
//
// Two things carry real risk and are pinned hardest here: the static CSRF
// header (without it every mutation 403s) and the list-unwrapping, which has to
// tolerate three response shapes because the extension found all three in the
// wild.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  engineFetch,
  engineUrl,
  parseData,
  unwrapList,
  listChats,
  listMessages,
  listLorebooks,
  createLorebook,
  deleteLorebookEntry,
  engineReachable,
  latestUserMessage,
  EngineError,
} from "../engine-client.js";

let fetchMock: ReturnType<typeof vi.fn>;
const ENGINE = "http://engine.test:7860";

beforeEach(() => {
  process.env.MARINARA_EXTENDER_ENGINE_URL = ENGINE;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MARINARA_EXTENDER_ENGINE_URL;
  delete process.env.MARINARA_EXTENDER_ENGINE_BASIC_AUTH;
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const calledUrl = () => fetchMock.mock.calls[0][0] as string;
const calledInit = () => fetchMock.mock.calls[0][1] as { method: string; headers: Record<string, string>; body?: string };

describe("engineUrl() normalization", () => {
  it("strips a trailing slash", () => {
    process.env.MARINARA_EXTENDER_ENGINE_URL = "http://host:7860/";
    expect(engineUrl()).toBe("http://host:7860");
  });

  it("strips a pasted /api suffix", () => {
    process.env.MARINARA_EXTENDER_ENGINE_URL = "http://host:7860/api";
    expect(engineUrl()).toBe("http://host:7860");
  });

  it("defaults to the engine's loopback address", () => {
    delete process.env.MARINARA_EXTENDER_ENGINE_URL;
    expect(engineUrl()).toBe("http://127.0.0.1:7860");
  });
});

describe("engineFetch — transport", () => {
  it("sends the static CSRF header on every request", async () => {
    // Without this the engine 403s every mutation. It is a fixed value, not a
    // token to fetch — see CSRF_HEADER_VALUE in the engine's security.ts.
    fetchMock.mockResolvedValue(json({}));
    await engineFetch("/chats");
    expect(calledInit().headers["x-marinara-csrf"]).toBe("1");
  });

  it("targets the engine's /api surface", async () => {
    fetchMock.mockResolvedValue(json({}));
    await engineFetch("/lorebooks");
    expect(calledUrl()).toBe(`${ENGINE}/api/lorebooks`);
  });

  it("omits a body on GET rather than sending 'undefined'", async () => {
    fetchMock.mockResolvedValue(json({}));
    await engineFetch("/chats");
    expect(calledInit().body).toBeUndefined();
  });

  it("omits content-type when there is no body", async () => {
    // REGRESSION (found by the live smoke test, not by these stubs): Fastify
    // rejects a bodyless request that declares application/json with
    // "Body cannot be empty when content-type is set to 'application/json'".
    // Sending it unconditionally made every DELETE a 400, which would have
    // broken the nuke-and-recreate lorebook cycle in slice lxp.
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await deleteLorebookEntry("lb1", "e1");
    expect(calledInit().headers["content-type"]).toBeUndefined();
    // The CSRF header must still be there — it is not conditional.
    expect(calledInit().headers["x-marinara-csrf"]).toBe("1");
  });

  it("sets content-type when a body IS present", async () => {
    fetchMock.mockResolvedValue(json({ id: "lb1" }));
    await engineFetch("/lorebooks", { method: "POST", body: { name: "x" } });
    expect(calledInit().headers["content-type"]).toBe("application/json");
  });

  it("serializes a body on mutations", async () => {
    fetchMock.mockResolvedValue(json({ id: "lb1" }));
    await engineFetch("/lorebooks", { method: "POST", body: { name: "x" } });
    expect(calledInit().method).toBe("POST");
    expect(JSON.parse(calledInit().body!)).toEqual({ name: "x" });
  });

  it("returns null for a 204 with no body (DELETE)", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(deleteLorebookEntry("lb1", "e1")).resolves.toBeNull();
  });

  it("adds Basic auth only when configured", async () => {
    // mockImplementation, not mockResolvedValue: this test calls twice, and a
    // Response body can only be read once — reusing one instance throws
    // "Body is unusable".
    fetchMock.mockImplementation(() => json({}));
    await engineFetch("/chats");
    expect(calledInit().headers.authorization).toBeUndefined();

    fetchMock.mockClear();
    process.env.MARINARA_EXTENDER_ENGINE_BASIC_AUTH = "user:pass";
    await engineFetch("/chats");
    expect(calledInit().headers.authorization).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
  });
});

describe("engineFetch — actionable failures", () => {
  it("explains an untrusted-origin CSRF rejection instead of a bare 403", async () => {
    fetchMock.mockResolvedValue(json({ code: "CSRF_ORIGIN_NOT_TRUSTED" }, 403));
    await expect(engineFetch("/lorebooks", { method: "POST", body: {} })).rejects.toThrow(
      /CSRF_TRUSTED_ORIGINS/,
    );
  });

  it("distinguishes a stripped CSRF header from an untrusted origin", async () => {
    // Different cause, different fix — collapsing these into one message is how
    // this becomes an hour of guessing.
    fetchMock.mockResolvedValue(json({ code: "CSRF_MISSING_HEADER" }, 403));
    await expect(engineFetch("/lorebooks", { method: "POST", body: {} })).rejects.toThrow(
      /stripping it/,
    );
  });

  it("points a 401 at the Basic-auth env var", async () => {
    fetchMock.mockResolvedValue(json({ error: "Unauthorized" }, 401));
    await expect(engineFetch("/chats")).rejects.toThrow(/MARINARA_EXTENDER_ENGINE_BASIC_AUTH/);
  });

  it("reports an unreachable engine as such rather than a parse error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const err = await engineFetch("/chats").catch((e) => e as EngineError);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).status).toBe(0);
    expect((err as EngineError).message).toMatch(/is it running/);
  });

  it("surfaces the engine's own message for other failures", async () => {
    fetchMock.mockResolvedValue(json({ error: "Invalid Discord webhook URL" }, 400));
    await expect(engineFetch("/chats/c1", { method: "PATCH", body: {} })).rejects.toThrow(
      /Invalid Discord webhook URL/,
    );
  });

  it("engineReachable() reports false instead of throwing", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(engineReachable()).resolves.toBe(false);
  });
});

describe("unwrapList — tolerates all three observed shapes", () => {
  it("accepts a bare array", () => {
    expect(unwrapList([{ id: 1 }], "chats")).toEqual([{ id: 1 }]);
  });

  it("accepts a named key", () => {
    expect(unwrapList({ chats: [{ id: 1 }] }, "chats")).toEqual([{ id: 1 }]);
  });

  it("accepts a data envelope", () => {
    expect(unwrapList({ data: [{ id: 1 }] }, "chats")).toEqual([{ id: 1 }]);
  });

  it("returns [] rather than throwing on an unexpected shape", () => {
    expect(unwrapList({ nope: true }, "chats")).toEqual([]);
    expect(unwrapList(null, "chats")).toEqual([]);
  });
});

describe("parseData — engine objects with a stringified data field", () => {
  it("parses a JSON string", () => {
    expect(parseData({ data: '{"characterId":"c1"}' })).toEqual({ characterId: "c1" });
  });

  it("passes an object through", () => {
    expect(parseData({ data: { characterId: "c1" } })).toEqual({ characterId: "c1" });
  });

  it("returns {} on malformed JSON rather than throwing", () => {
    expect(parseData({ data: "{not json" })).toEqual({});
  });

  it("returns {} when data is absent", () => {
    expect(parseData({ id: "x" })).toEqual({});
    expect(parseData(null)).toEqual({});
  });
});

describe("typed endpoint wrappers", () => {
  it("listChats unwraps the list", async () => {
    fetchMock.mockResolvedValue(json({ chats: [{ id: "c1" }] }));
    await expect(listChats()).resolves.toEqual([{ id: "c1" }]);
  });

  it("listMessages passes limit and before as query params", async () => {
    // The endpoint returns the FULL history with no limit, so the poller must
    // always bound it — this asserts the knob actually reaches the URL.
    fetchMock.mockResolvedValue(json({ messages: [] }));
    await listMessages("c1", { limit: 20, before: "cursor1" });
    expect(calledUrl()).toBe(`${ENGINE}/api/chats/c1/messages?limit=20&before=cursor1`);
  });

  it("listMessages omits the query string entirely when unbounded", async () => {
    fetchMock.mockResolvedValue(json({ messages: [] }));
    await listMessages("c1");
    expect(calledUrl()).toBe(`${ENGINE}/api/chats/c1/messages`);
  });

  it("listLorebooks unwraps a bare array", async () => {
    fetchMock.mockResolvedValue(json([{ id: "lb1" }]));
    await expect(listLorebooks()).resolves.toEqual([{ id: "lb1" }]);
  });

  it("createLorebook posts the documented shape", async () => {
    fetchMock.mockResolvedValue(json({ id: "lb1" }));
    await createLorebook({ name: "Marinara Extender — Rin", characterId: "c1", enabled: true, tokenBudget: 16384 });
    expect(calledInit().method).toBe("POST");
    expect(JSON.parse(calledInit().body!)).toEqual({
      name: "Marinara Extender — Rin",
      characterId: "c1",
      enabled: true,
      tokenBudget: 16384,
    });
  });
});

// ── latestUserMessage (771t) ──────────────────────────────────────────────────
//
// This is the crux of the pre-turn path, and its failure mode is silent. The
// shipped Engine hands a prompt-context contributor no messages, so the outgoing
// user turn is fetched by chatId — and if the wrong row comes back there is no
// error, just recall scored against turn N-1. Mari, 2026-08-29: "in a real
// conversation N-1 is topically adjacent to N almost always, so ranking on stale
// text produces plausible rows and looks exactly like it's working."
//
// So these assert WHICH row, never merely that a row came back.
describe("latestUserMessage() — which turn we score against", () => {
  it("returns the LAST user message, not the first and not the last message", async () => {
    fetchMock.mockResolvedValue(
      json({
        messages: [
          { id: "m1", role: "user", content: "the older question" },
          { id: "m2", role: "assistant", content: "a reply" },
          { id: "m3", role: "user", content: "the outgoing question" },
          // A chat can carry a trailing assistant row (a swipe being rewritten);
          // the relevance signal is still the last USER turn.
          { id: "m4", role: "assistant", content: "streaming..." },
        ],
      }),
    );

    const got = await latestUserMessage("chat1");

    expect(got).toEqual({ id: "m3", text: "the outgoing question" });
  });

  it("skips a blank user row rather than scoring against nothing", async () => {
    // An empty relevance signal is not a harmless default — it ranks on nothing
    // and returns the same generic rows every turn, which reads as "memory is on
    // but useless" instead of as a fault.
    fetchMock.mockResolvedValue(
      json({
        messages: [
          { id: "m1", role: "user", content: "the real question" },
          { id: "m2", role: "user", content: "   " },
        ],
      }),
    );

    expect(await latestUserMessage("chat1")).toEqual({ id: "m1", text: "the real question" });
  });

  it("returns null when the chat has no user message", async () => {
    fetchMock.mockResolvedValue(json({ messages: [{ id: "m1", role: "assistant", content: "greeting" }] }));
    expect(await latestUserMessage("chat1")).toBeNull();
  });

  it("returns null — never throws — when the engine is unreachable", async () => {
    // The caller is on the generation path. A throw here would surface as an
    // Engine warning on every turn for an outage the user cannot act on.
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await latestUserMessage("chat1")).toBeNull();
  });

  it("requests a bounded tail, not the whole chat", async () => {
    // Fetching thousands of messages would put our latency inside someone's
    // prompt assembly, against a 2s contributor deadline.
    fetchMock.mockResolvedValue(json({ messages: [] }));
    await latestUserMessage("chat1");
    expect(calledUrl()).toContain("limit=10");
  });
});
