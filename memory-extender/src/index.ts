import Fastify from "fastify";
import { readFile } from "fs/promises";
import { join } from "path";
import { registerApiRoutes } from "./api.js";
import { registerSetupRoutes } from "./setup.js";
import { isEideticMode } from "./loader.js";

// ── .env loader ───────────────────────────────────────────────────────────────
// Reads sidecar/.env at startup so users can store their API key once instead
// of re-entering it in every Marinara connection form.

async function loadDotEnv(): Promise<void> {
  try {
    const raw = await readFile(join(process.cwd(), ".env"), "utf8");
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
});

// ── CORS (for extension fetch() calls to /api/*) ──────────────────────────────

app.addHook("onSend", async (_req, reply) => {
  void reply.header("Access-Control-Allow-Origin", "*");
  void reply.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  void reply.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
});

app.options("*", { logLevel: "silent" }, async (_req, reply) => reply.send());

// ── Health ────────────────────────────────────────────────────────────────────

app.get("/api/health", { logLevel: "silent" }, async (_req, reply) => {
  // Check Ollama — strip the /v1 suffix from LOCAL_URL to get the base Ollama URL.
  const localUrl = (process.env.MARINARA_EXTENDER_LOCAL_URL ?? "").replace(/\/v1\/?$/, "");
  let ollama: "ok" | "unavailable" | "not_configured" = "not_configured";
  if (localUrl) {
    try {
      const r = await fetch(localUrl, { signal: AbortSignal.timeout(1000) });
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
  console.log(`Data dir:     ${process.env.MARINARA_EXTENDER_DATA ?? "./data"}`);
  console.log(`Digest URL:   ${process.env.MARINARA_EXTENDER_DIGEST_UPSTREAM ?? "https://api.openai.com"}/v1/chat/completions`);
  console.log(`Digest model: ${process.env.MARINARA_EXTENDER_DIGEST_MODEL ?? "gpt-4o-mini"}`);
  console.log(`API key:      ${apiKey ? `${apiKey.slice(0, 8)}…` : "NOT SET — imports will fail"}`);
  const localUrl = process.env.MARINARA_EXTENDER_LOCAL_URL;
  const localModel = process.env.MARINARA_EXTENDER_LOCAL_MODEL ?? "phi3:mini";
  console.log(`Local model:  ${localUrl ? `${localModel} @ ${localUrl}` : "not configured"}`);
  console.log(`Eidetic mode: ${isEideticMode() ? "ON — all entries injected (no budget limit)" : "off"}`);
  console.log(`Progress:     ${process.env.MARINARA_EXTENDER_PROGRESS !== "0" ? "on (story-import console bar)" : "off"}`);
});
