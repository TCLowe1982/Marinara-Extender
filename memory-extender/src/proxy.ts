// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Engine-facing inference proxy — the replacement for the client extension.
//
// Marinara Engine v2.3.4 removed client extensions entirely, so the sidecar can
// no longer observe turns from inside the browser. Instead Marinara points a
// connection at this proxy and every chat generation flows through here on its
// way to the real provider.
//
// TWO WIRE FORMATS, ONE PASSTHROUGH CORE. Anthropic is not OpenAI-compatible,
// and translating between them would mean owning message-shape conversion, SSE
// event translation, tool-call mapping and stop-reason mapping forever. We
// don't: Marinara's native Anthropic connection has a user-editable baseUrl
// (only the CLI-login providers hide it), so the proxy exposes a second
// Anthropic-shaped route and forwards that format untouched. The engine keeps
// owning provider-specific behaviour, which is where that knowledge belongs.
//
//   OpenAI-compatible  →  POST /proxy/v1/chat/completions     → proxyUpstream()
//   Anthropic Messages →  POST /anthropic/v1/messages         → anthropicUpstream()
//
// SLICE 1 (this file, for now): faithful passthrough only. No memory injection,
// no scope resolution, no turn ingestion. The point is to prove a turn streams
// through the sidecar byte-for-byte identically to a direct connection before
// any memory logic is layered on. Slices 2-4 add resolution, injection and the
// response tee at the marked seams below.
//
// Why this is separate from the /v1/chat/completions relay in index.ts: that
// one is the Rewrite Assistant helper, which deliberately picks the model and
// the key for its caller. These must do the opposite — change nothing and carry
// the caller's own credentials. Sharing a handler would mean guessing intent
// from the shape of the request, so they stay separate routes.
//
// Deliberately OUTSIDE /api/ so they are exempt from the CSRF guard: Marinara's
// provider client is a generic HTTP client and cannot carry x-me-csrf. The
// server binds 127.0.0.1, so the exposure is the same as the existing relay.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "stream";
import { proxyUpstream, anthropicUpstream } from "./llm-config.js";

// Request headers we carry upstream. An allowlist rather than a blind copy:
// forwarding Host/Content-Length/Connection breaks the upstream request, and
// forwarding cookies would leak browser state to the provider.
const FORWARD_REQUEST_HEADERS = [
  "authorization", // OpenAI-compatible providers
  "x-api-key", // Anthropic (engine sets apiKeyHeader "x-api-key", not Authorization)
  "anthropic-version", // required by the Anthropic Messages API
  "anthropic-beta",
  "api-key", // Azure OpenAI
  "openai-organization",
  "openai-project",
  "http-referer", // OpenRouter attribution
  "x-title", // OpenRouter attribution
];

// Response headers we must NOT copy back. fetch() has already decoded the body,
// so a surviving content-encoding makes the client try to decode it a second
// time; content-length would describe the encoded length and truncate the
// reply. The rest are hop-by-hop and belong to our own connection.
const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

function pickRequestHeaders(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = { "content-type": "application/json" };
  for (const name of FORWARD_REQUEST_HEADERS) {
    const v = req.headers[name];
    if (typeof v === "string" && v) out[name] = v;
  }
  return out;
}

function passthroughResponseHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) out[key] = value;
  });
  return out;
}

/**
 * Forward a request body to `targetUrl` and stream the reply back untouched.
 *
 * Wire-format agnostic on purpose — OpenAI and Anthropic differ in their JSON
 * shapes and SSE event names, but neither matters to a byte-for-byte relay.
 * Only slices 3 (injection) and 4 (the tee) need to know which format they are
 * looking at.
 */
async function forwardPassthrough(
  req: FastifyRequest,
  reply: FastifyReply,
  targetUrl: string,
  body: Record<string, unknown>,
  wantsStream: boolean,
): Promise<FastifyReply> {
  // Abort upstream when Marinara hangs up (the user pressing Stop), instead of
  // paying for a generation nobody will read.
  const ac = new AbortController();
  const onClose = () => ac.abort();
  req.raw.on("close", onClose);

  let res: Response;
  try {
    res = await fetch(targetUrl, {
      method: "POST",
      headers: pickRequestHeaders(req),
      body: JSON.stringify(body),
      signal: ac.signal,
      // No timeout: a long roleplay generation is normal and the engine has its
      // own CHAT_GENERATION_TIMEOUT_MS. Capping it here would sever healthy
      // streams mid-reply.
    });
  } catch (e) {
    req.raw.off("close", onClose);
    if (ac.signal.aborted) return reply; // client hung up; nothing to answer to
    console.warn(`[ME:proxy] upstream request failed (${targetUrl}) — ${String(e)}`);
    return reply.code(502).send({
      error: {
        message: `Inference proxy could not reach the upstream provider at ${targetUrl}: ${String(e)}`,
        type: "upstream_error",
      },
    });
  }

  // Non-streaming: hand back status and body unchanged, including error bodies.
  // A 400 from Anthropic ("temperature is not supported on this model") or a
  // 401 must reach Marinara verbatim — reshaping it into a sidecar error is how
  // an upstream model constraint gets misread as "the Extender is broken".
  if (!wantsStream || !res.body) {
    req.raw.off("close", onClose);
    const text = await res.text();
    reply.code(res.status);
    for (const [k, v] of Object.entries(passthroughResponseHeaders(res))) reply.header(k, v);
    return reply.send(text);
  }

  // Streaming: hijack the socket and pipe upstream bytes straight through, so
  // SSE frames flush as they arrive rather than being buffered by Fastify's
  // serializer.
  //
  // SEAM (slice 4): tee this stream to buffer the assistant text for turn
  // ingestion. The tee must never gate or delay a chunk being written out, and
  // must parse per format — OpenAI `choices[].delta.content` vs Anthropic
  // `content_block_delta` / `text_delta`.
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(res.status, passthroughResponseHeaders(res));

  const upstream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  upstream.on("error", (e) => {
    console.warn(`[ME:proxy] upstream stream error — ${String(e)}`);
    raw.end();
  });
  raw.on("close", () => {
    req.raw.off("close", onClose);
    upstream.destroy();
  });
  upstream.pipe(raw);

  return reply;
}

/** Shared guard: every chat request in both formats carries a messages[] array. */
function readChatBody(req: FastifyRequest, reply: FastifyReply) {
  const body = (req.body ?? {}) as Record<string, unknown> & {
    messages?: Array<unknown>;
    stream?: boolean;
  };
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    reply.code(400).send({ error: { message: "messages[] is required", type: "invalid_request_error" } });
    return null;
  }
  return body;
}

// ── OpenAI-compatible route ───────────────────────────────────────────────────

const handleOpenAiCompletions = async (req: FastifyRequest, reply: FastifyReply) => {
  const body = readChatBody(req, reply);
  if (!body) return reply;

  // SEAM (slice 2): resolve chatId/characterId from this request.
  // SEAM (slice 3): inject the memory block into the system message here.
  //
  // The body is forwarded as a whole object rather than rebuilt from an
  // allowlist of known fields, so provider-specific and future parameters
  // (tools, response_format, reasoning_effort, ...) survive untouched. The
  // relay in index.ts rebuilds the body and drops them — that is the bug this
  // handler exists to avoid.
  return forwardPassthrough(
    req,
    reply,
    `${proxyUpstream()}/v1/chat/completions`,
    body,
    body.stream === true,
  );
};

// ── Anthropic Messages route ──────────────────────────────────────────────────

const handleAnthropicMessages = async (req: FastifyRequest, reply: FastifyReply) => {
  const body = readChatBody(req, reply);
  if (!body) return reply;

  // SEAM (slice 2): resolve chatId/characterId from this request.
  // SEAM (slice 3): inject the memory block into the top-level `system` field.
  //
  // Anthropic takes `system` as a TOP-LEVEL parameter rather than a message
  // with role "system", so injection here is cleaner than in the OpenAI shape:
  // append to (or create) `body.system` instead of splicing the messages array.
  // `system` accepts a bare string or an array of text blocks — handle both.
  return forwardPassthrough(
    req,
    reply,
    `${anthropicUpstream()}/v1/messages`,
    body,
    body.stream === true,
  );
};

// ── Model listing (the connection's Test button) ──────────────────────────────

function makeModelsHandler(upstream: () => string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const target = `${upstream()}/v1/models`;
    try {
      const res = await fetch(target, { headers: pickRequestHeaders(req) });
      const text = await res.text();
      reply.code(res.status);
      for (const [k, v] of Object.entries(passthroughResponseHeaders(res))) reply.header(k, v);
      return reply.send(text);
    } catch (e) {
      return reply.code(502).send({
        error: { message: `Could not reach ${target}: ${String(e)}`, type: "upstream_error" },
      });
    }
  };
}

export function registerProxyRoutes(app: FastifyInstance): void {
  // OpenAI-compatible: set the Custom connection's base URL to
  //   http://127.0.0.1:3001/proxy/v1
  app.post("/proxy/v1/chat/completions", handleOpenAiCompletions);
  app.post("/proxy/chat/completions", handleOpenAiCompletions); // base URL without /v1
  app.get("/proxy/v1/models", makeModelsHandler(proxyUpstream));

  // Anthropic: set the NATIVE Anthropic connection's base URL to
  //   http://127.0.0.1:3001/anthropic/v1
  // (the engine appends /messages, and sends x-api-key rather than Authorization)
  app.post("/anthropic/v1/messages", handleAnthropicMessages);
  app.post("/anthropic/messages", handleAnthropicMessages); // base URL without /v1
  app.get("/anthropic/v1/models", makeModelsHandler(anthropicUpstream));
}
