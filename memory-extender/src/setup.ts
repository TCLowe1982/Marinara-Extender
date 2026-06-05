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

// ── Loader stub ─────────────────────────────────────────────────────────────
// Pasted ONCE into Marinara → Settings → Extensions. On every Marinara load it
// pulls the live extension from this server and runs it the same way Marinara
// would (new Function("marinara", code)). So updating the extension never needs
// a re-paste — just update the server file and reload Marinara. The port is
// baked in so a copied loader always points at the right server. Uses string
// concatenation (no inner template literals) so it survives templating cleanly.
function buildLoaderJs(port: number): string {
  return `/* Marinara Extender — loader. Paste this ONCE into Marinara → Settings →
   Extensions (name it "Marinara Extender"). It loads the live extension from your
   local Memory Extender every time, so updates never need re-pasting — just
   reload Marinara after updating the server. */
(async () => {
  const SIDECAR = "http://127.0.0.1:${port}";
  try {
    const res = await fetch(SIDECAR + "/marinara-extender.js?ts=" + Date.now());
    if (!res.ok) throw new Error("HTTP " + res.status);
    new Function("marinara", await res.text())(marinara);
  } catch (err) {
    console.error("[Marinara Extender] Memory Extender server not reachable at " + SIDECAR + " — is it running? (start.ps1 / Extender_start.bat)", err);
  }
})();`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
      <span class="status-text">Memory Extender running on port ${port}</span>
    </div>
    <h1>Marinara Extender</h1>
    <p class="subtitle">Two steps and you&#8217;re done.</p>
  </div>

  <div class="steps">

    <div class="step">
      <div class="step-num done">&#10003;</div>
      <div class="step-body">
        <h2>Start the Memory Extender</h2>
        <p>Done &#8212; you&#8217;re already here.</p>
      </div>
    </div>

    <div class="step">
      <div class="step-num">2</div>
      <div class="step-body">
        <h2>Install the extension &#8212; once</h2>
        <p>In Marinara &#8594; Settings &#8594; Extensions, add a new extension named
           <strong>Marinara Extender</strong> and paste this loader as its JavaScript:</p>
        <textarea id="loader" readonly rows="6"
          style="width:100%;background:#0d0c0a;border:1px solid #3d3a36;border-radius:6px;color:#c9c5bf;font-family:monospace;font-size:11px;line-height:1.45;padding:10px;resize:vertical;white-space:pre;overflow:auto">${escapeHtml(buildLoaderJs(port))}</textarea>
        <div class="row" style="margin-top:8px">
          <button class="btn-primary" id="copyLoader" type="button">Copy loader</button>
          <span id="copied" style="color:#4ade80;font-size:12px;display:none">Copied &#8212; paste it into the extension.</span>
        </div>
        <p style="margin-top:10px;color:#6b7280;font-size:12px">
          Paste it <strong>once</strong>. It pulls the latest extension from this server
          every time, so future updates just need a Marinara reload &#8212; never another paste.
        </p>
        <details style="margin-top:8px">
          <summary style="cursor:pointer;color:#6b7280;font-size:12px">Prefer the whole file? (offline / no auto-update)</summary>
          <div class="row" style="margin-top:8px">
            <a class="btn-primary" href="/marinara-extender.js" download="Marinara Extender.js">
              Download Marinara Extender.js
            </a>
          </div>
        </details>
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
<script>
  document.getElementById("copyLoader").addEventListener("click", async function () {
    var ta = document.getElementById("loader");
    try { await navigator.clipboard.writeText(ta.value); }
    catch (e) { ta.focus(); ta.select(); try { document.execCommand("copy"); } catch (e2) {} }
    document.getElementById("copied").style.display = "inline";
  });
</script>
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

  // The paste-once loader (port baked in). Handy for reference/automation; the
  // setup page also shows it inline with a copy button.
  app.get("/loader.js", async (_req, reply) => {
    reply.header("Content-Type", "text/plain; charset=utf-8");
    return reply.send(buildLoaderJs(port));
  });

  app.get("/marinara-extender.js", async (_req, reply) => {
    const code = await readExtensionJs();
    if (!code) {
      return reply.code(404).send("marinara-extender.js not found — run the server from the memory-extender/ directory.");
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
