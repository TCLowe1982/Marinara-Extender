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
  .why-btn { margin-left: auto; padding: 2px 11px; border-radius: 999px; cursor: pointer;
    background: none; border: 1px solid var(--accent); color: var(--accent); font: inherit; font-size: 11px; }
  .why-btn:hover { background: var(--bg); }
  .why-line { margin-top: 9px; padding-top: 9px; border-top: 1px dashed var(--edge);
    color: var(--muted); font-size: 12.5px; line-height: 1.7; }
  .why-line .k { color: var(--muted); font-size: 11px; }
  .back { background: none; border: 1px solid var(--edge); color: var(--muted); cursor: pointer;
    border-radius: 7px; padding: 4px 11px; font: inherit; font-size: 12px; margin-bottom: 14px; }
  .back:hover { color: var(--text); }
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
    <div id="view"></div>
  </main>
</div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const state = { mode: "entries", scope: "global", scopeId: "global", label: "Global", chatId: null };

// entryId -> the most recent verdict we have for it, across recent turns.
// Built once at load so a memory can answer "was I used, and why not" without
// the reader having to know which chat to look in — the question is about the
// MEMORY, not about a turn they have to go find.
const verdicts = new Map();
let turnsScanned = 0;

const PLAIN = {
  own_match: "its own words matched the message",
  thread_label: "the conversation matched its thread",
  thread_sibling: "a sibling beat in its thread matched strongly",
  recency_rider: "no topical match — rode in on recency because budget remained",
  cold_recall: "reached for in the cold archive after a miss",
  eidetic: "eidetic mode — everything injected",
  resolved: "the thread it belonged to is resolved",
  superseded: "a newer fact replaced it",
  unplayed: "outline canon — excluded from recall by design",
  budget_exhausted: "ranked, but the scope's token budget was already full",
};
const plain = (k) => PLAIN[k] || String(k).replace(/_/g, " ");

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
    b.onclick = () => { pick($("receipts"), b); state.chatId = b.dataset.chat; state.mode = "turn"; render(); };
  }

  await buildVerdicts(rs.slice(0, 8));
  $("hdr").textContent = chars.length + " character(s) · " + rs.length + " recorded turn(s)";
  render();
}

// Newest first, so the first verdict written for an entry is the freshest and
// later (older) turns must not overwrite it.
async function buildVerdicts(rows) {
  for (const row of rows) {
    const r = await get("/api/receipts/" + encodeURIComponent(row.chatId)).catch(() => null);
    if (!r) continue;
    turnsScanned += 1;
    for (const c of r.selected || []) {
      if (!verdicts.has(c.id)) verdicts.set(c.id, { used: true, at: r.createdAt, chatId: r.chatId, reasons: c.reasons || [], relevance: c.relevance });
    }
    for (const c of r.rejected || []) {
      if (!verdicts.has(c.id)) verdicts.set(c.id, { used: false, at: r.createdAt, chatId: r.chatId, rejection: c.rejection, relevance: c.relevance });
    }
  }
}

function select(scope, scopeId, label) {
  Object.assign(state, { scope, scopeId, label, mode: "entries" });
  render();
}

async function render() {
  const el = $("view");
  el.innerHTML = '<div class="empty">loading…</div>';
  try { state.mode === "entries" ? await renderEntries(el) : await renderReceipt(el); }
  catch (err) { el.innerHTML = '<div class="empty">' + esc(err.message) + "</div>"; }
}

async function renderEntries(el) {
  const rows = await get("/api/entries?scope=" + encodeURIComponent(state.scope) + "&scopeId=" + encodeURIComponent(state.scopeId) + "&status=all");
  if (!rows.length) { el.innerHTML = '<div class="empty">No memories stored for ' + esc(state.label) + " yet.</div>"; return; }
  el.innerHTML = '<div class="note">' + rows.length + " memory(ies) in " + esc(state.label) +
      " · click one to read it · <b>Why?</b> shows how it fared in the last " + turnsScanned + " recorded turn(s)</div>" +
    rows.map((r) => '<div class="card" data-id="' + esc(r.id) + '">' +
      '<div class="sum">' + esc(r.summary) + "</div>" +
      '<div class="meta"><span class="pill lane-' + esc(r.lane) + '">' + esc(String(r.lane).replace(/_/g, " ")) + "</span>" +
      '<span class="pill">' + esc(r.status || "open") + "</span>" +
      '<span class="pill">' + esc(r.tokens) + " tok</span>" +
      (r.supersededBy ? '<span class="pill nope">superseded</span>' : "") +
      (r.provenance === "unplayed" ? '<span class="pill nope">outline — never recalled</span>' : "") +
      '<button class="why-btn" data-why="' + esc(r.id) + '">Why?</button>' +
      "<span>" + esc(r.lastAccessed || "") + "</span></div>" +
      '<div class="why-line" hidden></div>' +
      '<div class="body" hidden></div></div>').join("");

  for (const card of el.querySelectorAll(".card")) {
    const body = card.querySelector(".body");
    const why = card.querySelector(".why-line");

    card.querySelector(".why-btn").onclick = (ev) => {
      ev.stopPropagation();            // reading the verdict is not reading the body
      if (!why.hidden) { why.hidden = true; return; }
      why.innerHTML = verdictHtml(card.dataset.id);
      why.hidden = false;
    };

    card.onclick = async () => {
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

/** The verdict for one memory, in plain language. */
function verdictHtml(id) {
  const v = verdicts.get(id);
  if (!v) {
    return turnsScanned
      ? '<span class="pill">not considered</span> It did not come up in the last ' + turnsScanned +
        " recorded turn(s) — nothing has asked for it."
      : '<span class="pill">no data</span> No turns recorded yet, so there is nothing to explain.';
  }
  const when = esc(String(v.at).replace("T", " ").slice(0, 16)) + ' in chat <code>' + esc(v.chatId) + "</code>";
  if (v.used) {
    return '<span class="pill why">injected</span> ' + when + "<br>" +
      (v.reasons || []).map((r) => "· " + esc(plain(r))).join("<br>") +
      '<br><span class="k">relevance ' + (v.relevance ?? 0).toFixed(3) + "</span>";
  }
  return '<span class="pill nope">held back</span> ' + when + "<br>· " + esc(plain(v.rejection)) +
    '<br><span class="k">relevance ' + (v.relevance ?? 0).toFixed(3) + "</span>";
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
    '<button class="back" id="back">← back to memories</button>' +
    '<div class="note">Turn recorded ' + esc(String(r.createdAt).replace("T", " ").slice(0, 19)) +
      " · query " + esc(r.querySize) + " chars · injection <b class=\"status-" + esc(r.injection?.status) + '">' +
      esc(r.injection?.status) + "</b>" + (r.injection?.status === "mismatch"
        ? " — the assembled block did not match what reached the prompt" : "") + "</div>" +
    "<h2>Budget</h2>" + '<div class="bars">' + budgets + "</div>" +
    "<h2>Injected — and why</h2>" + sel +
    "<h2>Considered and rejected — and why</h2>" + rej +
    (r.rejectedTruncated ? '<div class="note">Rejection list truncated; lowest-scoring were dropped first.</div>' : "");

  $("back").onclick = () => { pick($("receipts"), null); state.mode = "entries"; render(); };
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
