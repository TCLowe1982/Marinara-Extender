// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { readFile } from "fs/promises";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { allowedCorsOrigin } from "./cors.js";
import { defaultEnvPath } from "./paths.js";
import { getDataDir } from "./storage.js";
import { localUrl, localEnabled, localModel, externalUpstream, externalModel } from "./llm-config.js";
import { getCachedAuth } from "./auth-cache.js";
import { registerApiRoutes } from "./api.js";
import { registerSetupRoutes } from "./setup.js";
import { updateStatus } from "./update.js";
import { embeddingsStatus, describeEmbeddingsStatus } from "./embeddings.js";
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
  const [update, embeddings] = await Promise.all([updateStatus(), embeddingsStatus()]);
  return reply.send({ ok: true, ollama, embeddings, ...update });
});

// ── OpenAI-compatible inference proxy ─────────────────────────────────────────
// POST /v1/chat/completions — lets any OpenAI-compatible client (e.g. the
// Rewrite Assistant) route generation through this one sidecar instead of
// running a second local model. Local model first (honouring a per-request
// model override, else the configured default); external API as the fallback —
// the same connection config memory analysis already uses, so a light install
// runs ONE model server for everything.
//
// Deliberately OUTSIDE /api/ so it is exempt from the CSRF guard (a generic
// OpenAI client can't carry the x-me-csrf token). CORS still ensures only
// loopback origins can READ responses, and the server binds 127.0.0.1, so the
// only residual risk is a local page spending compute — not data exfiltration.
const handleChatCompletions = async (req: FastifyRequest, reply: FastifyReply) => {
  const body = (req.body ?? {}) as {
    model?: string;
    messages?: Array<{ role: string; content: string }>;
    temperature?: number;
    max_tokens?: number;
  };
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return reply.code(400).send({ error: { message: "messages[] is required", type: "invalid_request_error" } });
  }
  const base = {
    messages: body.messages,
    temperature: typeof body.temperature === "number" ? body.temperature : 0.7,
    stream: false as const,
    ...(typeof body.max_tokens === "number" ? { max_tokens: body.max_tokens } : {}),
  };

  // 1) Local model — honour a per-request model name, else the configured default.
  if (localEnabled()) {
    try {
      const res = await fetch(`${localUrl()}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...base, model: body.model || localModel() }),
        signal: AbortSignal.timeout(120_000),
      });
      if (res.ok) return reply.code(200).send(await res.json());
    } catch {
      /* fall through to the external fallback */
    }
  }

  // 2) External fallback — uses the configured fallback model (a local model
  //    name wouldn't exist upstream), same path memory analysis falls back to.
  const auth = getCachedAuth();
  if (!auth) {
    return reply.code(502).send({
      error: {
        message:
          "Local model unavailable and no external API key set. Run a local model (MARINARA_EXTENDER_LOCAL_URL/LOCAL_MODEL) or set MARINARA_EXTENDER_API_KEY.",
        type: "upstream_unavailable",
      },
    });
  }
  try {
    const res = await fetch(`${externalUpstream()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ ...base, model: externalModel() }),
    });
    return reply.code(res.status).send(await res.json());
  } catch (e) {
    return reply.code(502).send({ error: { message: `Inference proxy failed: ${String(e)}`, type: "upstream_error" } });
  }
};

app.post("/v1/chat/completions", handleChatCompletions);
app.post("/chat/completions", handleChatCompletions); // alias when the URL is set without the /v1 suffix

// ── Setup page ────────────────────────────────────────────────────────────────
// http://127.0.0.1:{PORT}/setup — one-stop install page with copy buttons.
// http://127.0.0.1:{PORT}/extension.js — raw extension file for the copy button.

registerSetupRoutes(app, { port: PORT });

// ── Management API ────────────────────────────────────────────────────────────

registerApiRoutes(app);

// ── Crash breadcrumb ────────────────────────────────────────────────────────
// A blind crash — the node process vanishing with nothing in the log — once
// cost ~2 hours of stale context: the sidecar died, the engine kept injecting
// the frozen lorebook, and nothing said so. These handlers write a final line
// to the same log the launcher tees to, so the next death names itself.
//
// The write MUST be synchronous: process.on("exit") runs synchronous work only,
// so an async writeFile never flushes before the process is gone — writeFileSync
// or it never lands. Hard kills (taskkill /F, a native V8 fault) still can't log
// from inside the dying process; the launcher watchdog is what catches those.
const BREADCRUMB_LOG = join(dirname(fileURLToPath(import.meta.url)), "..", "logs", "sidecar.log");

function localStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function breadcrumb(reason: string): void {
  try {
    const dir = dirname(BREADCRUMB_LOG);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(BREADCRUMB_LOG, `[${localStamp()}] [breadcrumb] sidecar exiting — ${reason}\n`, { flag: "a" });
  } catch {
    // An exit handler that throws is worse than a missing breadcrumb.
  }
}

process.on("uncaughtException", (err) => {
  breadcrumb(`uncaughtException: ${err?.stack ?? err}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  breadcrumb(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
  process.exit(1);
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => { breadcrumb(`signal ${sig}`); process.exit(0); });
}
process.on("exit", (code) => breadcrumb(`process exit (code ${code})`));

// ── Boot ──────────────────────────────────────────────────────────────────────

app.listen({ port: PORT, host: "127.0.0.1" }, (err) => {
  if (err) {
    // The common failure is EADDRINUSE: another sidecar already owns the port.
    // A raw stack dump in a console window that closes a beat later is useless
    // ("the extender keeps closing") — say plainly what happened and how to
    // fix it. The guarded launcher (Marinara_Extender_Start.bat) catches this earlier;
    // `npm start` and double-launches land here.
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(`\n  Marinara Extender is already running on port ${PORT}.`);
      console.error(`  This window is a DUPLICATE — the running one is fine; close this one.`);
      console.error(`  If memory seems dead, fully close every sidecar window, then launch once`);
      console.error(`  with Marinara_Extender_Start.bat (it refuses to start a second copy).\n`);
    } else {
      console.error(err);
    }
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
  // First-boot embeddings check — semantic degradation must never be silent.
  void embeddingsStatus().then((s) => console.log(`Embeddings:   ${describeEmbeddingsStatus(s)}`));
});
