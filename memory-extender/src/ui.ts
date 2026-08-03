// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// The memory browser.
//
// The browser extension used to own every user-facing surface. It was removed
// with Engine extensions in 2.3.4, which left the store reachable only by
// hand-curling the API — so the people whose memories these are had no way to
// look at them.
//
// This is deliberately a SEPARATE page rather than something embedded in
// Marinara: it keeps working when the capability package is not installed, when
// the Engine is a different version, and when the Engine is not running at all.
// The in-Marinara panel is a later, additive surface — not a replacement.
//
// Slice 1 is READ-ONLY on purpose. Every mutating route is CSRF-guarded (a
// browser page sends Origin, so it must carry a token), and editing memories is
// the operation where a half-built UI does real damage. Reading answers the
// urgent question first: what is stored, and why did recall behave that way.
//
// Self-contained: no CDN, no build step, no external fonts. It is served by the
// same process that owns the data.

import type { FastifyInstance } from "fastify";

const PAGE = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Marinara Extender — Memory</title>
<style>
  :root {
    --bg: #14121a; --panel: #1c1926; --edge: #2e2a3d; --text: #e8e4f0;
    --muted: #9a92b0; --accent: #c9a4ff; --good: #6ee7a8; --warn: #ffb86b; --bad: #ff8095;
    --thread: #6ba8ff; --user: #c58bff; --char: #5fd6a4;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.55 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; }
  header { padding: 14px 20px; border-bottom: 1px solid var(--edge);
    display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; letter-spacing: .01em; }
  header .sub { color: var(--muted); font-size: 12px; }
  .wrap { display: grid; grid-template-columns: 260px 1fr; min-height: calc(100vh - 52px); }
  aside { border-right: 1px solid var(--edge); padding: 14px; overflow: auto; }
  main { padding: 18px 22px; overflow: auto; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .09em;
    color: var(--muted); margin: 18px 0 8px; font-weight: 600; }
  aside h2:first-child { margin-top: 0; }
  .item { padding: 7px 9px; border-radius: 7px; cursor: pointer; color: var(--text);
    display: block; width: 100%; text-align: left; background: none; border: 0;
    font: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item:hover { background: var(--panel); }
  .item.sel { background: var(--panel); box-shadow: inset 2px 0 0 var(--accent); }
  .item .k { color: var(--muted); font-size: 11px; }
  .tabs { display: flex; gap: 6px; margin-bottom: 16px; }
  .tab { padding: 6px 13px; border-radius: 999px; border: 1px solid var(--edge);
    background: none; color: var(--muted); cursor: pointer; font: inherit; }
  .tab.on { color: var(--text); border-color: var(--accent); background: var(--panel); }
  .card { background: var(--panel); border: 1px solid var(--edge); border-radius: 10px;
    padding: 13px 15px; margin-bottom: 10px; }
  .card .sum { font-weight: 600; margin-bottom: 5px; }
  .card .body { color: var(--muted); white-space: pre-wrap; margin-top: 8px;
    padding-top: 8px; border-top: 1px solid var(--edge); font-size: 13px; }
  .meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
    color: var(--muted); font-size: 12px; }
  .pill { padding: 2px 8px; border-radius: 999px; border: 1px solid var(--edge); font-size: 11px; }
  .lane-open_threads { color: var(--thread); border-color: var(--thread); }
  .lane-user_topics { color: var(--user); border-color: var(--user); }
  .lane-character_topics { color: var(--char); border-color: var(--char); }
  .why { color: var(--good); border-color: var(--good); }
  .nope { color: var(--warn); border-color: var(--warn); }
  .status-confirmed { color: var(--good); }
  .status-mismatch { color: var(--bad); }
  .status-pending { color: var(--warn); }
  .empty { color: var(--muted); padding: 30px 0; }
  .bars { display: grid; gap: 7px; margin: 12px 0 20px; }
  .bar { display: grid; grid-template-columns: 90px 1fr auto; gap: 10px; align-items: center;
    font-size: 12px; color: var(--muted); }
  .track { background: var(--bg); border: 1px solid var(--edge); border-radius: 999px; height: 9px; overflow: hidden; }
  .fill { background: var(--accent); height: 100%; }
  code { background: var(--bg); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  .note { color: var(--muted); font-size: 12px; margin: -6px 0 16px; }
</style>
</head>
<body>
<header>
  <h1>Marinara Extender</h1>
  <span class="sub" id="hdr">loading…</span>
</header>
<div class="wrap">
  <aside>
    <h2>Scopes</h2>
    <div id="scopes"></div>
    <h2>Characters</h2>
    <div id="chars"></div>
    <h2>Recent recall</h2>
    <div id="receipts"></div>
  </aside>
  <main>
    <div class="tabs">
      <button class="tab on" data-view="entries">Memories</button>
      <button class="tab" data-view="receipt">Why this recall</button>
    </div>
    <div id="view"></div>
  </main>
</div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const state = { view: "entries", scope: "global", scopeId: "global", label: "Global", chatId: null, open: new Set() };

async function get(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(path + " -> " + res.status);
  return res.json();
}

function pick(el, on) { for (const b of el.querySelectorAll(".item")) b.classList.remove("sel"); if (on) on.classList.add("sel"); }

async function boot() {
  const [idents, receipts] = await Promise.all([
    get("/api/identity").catch(() => ({ entries: [] })),
    get("/api/receipts").catch(() => ({ receipts: [] })),
  ]);

  $("scopes").innerHTML = '<button class="item sel" data-scope="global" data-id="global">Global</button>';
  $("scopes").firstChild.onclick = (e) => { pick($("scopes"), e.target); pick($("chars"), null); select("global", "global", "Global"); };

  const chars = idents.entries ?? [];
  $("chars").innerHTML = chars.length
    ? chars.map((c) => '<button class="item" data-key="' + esc(c.identityKey) + '">' + esc(c.name || c.identityKey) +
        '<div class="k">' + esc(c.identityKey) + '</div></button>').join("")
    : '<div class="empty">none yet</div>';
  for (const b of $("chars").querySelectorAll(".item")) {
    b.onclick = () => { pick($("chars"), b); pick($("scopes"), null); select("character", b.dataset.key, b.textContent.split("\n")[0]); };
  }

  const rs = receipts.receipts ?? [];
  $("receipts").innerHTML = rs.length
    ? rs.slice(0, 12).map((r) => '<button class="item" data-chat="' + esc(r.chatId) + '"><span class="status-' + esc(r.status) + '">●</span> ' +
        esc(r.chatId) + '<div class="k">' + esc(String(r.createdAt).replace("T", " ").slice(0, 16)) + '</div></button>').join("")
    : '<div class="empty">no turns recorded yet</div>';
  for (const b of $("receipts").querySelectorAll(".item")) {
    b.onclick = () => { pick($("receipts"), b); state.chatId = b.dataset.chat; setView("receipt"); };
  }

  $("hdr").textContent = chars.length + " character(s) · " + rs.length + " recorded turn(s)";
  render();
}

function select(scope, scopeId, label) {
  Object.assign(state, { scope, scopeId, label });
  setView("entries");
}

function setView(v) {
  state.view = v;
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("on", t.dataset.view === v);
  render();
}
for (const t of document.querySelectorAll(".tab")) t.onclick = () => setView(t.dataset.view);

async function render() {
  const el = $("view");
  el.innerHTML = '<div class="empty">loading…</div>';
  try { state.view === "entries" ? await renderEntries(el) : await renderReceipt(el); }
  catch (err) { el.innerHTML = '<div class="empty">' + esc(err.message) + "</div>"; }
}

async function renderEntries(el) {
  const rows = await get("/api/entries?scope=" + encodeURIComponent(state.scope) + "&scopeId=" + encodeURIComponent(state.scopeId) + "&status=all");
  if (!rows.length) { el.innerHTML = '<div class="empty">No memories stored for ' + esc(state.label) + " yet.</div>"; return; }
  el.innerHTML = '<div class="note">' + rows.length + " memory(ies) in " + esc(state.label) + " · click one to read it</div>" +
    rows.map((r) => '<div class="card" data-id="' + esc(r.id) + '">' +
      '<div class="sum">' + esc(r.summary) + "</div>" +
      '<div class="meta"><span class="pill lane-' + esc(r.lane) + '">' + esc(String(r.lane).replace(/_/g, " ")) + "</span>" +
      '<span class="pill">' + esc(r.status || "open") + "</span>" +
      '<span class="pill">' + esc(r.tokens) + " tok</span>" +
      (r.supersededBy ? '<span class="pill nope">superseded</span>' : "") +
      (r.provenance === "unplayed" ? '<span class="pill nope">outline — never recalled</span>' : "") +
      "<span>" + esc(r.lastAccessed || "") + "</span></div>" +
      '<div class="body" hidden></div></div>').join("");

  for (const card of el.querySelectorAll(".card")) {
    card.onclick = async () => {
      const body = card.querySelector(".body");
      if (!body.hidden) { body.hidden = true; return; }
      if (!body.dataset.loaded) {
        body.textContent = "loading…"; body.hidden = false;
        const full = await get("/api/entries/" + encodeURIComponent(card.dataset.id) +
          "?scope=" + encodeURIComponent(state.scope) + "&scopeId=" + encodeURIComponent(state.scopeId));
        body.textContent = full.content || "(no body)";
        body.dataset.loaded = "1";
      }
      body.hidden = false;
    };
  }
}

async function renderReceipt(el) {
  if (!state.chatId) { el.innerHTML = '<div class="empty">Pick a recorded turn on the left to see why it recalled what it did.</div>'; return; }
  const r = await get("/api/receipts/" + encodeURIComponent(state.chatId));
  const budgets = (r.scopes || []).map((s) =>
    '<div class="bar"><span>' + esc(s.scope) + "</span><div class=\"track\"><div class=\"fill\" style=\"width:" +
    Math.min(100, s.budget ? Math.round((s.used / s.budget) * 100) : 0) + '%"></div></div><span>' +
    esc(s.used) + " / " + esc(s.budget) + " tok · " + esc(s.selected) + " of " + esc(s.candidates) + "</span></div>").join("");

  const sel = (r.selected || []).map((c) => '<div class="card"><div class="sum">' + esc(c.summary) + "</div>" +
    '<div class="meta"><span class="pill lane-' + esc(c.scope) + '">' + esc(c.scope) + "</span>" +
    (c.reasons || []).map((x) => '<span class="pill why">' + esc(String(x).replace(/_/g, " ")) + "</span>").join("") +
    '<span class="pill">score ' + (c.relevance ?? 0).toFixed(3) + "</span>" +
    '<span class="pill">' + esc(c.tokens) + " tok</span></div></div>").join("")
    || '<div class="empty">Nothing was injected this turn.</div>';

  const rej = (r.rejected || []).map((c) => '<div class="card"><div class="sum">' + esc(c.summary) + "</div>" +
    '<div class="meta"><span class="pill">' + esc(c.scope) + "</span>" +
    '<span class="pill nope">' + esc(String(c.rejection).replace(/_/g, " ")) + "</span>" +
    '<span class="pill">score ' + (c.relevance ?? 0).toFixed(3) + "</span></div></div>").join("")
    || '<div class="empty">Nothing was rejected — everything eligible fit.</div>';

  el.innerHTML =
    '<div class="note">Turn recorded ' + esc(String(r.createdAt).replace("T", " ").slice(0, 19)) +
      " · query " + esc(r.querySize) + " chars · injection <b class=\"status-" + esc(r.injection?.status) + '">' +
      esc(r.injection?.status) + "</b>" + (r.injection?.status === "mismatch"
        ? " — the assembled block did not match what reached the prompt" : "") + "</div>" +
    "<h2>Budget</h2>" + '<div class="bars">' + budgets + "</div>" +
    "<h2>Injected — and why</h2>" + sel +
    "<h2>Considered and rejected — and why</h2>" + rej +
    (r.rejectedTruncated ? '<div class="note">Rejection list truncated; lowest-scoring were dropped first.</div>' : "");
}

boot().catch((e) => { $("hdr").textContent = "cannot reach the memory server — " + e.message; });
</script>
</body>
</html>`;

/** Serves the memory browser. Read-only, so it needs no CSRF token. */
export function registerUiRoutes(app: FastifyInstance): void {
  const send = (_req: unknown, reply: { type: (t: string) => { send: (b: string) => unknown } }) =>
    reply.type("text/html; charset=utf-8").send(PAGE);
  app.get("/", send);
  app.get("/memory", send);
}
