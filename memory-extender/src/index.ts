// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { allowedCorsOrigin } from "./cors.js";
import { loadDotEnv } from "./env.js";
import { getDataDir } from "./storage.js";
import { localUrl, localEnabled, localModel, externalUpstream, externalModel } from "./llm-config.js";
import { getCachedAuth } from "./auth-cache.js";
import { registerApiRoutes } from "./api.js";
import { startPoller } from "./poller.js";
import { handleDetectedTurn } from "./turn-bridge.js";
import { engineUrl } from "./engine-client.js";
import { registerSetupRoutes } from "./setup.js";
import { registerUiRoutes } from "./ui.js";
import { updateStatus, builtAt, distBuiltAt, buildVersion } from "./update.js";
import { embeddingsStatus, describeEmbeddingsStatus } from "./embeddings.js";
import { conversationMemoryEnabled, lorebookSyncEnabled } from "./injection-policy.js";
import { isEideticMode } from "./loader.js";
import { readCaptureStatus } from "./capture-status.js";
import { indexHealth, logIndexHealth, hotEntryCap } from "./index-health.js";

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

// When THIS process started. Paired with builtAt() on /api/health so "is the
// sidecar running current code?" is answerable from one request instead of by
// comparing a process start time against dist mtime in PowerShell.
const STARTED_AT = new Date().toISOString();

// Compute the build string ONCE, at boot, before any request can ask for it.
// It is memoized, and it used to be reached only from request handlers — so its
// value was fixed by whenever somebody first happened to look. Warming it here
// removes that entirely: the answer is decided by the process, not the observer.
buildVersion();

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
  const [update, embeddings, capture] = await Promise.all([updateStatus(), embeddingsStatus(), readCaptureStatus()]);
  // Hot-index size as a tripwire (TC, 2026-08-26). Memoised; see index-health.ts
  // for why this warns rather than enforces.
  const idx = indexHealth();
  // "Is this process running current code?" used to need a PowerShell dance
  // comparing process start time against dist/index.js mtime, because the version
  // string answered a different question (what is git HEAD) and answered it at
  // whatever moment it was first asked. startedAt + builtAt answer it directly
  // and honestly: if builtAt is NEWER than startedAt, the process predates its
  // own dist and is stale. One curl, no self-report to trust.
  // TWO STAMPS, BECAUSE THEY ANSWER DIFFERENT QUESTIONS.
  //   builtAt()     — what the RUNNING code was built from (memoized; correct).
  //   distBuiltAt() — what is on disk RIGHT NOW (fresh read; the only one that
  //                   can change when dist changes).
  // Staleness is disk-vs-process-start. Comparing the memoized value against
  // startedAt can never become true after the first read, which is how this
  // endpoint reported stale:false while running four-hours-old code (2026-08-30).
  const built = builtAt();
  const onDisk = distBuiltAt();
  // Capture liveness (the 08-04 outage lesson): state AND event, together.
  // pollerOn says whether a capture path exists; lastCaptureAt says when one
  // last did real work. Either alone let six days of silence look healthy.
  return reply.send({
    ok: true, ollama, embeddings, ...update,
    startedAt: STARTED_AT,
    builtAt: built,
    distBuiltAt: onDisk,
    stale: onDisk ? onDisk > STARTED_AT : null,
    index: {
      hot: idx.hot,
      cold: idx.cold,
      scopes: idx.scopes,
      coldShare: Number(idx.coldShare.toFixed(4)),
      cap: hotEntryCap(),
      largestCharacter: idx.largest ? { id: idx.largest.id, hot: idx.largest.hot } : null,
      overCap: idx.overCap.map((s) => ({ id: s.id, hot: s.hot })),
      warnings: idx.warnings,
    },
    capture: {
      pollerOn: process.env.MARINARA_EXTENDER_POLLER === "1",
      turnHookOn: process.env.MARINARA_EXTENDER_TURN_HOOK === "1",
      lastCaptureAt: capture?.lastCaptureAt ?? null,
      lastCaptureSource: capture?.source ?? null,
    },
  });
});

// ── OpenAI-compatible inference proxy ─────────────────────────────────────────
// THIS IS THE REWRITE ASSISTANT RELAY, AND IT STAYS. Not to be confused with
// the Engine-facing inference proxy (proxy.ts), which was retired with the hq7
// epic on 2026-08-30 — superseded by the capability package for injection and
// the poller for capture. That one routed the user's OWN chat generations and
// carried their provider credentials; this one deliberately picks the model and
// key for its caller and never sat in the chat path.
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
registerUiRoutes(app);

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
  // Interim access point (c2wd). The memory browser is served at / and /memory but
  // nothing outside it links there, so it was reachable only by knowing the URL.
  // Until hwlj's in-Engine surface lands, the banner IS the discovery path — and it
  // stays the fallback afterwards, since it works with no package installed.
  console.log(`Memories:     http://127.0.0.1:${PORT}/memory   (browse, edit, restore)`);
  console.log(`Data dir:     ${getDataDir()}`);
  console.log(`Local model:  ${localEnabled() ? `${localModel()} @ ${localUrl()}` : "disabled (external only)"}`);
  console.log(`External API: ${apiKey ? `${externalModel()} @ ${externalUpstream()}` : "no key — local only"}`);
  console.log(`Eidetic mode: ${isEideticMode() ? "ON — all entries injected (no budget limit)" : "off"}`);
  console.log(`Progress:     ${process.env.MARINARA_EXTENDER_PROGRESS !== "0" ? "on (story-import console bar)" : "off"}`);
  // Conversation-mode injection state (771t). Printed because it is DEFAULT-ON
  // and the user has no UI to see it: the Engine conversation surface has no
  // agent picker, so this line is the only place the setting is visible.
  console.log(
    `Conv. memory:  ${conversationMemoryEnabled()
      ? "ON — pre-turn recall in Conversation chats (MARINARA_EXTENDER_CONVERSATION_MEMORY=0 to disable)"
      : "off — disabled via MARINARA_EXTENDER_CONVERSATION_MEMORY"}`,
  );
  // Which memory path is live. Two paths writing the same memory compete for one
  // prompt budget and the loser is silently trimmed, so this must be readable.
  console.log(
    `Lorebook sync: ${lorebookSyncEnabled()
      ? "ON — post-turn lorebook write (turn it OFF if the capability package is installed: MARINARA_EXTENDER_LOREBOOK_SYNC=0)"
      : "off — pre-turn injection via the capability package is the path"}`,
  );
  // Hot-index tripwire at startup. Printed unconditionally, warnings and all:
  // the lesson of 7mb6 and 771t is that a silently degraded path is
  // indistinguishable from a working one.
  //
  // ORDER MATTERS, AND IT IS NOT COSMETIC. This runs BEFORE the embeddings probe
  // below, because it is a synchronous YAML.parse over every index in the store —
  // 1,769 ms measured on the live store (74 scopes / 17,180 rows). Fired the other
  // way round, it blocked the event loop straight through the probe’s abort
  // deadline, so the timer was already overdue when the loop came back and won the
  // race against the socket callback. The banner then reported “Ollama is not
  // running” while Ollama was answering /api/tags in 5 ms and every semantic
  // feature was running normally. The tripwire added to catch silent degradation
  // caused a FALSE report of silent degradation in the diagnostic beside it.
  // Keep any new blocking startup work above this line, not between the probe and
  // its result.
  try { logIndexHealth(); } catch { /* never block startup on a diagnostic */ }
  // First-boot embeddings check — semantic degradation must never be silent.
  void embeddingsStatus(5_000).then((s) => console.log(`Embeddings:   ${describeEmbeddingsStatus(s)}`));

  // ── Engine poller (opt-in) ──────────────────────────────────────────────────
  // The replacement for the removed client extension: watch the engine for
  // finished turns, ingest them, and write memory back to the character's
  // lorebook.
  //
  // DEFAULT OFF, deliberately. It writes to real lorebooks (nuke-and-recreate),
  // and anyone still running the extension would get both paths writing the
  // same entries. Turning it on has to be a decision, not a surprise upgrade.
  if (process.env.MARINARA_EXTENDER_POLLER === "1") {
    const intervalMs = parseInt(process.env.MARINARA_EXTENDER_POLLER_INTERVAL_MS ?? "5000", 10);
    console.log(`Engine poller: ON — every ${intervalMs}ms against ${engineUrl()}`);
    console.log(`               (disable with MARINARA_EXTENDER_POLLER=0 if the extension is also running)`);
    startPoller({ intervalMs, onTurn: (turn) => void handleDetectedTurn(turn) });
  } else {
    // Not a neutral "off". The extension is dead (Engine 2.3.4) and the turn
    // hook is opt-in, so with the poller off there is NO live capture path at
    // all — and that exact state ran silently for six days after the 08-04
    // bench quarantine was never lifted. Say what it means, not just what it is.
    const hook = process.env.MARINARA_EXTENDER_TURN_HOOK === "1";
    if (hook) {
      console.log(`Engine poller: off (turn hook is on — capture rides notifications only; swipes covered, missed turns are not)`);
    } else {
      console.warn(`Engine poller: OFF — NOTHING IS CAPTURING. The extension is gone and the turn hook is off,`);
      console.warn(`               so chats are NOT being remembered. Set MARINARA_EXTENDER_POLLER=1 in .env`);
      console.warn(`               unless this is a deliberate quarantine (bench run / second instance).`);
    }
  }

  // ── Engine turn hook (opt-in) ───────────────────────────────────────────────
  // The push counterpart to the poller. Needs the engine side configured too:
  // TURN_NOTIFY_URL=http://127.0.0.1:<port>/api/engine/turn-complete
  //
  // Safe to run alongside the poller — both advance the same watermark under the
  // same per-chat lock, so whichever notices a turn first, the other skips it.
  // It is also the ONLY path that sees a regeneration: a swipe rewrites the
  // message in place without moving the chat's lastMessageAt, so polling cannot
  // detect one at all.
  if (process.env.MARINARA_EXTENDER_TURN_HOOK === "1") {
    console.log(`Engine turn hook: ON — POST /api/engine/turn-complete`);
    console.log(`                  (set the engine's TURN_NOTIFY_URL to http://127.0.0.1:${PORT}/api/engine/turn-complete)`);
  } else {
    console.log(`Engine turn hook: off (set MARINARA_EXTENDER_TURN_HOOK=1 to enable)`);
  }
});
