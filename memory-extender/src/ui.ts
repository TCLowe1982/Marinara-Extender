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
// Slice 1 was READ-ONLY on purpose — editing memories is where a half-built UI
// does real damage, and reading answered the urgent question first: what is
// stored, and why did recall behave that way.
//
// Slice 2 adds the mutations (edit / delete / restore / purge). Two rules govern
// them, and both are load-bearing rather than decorative:
//
//   Delete is SOFT and the page says so at the point of action. The store's
//   whole design rests on never destroying a memory on a single action —
//   supersession is a tier move, cold storage is demotion not compression — and
//   a delete button that silently contradicted that would be the one place the
//   UI lied about the architecture. Purge, the single irreversible action in the
//   product, is reachable only from inside the deleted view.
//
//   Mutations live ON the memory, next to Why?, for the reason TC gave when Why?
//   was a top-level tab: model the surface around the question the reader is
//   holding ("should this be here?"), not around the shape of the operation.
//
// Every mutating route is CSRF-guarded. This page is served BY the sidecar, but
// same-origin does not exempt it: browsers send Origin on non-GET fetches, so
// the token is required here exactly as it is for any other client.
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
  .cap { font-size: 12px; padding: 2px 10px; border-radius: 999px; border: 1px solid transparent; }
  .cap-ok { color: var(--muted); border-color: var(--edge); }
  .cap-dead { color: #fff; background: #b91c1c; font-weight: 600; }
  header nav { margin-left: auto; display: flex; gap: 14px; }
  header nav a { color: var(--accent); font-size: 12px; text-decoration: none; }
  header nav a:hover { text-decoration: underline; }
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
  .why-btn { padding: 2px 11px; border-radius: 999px; cursor: pointer;
    background: none; border: 1px solid var(--accent); color: var(--accent); font: inherit; font-size: 11px; }
  .why-btn:hover { background: var(--bg); }
  .why-line { margin-top: 9px; padding-top: 9px; border-top: 1px dashed var(--edge);
    color: var(--muted); font-size: 12.5px; line-height: 1.7; }
  .why-line .k { color: var(--muted); font-size: 11px; }
  .back { background: none; border: 1px solid var(--edge); color: var(--muted); cursor: pointer;
    border-radius: 7px; padding: 4px 11px; font: inherit; font-size: 12px; margin-bottom: 14px; }
  .back:hover { color: var(--text); }

  /* Action buttons share the Why? shape so nothing reads as more important than
     it is — except the destructive ones, which are coloured to be found. */
  .act { padding: 2px 11px; border-radius: 999px; cursor: pointer; background: none;
    border: 1px solid var(--edge); color: var(--muted); font: inherit; font-size: 11px; }
  .act:hover { background: var(--bg); color: var(--text); }
  .act.danger { border-color: var(--bad); color: var(--bad); }
  .act.go { border-color: var(--good); color: var(--good); }
  .act[disabled] { opacity: .5; cursor: default; }
  .acts { display: flex; gap: 6px; margin-left: auto; }

  .edit { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--edge); display: grid; gap: 8px; }
  .edit label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
  .edit input, .edit textarea, .edit select {
    width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--edge);
    border-radius: 7px; padding: 8px 10px; font: inherit; font-size: 13px; }
  .edit textarea { min-height: 120px; resize: vertical; line-height: 1.55; }
  .edit .row { display: flex; gap: 8px; align-items: center; }
  .edit .row select { width: auto; }

  /* Reversibility is stated where the action is taken, not in a doc nobody opens. */
  .confirm { margin-top: 10px; padding: 10px 12px; border-radius: 8px;
    border: 1px solid var(--bad); background: rgba(255,128,149,.07); font-size: 13px; }
  .confirm .row { display: flex; gap: 8px; margin-top: 9px; align-items: center; }
  .toast { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%);
    background: var(--panel); border: 1px solid var(--edge); border-radius: 9px;
    padding: 9px 15px; font-size: 13px; box-shadow: 0 6px 24px rgba(0,0,0,.45); z-index: 9; }
  .toast.bad { border-color: var(--bad); color: var(--bad); }
  .card.gone { opacity: .55; }
  .viewbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }

  /* Held for review (4z0h). Severity is carried by the left stripe so what needs
     attention reads before any of the words do. */
  .tally { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
  .stat { background: var(--panel); border: 1px solid var(--edge); border-radius: 10px;
    padding: 9px 13px; display: grid; gap: 1px; min-width: 104px; }
  .stat .v { font-size: 19px; font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums; }
  .stat .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .07em; }
  .stat.recited .v { color: var(--bad); }
  .stat.orphan .v { color: var(--warn); }
  .stat.thread .v { color: var(--thread); }
  .stat.retrieved .v { color: var(--muted); }
  .card[class*="s-"] { border-left-width: 3px; padding-left: 17px; }
  .card.s-recited { border-left-color: var(--bad); }
  .card.s-orphan { border-left-color: var(--warn); }
  .card.s-thread { border-left-color: var(--thread); }
  .card.s-retrieved { border-left-color: var(--muted); }
  /* NOT ".why" — that is already a pill modifier (colour only) and a block-level
     rule of the same name would silently restyle every <span class="pill why">. */
  .hl-why { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--edge);
    display: grid; gap: 7px; font-size: 13px; color: var(--muted); line-height: 1.6; }
  .hl-why .r { display: grid; grid-template-columns: 8px 1fr; gap: 10px; align-items: start; }
  .hl-why .dot { width: 7px; height: 7px; border-radius: 50%; margin-top: 7px; }
  .hl-why .r.recited .dot { background: var(--bad); }
  .hl-why .r.orphan .dot { background: var(--warn); }
  .hl-why .r.thread .dot { background: var(--thread); }
  .hl-why .r.retrieved .dot { background: var(--muted); }
  .hl-why b { color: var(--text); font-weight: 600; }
  .acts { margin-top: 11px; }
  .prov { margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--edge);
    display: flex; gap: 14px; flex-wrap: wrap; color: var(--muted); font-size: 11.5px;
    font-variant-numeric: tabular-nums; }
  .acts .act[disabled] { opacity: .5; cursor: default; }
</style>
</head>
<body>
<header>
  <h1>Marinara Extender</h1>
  <span class="sub" id="hdr">loading…</span>
  <span class="cap" id="capture"></span>
  <nav><a href="/setup">setup</a><a href="/prompts">prompts</a></nav>
</header>
<div class="wrap">
  <aside>
    <h2>Scopes</h2>
    <div id="scopes"></div>
    <h2>Characters</h2>
    <div id="chars"></div>
    <h2>Recent recall</h2>
    <div id="receipts"></div>
    <h2>Needs you</h2>
    <div id="held-nav"></div>
  </aside>
  <main>
    <div id="view"></div>
  </main>
</div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const state = { mode: "entries", scope: "global", scopeId: "global", label: "Global", chatId: null };
const VALID_STATUSES = ["open", "in_progress", "done", "deferred"];

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

// ── Mutating requests ────────────────────────────────────────────────────────
// The CSRF token is minted per PROCESS, so a sidecar restart silently
// invalidates whatever this page is holding — and the page can outlive the
// server easily (a tab left open overnight). One 403 therefore means "stale",
// not "forbidden": refetch once and retry, and only then surface a failure.

let csrf = null;

async function loadCsrf() {
  csrf = (await get("/api/csrf-token")).token;
  return csrf;
}

async function send(method, path, body) {
  const attempt = async () => fetch(path, {
    method,
    headers: Object.assign({ "x-me-csrf": csrf || "" }, body ? { "content-type": "application/json" } : {}),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  let res = await attempt();
  if (res.status === 403) {          // stale token — the sidecar restarted
    await loadCsrf().catch(() => {});
    res = await attempt();
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || method + " " + path + " -> " + res.status);
  }
  return res.json().catch(() => ({}));
}

let toastTimer = null;
function toast(message, bad) {
  const prev = document.querySelector(".toast");
  if (prev) prev.remove();
  clearTimeout(toastTimer);
  const el = document.createElement("div");
  el.className = "toast" + (bad ? " bad" : "");
  el.textContent = message;
  document.body.appendChild(el);
  toastTimer = setTimeout(() => el.remove(), bad ? 6000 : 3200);
}

const q = () => "scope=" + encodeURIComponent(state.scope) + "&scopeId=" + encodeURIComponent(state.scopeId);

function pick(el, on) { for (const b of el.querySelectorAll(".item")) b.classList.remove("sel"); if (on) on.classList.add("sel"); }

async function boot() {
  const [idents, receipts] = await Promise.all([
    get("/api/identity").catch(() => ({ entries: [] })),
    get("/api/receipts").catch(() => ({ receipts: [] })),
    // Not fatal: the page is useful read-only without it, and send() refetches
    // on the first 403 anyway. Failing boot over an unusable Edit button would
    // trade the whole browser for one feature.
    loadCsrf().catch(() => {}),
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
  await loadCaptureStatus().catch(() => {});
  await loadHeldCount().catch(() => {});
  render();
}

// Capture liveness (the 08-04 outage: six days of silence that looked healthy
// from every page anyone was reading). Two facts, one line: does a capture
// path EXIST (poller/hook state), and when did one last DO anything (event).
// Red only for the true outage state — no path at all. A stale timestamp with
// the poller on just means nobody has chatted, and crying wolf about idle
// time is how warnings get ignored.
async function loadCaptureStatus() {
  const h = await fetch("/api/health").then((r) => r.json());
  const c = h.capture ?? {};
  const el = $("capture");
  const last = c.lastCaptureAt ? new Date(c.lastCaptureAt) : null;
  const ago = last ? Math.round((Date.now() - last.getTime()) / 60000) : null;
  const agoText = ago === null ? "never"
    : ago < 1 ? "just now"
    : ago < 60 ? ago + "m ago"
    : ago < 2880 ? Math.round(ago / 60) + "h ago"
    : Math.round(ago / 1440) + "d ago";
  if (!c.pollerOn && !c.turnHookOn) {
    el.className = "cap cap-dead";
    el.textContent = "NOT CAPTURING — no poller, no hook · last turn " + agoText;
  } else {
    el.className = "cap cap-ok";
    el.textContent = "capturing (" + (c.pollerOn ? "poller" : "hook") + ") · last turn " + agoText +
      (c.lastCaptureSource === "backfill" ? " (backfill)" : "");
  }
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

const VIEWS = { entries: renderEntries, turn: renderReceipt, deleted: renderDeleted, held: renderHeld };

// ── Held for review (4z0h) ───────────────────────────────────────────────────
// Its OWN sidebar entry, deliberately not folded under "Recently deleted". These
// memories were retired because a re-roll threw away the reply they came from —
// the user deleted nothing, and filing them under deletes would reassert exactly
// the conflation that discardedAt exists to prevent. (No backticks in here —
// this whole block lives inside the String.raw page template.)

// Same discipline as the recall panel above: a closed vocabulary underneath so
// the signals stay countable, plain language on the surface. A reader is judging
// a memory, not reading a log line.
function heldReason(raw) {
  const [kind, rest] = String(raw).split(":");
  if (kind === "recited") {
    const n = Number(rest) || 1;
    return { cls: "recited", text: "The character has <b>said this in a reply" +
      (n > 1 ? ", " + n + " times" : "") + "</b> since it was captured. Retiring the memory " +
      "does not retract what was already said." };
  }
  if (kind === "retrieved") {
    const n = Number(rest) || 1;
    return { cls: "retrieved", text: "It was put in front of the character <b>" + n +
      (n === 1 ? " time" : " times") + "</b> but never repeated back, so it may have steered a " +
      "reply without being quoted. The weakest signal — usually safe to leave retired." };
  }
  if (kind === "thread") {
    return { cls: "thread", text: "It belongs to a <b>thread</b> that runs across scenes and " +
      "outlives the turn it came from. Removing it quietly changes the shape of a storyline." };
  }
  if (kind === "orphans") {
    return { cls: "orphan", text: "It <b>replaced an older memory</b>. With this one retired, " +
      "nothing live stands in its place — the older memory stays retired too, behind a memory " +
      "that is gone. One of the two probably wants to be active." };
  }
  return null;
}

// The strongest signal present, which drives the card's stripe. Order is the same
// one discard-review.ts ranks by, so the UI cannot disagree with the detector.
function heldSeverity(reasons) {
  for (const k of ["recited", "orphans", "thread", "retrieved"]) {
    if (reasons.some((r) => r.startsWith(k + ":"))) return k === "orphans" ? "orphan" : k;
  }
  return "retrieved";
}

async function renderHeld(el) {
  const { held } = await get("/api/held");
  if (!held.length) {
    el.innerHTML =
      '<div class="empty" style="border:1px dashed var(--edge);border-radius:10px;padding:34px 26px;text-align:center">' +
      '<div style="color:var(--good);font-size:15px;font-weight:600;margin-bottom:6px">Nothing held</div>' +
      "<p style=\"margin:0 auto;max-width:56ch;font-size:13px\">Re-rolls are retiring cleanly. A memory only " +
      "lands here when the reply it came from was thrown away <em>after</em> the memory had already been " +
      "used — said out loud, put on a thread, or standing in for an older memory.</p></div>";
    return;
  }

  const tally = {};
  for (const h of held) tally[heldSeverity(h.reasons || [])] = (tally[heldSeverity(h.reasons || [])] || 0) + 1;
  const stat = (k, label) => tally[k]
    ? '<div class="stat ' + k + '"><span class="v">' + tally[k] + '</span><span class="k">' + label + "</span></div>"
    : "";

  el.innerHTML =
    '<div class="tally">' + stat("recited", "Recited") + stat("orphan", "Orphaned") +
      stat("thread", "On a thread") + stat("retrieved", "Reached the prompt") + "</div>" +
    '<p class="note">A re-roll retires whatever the discarded reply taught. These are the ones ' +
      "retirement did not settle — the memory had already gone somewhere before it was thrown away. " +
      "Nothing here is urgent, and nothing is blocking a chat.</p>" +
    held.map(heldCard).join("");

  for (const btn of el.querySelectorAll("[data-held]")) {
    btn.addEventListener("click", () => resolveHeldRecord(btn));
  }
}

function heldCard(h) {
  const d = h.detail || {};
  const reasons = (h.reasons || []).filter((r) => r !== "discarded-swipe");
  const sev = heldSeverity(reasons);
  const lines = reasons.map(heldReason).filter(Boolean)
    .map((r) => '<div class="r ' + r.cls + '"><span class="dot"></span><span>' + r.text + "</span></div>").join("");
  const orphaned = (d.orphaned || [])[0];
  const arg = (a) => "data-held='" + esc(JSON.stringify({
    id: h.id, action: a, scope: h.scope, scopeId: h.scopeId, entryId: d.entryId, displacedId: orphaned,
  })) + "'";

  return '<article class="card s-' + sev + '" data-card="' + esc(h.id) + '">' +
    '<div class="sum">' + esc(d.entrySummary || h.summary) + "</div>" +
    '<div class="meta">' +
      (d.lane ? '<span class="pill lane-' + esc(d.lane) + '">' + esc(d.lane) + "</span>" : "") +
      "<span>" + esc(h.scopeId) + "</span>" +
    "</div>" +
    '<div class="hl-why">' + lines + "</div>" +
    '<div class="prov">' +
      (d.sourceMessageId ? "<span>msg " + esc(d.sourceMessageId) + "</span>" : "") +
      (d.sourceSwipeIndex !== undefined ? "<span>swipe " + esc(d.sourceSwipeIndex) + " discarded</span>" : "") +
      (d.discardedAt ? "<span>" + esc(String(d.discardedAt).replace("T", " ").slice(0, 16)) + "</span>" : "") +
    "</div>" +
    '<div class="acts">' +
      (orphaned ? '<button class="act go" ' + arg("restore-displaced") + ">Restore the older memory</button>" : "") +
      '<button class="act" ' + arg("restore-entry") + ">Bring this one back</button>" +
      '<button class="act" ' + arg("dismiss") + ">Leave it retired</button>" +
    "</div></article>";
}

async function resolveHeldRecord(btn) {
  const body = JSON.parse(btn.getAttribute("data-held"));
  for (const b of btn.parentElement.querySelectorAll("button")) b.disabled = true;
  try {
    await send("POST", "/api/held/resolve", body);
    toast(body.action === "dismiss" ? "Left retired" : "Restored");
    await loadHeldCount();
    await render();
  } catch (err) {
    for (const b of btn.parentElement.querySelectorAll("button")) b.disabled = false;
    toast(err.message, true);
  }
}

// The sidebar entry only appears when there is something in it. An always-visible
// "0" trains the eye to skip the row, which is the opposite of what a lane is for.
async function loadHeldCount() {
  const nav = $("held-nav");
  if (!nav) return;
  let n = 0;
  try { n = (await get("/api/held")).held.length; } catch { return; }
  const heading = nav.previousElementSibling;
  if (!n) {
    nav.innerHTML = "";
    if (heading) heading.style.display = "none";
    if (state.mode === "held") { state.mode = "entries"; }
    return;
  }
  if (heading) heading.style.display = "";
  nav.innerHTML = '<button class="item' + (state.mode === "held" ? " sel" : "") + '" id="go-held">' +
    '<span class="lbl">Held for review</span><span class="n" style="margin-left:auto;color:var(--warn)">' + n + "</span></button>";
  $("go-held").addEventListener("click", () => { state.mode = "held"; render(); loadHeldCount(); });
}

async function render() {
  const el = $("view");
  el.innerHTML = '<div class="empty">loading…</div>';
  try { await VIEWS[state.mode](el); }
  catch (err) { el.innerHTML = '<div class="empty">' + esc(err.message) + "</div>"; }
}

async function renderEntries(el) {
  const rows = await get("/api/entries?" + q() + "&status=all");
  const bar = '<div class="viewbar"><button class="act" id="see-deleted">Recently deleted…</button></div>';
  if (!rows.length) {
    el.innerHTML = bar + '<div class="empty">No memories stored for ' + esc(state.label) + " yet.</div>";
    $("see-deleted").onclick = () => { state.mode = "deleted"; render(); };
    return;
  }
  el.innerHTML = bar +
    '<div class="note">' + rows.length + " memory(ies) in " + esc(state.label) +
      " · click one to read it · <b>Why?</b> shows how it fared in the last " + turnsScanned + " recorded turn(s)</div>" +
    rows.map((r) => '<div class="card" data-id="' + esc(r.id) + '">' +
      '<div class="sum">' + esc(r.summary) + "</div>" +
      '<div class="meta"><span class="pill lane-' + esc(r.lane) + '">' + esc(String(r.lane).replace(/_/g, " ")) + "</span>" +
      '<span class="pill st">' + esc(r.status || "open") + "</span>" +
      '<span class="pill tok">' + esc(r.tokens) + " tok</span>" +
      (r.supersededBy ? '<span class="pill nope">superseded</span>' : "") +
      (r.provenance === "unplayed" ? '<span class="pill nope">outline — never recalled</span>' : "") +
      '<span>' + esc(r.lastAccessed || "") + "</span>" +
      '<span class="acts">' +
        '<button class="why-btn">Why?</button>' +
        '<button class="act edit-btn">Edit</button>' +
        '<button class="act danger del-btn">Delete</button>' +
      "</span></div>" +
      '<div class="why-line" hidden></div>' +
      '<div class="body" hidden></div>' +
      '<div class="pane"></div></div>').join("");

  $("see-deleted").onclick = () => { state.mode = "deleted"; render(); };

  for (const card of el.querySelectorAll(".card")) {
    const body = card.querySelector(".body");
    const why = card.querySelector(".why-line");
    const pane = card.querySelector(".pane");   // holds the editor / delete confirm
    const id = card.dataset.id;

    // Load the entry body once; both reading and editing need it.
    const full = async () => {
      if (!body.dataset.loaded) {
        const e = await get("/api/entries/" + encodeURIComponent(id) + "?" + q());
        body.textContent = e.content || "(no body)";
        body.dataset.loaded = "1";
        card.dataset.content = e.content || "";
      }
      return card.dataset.content || "";
    };

    card.querySelector(".why-btn").onclick = (ev) => {
      ev.stopPropagation();            // reading the verdict is not reading the body
      if (!why.hidden) { why.hidden = true; return; }
      why.innerHTML = verdictHtml(id);
      why.hidden = false;
    };

    card.querySelector(".edit-btn").onclick = async (ev) => {
      ev.stopPropagation();
      if (pane.dataset.open === "edit") { closePane(pane); return; }
      const content = await full();
      openEditor(card, pane, id, content);
    };

    card.querySelector(".del-btn").onclick = (ev) => {
      ev.stopPropagation();
      if (pane.dataset.open === "del") { closePane(pane); return; }
      openDeleteConfirm(card, pane, id);
    };

    card.onclick = async () => {
      if (!body.hidden) { body.hidden = true; return; }
      body.textContent = body.dataset.loaded ? body.textContent : "loading…";
      body.hidden = false;
      await full();
    };
  }
}

function closePane(pane) { pane.innerHTML = ""; delete pane.dataset.open; }

/**
 * Inline editor. Deliberately not a modal: the surrounding card carries the
 * lane, the status and the recall verdict, and those are exactly the context
 * someone needs while deciding what to change. A modal would hide them.
 */
function openEditor(card, pane, id, content) {
  pane.dataset.open = "edit";
  const status = card.querySelector(".st").textContent.trim();
  const summary = card.querySelector(".sum").textContent;
  pane.innerHTML =
    '<div class="edit">' +
      "<div><label>Summary</label><input class=\"f-sum\" value=\"" + esc(summary) + "\"></div>" +
      "<div><label>Body</label><textarea class=\"f-body\">" + esc(content) + "</textarea></div>" +
      '<div class="row"><label>Status</label><select class="f-status">' +
        VALID_STATUSES.map((s) => '<option value="' + s + '"' + (s === status ? " selected" : "") + ">" +
          s.replace(/_/g, " ") + "</option>").join("") +
      "</select>" +
      '<span class="acts"><button class="act save">Save</button>' +
      '<button class="act cancel">Cancel</button></span></div>' +
      '<div class="note" style="margin:0">Marking an open thread <b>done</b> retires it from recall — it stays stored and readable.</div>' +
    "</div>";

  pane.querySelector(".cancel").onclick = (ev) => { ev.stopPropagation(); closePane(pane); };
  pane.onclick = (ev) => ev.stopPropagation();   // typing must not toggle the body

  pane.querySelector(".save").onclick = async (ev) => {
    ev.stopPropagation();
    const btn = ev.target;
    btn.disabled = true; btn.textContent = "saving…";
    try {
      const r = await send("PATCH", "/api/entries/" + encodeURIComponent(id), {
        scope: state.scope, scopeId: state.scopeId,
        summary: pane.querySelector(".f-sum").value,
        content: pane.querySelector(".f-body").value,
        status: pane.querySelector(".f-status").value,
      });
      // Patch the card in place rather than re-rendering the list: a re-render
      // would collapse every other card the reader had opened.
      const e = r.entry || {};
      card.querySelector(".sum").textContent = e.summary ?? "";
      card.querySelector(".st").textContent = e.status ?? "open";
      card.querySelector(".tok").textContent = (e.tokens ?? 0) + " tok";
      card.dataset.content = e.content ?? "";
      card.querySelector(".body").textContent = e.content || "(no body)";
      closePane(pane);
      toast("Saved.");
    } catch (err) {
      btn.disabled = false; btn.textContent = "Save";
      toast(err.message, true);
    }
  };
}

/**
 * Delete confirmation.
 *
 * The wording is the feature. Delete here is a SOFT delete — the entry moves to
 * cold storage and stays recoverable — and that has to be said at the point of
 * action, because every instinct a user brings to a red button says otherwise.
 * The store never destroys a memory on one action anywhere else in the
 * architecture; this is the one screen where that promise is visible.
 */
function openDeleteConfirm(card, pane, id) {
  pane.dataset.open = "del";
  pane.innerHTML =
    '<div class="confirm">Delete this memory? It moves to <b>Recently deleted</b> and can be restored — ' +
    "nothing is destroyed by this action." +
    '<div class="row"><button class="act danger yes">Delete</button>' +
    '<button class="act no">Cancel</button></div></div>';
  pane.onclick = (ev) => ev.stopPropagation();
  pane.querySelector(".no").onclick = () => closePane(pane);
  pane.querySelector(".yes").onclick = async (ev) => {
    const btn = ev.target;
    btn.disabled = true;
    try {
      await send("DELETE", "/api/entries/" + encodeURIComponent(id) + "?" + q());
      card.classList.add("gone");
      closePane(pane);
      card.querySelector(".acts").innerHTML = '<span class="pill nope">deleted — recoverable</span>';
      toast("Moved to Recently deleted.");
    } catch (err) {
      btn.disabled = false;
      toast(err.message, true);
    }
  };
}

/**
 * The recovery view — and the only place purge is reachable.
 *
 * Purge is the single irreversible action in the product, so it is deliberately
 * two decisions deep: come in here on purpose, then confirm. It is not offered
 * on the main list at all, because a control that destroys data should never sit
 * one misclick from a control that does not.
 */
async function renderDeleted(el) {
  const { deleted } = await get("/api/deleted?" + q());
  const bar = '<button class="back" id="back-del">← back to memories</button>';
  if (!deleted || !deleted.length) {
    el.innerHTML = bar + '<div class="empty">Nothing deleted in ' + esc(state.label) + ".</div>";
    $("back-del").onclick = back;
    return;
  }
  el.innerHTML = bar +
    '<div class="note">' + deleted.length + " deleted memory(ies) in " + esc(state.label) +
      " · restore puts one back into recall · purge is permanent</div>" +
    deleted.map((r) => '<div class="card" data-id="' + esc(r.id) + '">' +
      '<div class="sum">' + esc(r.summary) + "</div>" +
      // listDeleted returns { id, summary, lane, deletedAt } only — no tokens.
      '<div class="meta"><span class="pill lane-' + esc(r.lane) + '">' + esc(String(r.lane).replace(/_/g, " ")) + "</span>" +
      "<span>deleted " + esc(String(r.deletedAt || "").replace("T", " ").slice(0, 16)) + "</span>" +
      '<span class="acts"><button class="act go restore-btn">Restore</button>' +
      '<button class="act danger purge-btn">Purge…</button></span></div>' +
      '<div class="pane"></div></div>').join("");

  $("back-del").onclick = back;

  for (const card of el.querySelectorAll(".card")) {
    const id = card.dataset.id;
    const pane = card.querySelector(".pane");

    card.querySelector(".restore-btn").onclick = async (ev) => {
      ev.target.disabled = true;
      try {
        await send("POST", "/api/entries/" + encodeURIComponent(id) + "/restore?" + q());
        card.remove();
        toast("Restored.");
      } catch (err) { ev.target.disabled = false; toast(err.message, true); }
    };

    card.querySelector(".purge-btn").onclick = () => {
      if (pane.dataset.open) { closePane(pane); return; }
      pane.dataset.open = "purge";
      pane.innerHTML =
        '<div class="confirm"><b>Permanently destroy this memory?</b> Unlike Delete, this cannot be undone — ' +
        "the entry and its file are removed. Restore it instead if you are unsure." +
        '<div class="row"><button class="act danger yes">Purge permanently</button>' +
        '<button class="act no">Cancel</button></div></div>';
      pane.querySelector(".no").onclick = () => closePane(pane);
      pane.querySelector(".yes").onclick = async (ev) => {
        ev.target.disabled = true;
        try {
          await send("DELETE", "/api/entries/" + encodeURIComponent(id) + "?" + q() + "&purge=true");
          card.remove();
          toast("Purged permanently.");
        } catch (err) { ev.target.disabled = false; toast(err.message, true); }
      };
    };
  }
}

function back() { state.mode = "entries"; render(); }

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

  // ── /prompts (pifl) ────────────────────────────────────────────────────────
  // Every prompt the sidecar sends a model, ASSEMBLED, read from the running
  // build so it can never drift from what is actually being sent. The prompts
  // live as template literals across six files and are stitched together at call
  // time; reading one meant assembling it by hand, so in practice nobody did —
  // which is how a prompt EXAMPLE became 9% of the beat store.
  //
  // docs/PROMPTS.md is the same content, committed, so a prompt change also shows
  // up in a review diff. This route is the copy that cannot go stale.
  app.get("/prompts", async (_req, reply) => {
    const { collectPrompts } = await import("./prompt-catalog.js");
    const { buildVersion } = await import("./update.js");
    const docs = await collectPrompts();
    const esc = (t: string) => String(t ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
    const body = docs.map((d) => `
      <section id="${esc(d.id)}">
        <h2>${esc(d.title)}</h2>
        <p class="src"><code>${esc(d.source)}</code></p>
        <p class="when">${esc(d.when)}</p>
        <pre>${esc(d.text)}</pre>
      </section>`).join("");
    const toc = docs.map((d) => `<a href="#${esc(d.id)}">${esc(d.title)}</a>`).join("");
    return reply.type("text/html; charset=utf-8").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Marinara Extender — Prompts</title><style>
  :root { --bg:#14121a; --panel:#1c1926; --edge:#2e2a3d; --text:#e8e4f0; --muted:#9a92b0; --accent:#c9a4ff; }
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);
    font:14px/1.6 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif}
  header{padding:14px 20px;border-bottom:1px solid var(--edge);display:flex;gap:14px;align-items:baseline;flex-wrap:wrap}
  header h1{font-size:16px;margin:0;font-weight:600} header .sub{color:var(--muted);font-size:12px}
  header a{color:var(--accent);font-size:12px;text-decoration:none;margin-left:auto}
  main{padding:18px 22px;max-width:100ch}
  nav{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:22px}
  nav a{color:var(--muted);border:1px solid var(--edge);border-radius:999px;padding:3px 11px;
    font-size:11px;text-decoration:none} nav a:hover{color:var(--text);border-color:var(--accent)}
  section{margin-bottom:26px} h2{font-size:14px;margin:0 0 4px;color:var(--accent)}
  .src{margin:0;color:var(--muted);font-size:12px} .when{margin:2px 0 8px;color:var(--muted);font-size:12.5px}
  code{background:var(--panel);padding:1px 5px;border-radius:4px;font-size:12px}
  pre{background:var(--panel);border:1px solid var(--edge);border-radius:10px;padding:14px 16px;
    overflow-x:auto;white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.65;margin:0}
</style></head><body>
<header><h1>Prompts</h1><span class="sub">assembled from the running build &middot; ${esc(buildVersion())}</span>
<a href="/memory">&larr; memory</a></header>
<main><nav>${toc}</nav>${body}</main></body></html>`);
  });
}
