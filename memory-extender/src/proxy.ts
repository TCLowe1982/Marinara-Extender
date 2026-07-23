// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Engine-facing inference proxy — the replacement for the client extension.
//
// Marinara Engine v2.3.4 removed client extensions entirely, so the sidecar can
// no longer observe turns from inside the browser. Instead Marinara points its
// MAIN connection at this proxy (a Custom OpenAI-compatible provider) and every
// chat generation flows through here on its way to the real provider.
//
// SLICE 1 (this file, for now): faithful passthrough only. No memory injection,
// no scope resolution, no turn ingestion. The point is to prove a turn streams
// through the sidecar byte-for-byte identically to a direct connection before
// any memory logic is layered on. Slices 2-4 add resolution, injection and the
// response tee at the marked seams below.
//
// Why a separate path from the /v1/chat/completions relay in index.ts: that one
// is the Rewrite Assistant helper, which deliberately picks the model and the
// key for the caller. This one must do the opposite — change nothing and carry
// the caller's own credentials. Sharing a handler would mean guessing intent
// from the shape of the request, so they stay separate routes.
//
// Deliberately OUTSIDE /api/ so it is exempt from the CSRF guard: Marinara's
// provider client is a generic OpenAI client and cannot carry x-me-csrf. The
// server binds 127.0.0.1, so the exposure is the same as the existing relay.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "stream";
import { proxyUpstream } from "./llm-config.js";

// Request headers we carry upstream. An allowlist rather than a blind copy:
// forwarding Host/Content-Length/Connection breaks the upstream request, and
// forwarding cookies would leak browser state to the provider.
const FORWARD_REQUEST_HEADERS = [
  "authorization",
  "api-key", // Azure OpenAI
  "x-api-key", // Anthropic-compatible shims
  "anthropic-version",
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

const handleProxyCompletions = async (req: FastifyRequest, reply: FastifyReply) => {
  const body = (req.body ?? {}) as Record<string, unknown> & {
    messages?: Array<{ role: string; content: unknown }>;
    stream?: boolean;
    model?: string;
  };

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return reply
      .code(400)
      .send({ error: { message: "messages[] is required", type: "invalid_request_error" } });
  }

  // SEAM (slice 2): resolve chatId/characterId from this request.
  // SEAM (slice 3): inject the memory block into the system message here.
  //
  // The body is forwarded as a whole object rather than rebuilt from an
  // allowlist of known fields, so provider-specific and future parameters
  // (tools, response_format, reasoning_effort, ...) survive untouched. The
  // relay in index.ts rebuilds the body and drops them — that is the bug this
  // handler exists to avoid.
  const outbound = JSON.stringify(body);
  const wantsStream = body.stream === true;

  // Abort upstream when Marinara hangs up (the user pressing Stop), instead of
  // paying for a generation nobody will read.
  const ac = new AbortController();
  const onClose = () => ac.abort();
  req.raw.on("close", onClose);

  let res: Response;
  try {
    res = await fetch(`${proxyUpstream()}/v1/chat/completions`, {
      method: "POST",
      headers: pickRequestHeaders(req),
      body: outbound,
      signal: ac.signal,
      // No timeout: a long roleplay generation is normal and the engine has its
      // own CHAT_GENERATION_TIMEOUT_MS. Capping it here would sever healthy
      // streams mid-reply.
    });
  } catch (e) {
    req.raw.off("close", onClose);
    if (ac.signal.aborted) return reply; // client hung up; nothing to answer to
    console.warn(`[ME:proxy] upstream request failed — ${String(e)}`);
    return reply.code(502).send({
      error: {
        message: `Inference proxy could not reach the upstream provider at ${proxyUpstream()}: ${String(e)}`,
        type: "upstream_error",
      },
    });
  }

  // Non-streaming: hand back status and body unchanged, including error bodies
  // (a 401 from the provider must reach Marinara as a 401 with its own message,
  // not be reshaped into a sidecar error the user cannot act on).
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
  // ingestion. The tee must never gate or delay a chunk being written out.
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
};

export function registerProxyRoutes(app: FastifyInstance): void {
  app.post("/proxy/v1/chat/completions", handleProxyCompletions);
  // Alias for a base URL configured without the /v1 suffix.
  app.post("/proxy/chat/completions", handleProxyCompletions);

  // Marinara probes the models list when testing a Custom connection. Proxy it
  // so the connection's "Test" button reports the real upstream state rather
  // than a 404 that looks like the sidecar is broken.
  app.get("/proxy/v1/models", async (req, reply) => {
    try {
      const res = await fetch(`${proxyUpstream()}/v1/models`, { headers: pickRequestHeaders(req) });
      const text = await res.text();
      reply.code(res.status);
      for (const [k, v] of Object.entries(passthroughResponseHeaders(res))) reply.header(k, v);
      return reply.send(text);
    } catch (e) {
      return reply.code(502).send({
        error: { message: `Could not reach ${proxyUpstream()}: ${String(e)}`, type: "upstream_error" },
      });
    }
  });
}
