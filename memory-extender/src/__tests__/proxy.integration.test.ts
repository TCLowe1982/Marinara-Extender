// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Engine-facing inference proxy (MarinaraExtender-53f, epic hq7) — drives the
// real routes via app.inject with fetch() stubbed as the upstream provider.
//
// The contract under test is "change nothing": Marinara's Main connection points
// at this proxy, so anything the proxy alters silently degrades every chat. The
// cases below pin the three ways passthrough has historically broken — a
// rebuilt body dropping parameters, a re-encoded stream, and a reshaped error.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerProxyRoutes } from "../proxy.js";
import { proxyUpstream, anthropicUpstream } from "../llm-config.js";

let app: FastifyInstance;
let fetchMock: ReturnType<typeof vi.fn>;

const UPSTREAM = "https://upstream.test";
const ANTHROPIC_UPSTREAM = "https://anthropic.test";

beforeEach(async () => {
  process.env.MARINARA_EXTENDER_PROXY_UPSTREAM = UPSTREAM;
  process.env.MARINARA_EXTENDER_ANTHROPIC_UPSTREAM = ANTHROPIC_UPSTREAM;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  app = Fastify();
  registerProxyRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  vi.unstubAllGlobals();
  delete process.env.MARINARA_EXTENDER_PROXY_UPSTREAM;
  delete process.env.MARINARA_EXTENDER_ANTHROPIC_UPSTREAM;
});

const MESSAGES = [
  { role: "system", content: "You are Rin." },
  { role: "user", content: "hello" },
];

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
}

/** The body the proxy actually sent upstream, parsed. */
function outboundBody(): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}
function outboundHeaders(): Record<string, string> {
  return fetchMock.mock.calls[0][1].headers as Record<string, string>;
}

describe("inference proxy — request guard", () => {
  it("rejects a request with no messages[]", async () => {
    const r = await app.inject({ method: "POST", url: "/proxy/v1/chat/completions", payload: {} });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.type).toBe("invalid_request_error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty messages[]", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/proxy/v1/chat/completions",
      payload: { messages: [] },
    });
    expect(r.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("inference proxy — faithful passthrough", () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "cmpl-1", choices: [{ message: { content: "hi" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  it("forwards the caller's model rather than substituting one", async () => {
    await app.inject({
      method: "POST",
      url: "/proxy/v1/chat/completions",
      payload: { model: "anthropic/claude-opus-4.8", messages: MESSAGES },
    });
    expect(outboundBody().model).toBe("anthropic/claude-opus-4.8");
  });

  it("preserves parameters the Rewrite Assistant relay drops", async () => {
    // The relay in index.ts rebuilds the body from a handful of known fields;
    // anything else is silently lost. This handler must not.
    await app.inject({
      method: "POST",
      url: "/proxy/v1/chat/completions",
      payload: {
        model: "gpt-5.6",
        messages: MESSAGES,
        top_p: 0.9,
        presence_penalty: 0.4,
        frequency_penalty: 0.2,
        stop: ["\n\n"],
        seed: 42,
        tools: [{ type: "function", function: { name: "recall_memory" } }],
        tool_choice: "auto",
        response_format: { type: "json_object" },
        reasoning_effort: "high",
      },
    });
    const sent = outboundBody();
    expect(sent.top_p).toBe(0.9);
    expect(sent.presence_penalty).toBe(0.4);
    expect(sent.frequency_penalty).toBe(0.2);
    expect(sent.stop).toEqual(["\n\n"]);
    expect(sent.seed).toBe(42);
    expect(sent.tools).toHaveLength(1);
    expect(sent.tool_choice).toBe("auto");
    expect(sent.response_format).toEqual({ type: "json_object" });
    // An unknown/future parameter must survive too — that is the point of
    // forwarding the whole object instead of an allowlist.
    expect(sent.reasoning_effort).toBe("high");
  });

  it("carries the caller's Authorization upstream so keys stay in engine config", async () => {
    await app.inject({
      method: "POST",
      url: "/proxy/v1/chat/completions",
      payload: { messages: MESSAGES },
      headers: { authorization: "Bearer sk-user-key" },
    });
    expect(outboundHeaders().authorization).toBe("Bearer sk-user-key");
  });

  it("does not forward browser cookies to the provider", async () => {
    await app.inject({
      method: "POST",
      url: "/proxy/v1/chat/completions",
      payload: { messages: MESSAGES },
      headers: { cookie: "session=secret" },
    });
    expect(outboundHeaders().cookie).toBeUndefined();
  });

  it("targets the configured upstream", async () => {
    await app.inject({
      method: "POST",
      url: "/proxy/v1/chat/completions",
      payload: { messages: MESSAGES },
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${UPSTREAM}/v1/chat/completions`);
  });

  it("serves the alias path for a base URL configured without /v1", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/proxy/chat/completions",
      payload: { messages: MESSAGES },
    });
    expect(r.statusCode).toBe(200);
  });
});

describe("inference proxy — response passthrough", () => {
  it("returns the upstream JSON body unchanged", async () => {
    const payload = { id: "cmpl-9", choices: [{ message: { role: "assistant", content: "hey" } }] };
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const r = await app.inject({
      method: "POST",
      url: "/proxy/v1/chat/completions",
      payload: { messages: MESSAGES },
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual(payload);
  });

  it("passes an upstream error through with its status and message intact", async () => {
    // A 401 must reach Marinara as a 401 the user can act on, not be reshaped
    // into a sidecar error that looks like the Extender is broken.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Incorrect API key provided" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const r = await app.inject({
      method: "POST",
      url: "/proxy/v1/chat/completions",
      payload: { messages: MESSAGES },
    });
    expect(r.statusCode).toBe(401);
    expect(JSON.parse(r.body).error.message).toBe("Incorrect API key provided");
  });

  it("strips content-encoding and content-length from the upstream response", async () => {
    // fetch() has already decoded the body; leaving these on makes the client
    // decode a second time or truncate the reply.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "x-request-id": "req-123",
        },
      }),
    );
    const r = await app.inject({
      method: "POST",
      url: "/proxy/v1/chat/completions",
      payload: { messages: MESSAGES },
    });
    expect(r.headers["content-encoding"]).toBeUndefined();
    // Unrelated provider headers still come back.
    expect(r.headers["x-request-id"]).toBe("req-123");
  });

  it("returns 502 with an actionable message when the upstream is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await app.inject({
      method: "POST",
      url: "/proxy/v1/chat/completions",
      payload: { messages: MESSAGES },
    });
    expect(r.statusCode).toBe(502);
    expect(r.json().error.type).toBe("upstream_error");
    expect(r.json().error.message).toContain(UPSTREAM);
  });
});

describe("inference proxy — streaming", () => {
  it("pipes SSE frames through byte-for-byte", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    fetchMock.mockResolvedValue(
      new Response(sseStream(frames), {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      }),
    );
    const r = await app.inject({
      method: "POST",
      url: "/proxy/v1/chat/completions",
      payload: { messages: MESSAGES, stream: true },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("text/event-stream");
    expect(r.body).toBe(frames.join(""));
  });

  it("forwards stream:true upstream rather than downgrading to a blocking call", async () => {
    fetchMock.mockResolvedValue(
      new Response(sseStream(["data: [DONE]\n\n"]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    await app.inject({
      method: "POST",
      url: "/proxy/v1/chat/completions",
      payload: { messages: MESSAGES, stream: true },
    });
    expect(outboundBody().stream).toBe(true);
  });
});

describe("Anthropic Messages route", () => {
  const ANTHROPIC_BODY = {
    model: "claude-opus-4-8",
    max_tokens: 4096,
    system: "You are Rin.",
    messages: [{ role: "user", content: "hello" }],
  };

  it("rejects a request with no messages[]", async () => {
    const r = await app.inject({ method: "POST", url: "/anthropic/v1/messages", payload: {} });
    expect(r.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("targets the Anthropic upstream, not the OpenAI-compatible one", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await app.inject({ method: "POST", url: "/anthropic/v1/messages", payload: ANTHROPIC_BODY });
    expect(fetchMock.mock.calls[0][0]).toBe(`${ANTHROPIC_UPSTREAM}/v1/messages`);
  });

  it("forwards x-api-key and anthropic-version rather than rewriting to Authorization", async () => {
    // The engine sets apiKeyHeader "x-api-key" with usesAuthHeader false for the
    // native Anthropic provider — dropping these is an instant 401.
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await app.inject({
      method: "POST",
      url: "/anthropic/v1/messages",
      payload: ANTHROPIC_BODY,
      headers: { "x-api-key": "sk-ant-user-key", "anthropic-version": "2023-06-01" },
    });
    const headers = outboundHeaders();
    expect(headers["x-api-key"]).toBe("sk-ant-user-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.authorization).toBeUndefined();
  });

  it("preserves Anthropic-shaped fields the OpenAI schema has no concept of", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await app.inject({
      method: "POST",
      url: "/anthropic/v1/messages",
      payload: {
        ...ANTHROPIC_BODY,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
        stop_sequences: ["\n\nUser:"],
      },
    });
    const sent = outboundBody();
    // `system` is a TOP-LEVEL Anthropic parameter, not a message — slice 3
    // injects into this field, so passthrough must not disturb it.
    expect(sent.system).toBe("You are Rin.");
    expect(sent.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(sent.output_config).toEqual({ effort: "high" });
    expect(sent.stop_sequences).toEqual(["\n\nUser:"]);
  });

  it("serves the alias path for a base URL configured without /v1", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const r = await app.inject({
      method: "POST",
      url: "/anthropic/messages",
      payload: ANTHROPIC_BODY,
    });
    expect(r.statusCode).toBe(200);
  });

  it("pipes Anthropic SSE events through byte-for-byte", async () => {
    // Anthropic's event shape differs from OpenAI's entirely — passthrough must
    // not assume either.
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"He"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    fetchMock.mockResolvedValue(
      new Response(sseStream(frames), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const r = await app.inject({
      method: "POST",
      url: "/anthropic/v1/messages",
      payload: { ...ANTHROPIC_BODY, stream: true },
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe(frames.join(""));
  });

  it("passes an upstream 400 through verbatim so the real cause is visible", async () => {
    // Real case: sampling parameters are rejected on Opus 4.7/4.8. If the proxy
    // reshaped this, an upstream model constraint would look like a sidecar bug.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "temperature: Extra inputs are not permitted" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    const r = await app.inject({
      method: "POST",
      url: "/anthropic/v1/messages",
      payload: { ...ANTHROPIC_BODY, temperature: 0.9 },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error.message).toMatch(/temperature/);
  });
});

describe("anthropicUpstream() normalization", () => {
  it("strips a pasted /v1 suffix (Marinara's default is https://api.anthropic.com/v1)", () => {
    process.env.MARINARA_EXTENDER_ANTHROPIC_UPSTREAM = "https://api.anthropic.com/v1";
    expect(anthropicUpstream()).toBe("https://api.anthropic.com");
  });

  it("defaults to the Anthropic API when unset", () => {
    delete process.env.MARINARA_EXTENDER_ANTHROPIC_UPSTREAM;
    expect(anthropicUpstream()).toBe("https://api.anthropic.com");
  });
});

describe("proxyUpstream() normalization", () => {
  it("strips a trailing slash", () => {
    process.env.MARINARA_EXTENDER_PROXY_UPSTREAM = "https://host.test/";
    expect(proxyUpstream()).toBe("https://host.test");
  });

  it("strips a pasted /v1 suffix so both documented forms work", () => {
    process.env.MARINARA_EXTENDER_PROXY_UPSTREAM = "https://host.test/v1";
    expect(proxyUpstream()).toBe("https://host.test");
  });

  it("strips /v1 with a trailing slash", () => {
    process.env.MARINARA_EXTENDER_PROXY_UPSTREAM = "https://host.test/v1/";
    expect(proxyUpstream()).toBe("https://host.test");
  });
});
