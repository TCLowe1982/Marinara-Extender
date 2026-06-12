// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

import Fastify from "fastify";
import { readFile } from "fs/promises";
import { allowedCorsOrigin } from "./cors.js";
import { defaultEnvPath } from "./paths.js";
import { getDataDir } from "./storage.js";
import { localUrl, localEnabled, localModel, externalUpstream, externalModel } from "./llm-config.js";
import { registerApiRoutes } from "./api.js";
import { registerSetupRoutes } from "./setup.js";
import { isEideticMode } from "./loader.js";

// ── .env loader ───────────────────────────────────────────────────────────────
// Reads sidecar/.env at startup so users can store their API key once instead
// of re-entering it in every Marinara connection form.

async function loadDotEnv(): Promise<void> {
  try {
    const raw = await readFile(defaultEnvPath(), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      // .env always wins — overwrites stale system env vars (e.g. from Python venvs)
      if (key && val) process.env[key] = val;
    }
  } catch {
    // no .env — fine
  }
}

await loadDotEnv();

const PORT = parseInt(process.env.MARINARA_EXTENDER_PORT ?? "3001", 10);

// Suppress Fastify's JSON request/response logs — our own console.info calls
// carry all the meaningful context. Set ME_HTTP_LOG=1 to re-enable if you
// need to debug raw HTTP traffic.
const app = Fastify({
  logger: process.env.ME_HTTP_LOG === "1"
    ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" } } }
    : { level: "warn" },
  // Long chats (1k+ messages) are POSTed whole for granular import; the default
  // 1MB body limit is far too small.
  bodyLimit: 64 * 1024 * 1024, // 64 MB
});

// ── CORS (for extension fetch() calls to /api/*) ──────────────────────────────

app.addHook("onSend", async (req, reply) => {
  // Only allow loopback (or explicitly-configured) origins to read responses, so
  // a random site the user visits can't read their memory store. See cors.ts.
  const allowed = allowedCorsOrigin(req.headers.origin);
  if (allowed) {
    void reply.header("Access-Control-Allow-Origin", allowed);
    void reply.header("Vary", "Origin");
  }
  void reply.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  void reply.header("Access-Control-Allow-Headers", "Content-Type,Authorization,x-me-csrf");
});

app.options("*", { logLevel: "silent" }, async (_req, reply) => reply.send());

// ── Health ────────────────────────────────────────────────────────────────────

app.get("/api/health", { logLevel: "silent" }, async (_req, reply) => {
  // Check the local provider — strip the /v1 suffix to ping the server root.
  const root = localUrl().replace(/\/v1\/?$/, "");
  let ollama: "ok" | "unavailable" | "not_configured" = "not_configured";
  if (localEnabled()) {
    try {
      const r = await fetch(root, { signal: AbortSignal.timeout(1000) });
      ollama = r.ok ? "ok" : "unavailable";
    } catch {
      ollama = "unavailable";
    }
  }
  return reply.send({ ok: true, ollama });
});

// ── Setup page ────────────────────────────────────────────────────────────────
// http://127.0.0.1:{PORT}/setup — one-stop install page with copy buttons.
// http://127.0.0.1:{PORT}/extension.js — raw extension file for the copy button.

registerSetupRoutes(app, { port: PORT });

// ── Management API ────────────────────────────────────────────────────────────

registerApiRoutes(app);

// ── Boot ──────────────────────────────────────────────────────────────────────

app.listen({ port: PORT, host: "127.0.0.1" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  const apiKey = process.env.MARINARA_EXTENDER_API_KEY;
  console.log(`\nMarinara Extender memory server running on http://127.0.0.1:${PORT}`);
  console.log(`Setup page:   http://127.0.0.1:${PORT}/setup`);
  console.log(`Data dir:     ${getDataDir()}`);
  console.log(`Local model:  ${localEnabled() ? `${localModel()} @ ${localUrl()}` : "disabled (external only)"}`);
  console.log(`External API: ${apiKey ? `${externalModel()} @ ${externalUpstream()}` : "no key — local only"}`);
  console.log(`Eidetic mode: ${isEideticMode() ? "ON — all entries injected (no budget limit)" : "off"}`);
  console.log(`Progress:     ${process.env.MARINARA_EXTENDER_PROGRESS !== "0" ? "on (story-import console bar)" : "off"}`);
});
