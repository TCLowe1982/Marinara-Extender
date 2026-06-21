// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Setup page — served at GET /setup and GET /marinara-extender.js.
// Gives users a one-stop browser page for completing installation without
// hunting through the file system.

import type { FastifyInstance } from "fastify";
import { readFile } from "fs/promises";
import { defaultEnvPath, extensionJsCandidates } from "./paths.js";
import { atomicWriteFile } from "./storage.js";
import { buildVersion } from "./update.js";
import { localUrl, localModel, localEnabled, externalUpstream, externalModel } from "./llm-config.js";

// ── Extension file lookup ─────────────────────────────────────────────────────

async function readExtensionJs(): Promise<string | null> {
  for (const p of extensionJsCandidates()) {
    try {
      return await readFile(p, "utf8");
    } catch {
      // try next
    }
  }
  return null;
}

// ── .env key persistence ──────────────────────────────────────────────────────

// Persist one or more env vars to sidecar/.env and apply them immediately —
// the llm-config getters and getCachedAuth read process.env at call time, so no
// restart is needed. Existing lines for the same keys are replaced.
async function saveEnvVars(vars: Record<string, string>): Promise<void> {
  const envPath = defaultEnvPath();
  let existing = "";
  try { existing = await readFile(envPath, "utf8"); } catch { /* new file */ }

  const keys = Object.keys(vars);
  const lines = existing.split("\n").filter((l) => !keys.some((k) => l.startsWith(`${k}=`)));
  for (const k of keys) lines.push(`${k}=${vars[k]}`);
  await atomicWriteFile(envPath, lines.filter(Boolean).join("\n") + "\n");

  for (const k of keys) process.env[k] = vars[k];
}

async function saveApiKeyToEnv(key: string): Promise<void> {
  await saveEnvVars({ MARINARA_EXTENDER_API_KEY: key });
}

// ── Loader stub ─────────────────────────────────────────────────────────────
// Pasted ONCE into Marinara → Settings → Extensions. On every Marinara load it
// pulls the live extension from this server and runs it the same way Marinara
// would (new Function("marinara", code)). So updating the extension never needs
// a re-paste — just update the server file and reload Marinara. The port is
// baked in so a copied loader always points at the right server. Uses string
// concatenation (no inner template literals) so it survives templating cleanly.
function buildLoaderJs(port: number): string {
  return `/* Marinara Extender — loader. Install ONCE into Marinara → Settings →
   Extensions (name it "Marinara Extender"). It loads the live extension from your
   local Memory Extender every time Marinara loads, so updates never need
   re-importing — just reload Marinara after updating the server.
   CSP note: Marinara's CSP allows blob: scripts but NOT eval/new Function, so the
   fetched code is run via a blob <script>, with the scoped 'marinara' API bridged
   in through a temporary global. */
(async () => {
  const SIDECAR = "http://127.0.0.1:${port}";
  try {
    const res = await fetch(SIDECAR + "/marinara-extender.js?ts=" + Date.now());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const code = await res.text();
    window.__marinaraExtender = marinara;
    // Single source of truth for where the sidecar lives: the extension reads
    // this instead of hardcoding its own address, so a remote/Tailscale install
    // is configured in ONE place — the SIDECAR line of this pasted loader — and
    // both the fetch above and every memory call inside the extension follow it.
    window.__meSidecar = SIDECAR;
    // Wrap so the fetched code sees 'marinara'; leading newline guards against the
    // file starting with a // comment swallowing the wrapper line.
    const wrapped = "(function(marinara){\\n" + code + "\\n})(window.__marinaraExtender);";
    const url = URL.createObjectURL(new Blob([wrapped], { type: "text/javascript" }));
    const s = document.createElement("script");
    s.src = url;
    s.onload = function () { URL.revokeObjectURL(url); };
    document.head.appendChild(s);
    if (marinara.onCleanup) marinara.onCleanup(function () { s.remove(); });
  } catch (err) {
    console.error("[Marinara Extender] Could not load from " + SIDECAR + " — is the Memory Extender running? (Marinara_Extender_Start.bat)", err);
    // Non-technical users never open the console, so surface it on the page.
    try {
      var id = "marinara-extender-offline";
      if (!document.getElementById(id)) {
        var b = document.createElement("div");
        b.id = id;
        // Platform-honest copy. The .bat advice is actively misleading on a phone
        // (there is no Marinara_Extender_Start.bat on Android/iOS) and on Linux/Mac (no
        // .bat at all) — every mobile tester reads "start the .bat" and files the
        // same not-a-bug. The memory server runs on a computer; a phone can't run
        // it locally, so on mobile this is "not reachable", not "not started".
        var ua = navigator.userAgent || "";
        b.textContent = /Android|iPhone|iPad|iPod|Mobile/i.test(ua)
          ? "Marinara Extender: memory server not reachable from this device. It runs on a computer, not the phone — see the mobile setup notes."
          : /Windows/i.test(ua)
            ? "Marinara Extender: memory server not running. Start it (Marinara_Extender_Start.bat), then reload."
            : "Marinara Extender: memory server not reachable. Start the Memory Extender, then reload.";
        b.style.cssText = "position:fixed;bottom:12px;right:12px;z-index:2147483647;max-width:340px;background:#3f1414;color:#fecaca;border:1px solid #f87171;border-radius:8px;padding:10px 14px;font:13px system-ui,-apple-system,sans-serif;line-height:1.4;box-shadow:0 2px 12px rgba(0,0,0,.4)";
        document.body.appendChild(b);
        if (marinara && marinara.onCleanup) marinara.onCleanup(function () { b.remove(); });
        setTimeout(function () { b.remove(); }, 15000);
      }
    } catch (e) {}
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
    .cfgrow{display:flex;align-items:center;gap:10px}
    .cfgrow>span{width:128px;flex-shrink:0;color:#c9c5bf;font-size:12px}
    .cfgrow input{flex:1;min-width:0;background:#0d0c0a;border:1px solid #3d3a36;border-radius:5px;
      color:#e8e5e0;font-family:inherit;font-size:12px;padding:7px 9px}
    .cfgrow input:focus{outline:none;border-color:#f97316}
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
        <p>Download the <strong>loader</strong>, then in Marinara &#8594; Settings &#8594;
           Extensions add a new extension named <strong>Marinara Extender</strong> and
           <strong>upload this file</strong> when it asks:</p>
        <div class="row" style="margin-top:8px">
          <a class="btn-primary" href="/loader.js" download="Marinara Extender.js">
            Download loader (Marinara Extender.js)
          </a>
        </div>
        <p style="margin-top:10px;color:#6b7280;font-size:12px">
          Upload it <strong>once</strong>. The loader pulls the latest extension from this
          server every time Marinara loads, so future updates just need a Marinara reload
          &#8212; never another upload.
        </p>
        <details style="margin-top:8px">
          <summary style="cursor:pointer;color:#6b7280;font-size:12px">If your Marinara lets you paste JS instead of uploading a file</summary>
          <textarea id="loader" readonly rows="6"
            style="width:100%;margin-top:8px;background:#0d0c0a;border:1px solid #3d3a36;border-radius:6px;color:#c9c5bf;font-family:monospace;font-size:11px;line-height:1.45;padding:10px;resize:vertical;white-space:pre;overflow:auto">${escapeHtml(buildLoaderJs(port))}</textarea>
          <div class="row" style="margin-top:8px">
            <button class="btn-primary" id="copyLoader" type="button">Copy loader</button>
            <span id="copied" style="color:#4ade80;font-size:12px;display:none">Copied.</span>
          </div>
        </details>
        <details style="margin-top:8px">
          <summary style="cursor:pointer;color:#6b7280;font-size:12px">Prefer the whole file? (offline / no auto-update &#8212; re-upload on each update)</summary>
          <div class="row" style="margin-top:8px">
            <a class="btn-primary" href="/marinara-extender.js" download="Marinara Extender (full).js">
              Download full extension
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

    <div class="step">
      <div class="step-num">&#9881;</div>
      <div class="step-body">
        <h2>Model &amp; connection <span style="color:#6b7280;font-weight:400;font-size:12px">&#8212; optional</span></h2>
        <p style="color:#6b7280;font-size:12px">Defaults work out of the box with Ollama. Point these at a different
           local server (LM Studio, KoboldCpp, llama.cpp) or set an external API fallback. Saved to <code>.env</code>
           and applied immediately &#8212; no restart.</p>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
          <label class="cfgrow"><span>Local URL</span><input id="cfgLocalUrl" type="text" placeholder="http://127.0.0.1:11434/v1"></label>
          <label class="cfgrow"><span>Local model</span><input id="cfgLocalModel" type="text" placeholder="dolphin3:8b"></label>
          <label class="cfgrow"><span>External upstream</span><input id="cfgExtUpstream" type="text" placeholder="https://api.openai.com"></label>
          <label class="cfgrow"><span>External model</span><input id="cfgExtModel" type="text" placeholder="gpt-4o-mini"></label>
          <label class="cfgrow"><span>API key</span><input id="cfgApiKey" type="password" placeholder="leave blank to keep current"></label>
        </div>
        <div class="row" style="margin-top:10px">
          <button class="btn-primary" id="cfgSave" type="button">Save</button>
          <span id="cfgStatus" style="font-size:12px"></span>
        </div>
        <p style="margin-top:8px;color:#6b7280;font-size:12px">Tip: clear <strong>Local URL</strong> to disable local
           inference and use the external API only.</p>
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

  // Model & connection config form. GET fills the fields; saving mutates /api/*,
  // so it fetches the CSRF token first and sends it in the x-me-csrf header.
  var __csrf = null;
  function __getCsrf() {
    return fetch("/api/csrf-token").then(function (r) { return r.json(); })
      .then(function (j) { __csrf = j && j.token; return __csrf; }).catch(function () { return null; });
  }
  fetch("/api/config").then(function (r) { return r.json(); }).then(function (c) {
    document.getElementById("cfgLocalUrl").value = c.localUrl || "";
    document.getElementById("cfgLocalModel").value = c.localModel || "";
    document.getElementById("cfgExtUpstream").value = c.externalUpstream || "";
    document.getElementById("cfgExtModel").value = c.externalModel || "";
    if (c.apiKeySet) document.getElementById("cfgApiKey").placeholder = "already set - leave blank to keep";
  }).catch(function () {});
  document.getElementById("cfgSave").addEventListener("click", async function () {
    var st = document.getElementById("cfgStatus");
    st.style.color = "#6b7280"; st.textContent = "Saving...";
    var body = {
      localUrl: document.getElementById("cfgLocalUrl").value,
      localModel: document.getElementById("cfgLocalModel").value,
      externalUpstream: document.getElementById("cfgExtUpstream").value,
      externalModel: document.getElementById("cfgExtModel").value
    };
    var key = document.getElementById("cfgApiKey").value;
    if (key && key.trim()) body.apiKey = key;
    try {
      if (!__csrf) await __getCsrf();
      var res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-me-csrf": __csrf || "" },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        st.style.color = "#4ade80"; st.textContent = "Saved. Applied immediately.";
        document.getElementById("cfgApiKey").value = "";
      } else {
        var e = await res.json().catch(function () { return {}; });
        st.style.color = "#f87171"; st.textContent = "Error: " + (e.error || ("HTTP " + res.status));
      }
    } catch (err) {
      st.style.color = "#f87171"; st.textContent = "Error: " + String(err);
    }
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

  // The install-once loader (port baked in). Served as a downloadable file since
  // Marinara's extension import is file-upload, not paste. Upload this once; it
  // pulls the live extension from the server thereafter.
  app.get("/loader.js", async (_req, reply) => {
    reply.header("Content-Type", "text/javascript; charset=utf-8");
    reply.header("Content-Disposition", 'attachment; filename="Marinara Extender.js"');
    return reply.send(buildLoaderJs(port));
  });

  app.get("/marinara-extender.js", async (_req, reply) => {
    const code = await readExtensionJs();
    if (!code) {
      return reply.code(404).send("marinara-extender.js not found — run the server from the memory-extender/ directory.");
    }
    reply.header("Content-Type", "text/plain; charset=utf-8");
    // Stamp the served extension with the sidecar's version so the panel can
    // show what's ACTUALLY loaded in the tab and warn on mismatch — a stale
    // tab running old extension code is otherwise invisible (learned the
    // hard way: a shipped fix "didn't work" because it was never loaded).
    // split/join, NOT replace: the placeholder appears more than once and
    // String.replace with a string pattern only hits the first occurrence.
    // buildVersion (release+commit) so builds within a release are
    // distinguishable and the stale-tab check catches mid-release drift.
    return reply.send(code.split("__ME_VERSION__").join(buildVersion()));
  });

  // Serve the local Rewrite Assistant build for its auto-update loader, which
  // tries this localhost route first (your working build) before GitHub. Path
  // via MARINARA_RWA_PATH; 404 when unset/missing so the loader falls back.
  app.get("/rewrite-assistant.js", async (_req, reply) => {
    const p = process.env.MARINARA_RWA_PATH;
    if (!p) return reply.code(404).send("MARINARA_RWA_PATH not set");
    try {
      const code = await readFile(p, "utf8");
      reply.header("Content-Type", "text/javascript; charset=utf-8");
      return reply.send(code);
    } catch {
      return reply.code(404).send("Rewrite Assistant source not found at MARINARA_RWA_PATH");
    }
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

  // Current effective model/connection config, for the setup page's config form.
  // GET is CSRF-exempt; reads the live values (env or built-in defaults).
  app.get("/api/config", async (_req, reply) => {
    return reply.send({
      localUrl: localUrl(),
      localModel: localModel(),
      localEnabled: localEnabled(),
      externalUpstream: externalUpstream(),
      externalModel: externalModel(),
      apiKeySet: !!(process.env.MARINARA_EXTENDER_API_KEY || "").trim(),
    });
  });

  // Save model/connection config to .env and apply immediately. Mutating /api/*,
  // so the CSRF guard requires the x-me-csrf token (the form fetches it first).
  // Only fields actually present in the body are written. Clearing Local URL
  // (empty string) disables local inference — external API only.
  app.post<{
    Body: { localUrl?: string; localModel?: string; externalUpstream?: string; externalModel?: string; apiKey?: string };
  }>("/api/config", async (req, reply) => {
    const b = req.body ?? {};
    const vars: Record<string, string> = {};
    if (typeof b.localUrl === "string") vars.MARINARA_EXTENDER_LOCAL_URL = b.localUrl.trim();
    if (typeof b.localModel === "string") vars.MARINARA_EXTENDER_LOCAL_MODEL = b.localModel.trim();
    if (typeof b.externalUpstream === "string") vars.MARINARA_EXTENDER_DIGEST_UPSTREAM = b.externalUpstream.trim();
    if (typeof b.externalModel === "string") vars.MARINARA_EXTENDER_DIGEST_MODEL = b.externalModel.trim();
    if (typeof b.apiKey === "string" && b.apiKey.trim()) vars.MARINARA_EXTENDER_API_KEY = b.apiKey.trim();
    if (Object.keys(vars).length === 0) return reply.code(400).send({ error: "no recognized fields" });
    try {
      await saveEnvVars(vars);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.code(500).send({ error: "failed to write .env", detail: String(err) });
    }
  });
}
