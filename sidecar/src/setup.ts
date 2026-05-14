// Setup page — served at GET /setup and GET /marinara-extender.js.
// Gives users a one-stop browser page for completing installation without
// hunting through the file system.

import type { FastifyInstance } from "fastify";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";

// ── Extension file lookup ─────────────────────────────────────────────────────

async function readExtensionJs(): Promise<string | null> {
  const candidates = [
    join(process.cwd(), "..", "marinara-extender.js"),
    join(process.cwd(), "marinara-extender.js"),
  ];
  for (const p of candidates) {
    try {
      return await readFile(p, "utf8");
    } catch {
      // try next
    }
  }
  return null;
}

// ── .env key persistence ──────────────────────────────────────────────────────

async function saveApiKeyToEnv(key: string): Promise<void> {
  const envPath = join(process.cwd(), ".env");
  let existing = "";
  try { existing = await readFile(envPath, "utf8"); } catch { /* new file */ }

  const lines = existing.split("\n").filter((l) => !l.startsWith("MARINARA_EXTENDER_API_KEY="));
  lines.push(`MARINARA_EXTENDER_API_KEY=${key}`);
  await writeFile(envPath, lines.filter(Boolean).join("\n") + "\n", "utf8");

  // Take effect immediately without restart
  process.env.MARINARA_EXTENDER_API_KEY = key;
}

// ── Setup page HTML ───────────────────────────────────────────────────────────

function buildSetupHtml(port: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Marinara Extender — Setup</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f0e0c;color:#e8e5e0;font-family:system-ui,-apple-system,sans-serif;
      font-size:14px;line-height:1.6;min-height:100vh;padding:40px 20px}
    .container{max-width:540px;margin:0 auto}
    .header{margin-bottom:32px}
    .status{display:flex;align-items:center;gap:8px;margin-bottom:12px}
    .dot{width:8px;height:8px;border-radius:50%;background:#4ade80}
    .status-text{color:#4ade80;font-size:12px}
    h1{font-size:22px;font-weight:700;color:#fff}
    .subtitle{color:#6b7280;margin-top:4px}
    .steps{display:flex;flex-direction:column;gap:14px}
    .step{background:#1a1917;border:1px solid #2e2b27;border-radius:8px;
      padding:16px 18px;display:flex;gap:14px}
    .step-num{width:24px;height:24px;border-radius:50%;background:#252320;
      border:1px solid #3d3a36;color:#f97316;font-size:12px;font-weight:700;
      display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px}
    .step-num.done{background:#052e1a;border-color:#4ade80;color:#4ade80}
    .step-body{flex:1;min-width:0}
    h2{font-size:15px;font-weight:600;color:#fff;margin-bottom:6px}
    p{color:#c9c5bf;margin-bottom:8px}
    p:last-child{margin-bottom:0}
    .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}
    code{background:#252320;border:1px solid #3d3a36;border-radius:4px;
      padding:2px 7px;font-size:12px;font-family:monospace;color:#f97316}
    .btn-primary{background:#f97316;color:#fff;border:none;border-radius:5px;
      font-size:14px;font-weight:500;cursor:pointer;padding:9px 20px;
      text-decoration:none;display:inline-block;font-family:inherit}
    .btn-primary:hover{background:#ea6a00}
    .note{margin-top:24px;background:#0d1f12;border:1px solid #1a4228;
      border-radius:6px;padding:12px 14px;color:#86efac;font-size:13px}
    .note strong{color:#4ade80}
    .footer{margin-top:24px;text-align:center;color:#4b5563;font-size:12px}
    .footer a{color:#6b7280;text-decoration:none}
    .footer a:hover{color:#9ca3af}
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="status">
      <span class="dot"></span>
      <span class="status-text">Sidecar running on port ${port}</span>
    </div>
    <h1>Marinara Extender</h1>
    <p class="subtitle">Two steps and you&#8217;re done.</p>
  </div>

  <div class="steps">

    <div class="step">
      <div class="step-num done">&#10003;</div>
      <div class="step-body">
        <h2>Start the sidecar</h2>
        <p>Done &#8212; you&#8217;re already here.</p>
      </div>
    </div>

    <div class="step">
      <div class="step-num">2</div>
      <div class="step-body">
        <h2>Install the extension</h2>
        <p>In Marinara &#8594; Settings &#8594; Extensions, add a new extension
           named <strong>Marinara Extender</strong> and upload this file.</p>
        <div class="row" style="margin-top:8px">
          <a class="btn-primary" href="/marinara-extender.js" download="Marinara Extender.js">
            Download Marinara Extender.js
          </a>
        </div>
      </div>
    </div>

    <div class="step">
      <div class="step-num done">&#10003;</div>
      <div class="step-body">
        <h2>Open any character chat</h2>
        <p>That&#8217;s it. The extension handles everything automatically &#8212;
           no special connection, no character card edits needed.</p>
      </div>
    </div>

  </div>

  <div class="note">
    <strong>Import from past chats:</strong> Open the memory panel in any chat
    (&#8801; icon in the chat header) and use the Import section to digest
    old conversations into the character&#8217;s memory.
  </div>

  <div class="footer">
    <a href="https://github.com/Pasta-Devs/Marinara-Engine" target="_blank" rel="noopener">
      Marinara Engine
    </a>
  </div>
</div>
</body>
</html>`;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerSetupRoutes(
  app: FastifyInstance,
  opts: { port: number },
): void {
  const { port } = opts;

  app.get("/setup", async (_req, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    return reply.send(buildSetupHtml(port));
  });

  app.get("/marinara-extender.js", async (_req, reply) => {
    const code = await readExtensionJs();
    if (!code) {
      return reply.code(404).send("marinara-extender.js not found — run the sidecar from the sidecar/ directory.");
    }
    reply.header("Content-Type", "text/plain; charset=utf-8");
    return reply.send(code);
  });

  // Saves the API key to sidecar/.env and applies it immediately.
  // Only reachable on localhost since the sidecar binds to 127.0.0.1.
  app.post<{ Body: { apiKey: string } }>("/api/save-key", async (req, reply) => {
    const { apiKey } = req.body ?? {};
    if (!apiKey?.trim()) {
      return reply.code(400).send({ error: "apiKey is required" });
    }
    try {
      await saveApiKeyToEnv(apiKey.trim());
      return reply.send({ ok: true });
    } catch (err) {
      return reply.code(500).send({ error: "failed to write .env", detail: String(err) });
    }
  });
}
