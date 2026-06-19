// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║                        Marinara Extender                                ║
// ║                  Persistent scoped memory for characters                ║
// ╠══════════════════════════════════════════════════════════════════════════╣
// ║  INSTALLATION                                                            ║
// ║  In Marinara → Settings → Extensions, add a new extension named         ║
// ║  "Marinara Extender" and upload this file. The Memory Extender server   ║
// ║  must be running first:                                                  ║
// ║    cd memory-extender && npm install && npm run dev                      ║
// ║  Then open http://127.0.0.1:3001/setup for the full setup guide.        ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// Where the sidecar lives. The loader stub (setup.ts) sets window.__meSidecar to
// the address it fetched THIS file from, so a remote/Tailscale install is
// configured in one place (the loader's SIDECAR line) and both the loader's
// fetch and every memory call here follow it. Falls back to localhost for the
// standard same-machine setup, so nothing changes for the 99% on 127.0.0.1.
const MEMORY_EXTENDER = (typeof window !== "undefined" && window.__meSidecar) || "http://127.0.0.1:3001";
// Stamped by the sidecar at serve time (setup.ts) — shows what's ACTUALLY
// loaded in this tab. "dev" = running from a copy the sidecar didn't serve.
const ME_VERSION = ("__ME_VERSION__".startsWith("__") ? "dev" : "__ME_VERSION__");
const ME_DEBUG_KEY = `${marinara.extensionId}:debug`;
const isDebug = () => localStorage.getItem(ME_DEBUG_KEY) === "1";
const dbg = (...a) => isDebug() && console.debug("[ME:dbg]", ...a);
const REGEX_INSTALLED_KEY = `${marinara.extensionId}:regex-installed:v5`;
const REGEX_SCRIPT_NAME = "Marinara Extender: Strip memory tags";

// v5: strips both legacy XML tags AND new bracket commands in one pass
const REGEX_MANIFEST = {
  name: REGEX_SCRIPT_NAME,
  enabled: true,
  findRegex: "<bookmark[^>]*>[\\s\\S]*?<\\/bookmark>|<remember[^>]*>[\\s\\S]*?<\\/remember>|\\[remember:\\s*[^\\]]*\\]|\\[bookmark:\\s*[^\\]]*\\]",
  replaceString: "",
  placement: ["ai_output"],
  flags: "gi",
  trimStrings: [],
  promptOnly: false,
  minDepth: null,
  maxDepth: null,
  order: 0,
};

// Marinara stores structured fields as a JSON string in `data`. Parse it safely.
function parseData(obj) {
  const raw = obj?.data;
  if (typeof raw === "string") { try { return JSON.parse(raw); } catch { return {}; } }
  return raw ?? {};
}

// Chats in conversation mode use `characterIds` (JSON string array) instead of
// `characterId`. Returns the first character ID regardless of which field is used.
function getChatCharacterId(chat) {
  const d = parseData(chat);
  const direct = chat?.characterId ?? chat?.character_id ?? d?.characterId ?? d?.character_id;
  if (direct) return String(direct);
  const arr = getChatParticipantIds(chat);
  return arr.length > 0 ? arr[0] : null;
}

// All character ids in the chat (group scenes) — the sidecar uses these to
// scope the subject roster to characters actually IN the scene, so absent
// characters (e.g. the Narrator-aliased one) stop collecting stray facts.
function getChatParticipantIds(chat) {
  const d = parseData(chat);
  const raw = chat?.characterIds ?? d?.characterIds;
  if (!raw) return [];
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch { return []; }
}

const LANES = [
  { key: "open_threads",     label: "Open Threads",    color: "#3b82f6", addLabel: "+ Thread" },
  { key: "user_topics",      label: "User Topics",     color: "#a855f7", addLabel: "+ Topic"  },
  { key: "character_topics", label: "Character Agenda", color: "#10b981", addLabel: "+ Agenda" },
];

const STATUS_BADGE = {
  open:        { label: "open",     bg: "#2d3748", fg: "#9ca3af" },
  in_progress: { label: "active",   bg: "#1e3a5f", fg: "#60a5fa" },
  done:        { label: "done",     bg: "#064e3b", fg: "#34d399" },
  deferred:    { label: "hold",     bg: "#451a03", fg: "#fbbf24" },
};

// ── Styles ────────────────────────────────────────────────────────────────────

marinara.addStyle(`
  /* Toggle button — Tailwind classes handle layout/color; only non-Tailwind extras here */
  .me-toggle-btn { font-size: 16px; line-height: 1; cursor: pointer; position: relative; }
  .me-toggle-btn:hover { }
  .me-toggle-btn.sidecar-down   { color: #f87171; }
  .me-toggle-btn.ollama-down    { color: #fb923c; }  /* orange = sidecar up but Ollama down */

  /* Notification badge on the toggle button */
  .me-badge {
    position: absolute; top: 0px; right: -2px;
    background: #8b5cf6; border: 1.5px solid #1a1917;
    border-radius: 50%; width: 8px; height: 8px;
    pointer-events: none;
  }

  /* Hide memory/system tags that the AI renders as DOM elements.
     CSS is React-proof — el.remove() gets undone on re-render, this doesn't. */
  bookmark, remember, context, commands { display: none !important; }

  /* Panel — drops down from the top-right, below the chat header */
  #me-panel {
    position: fixed; top: 56px; right: 8px;
    width: 300px; max-height: calc(100vh - 72px);
    background: #1a1917; border: 1px solid #3d3a36;
    border-radius: 8px; z-index: 9998;
    display: none; flex-direction: column;
    font-size: 12px; color: #e8e5e0;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    font-family: inherit;
  }
  #me-panel.open { display: flex; }

  .me-panel-header {
    display: flex; align-items: center; gap: 6px;
    padding: 8px 10px; border-bottom: 1px solid #2e2b27;
    flex-shrink: 0;
  }
  .me-panel-title { flex: 1; font-weight: 600; color: #e8e5e0; font-size: 13px; }
  .me-panel-info {
    padding: 4px 10px; font-size: 11px; color: #6b7280;
    border-bottom: 1px solid #2e2b27; flex-shrink: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .me-panel-content {
    overflow-y: auto; flex: 1;
    padding: 6px 0;
  }

  /* Tab bar */
  .me-tabbar {
    display: flex; flex-shrink: 0;
    border-bottom: 1px solid #2e2b27;
  }
  .me-tab {
    flex: 1; background: none; border: none; cursor: pointer;
    color: #8b8680; font-size: 11px; font-weight: 600;
    padding: 7px 4px; border-bottom: 2px solid transparent;
    font-family: inherit;
  }
  .me-tab:hover { color: #e8e5e0; background: #211f1c; }
  .me-tab.active { color: #e8e5e0; border-bottom-color: #8b5cf6; }

  /* First-run onboarding */
  .me-onboard {
    display: flex; flex-direction: column; align-items: center; text-align: center;
    gap: 10px; padding: 30px 18px 24px;
  }
  .me-onboard-head { font-size: 15px; font-weight: 700; color: #e8e5e0; }
  .me-onboard-copy { font-size: 12px; color: #b8b3ab; line-height: 1.5; max-width: 240px; }
  .me-onboard-sub { font-size: 11px; color: #8b8680; line-height: 1.4; max-width: 250px; }
  .me-onboard-line { font-size: 12px; color: #e8e5e0; font-weight: 600; margin-top: 2px; }
  .me-onboard-cta { margin-top: 6px; padding: 9px 18px; font-size: 13px; font-weight: 600; width: 100%; }
  .me-onboard-skip { font-size: 11px; color: #6b7280; text-decoration: none; }
  .me-onboard-skip:hover { color: #b8b3ab; text-decoration: underline; }
  .me-onboard-bar { width: 100%; height: 8px; background: #2e2b27; border-radius: 4px; overflow: hidden; margin-top: 4px; }
  .me-onboard-bar-fill { height: 100%; background: #8b5cf6; transition: width 0.3s ease; }
  .me-onboard-check { font-size: 30px; color: #34d399; line-height: 1; }
  .me-onboard-payoff { font-size: 14px; font-weight: 600; color: #e8e5e0; line-height: 1.45; max-width: 250px; }
  .me-onboard-scope { display: flex; gap: 0; border: 1px solid #3d3a36; border-radius: 6px; overflow: hidden; margin-top: 4px; }
  .me-scope-btn { background: none; border: none; color: #8b8680; font-size: 11px; font-weight: 600; padding: 6px 12px; cursor: pointer; font-family: inherit; }
  .me-scope-btn:hover { color: #e8e5e0; background: #211f1c; }
  .me-scope-btn.active { background: #8b5cf6; color: #fff; }
  .me-onboard-choosebar { display: flex; align-items: center; gap: 10px; width: 100%; justify-content: center; }
  .me-onboard-list { width: 100%; max-height: 240px; overflow-y: auto; border: 1px solid #2e2b27; border-radius: 6px; text-align: left; }
  .me-onboard-chatrow { display: flex; align-items: center; gap: 8px; padding: 5px 8px; cursor: pointer; border-bottom: 1px solid #211f1c; }
  .me-onboard-chatrow:last-child { border-bottom: none; }
  .me-onboard-chatrow:hover { background: #211f1c; }
  .me-onboard-chatrow input { accent-color: #8b5cf6; cursor: pointer; flex-shrink: 0; }
  .me-onboard-chatlabel { font-size: 11px; color: #d8d4cd; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* Icon buttons in header */
  .me-icon-btn {
    background: none; border: none; color: #6b7280;
    font-size: 15px; cursor: pointer; padding: 0 2px;
    line-height: 1; border-radius: 3px;
  }
  .me-icon-btn:hover { color: #e8e5e0; background: #2e2b27; }

  /* Sections */
  .me-section { border-bottom: 1px solid #2e2b27; padding: 6px 0 4px; }
  .me-section:last-child { border-bottom: none; }

  .me-section-header {
    display: flex; align-items: center; gap: 6px;
    padding: 2px 10px 4px; cursor: default;
  }
  .me-section-dot {
    width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
  }
  .me-section-label { flex: 1; font-weight: 500; font-size: 11px; color: #c9c5bf; }
  .me-section-count {
    font-size: 10px; color: #6b7280;
    background: #2e2b27; border-radius: 8px;
    padding: 1px 5px;
  }
  .me-section-empty { padding: 2px 10px 4px; color: #4b5563; font-size: 11px; }

  /* Entries */
  .me-entry {
    padding: 4px 10px;
    display: flex; align-items: flex-start; gap: 6px;
  }
  .me-entry:hover { background: #252320; }
  .me-entry-body { flex: 1; min-width: 0; }
  .me-entry-summary {
    display: block; color: #d1cdc7; line-height: 1.4;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .me-entry-meta { display: flex; gap: 4px; margin-top: 2px; }
  .me-status-badge {
    font-size: 10px; border-radius: 3px;
    padding: 1px 4px; flex-shrink: 0;
  }
  .me-entry-actions { display: flex; gap: 3px; flex-shrink: 0; padding-top: 1px; }
  .me-btn-done, .me-btn-delete {
    background: none; border: 1px solid transparent;
    border-radius: 3px; font-size: 11px;
    cursor: pointer; padding: 1px 4px; line-height: 1;
  }
  .me-btn-done  { color: #34d399; }
  .me-btn-done:hover  { border-color: #34d399; background: #064e3b; }
  .me-btn-delete { color: #6b7280; }
  .me-btn-delete:hover { border-color: #f87171; color: #f87171; background: #3f1414; }

  /* Add button + form */
  .me-add-btn {
    display: block; width: 100%;
    background: none; border: none; border-top: 1px dashed #2e2b27;
    color: #6b7280; font-size: 11px;
    cursor: pointer; text-align: left;
    padding: 4px 10px;
  }
  .me-add-btn:hover { color: #f97316; background: #252320; }

  .me-add-form { padding: 4px 10px 6px; }
  .me-add-input {
    width: 100%; box-sizing: border-box;
    background: #252320; border: 1px solid #3d3a36;
    border-radius: 4px; color: #e8e5e0;
    font-size: 12px; padding: 5px 7px;
    font-family: inherit; outline: none;
  }
  .me-add-input:focus { border-color: #f97316; }
  .me-add-form-row { display: flex; gap: 6px; margin-top: 5px; }
  .me-btn-primary {
    background: #f97316; border: none; border-radius: 4px;
    color: #fff; font-size: 11px; cursor: pointer;
    padding: 3px 10px; font-family: inherit;
  }
  .me-btn-primary:hover { background: #ea6a00; }
  .me-btn-cancel {
    background: none; border: 1px solid #3d3a36; border-radius: 4px;
    color: #9ca3af; font-size: 11px; cursor: pointer;
    padding: 3px 8px; font-family: inherit;
  }
  .me-btn-cancel:hover { border-color: #6b7280; color: #e8e5e0; }

  /* Bookmarks */
  .me-bookmark {
    padding: 5px 10px;
  }
  .me-bookmark:hover { background: #252320; }
  .me-bm-row { display: flex; align-items: center; gap: 6px; }
  .me-bm-topic { font-weight: 500; color: #fbbf24; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .me-bm-bar-wrap { display: flex; align-items: center; gap: 4px; }
  .me-bm-bar { width: 36px; height: 4px; background: #2e2b27; border-radius: 2px; overflow: hidden; }
  .me-bm-fill { height: 100%; background: #f59e0b; border-radius: 2px; }
  .me-bm-pct { font-size: 10px; color: #9ca3af; width: 26px; text-align: right; }
  .me-bm-summary { font-size: 11px; color: #9ca3af; margin-top: 1px; line-height: 1.3; }
  .me-bm-why { font-size: 10px; color: #6b7280; margin-top: 1px; }

  /* State messages */
  .me-loading, .me-empty, .me-error { padding: 12px 10px; color: #6b7280; font-size: 11px; text-align: center; }
  .me-error { color: #f87171; }

  /* Identity section */
  .me-identity-section { border-top: 1px solid #2e2b27; }
  .me-identity-toggle {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 10px; cursor: pointer; width: 100%;
    background: none; border: none; color: inherit; font-family: inherit;
    font-size: 12px; text-align: left;
  }
  .me-identity-toggle:hover { background: #252320; }
  .me-identity-body { padding: 4px 10px 8px; }
  .me-id-field { display: flex; align-items: center; gap: 4px; margin-bottom: 5px; }
  .me-id-label { font-size: 10px; color: #6b7280; flex-shrink: 0; width: 46px; }
  .me-id-value {
    flex: 1; min-width: 0; font-size: 10px; font-family: monospace;
    color: #c9c5bf; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    cursor: pointer;
  }
  .me-id-value:hover { color: #e8e5e0; }
  .me-id-copy {
    flex-shrink: 0; background: none; border: none;
    color: #6b7280; font-size: 11px; cursor: pointer; padding: 0 3px;
  }
  .me-id-copy:hover { color: #e8e5e0; }
  .me-relink-label { font-size: 10px; color: #6b7280; margin: 6px 0 3px; }
  .me-relink-row { display: flex; gap: 4px; }
  .me-relink-input {
    flex: 1; background: #252320; border: 1px solid #3d3a36;
    border-radius: 4px; color: #e8e5e0; font-size: 11px;
    padding: 3px 6px; font-family: inherit; outline: none; min-width: 0;
  }
  .me-relink-input:focus { border-color: #f97316; }
  .me-relink-ok  { font-size: 10px; color: #34d399; margin-top: 4px; }
  .me-relink-err { font-size: 10px; color: #f87171; margin-top: 4px; }

  /* Import section */
  .me-import-section { border-top: 1px solid #2e2b27; }
  .me-import-toggle {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 10px; cursor: pointer; width: 100%;
    background: none; border: none; color: inherit; font-family: inherit;
    font-size: 12px; text-align: left;
  }
  .me-import-toggle:hover { background: #252320; }
  .me-import-chevron { font-size: 10px; color: #6b7280; margin-left: auto; transition: transform 0.15s; }
  .me-import-chevron.open { transform: rotate(90deg); }
  .me-import-body { padding-bottom: 6px; }
  .me-import-search {
    display: block; width: calc(100% - 20px); margin: 6px 10px 4px;
    background: #1a1816; border: 1px solid #3d3a36; border-radius: 4px;
    color: #e8e5e0; font-size: 11px; padding: 4px 8px; font-family: inherit;
    box-sizing: border-box;
  }
  .me-import-search:focus { outline: none; border-color: #60a5fa; }
  .me-import-search::placeholder { color: #6b7280; }
  .me-import-all-btn {
    display: block; width: calc(100% - 20px); margin: 4px 10px 0;
    background: #252320; border: 1px solid #3d3a36;
    border-radius: 4px; color: #e8e5e0; font-size: 11px;
    cursor: pointer; padding: 5px 8px; font-family: inherit; text-align: center;
  }
  .me-import-all-btn:hover:not(:disabled) { border-color: #f97316; color: #f97316; }
  .me-import-all-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .me-import-warning { margin: 4px 10px 0; font-size: 10px; color: #f59e0b; text-align: center; }
  .me-import-list { max-height: 240px; overflow-y: auto; margin-top: 4px; }
  .me-chat-row { display: flex; align-items: center; gap: 6px; padding: 3px 10px; }
  .me-chat-row:hover { background: #1e1c19; }
  .me-chat-info { flex: 1; min-width: 0; }
  .me-chat-name { display: block; font-size: 11px; color: #c9c5bf; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .me-chat-folder { display: block; font-size: 10px; color: #6b7280; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .me-chat-import-btn {
    flex-shrink: 0; background: none; border: 1px solid #3d3a36;
    border-radius: 3px; color: #9ca3af; font-size: 10px;
    cursor: pointer; padding: 2px 6px; font-family: inherit;
  }
  .me-chat-import-btn:hover:not(:disabled) { border-color: #60a5fa; color: #60a5fa; }
  .me-chat-import-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .me-chat-hide-btn {
    flex-shrink: 0; background: none; border: none; color: #4b5563;
    font-size: 12px; cursor: pointer; padding: 0 2px; line-height: 1;
  }
  .me-chat-hide-btn:hover { color: #f87171; }
  .me-import-ok  { flex-shrink: 0; font-size: 10px; color: #34d399; }
  .me-import-err { flex-shrink: 0; font-size: 10px; color: #f87171; }
  .me-import-hidden-row { padding: 2px 10px; font-size: 10px; color: #4b5563; cursor: pointer; }
  .me-import-hidden-row:hover { color: #9ca3af; }

  /* Story ingest section */
  @keyframes me-spin { to { transform: rotate(360deg); } }
  .me-spinner {
    display: inline-block; width: 13px; height: 13px;
    border: 2px solid #3d3a36; border-top-color: #8b5cf6;
    border-radius: 50%;
    animation: me-spin 0.75s linear infinite;
    vertical-align: middle; flex-shrink: 0;
  }
  .me-ingest-running {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 0; color: #9ca3af; font-size: 11px;
  }
  .me-ingest-hint { font-size: 10px; color: #4b5563; margin-top: 2px; margin-bottom: 6px; }
  .me-ingest-section { border-top: 1px solid #2e2b27; }
  .me-ingest-toggle {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 10px; cursor: pointer; width: 100%;
    background: none; border: none; color: inherit; font-family: inherit;
    font-size: 12px; text-align: left;
  }
  .me-ingest-toggle:hover { background: #252320; }
  .me-ingest-body { padding: 6px 10px 8px; }
  .me-ingest-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
  .me-ingest-lbl { font-size: 10px; color: #6b7280; flex-shrink: 0; width: 46px; }
  .me-ingest-input {
    flex: 1; background: #252320; border: 1px solid #3d3a36;
    border-radius: 4px; color: #e8e5e0; font-size: 11px;
    padding: 3px 6px; font-family: inherit; outline: none; min-width: 0;
  }
  .me-ingest-input:focus { border-color: #f97316; }
  .me-ingest-check {
    display: flex; align-items: center; gap: 6px; margin-bottom: 6px;
    font-size: 10px; color: #8b8680; cursor: pointer;
  }
  .me-ingest-check input { accent-color: #8b5cf6; cursor: pointer; }
  .me-ingest-sublabel { font-size: 10px; color: #8b8680; font-weight: 600; margin: 8px 0 4px; }
  select.me-ingest-input { cursor: pointer; }
  select.me-ingest-input option { background: #1a1917; color: #e8e5e0; }
  .me-ingest-file-row { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
  .me-ingest-file-btn {
    flex-shrink: 0; background: #252320; border: 1px solid #3d3a36;
    border-radius: 4px; color: #9ca3af; font-size: 11px;
    cursor: pointer; padding: 3px 8px; font-family: inherit;
  }
  .me-ingest-file-btn:hover:not(:disabled) { border-color: #f97316; color: #f97316; }
  .me-ingest-file-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .me-ingest-filename {
    flex: 1; min-width: 0; font-size: 10px; color: #c9c5bf;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .me-ingest-clear {
    flex-shrink: 0; background: none; border: none;
    color: #6b7280; font-size: 14px; cursor: pointer; padding: 0 3px; line-height: 1;
  }
  .me-ingest-clear:hover { color: #f87171; }
  .me-ingest-or { font-size: 10px; color: #4b5563; margin-bottom: 4px; }
  .me-ingest-textarea {
    width: 100%; box-sizing: border-box;
    background: #252320; border: 1px solid #3d3a36;
    border-radius: 4px; color: #e8e5e0; font-size: 11px;
    padding: 5px 7px; font-family: inherit; outline: none;
    resize: vertical; min-height: 80px;
  }
  .me-ingest-textarea:focus { border-color: #f97316; }
  .me-ingest-bottom { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
  .me-ingest-count { font-size: 10px; color: #4b5563; flex: 1; text-align: right; }
  .me-ingest-result { margin-top: 6px; font-size: 11px; line-height: 1.4; }
  .me-ingest-ok { color: #34d399; }
  .me-ingest-err { color: #f87171; }
  .me-ingest-clear-row { display: flex; align-items: center; gap: 6px; margin-top: 8px; padding-top: 6px; border-top: 1px dashed #2e2b27; }
  .me-btn-danger {
    background: none; border: 1px solid #3d3a36; border-radius: 4px;
    color: #9ca3af; font-size: 11px; cursor: pointer;
    padding: 3px 8px; font-family: inherit;
  }
  .me-btn-danger:hover:not(:disabled) { border-color: #f87171; color: #f87171; background: #3f1414; }
  .me-btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Settings section */
  .me-settings-section { border-top: 1px solid #2e2b27; }
  .me-settings-toggle {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 10px; cursor: pointer; width: 100%;
    background: none; border: none; color: inherit; font-family: inherit;
    font-size: 12px; text-align: left;
  }
  .me-settings-toggle:hover { background: #252320; }
  .me-settings-body { padding: 4px 10px 8px; }
  .me-settings-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
  .me-settings-lbl { font-size: 11px; color: #c9c5bf; flex: 1; }
  .me-settings-lbl small { display: block; font-size: 10px; color: #4b5563; margin-top: 1px; }
  .me-toggle-pill {
    flex-shrink: 0; width: 34px; height: 18px; border-radius: 9px;
    border: none; cursor: pointer; position: relative; transition: background 0.2s;
    background: #3d3a36;
  }
  .me-toggle-pill.on { background: #8b5cf6; }
  .me-toggle-pill:disabled { opacity: 0.5; cursor: not-allowed; }
  .me-toggle-pill::after {
    content: ''; position: absolute; top: 2px; left: 2px;
    width: 14px; height: 14px; border-radius: 50%;
    background: #9ca3af; transition: transform 0.2s, background 0.2s;
  }
  .me-toggle-pill.on::after { transform: translateX(16px); background: #fff; }

  /* Setup banner */
  #me-setup-banner {
    position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
    background: #1e1b18; border: 1px solid #f97316;
    border-radius: 8px; color: #fef3c7;
    font-size: 13px; padding: 10px 14px;
    z-index: 10000; max-width: 480px; line-height: 1.5;
  }
  #me-setup-banner code { background: #2d2a26; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  #me-setup-banner button { background: none; border: none; color: #9ca3af; cursor: pointer; float: right; font-size: 16px; line-height: 1; margin: -2px -4px 0 8px; }

  /* Toggle pulses while an import is running, so it's clear it's still going
     after the panel is closed — click to jump back to the progress. */
  @keyframes me-import-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(249, 115, 22, 0.55); }
    50%      { box-shadow: 0 0 0 5px rgba(249, 115, 22, 0); }
  }
  .me-toggle-btn.importing { animation: me-import-pulse 1.6s ease-in-out infinite; color: #f97316; }

  /* Generic small button */
  .me-btn {
    background: none; border: 1px solid #3d3a36; border-radius: 4px;
    color: #c9c5bf; font-size: 11px; cursor: pointer;
    padding: 3px 8px; font-family: inherit;
  }
  .me-btn:hover:not(:disabled) { border-color: #f97316; color: #f5f3f0; }
  .me-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Inline text link (e.g. "Resolve now") */
  .me-link-btn {
    background: none; border: none; padding: 0; cursor: pointer;
    color: #f97316; font-family: inherit; font-size: inherit;
    text-decoration: underline;
  }
  .me-link-btn:hover { color: #ea6a00; }

  /* Pending speakers tab */
  .me-pending-row { border: 1px solid #2e2b27; border-radius: 6px; padding: 8px; margin-bottom: 8px; }
  .me-pending-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
  .me-pending-label { font-size: 12px; color: #f5f3f0; font-weight: 600; }
  .me-pending-count { font-size: 10px; color: #8b8680; }
  .me-pending-suggested {
    font-size: 10px; color: #c4b5fd; background: #2e2440;
    border: 1px solid #4c3a6b; border-radius: 10px; padding: 1px 7px;
  }
  .me-pending-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .me-pending-select {
    background: #1a1815; border: 1px solid #3d3a36; border-radius: 4px;
    color: #c9c5bf; font-size: 11px; font-family: inherit; padding: 3px 6px;
    max-width: 160px;
  }
  .me-pending-select:disabled { opacity: 0.5; }
`);

// ── DOM helpers ───────────────────────────────────────────────────────────────

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function shorten(id, len = 12) {
  return id.length > len ? id.slice(0, len) + "…" : id;
}

// ── Ingest completion notification ───────────────────────────────────────────

function showIngestBadge() {
  const btn = document.getElementById("me-toggle");
  if (!btn || btn.querySelector(".me-badge")) return;
  const dot = document.createElement("span");
  dot.className = "me-badge";
  btn.appendChild(dot);
}

function clearIngestBadge() {
  document.getElementById("me-toggle")?.querySelector(".me-badge")?.remove();
}

function notifyIngestDone(characterName, beatCount) {
  showIngestBadge();
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  new Notification("Story analysis complete", {
    body: `${beatCount} beat${beatCount === 1 ? "" : "s"} saved for ${characterName ?? "character"}`,
    silent: true,
  });
}

// ── Sidecar fetch helper ──────────────────────────────────────────────────────

// ── CSRF token ────────────────────────────────────────────────────────────────
// The sidecar requires x-me-csrf on mutating requests from browser origins.
// The token is per-process: a sidecar restart mints a new one, so a 403 means
// "refresh and retry once", not "give up".

let _csrfToken = null;
async function getCsrfToken(force = false) {
  if (_csrfToken && !force) return _csrfToken;
  try {
    const r = await fetch(`${MEMORY_EXTENDER}/api/csrf-token`);
    _csrfToken = (await r.json())?.token ?? null;
  } catch { _csrfToken = null; }
  return _csrfToken;
}

async function memFetch(path, options = {}) {
  const { headers: extraHeaders, ...rest } = options;
  const method = (options.method ?? "GET").toUpperCase();
  const doFetch = async (token) => fetch(`${MEMORY_EXTENDER}${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "x-me-csrf": token } : {}),
      ...(extraHeaders ?? {}),
    },
  });
  let r = await doFetch(method === "GET" ? null : await getCsrfToken());
  if (r.status === 403 && method !== "GET") {
    r = await doFetch(await getCsrfToken(true)); // sidecar restarted — fresh token
  }
  // Tolerate a non-JSON or empty body (a bare 500, a proxy error page, a 204).
  // r.json() would throw, and not every caller wraps memFetch in .catch — return
  // null so a bad response degrades to "no data" instead of an exception.
  try {
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// ── Toggle button — injected into the sticky chat header ─────────────────────
// Uses observe so it survives React re-renders of the header DOM.

function injectToggle() {
  const header = document.querySelector('.mari-messages-scroll > .sticky.top-0');
  if (!header || header.querySelector('#me-toggle')) return;
  const btn = document.createElement('button');
  btn.id = 'me-toggle';
  btn.className = 'me-toggle-btn flex items-center justify-center rounded-lg bg-[var(--card)]/80 p-1.5 text-foreground/80 backdrop-blur-sm transition-colors hover:bg-[var(--card)] hover:text-foreground dark:bg-black/30 dark:hover:bg-black/50';
  btn.title = 'Marinara Extender';
  btn.innerHTML = '&#8801;';
  btn.addEventListener('click', () => {
    panel?.classList.contains('open') ? closePanel() : openPanel();
  });
  const folderBtn = header.querySelector('[title="Manage Chat Files"]');
  if (folderBtn) {
    folderBtn.parentElement.insertBefore(btn, folderBtn);
  } else {
    header.appendChild(btn);
  }
}

injectToggle();
marinara.observe(document.body, injectToggle);
marinara.onCleanup(() => document.getElementById('me-toggle')?.remove());

// ── Sidecar health (shown via button colour) ──────────────────────────────────

async function checkSidecar() {
  const btn = document.getElementById('me-toggle');
  try {
    const r = await fetch(`${MEMORY_EXTENDER}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) {
      btn?.classList.add('sidecar-down');
      btn?.classList.remove('ollama-down');
      btn?.title && (btn.title = "Memory Extender is unreachable");
      return;
    }
    const data = await r.json().catch(() => ({}));
    const ollamaDown = data.ollama === "unavailable";
    btn?.classList.remove('sidecar-down');
    btn?.classList.toggle('ollama-down', ollamaDown);
    if (btn) btn.title = ollamaDown
      ? "Ollama is not running — local model unavailable"
      : "Memory Extender running";
  } catch {
    btn?.classList.add('sidecar-down');
    btn?.classList.remove('ollama-down');
    if (btn) btn.title = "Memory Extender is not running — use start.bat to launch";
  }
}

checkSidecar();
marinara.setInterval(checkSidecar, 15_000);

// ── Panel state ───────────────────────────────────────────────────────────────

const panelState = {
  session: null,
  activeTab: "memory",     // "memory" | "import" | "settings"
  chatEntries: [],
  bookmarks: [],
  addingLane: null,
  addingSummary: "",
  loading: false,
  error: null,
  // Import section
  importExpanded: false,
  importChats: null,       // null = not yet loaded; array = loaded
  importChatsLoading: false,
  importChatsError: null,
  importingSet: new Set(), // chatIds currently being digested
  importAllActive: false,
  importAllProgress: null, // { current, total }
  importResults: {},       // { [chatId]: { count } | { error } }
  importFilter: "",        // live search string
  // First-run onboarding import flow
  importFlow: "intro",     // intro | choosing | estimating | ready | running | done
  importScope: "character",// "character" (open char) | "all" (every character)
  importChatsAll: null,    // all chats w/ character info (for the "all" scope)
  importChosen: null,      // Set<chatId> when picking a subset
  importTargets: [],       // resolved chat list currently being imported
  importFlowStats: null,   // { chats, calls, tokens }
  importFlowProgress: null,// { current, total, startMs }
  importFlowResult: null,  // { moments, chats, failed }
  importCancel: false,
  importAbort: null,       // AbortController for the in-flight chat
  importChatProgress: null,// { current, total } within the chat being analyzed (streamed)
  _onboardMsgs: {},        // chatId -> messages, cached from the estimate scan
  // Story ingest section
  ingestExpanded: false,
  ingestPovChar: "",
  ingestAssignments: [],       // [{ characterId, characterName, names }] — who gets which speaker
  ingestAssignmentsFor: null,  // session characterId the assignments were initialized for
  allCharacters: null,         // null = not loaded; [{ id, name }] for the picker
  allCharactersLoading: false,
  ingestUseExternal: false,    // attribute via external API + bigger windows
  ingestText: "",
  ingestFileName: null,
  ingestRunning: false,
  ingestAbort: null,           // AbortController for the in-flight import
  ingestStatus: "",    // short message shown while running
  ingestResult: null,
  ingestClearRunning: false,
  ingestClearResult: null,
  // Settings section
  settingsExpanded: false,
  stripTagsEnabled: null,   // null = not yet loaded
  stripTagsScriptId: null,
  stripTagsLoading: false,
  // Pending speakers tab (holding-pool resolution)
  pendingSpeakers: null,    // null = not loaded; array of {label, normalized, count, suggestion}
  pendingLoading: false,
  pendingError: null,
  pendingBusy: null,        // normalized label currently being resolved (disables its row)
  pendingMapSel: {},        // normalized label -> selected characterId for "Map to existing"
  // Identity section
  identityExpanded: false,
  identityKey: null,       // loaded from /api/identity on expand
  identityLoading: false,
  relinkInput: "",
  relinkStatus: null,      // null | "ok" | string (error message)
  renameInput: "",
  renameStatus: null,      // null | "ok" | string (error message)
  // Retired section (3pl) — character-scope superseded facts, for rollback
  retiredExpanded: false,
  retired: null,           // null = not loaded; array of { id, summary, supersededAt, replacedBy }
  retiredLoading: false,
  retiredBusy: null,       // id currently being rolled back (disables its row)
  retiredShowAll: false,   // false = show only the newest few; true = the whole list
};

// ── Remembered speaker names (per character, persisted) ─────────────────────────
// Maps characterId → the comma-separated speaker names the user pins for story
// imports, so e.g. "Mari" is remembered for "Dr. Mari Zielińska" next time.

const CHAR_NAMES_KEY = `${marinara.extensionId}:char-names`;

function loadCharNamesMap() {
  try { return JSON.parse(localStorage.getItem(CHAR_NAMES_KEY) || "{}"); }
  catch { return {}; }
}

function getSavedCharNames(characterId) {
  if (!characterId) return "";
  return loadCharNamesMap()[characterId] ?? "";
}

function setSavedCharNames(characterId, names) {
  if (!characterId) return;
  const map = loadCharNamesMap();
  const trimmed = (names ?? "").trim();
  if (trimmed) map[characterId] = trimmed;
  else delete map[characterId];
  try { localStorage.setItem(CHAR_NAMES_KEY, JSON.stringify(map)); } catch { /* quota */ }
}

// Load the full character list once, for the multi-character import picker.
async function loadAllCharacters() {
  if (panelState.allCharacters || panelState.allCharactersLoading) return;
  panelState.allCharactersLoading = true;
  try {
    const res = await marinara.apiFetch("/characters");
    const arr = Array.isArray(res) ? res : (res?.characters ?? res?.data ?? []);
    panelState.allCharacters = arr
      .map(c => { const d = parseData(c); return { id: String(c.id ?? d.id ?? ""), name: d.name ?? c.name ?? "Unknown" }; })
      .filter(c => c.id)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { panelState.allCharacters = []; }
  panelState.allCharactersLoading = false;
  renderPanel();
}

// ── Settings helpers ──────────────────────────────────────────────────────────

async function loadStripTagsState() {
  panelState.stripTagsLoading = true;
  renderPanel();
  try {
    const scripts = await marinara.apiFetch("/regex-scripts");
    const list = Array.isArray(scripts) ? scripts : [];
    const found = list.find(s => {
      const d = parseData(s);
      return (s.name ?? d.name) === REGEX_SCRIPT_NAME;
    });
    if (found) {
      const d = parseData(found);
      panelState.stripTagsScriptId = String(found.id ?? d.id);
      panelState.stripTagsEnabled = found.enabled ?? d.enabled ?? true;
    } else {
      panelState.stripTagsEnabled = false;
      panelState.stripTagsScriptId = null;
    }
  } catch {
    panelState.stripTagsEnabled = null;
  }
  panelState.stripTagsLoading = false;
  renderPanel();
}

async function toggleStripTags() {
  if (!panelState.stripTagsScriptId || panelState.stripTagsLoading) return;
  const next = !panelState.stripTagsEnabled;
  panelState.stripTagsLoading = true;
  panelState.stripTagsEnabled = next;  // optimistic update
  renderPanel();
  try {
    await marinara.apiFetch(`/regex-scripts/${panelState.stripTagsScriptId}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: next }),
    });
  } catch {
    panelState.stripTagsEnabled = !next;  // revert on failure
  }
  panelState.stripTagsLoading = false;
  renderPanel();
}

// ── Pending speakers (holding-pool resolution) ──────────────────────────────────

async function loadPendingSpeakers() {
  panelState.pendingLoading = true;
  panelState.pendingError = null;
  renderPanel();
  try {
    const res = await memFetch("/api/pending-speakers");
    panelState.pendingSpeakers = res?.speakers ?? [];
  } catch {
    panelState.pendingSpeakers = [];
    panelState.pendingError = "Could not reach the sidecar to load pending speakers.";
  }
  panelState.pendingLoading = false;
  renderPanel();
}

// map | create | ignore one pending speaker, then refresh the list + count.
async function resolveSpeaker(normalized, label, action, char) {
  panelState.pendingBusy = normalized;
  renderPanel();
  try {
    const body = { label, action };
    if (action === "map" || action === "create") {
      body.characterId = char.id;
      body.characterName = char.name;
    }
    const res = await memFetch("/api/resolve-speaker", { method: "POST", body: JSON.stringify(body) });
    if (res?.error) throw new Error(res.error);

    // Alias collision: the beats were routed to the chosen character, but the
    // label already belongs to another. Ask what should happen for FUTURE
    // imports — reassign the label, or leave it with the existing owner.
    if (res?.collision?.length && (action === "map" || action === "create")) {
      const others = res.collision.map(c => c.canonicalName).join(", ");
      const reassign = window.confirm(
        `"${label}" is already mapped to ${others}. Its waiting beats were routed to ${char.name}.\n\n` +
        `For future imports, reassign "${label}" to ${char.name}?\n\n` +
        `OK = reassign to ${char.name}   ·   Cancel = leave it with ${others}`
      );
      if (reassign) {
        for (const c of res.collision) {
          await memFetch("/api/aliases", { method: "DELETE", body: JSON.stringify({ identityKey: c.identityKey, label }) }).catch(() => {});
        }
        await memFetch("/api/aliases", { method: "POST", body: JSON.stringify({ identityKey: res.identityKey, characterName: char.name, label, force: true }) }).catch(() => {});
      }
    }
  } catch (err) {
    panelState.pendingError = err.message ?? "Resolve failed";
  }
  panelState.pendingBusy = null;
  delete panelState.pendingMapSel[normalized];
  await loadPendingSpeakers();
}

// Create a minimal Marinara card named for the speaker, then map the held beats
// to it. The user fleshes the card out later in Marinara — we just need its id.
// Create a minimal Marinara character card and return { id, name }. The user
// fleshes it out later in Marinara — we just need its id to route beats. Shared
// by the import assignment picker and the Pending tab's "Create card".
async function createCharacterCard(name) {
  const created = await marinara.apiFetch("/characters", {
    method: "POST",
    body: JSON.stringify({ data: { name, description: "" } }),
  });
  const cd = parseData(created) ?? {};
  const newId = String(created?.id ?? cd.id ?? created?.character?.id ?? "");
  if (!newId) throw new Error("card created but no id was returned");
  return { id: newId, name };
}

async function createCardForSpeaker(normalized, label) {
  const name = (window.prompt("Create a new character card named:", label) || "").trim();
  if (!name) return;
  panelState.pendingBusy = normalized;
  panelState.pendingError = null;
  renderPanel();
  try {
    const c = await createCharacterCard(name);
    panelState.allCharacters = null; // new card should appear in dropdowns
    loadAllCharacters();
    await resolveSpeaker(normalized, label, "create", c);
  } catch (err) {
    panelState.pendingError = `Create card failed: ${err?.message ?? err}`;
    panelState.pendingBusy = null;
    renderPanel();
  }
}

function renderPendingRow(sp) {
  const row = el("div", "me-pending-row");
  const busy = panelState.pendingBusy === sp.normalized;

  const head = el("div", "me-pending-head");
  const name = el("span", "me-pending-label");
  name.textContent = sp.label;
  const count = el("span", "me-pending-count");
  count.textContent = `${sp.count} beat${sp.count === 1 ? "" : "s"} waiting`;
  head.append(name, count);
  if (sp.suggestion) {
    const badge = el("span", "me-pending-suggested");
    badge.textContent = `suggested: ${sp.suggestion.canonicalName}`;
    badge.title = `Fuzzy match (${Math.round((sp.suggestion.score ?? 0) * 100)}%) — confirm before routing`;
    head.appendChild(badge);
  }
  row.appendChild(head);

  const actions = el("div", "me-pending-actions");

  // Map to existing character
  const sel = el("select", "me-pending-select");
  const ph = el("option");
  ph.value = "";
  ph.textContent = panelState.allCharacters ? "Map to character…" : "Loading characters…";
  sel.appendChild(ph);
  for (const c of (panelState.allCharacters ?? [])) {
    const o = el("option");
    o.value = c.id;
    o.textContent = c.name;
    sel.appendChild(o);
  }
  // Pre-select: prior choice, else a character whose name matches the suggestion.
  const suggestedId = sp.suggestion
    ? (panelState.allCharacters ?? []).find(c => c.name.toLowerCase() === sp.suggestion.canonicalName.toLowerCase())?.id
    : "";
  const pre = panelState.pendingMapSel[sp.normalized] ?? suggestedId ?? "";
  if (pre) sel.value = pre;
  sel.disabled = busy;
  sel.addEventListener("change", () => { panelState.pendingMapSel[sp.normalized] = sel.value; });

  const mapBtn = el("button", "me-btn");
  mapBtn.textContent = "Map";
  mapBtn.disabled = busy;
  mapBtn.addEventListener("click", () => {
    const id = panelState.pendingMapSel[sp.normalized] || sel.value;
    const c = (panelState.allCharacters ?? []).find(x => x.id === id);
    if (!c) { panelState.pendingError = "Pick a character to map to first."; renderPanel(); return; }
    resolveSpeaker(sp.normalized, sp.label, "map", c);
  });

  const createBtn = el("button", "me-btn");
  createBtn.textContent = "Create card";
  createBtn.disabled = busy;
  createBtn.addEventListener("click", () => createCardForSpeaker(sp.normalized, sp.label));

  const ignoreBtn = el("button", "me-btn-danger");
  ignoreBtn.textContent = "Ignore";
  ignoreBtn.disabled = busy;
  ignoreBtn.addEventListener("click", () => {
    if (!window.confirm(`Ignore ${sp.count} beat${sp.count === 1 ? "" : "s"} from "${sp.label}"? They move to a recoverable bucket (kept 30 days).`)) return;
    resolveSpeaker(sp.normalized, sp.label, "ignore");
  });

  actions.append(sel, mapBtn, createBtn, ignoreBtn);
  if (busy) {
    const b = el("span");
    b.style.cssText = "font-size:10px; color:#8b8680; margin-left:6px;";
    b.textContent = "…working";
    actions.appendChild(b);
  }
  row.appendChild(actions);
  return row;
}

function renderPendingSection() {
  const wrap = el("div", "me-pending-wrap");

  if (panelState.pendingLoading && panelState.pendingSpeakers === null) {
    wrap.appendChild(Object.assign(el("div", "me-loading"), { textContent: "Loading pending speakers…" }));
    return wrap;
  }
  if (panelState.pendingError) {
    wrap.appendChild(Object.assign(el("div", "me-error"), { textContent: panelState.pendingError }));
  }

  const speakers = panelState.pendingSpeakers ?? [];

  const intro = el("div");
  intro.style.cssText = "font-size:11px; color:#8b8680; margin: 4px 0 10px;";
  intro.textContent = speakers.length
    ? "Speakers from imports that didn't match a known character. Route each to a card or ignore it — once mapped, future imports route that name automatically."
    : "No speakers waiting. When an import attributes beats to a name we don't recognize, they'll wait here for you to route — nothing is ever dropped.";
  wrap.appendChild(intro);

  for (const sp of speakers) wrap.appendChild(renderPendingRow(sp));

  return wrap;
}

function renderSettingsSection() {
  const wrap = el("div", "me-settings-section");

  const toggleBtn = el("button", "me-settings-toggle");
  const dot_ = el("span", "me-section-dot");
  dot_.style.background = "#6b7280";
  dot_.style.flexShrink = "0";
  const label = el("span", "me-section-label");
  label.textContent = "Settings";
  const chevron = el("span", "me-import-chevron");
  chevron.textContent = "▶";
  if (panelState.settingsExpanded) chevron.classList.add("open");
  toggleBtn.append(dot_, label, chevron);
  wrap.appendChild(toggleBtn);

  toggleBtn.addEventListener("click", () => {
    panelState.settingsExpanded = !panelState.settingsExpanded;
    if (panelState.settingsExpanded && panelState.stripTagsEnabled === null && !panelState.stripTagsLoading) {
      loadStripTagsState();
    } else {
      renderPanel();
    }
  });

  if (!panelState.settingsExpanded) return wrap;

  const body = el("div", "me-settings-body");

  const row = el("div", "me-settings-row");
  const lbl = el("div", "me-settings-lbl");
  lbl.textContent = "Strip memory tags from chat";
  const small = el("small");
  if (panelState.stripTagsLoading) {
    small.textContent = "Loading…";
  } else if (panelState.stripTagsEnabled === null) {
    small.textContent = "Script not found — run a chat turn to install it";
  } else {
    small.textContent = panelState.stripTagsEnabled
      ? "Tags hidden from chat output (normal)"
      : "Tags visible — for debugging only";
  }
  lbl.appendChild(small);

  const pill = el("button", "me-toggle-pill");
  pill.disabled = panelState.stripTagsLoading || panelState.stripTagsScriptId === null;
  if (panelState.stripTagsEnabled) pill.classList.add("on");
  pill.title = panelState.stripTagsEnabled ? "Click to show tags" : "Click to hide tags";
  pill.addEventListener("click", toggleStripTags);

  row.append(lbl, pill);
  body.appendChild(row);

  // Clean up memory pool
  const cleanupRow = el("div", "me-settings-row");
  const cleanupLbl = el("div", "me-settings-lbl");
  cleanupLbl.textContent = "Clean up memory pool";
  const cleanupSmall = el("small");
  cleanupSmall.textContent = "Prune ghosts, deduplicate, mark transients done";
  cleanupLbl.appendChild(cleanupSmall);
  const cleanupBtn = el("button", "me-btn");
  cleanupBtn.textContent = "Run cleanup";
  cleanupBtn.style.fontSize = "10px";
  cleanupBtn.style.padding = "2px 8px";
  cleanupBtn.addEventListener("click", async () => {
    cleanupBtn.disabled = true;
    cleanupBtn.textContent = "Cleaning…";
    try {
      const res = await memFetch("/api/cleanup", { method: "POST", body: JSON.stringify({}) });
      cleanupBtn.textContent = `Done — ${res?.pruned ?? 0} pruned, ${res?.deduped ?? 0} deduped, ${res?.transients ?? 0} transients`;
    } catch {
      cleanupBtn.textContent = "Failed";
    }
  });
  cleanupRow.append(cleanupLbl, cleanupBtn);
  body.appendChild(cleanupRow);

  // Back up memories — full copy of the data dir to a timestamped folder.
  const backupRow = el("div", "me-settings-row");
  const backupLbl = el("div", "me-settings-lbl");
  backupLbl.textContent = "Back up my memories";
  const backupSmall = el("small");
  backupSmall.textContent = "Copy all memory data to a timestamped folder you can keep";
  backupLbl.appendChild(backupSmall);
  const backupBtn = el("button", "me-btn");
  backupBtn.textContent = "Back up now";
  backupBtn.style.fontSize = "10px";
  backupBtn.style.padding = "2px 8px";
  backupBtn.addEventListener("click", async () => {
    backupBtn.disabled = true;
    backupBtn.textContent = "Backing up…";
    try {
      const res = await memFetch("/api/backup", { method: "POST", body: JSON.stringify({}) });
      if (res?.ok) {
        backupBtn.textContent = `Backed up ${res.files} files`;
        backupSmall.textContent = res.dir;
        backupSmall.title = res.dir;
      } else {
        backupBtn.textContent = "Failed";
      }
    } catch {
      backupBtn.textContent = "Failed — is the server running?";
    }
  });
  backupRow.append(backupLbl, backupBtn);
  body.appendChild(backupRow);

  // Backfill memory tiers
  const backfillRow = el("div", "me-settings-row");
  const backfillLbl = el("div", "me-settings-lbl");
  backfillLbl.textContent = "Backfill memory tiers";
  const backfillSmall = el("small");
  backfillSmall.textContent = "Tag pre-existing memories with their earned tier";
  backfillLbl.appendChild(backfillSmall);
  const backfillBtn = el("button", "me-btn");
  backfillBtn.textContent = "Run now";
  backfillBtn.style.fontSize = "10px";
  backfillBtn.style.padding = "2px 8px";
  backfillBtn.addEventListener("click", async () => {
    backfillBtn.disabled = true;
    backfillBtn.textContent = "Running…";
    try {
      const res = await memFetch("/api/promote-all", { method: "POST", body: JSON.stringify({}) });
      backfillBtn.textContent = `Done — ${res?.promoted ?? 0} promoted, ${res?.pruned ?? 0} pruned`;
    } catch {
      backfillBtn.textContent = "Failed";
    }
  });
  backfillRow.append(backfillLbl, backfillBtn);
  body.appendChild(backfillRow);

  // Debug logging toggle
  const debugRow = el("div", "me-settings-row");
  const debugLbl = el("div", "me-settings-lbl");
  debugLbl.textContent = "Debug logging";
  const debugSmall = el("small");
  const debugOn = isDebug();
  debugSmall.textContent = debugOn ? "Verbose pipeline logs to browser console" : "Off — errors only";
  debugLbl.appendChild(debugSmall);
  const debugPill = el("button", "me-toggle-pill");
  if (debugOn) debugPill.classList.add("on");
  debugPill.addEventListener("click", () => {
    const next = !isDebug();
    localStorage.setItem(ME_DEBUG_KEY, next ? "1" : "0");
    renderPanel();
  });
  debugRow.append(debugLbl, debugPill);
  body.appendChild(debugRow);

  wrap.appendChild(body);
  return wrap;
}

// ── Panel DOM ─────────────────────────────────────────────────────────────────

const panel = marinara.addElement(document.body, "div", { id: "me-panel" });

// ── Render ────────────────────────────────────────────────────────────────────

const PANEL_TABS = [
  { key: "memory",   label: "Memory" },
  { key: "import",   label: "Import" },
  { key: "pending",  label: "Pending" },
  { key: "settings", label: "Settings" },
];

// Tab label, with a live count badge on Pending when speakers are waiting.
function tabLabel(t) {
  if (t.key !== "pending") return t.label;
  const n = (panelState.pendingSpeakers ?? []).length;
  return n > 0 ? `${t.label} (${n})` : t.label;
}

function setActiveTab(key) {
  if (panelState.activeTab === key) { renderPanel(); return; }
  panelState.activeTab = key;
  // Entering a tab opens its sections so controls are visible without a second click.
  if (key === "import")   { panelState.importExpanded = true; panelState.ingestExpanded = true; }
  if (key === "settings") { panelState.settingsExpanded = true; panelState.identityExpanded = true; }
  if (key === "pending") {
    loadAllCharacters();                       // for the "Map to existing" dropdown
    if (panelState.pendingSpeakers === null) loadPendingSpeakers();
  }
  renderPanel();
}

function renderPanel() {
  if (!panel) return;

  // Keep the toggle's "import running" cue in sync — renderPanel fires on every
  // progress tick (even while the panel is closed), so this stays live.
  document.getElementById("me-toggle")?.classList.toggle("importing", importInFlight());

  // Preserve scroll position across the full re-render (every action rebuilds
  // the DOM, which would otherwise jump the view back to the top). On a tab
  // switch the content differs, so reset to the top instead.
  const prevContent = panel.querySelector(".me-panel-content");
  const prevScroll = prevContent ? prevContent.scrollTop : 0;
  // Inner scrollables are rebuilt at scrollTop 0 by the full re-render —
  // importing a chat low in the list would snap the list back to the top.
  const prevImportScroll = panel.querySelector(".me-import-list")?.scrollTop ?? 0;
  const tabChanged = panelState._lastRenderedTab !== panelState.activeTab;
  panelState._lastRenderedTab = panelState.activeTab;

  panel.innerHTML = "";

  // Header
  const hdr = el("div", "me-panel-header");
  const title = el("span", "me-panel-title");
  title.textContent = "Ledger";
  const refreshBtn = el("button", "me-icon-btn");
  refreshBtn.innerHTML = "&#8635;";
  refreshBtn.title = "Refresh";
  const closeBtn = el("button", "me-icon-btn");
  closeBtn.innerHTML = "&#215;";
  closeBtn.title = "Close";
  hdr.append(title, refreshBtn, closeBtn);
  panel.appendChild(hdr);

  refreshBtn.addEventListener("click", loadPanelData);
  closeBtn.addEventListener("click", closePanel);

  // Session info line.
  if (panelState.session) {
    const info = el("div", "me-panel-info");
    const charLabel = panelState.session.characterName ?? shorten(panelState.session.characterId);
    info.textContent = `chat/${shorten(panelState.session.chatId)} · ${charLabel}`;
    panel.appendChild(info);
  }

  // Version line — its own row so it's actually readable. Green check when
  // the tab matches the server; the red stale-tab alarm below covers mismatch.
  {
    const serverV = panelState.health?.version;
    const ver = el("div", "me-panel-info");
    ver.style.fontSize = "11px";
    ver.style.opacity = "0.75";
    ver.style.marginTop = "-2px";
    if (serverV && serverV === ME_VERSION) {
      ver.textContent = `Marinara Extender v${ME_VERSION} ✓`;
      ver.title = "Extension and memory server are both on this version.";
    } else if (serverV) {
      ver.textContent = `extension v${ME_VERSION} · server v${serverV}`;
      ver.title = "Versions differ — see the warning below.";
    } else {
      ver.textContent = `Marinara Extender v${ME_VERSION}`;
      ver.title = "Server version unknown (health not loaded yet).";
    }
    panel.appendChild(ver);
  }

  // Stale-tab alarm: the tab is running older extension code than the server
  // is serving — every "the fix didn't work" so far has been exactly this.
  const serverVersion = panelState.health?.version;
  if (serverVersion && ME_VERSION !== "dev" && ME_VERSION !== serverVersion) {
    const stale = el("div", "me-panel-info");
    stale.style.color = "#f87171";
    stale.style.fontWeight = "600";
    // The shared info-line style ellipsizes — this message must wrap in full.
    stale.style.whiteSpace = "normal";
    stale.style.overflow = "visible";
    stale.style.textOverflow = "clip";
    stale.style.wordBreak = "break-word";
    stale.style.lineHeight = "1.4";
    stale.textContent = `⚠ This tab is running extension v${ME_VERSION} but the server is v${serverVersion} — reload the page to update.`;
    panel.appendChild(stale);
  }

  // One-click update (uo4): when GitHub has a newer published release, offer
  // it right here — the updater runs in its own console; no terminal needed.
  if (panelState.health?.updateAvailable && !panelState.updateLaunched) {
    const up = el("button", "me-import-all-btn");
    up.textContent = `⬆ Update to v${panelState.health.latest} (installed: v${panelState.health.version})`;
    up.title = "Downloads, builds, and restarts the memory server in a visible console window, then you reload this page.";
    up.addEventListener("click", async () => {
      up.disabled = true;
      up.textContent = "Updating — watch the console window…";
      panelState.updateLaunched = true;
      try { await memFetch("/api/update", { method: "POST" }); } catch { /* server restarts mid-reply */ }
    });
    panel.appendChild(up);
  } else if (panelState.updateLaunched) {
    const note = el("div", "me-panel-info");
    note.textContent = "⬆ Updating… the memory server is restarting. Reload this page in a minute.";
    panel.appendChild(note);
  }

  // Embeddings degradation is never silent (support-ticket prevention): if
  // semantic features are off for a fixable reason, say so with the fix.
  const emb = panelState.health?.embeddings;
  if (emb === "model_missing" || emb === "ollama_down") {
    const warn = el("div", "me-panel-info");
    warn.style.color = "#fbbf24";
    warn.textContent = emb === "model_missing"
      ? "⚠ Semantic memory features are OFF — embedding model not installed. Run: ollama pull nomic-embed-text"
      : "⚠ Semantic memory features are OFF — Ollama isn't running.";
    warn.title = "Affects arc clustering and semantic chunk merging. Everything else works normally.";
    panel.appendChild(warn);
  }

  // Last-turn memory activity (15y): what the character actually had in
  // context, without reading sidecar logs. Click to expand the list.
  if (lastTurnActivity && panelState.session && lastTurnActivity.chatId === panelState.session.chatId) {
    const act = el("div", "me-panel-info");
    act.style.cursor = "pointer";
    const n = lastTurnActivity.surfaced.length;
    const extras = [];
    if (lastTurnActivity.created > 0) extras.push(`+${lastTurnActivity.created} saved`);
    if (lastTurnActivity.bookmarks > 0) extras.push(`${lastTurnActivity.bookmarks} bookmark${lastTurnActivity.bookmarks === 1 ? "" : "s"}`);
    const ago = Math.max(0, Math.round((Date.now() - lastTurnActivity.at) / 1000));
    act.textContent = `🧠 last turn: ${n} memor${n === 1 ? "y" : "ies"} in context${extras.length ? " · " + extras.join(" · ") : ""} (${ago}s ago) ${panelState.showActivity ? "▾" : "▸"}`;
    act.title = "Memories surfaced into the prompt on the last processed turn — click to expand";
    act.addEventListener("click", () => { panelState.showActivity = !panelState.showActivity; renderPanel(); });
    panel.appendChild(act);
    if (panelState.showActivity && n > 0) {
      const list = el("div", "me-panel-info");
      list.style.maxHeight = "140px";
      list.style.overflowY = "auto";
      list.style.fontSize = "11px";
      list.style.opacity = "0.85";
      for (const s of lastTurnActivity.surfaced) {
        const row = el("div");
        row.textContent = `· [${s.scope}] ${s.summary}`;
        row.title = s.id;
        list.appendChild(row);
      }
      panel.appendChild(list);
    }
  }

  // First-run onboarding takes over the panel (no tabs) until imported or skipped.
  if (panelState.session && !panelState.loading && !panelState.error && !isOnboarded()) {
    const obContent = el("div", "me-panel-content");
    renderOnboarding(obContent);
    panel.appendChild(obContent);
    if (prevScroll && !tabChanged) obContent.scrollTop = prevScroll;
    return;
  }

  // Tab bar
  const tabs = panelState.activeTab;
  const tabBar = el("div", "me-tabbar");
  for (const t of PANEL_TABS) {
    const tabBtn = el("button", "me-tab" + (tabs === t.key ? " active" : ""));
    tabBtn.textContent = tabLabel(t);
    tabBtn.addEventListener("click", () => setActiveTab(t.key));
    tabBar.appendChild(tabBtn);
  }
  panel.appendChild(tabBar);

  // Scrollable content
  const content = el("div", "me-panel-content");

  if (panelState.loading) {
    content.appendChild(Object.assign(el("div", "me-loading"), { textContent: "Loading…" }));
  } else if (!panelState.session) {
    if (tabs === "settings") {
      content.appendChild(renderSettingsSection());
    } else {
      content.appendChild(Object.assign(el("div", "me-empty"), { textContent: "Open a chat with a character to use the ledger." }));
    }
  } else if (panelState.error) {
    content.appendChild(Object.assign(el("div", "me-error"), { textContent: panelState.error }));
  } else if (tabs === "memory") {
    for (const lane of LANES) {
      const entries = panelState.chatEntries.filter(e => e.lane === lane.key);
      content.appendChild(renderLaneSection(lane, entries));
    }
    content.appendChild(renderBookmarksSection(panelState.bookmarks));
    content.appendChild(renderRetiredSection());
  } else if (tabs === "import") {
    content.appendChild(renderImportSection());
    content.appendChild(renderStoryIngestSection());
  } else if (tabs === "pending") {
    content.appendChild(renderPendingSection());
  } else if (tabs === "settings") {
    content.appendChild(renderIdentitySection());
    content.appendChild(renderSettingsSection());
  }

  panel.appendChild(content);

  // Restore scroll once layout is in place (unless we just switched tabs).
  if (prevScroll && !tabChanged) content.scrollTop = prevScroll;
  if (prevImportScroll && !tabChanged) {
    const importList = content.querySelector(".me-import-list");
    if (importList) importList.scrollTop = prevImportScroll;
  }
}

function etaText(current, total, startMs) {
  if (!startMs || current <= 1) return "estimating time remaining…"; // need 1 done chat to time
  const per = (Date.now() - startMs) / (current - 1); // chats actually completed so far
  const remain = per * (total - current + 1);
  if (remain < 1500) return "almost done…";
  const mins = Math.round(remain / 60000);
  return mins >= 1
    ? `about ${mins} minute${mins === 1 ? "" : "s"} remaining`
    : `about ${Math.round(remain / 1000)} seconds remaining`;
}

// First-run onboarding: a single prominent action, honest progress, a payoff.
function renderOnboarding(content) {
  const wrap = el("div", "me-onboard");
  const flow = panelState.importFlow;

  if (flow === "running") {
    const { current, total, startMs } = panelState.importFlowProgress ?? { current: 0, total: 0, startMs: 0 };
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    wrap.append(Object.assign(el("div", "me-onboard-head"), { textContent: "Building your characters' memories" }));
    const bar = el("div", "me-onboard-bar");
    const fill = el("div", "me-onboard-bar-fill"); fill.style.width = `${pct}%`; bar.appendChild(fill);
    wrap.append(bar);
    wrap.append(Object.assign(el("div", "me-onboard-line"), { textContent: `Analyzing chat ${current} of ${total}` }));
    // Within-chat progress (streamed) — so a long chat doesn't look frozen.
    const cp = panelState.importChatProgress;
    if (cp && cp.total > 0) {
      const sub = el("div", "me-onboard-bar"); sub.style.height = "5px";
      const sf = el("div", "me-onboard-bar-fill"); sf.style.width = `${Math.round((cp.current / cp.total) * 100)}%`;
      sub.appendChild(sf); wrap.append(sub);
      wrap.append(Object.assign(el("div", "me-onboard-sub"), { textContent: `moment ${cp.current} of ${cp.total} in this chat` }));
    }
    wrap.append(Object.assign(el("div", "me-onboard-sub"), { textContent: etaText(current, total, startMs) }));
    const cancel = el("button", "me-btn-danger");
    cancel.textContent = panelState.importCancel ? "Finishing current chat…" : "Cancel";
    cancel.disabled = panelState.importCancel;
    cancel.addEventListener("click", cancelOnboarding);
    wrap.append(cancel);
    content.appendChild(wrap);
    return;
  }

  if (flow === "done") {
    const r = panelState.importFlowResult ?? { moments: 0, chats: 0, failed: 0 };
    wrap.append(Object.assign(el("div", "me-onboard-check"), { textContent: "✓" }));
    wrap.append(Object.assign(el("div", "me-onboard-payoff"), {
      textContent: `Your characters remembered ${r.moments.toLocaleString()} moment${r.moments === 1 ? "" : "s"} across ${r.chats.toLocaleString()} conversation${r.chats === 1 ? "" : "s"}.`,
    }));
    const cta = el("button", "me-btn-primary me-onboard-cta");
    cta.textContent = "Open a chat";
    cta.addEventListener("click", finishOnboarding);
    wrap.append(cta);
    if (r.failed) wrap.append(Object.assign(el("div", "me-onboard-sub"), { textContent: `${r.failed} chat${r.failed === 1 ? "" : "s"} couldn't be processed and were skipped.` }));
    if (r.cancelled) wrap.append(Object.assign(el("div", "me-onboard-sub"), { textContent: "Stopped early — re-open the Import tab to finish the rest anytime." }));
    content.appendChild(wrap);
    return;
  }

  if (flow === "estimating") {
    wrap.append(Object.assign(el("div", "me-onboard-head"), { textContent: "Scanning your chats…" }));
    const p = panelState.importFlowProgress;
    wrap.append(Object.assign(el("div", "me-onboard-sub"), { textContent: p ? `reading chat ${p.current} of ${p.total}` : "one moment…" }));
    content.appendChild(wrap);
    return;
  }

  if (flow === "choosing") {
    const chats = panelState.importScope === "all"
      ? (panelState.importChatsAll ?? [])
      : (panelState.importChats ?? []);
    const chosen = panelState.importChosen ?? new Set();
    wrap.append(Object.assign(el("div", "me-onboard-head"), { textContent: "Choose chats to import" }));
    const bar = el("div", "me-onboard-choosebar");
    const selAll = el("a", "me-onboard-skip"); selAll.textContent = "Select all"; selAll.href = "#";
    selAll.addEventListener("click", (e) => { e.preventDefault(); setAllChosen(true); });
    const selNone = el("a", "me-onboard-skip"); selNone.textContent = "None"; selNone.href = "#";
    selNone.addEventListener("click", (e) => { e.preventDefault(); setAllChosen(false); });
    bar.append(selAll, Object.assign(el("span", "me-onboard-sub"), { textContent: `${chosen.size}/${chats.length} selected` }), selNone);
    wrap.append(bar);

    const list = el("div", "me-onboard-list");
    for (const c of chats) {
      const row = el("label", "me-onboard-chatrow");
      const cb = el("input"); cb.type = "checkbox"; cb.checked = chosen.has(c.id);
      cb.addEventListener("change", () => toggleChosen(c.id));
      const lbl = el("span", "me-onboard-chatlabel");
      lbl.textContent = panelState.importScope === "all" ? `${c.characterName} · ${c.name}` : c.name;
      lbl.title = lbl.textContent;
      row.append(cb, lbl);
      list.append(row);
    }
    wrap.append(list);

    const go = el("button", "me-btn-primary me-onboard-cta");
    go.textContent = `Import selected (${chosen.size})`;
    go.disabled = chosen.size === 0;
    go.addEventListener("click", onboardScanChosen);
    wrap.append(go);
    const back = el("a", "me-onboard-skip"); back.textContent = "Back"; back.href = "#";
    back.addEventListener("click", (e) => { e.preventDefault(); panelState.importFlow = "intro"; renderPanel(); });
    wrap.append(back);
    content.appendChild(wrap);
    return;
  }

  if (flow === "ready") {
    const s = panelState.importFlowStats ?? { chats: 0, calls: 0, tokens: 0, characters: 0 };
    if (s.chats === 0) {
      wrap.append(Object.assign(el("div", "me-onboard-head"), { textContent: "Nothing to import" }));
      wrap.append(Object.assign(el("div", "me-onboard-copy"), { textContent: "No conversations found for this selection. Come back once you've chatted more." }));
      const ok = el("button", "me-btn-primary me-onboard-cta"); ok.textContent = "Got it"; ok.addEventListener("click", skipOnboarding);
      wrap.append(ok);
      content.appendChild(wrap);
      return;
    }
    wrap.append(Object.assign(el("div", "me-onboard-head"), { textContent: "Ready to import" }));
    const charPart = s.characters > 1 ? ` across ${s.characters} characters` : "";
    wrap.append(Object.assign(el("div", "me-onboard-sub"), {
      textContent: `${s.chats.toLocaleString()} conversation${s.chats === 1 ? "" : "s"}${charPart} · ~${s.calls.toLocaleString()} analysis call${s.calls === 1 ? "" : "s"} (~${s.tokens.toLocaleString()} tokens)`,
    }));
    const start = el("button", "me-btn-primary me-onboard-cta"); start.textContent = "Start import"; start.addEventListener("click", onboardRun);
    wrap.append(start);
    const later = el("a", "me-onboard-skip"); later.textContent = "Not now"; later.href = "#";
    later.addEventListener("click", (e) => { e.preventDefault(); skipOnboarding(); });
    wrap.append(later);
    content.appendChild(wrap);
    return;
  }

  // intro (default)
  wrap.append(Object.assign(el("div", "me-onboard-head"), { textContent: "Give your characters their memory" }));
  wrap.append(Object.assign(el("div", "me-onboard-copy"), { textContent: "Import your past chats so your characters can remember them." }));

  // Scope toggle: this character vs all characters.
  const scopeRow = el("div", "me-onboard-scope");
  for (const opt of [{ k: "character", t: "This character" }, { k: "all", t: "All characters" }]) {
    const b = el("button", "me-scope-btn" + (panelState.importScope === opt.k ? " active" : ""));
    b.textContent = opt.t;
    b.addEventListener("click", () => setImportScope(opt.k));
    scopeRow.append(b);
  }
  wrap.append(scopeRow);

  const btn = el("button", "me-btn-primary me-onboard-cta");
  btn.textContent = panelState.importScope === "all" ? "Import all chats — every character" : "Import all my past chats";
  btn.addEventListener("click", onboardScanAll);
  wrap.append(btn);

  const choose = el("a", "me-onboard-skip"); choose.textContent = "Choose which chats"; choose.href = "#";
  choose.addEventListener("click", (e) => { e.preventDefault(); openChooser(); });
  wrap.append(choose);
  const later = el("a", "me-onboard-skip"); later.textContent = "Not now"; later.href = "#";
  later.addEventListener("click", (e) => { e.preventDefault(); skipOnboarding(); });
  wrap.append(later);
  content.appendChild(wrap);
}

// ── Retired section (3pl) ─────────────────────────────────────────────────────
// Collapsible list of CHARACTER-scope facts the curator/sweep retired, with the
// fact that replaced each, and a human-initiated rollback (undo, or flip). Lazy-
// loads on first expand. Reuses the .me-section / .me-entry patterns (no new CSS).
function renderRetiredSection() {
  const section = el("div", "me-section");
  const hdr = el("div", "me-section-header");
  hdr.style.cursor = "pointer";
  const dot_ = el("span", "me-section-dot");
  dot_.style.background = "#6b7280"; // grey — retired/cold
  const label = el("span", "me-section-label");
  label.textContent = (panelState.retiredExpanded ? "▾ " : "▸ ") + "Retired (character memory)";
  const count = el("span", "me-section-count");
  count.textContent = panelState.retired ? panelState.retired.length : "";
  hdr.append(dot_, label, count);
  hdr.title = "Facts the reconciliation curator merged away. Restore one if it was wrong.";
  hdr.addEventListener("click", () => {
    panelState.retiredExpanded = !panelState.retiredExpanded;
    if (panelState.retiredExpanded && panelState.retired === null && !panelState.retiredLoading) loadRetired();
    renderPanel();
  });
  section.appendChild(hdr);

  if (panelState.retiredExpanded) {
    if (panelState.retiredLoading) {
      section.appendChild(Object.assign(el("div", "me-section-empty"), { textContent: "Loading…" }));
    } else if (!panelState.retired || panelState.retired.length === 0) {
      section.appendChild(Object.assign(el("div", "me-section-empty"), { textContent: "No retired facts." }));
    } else {
      const PREVIEW = 12;
      const showAll = panelState.retiredShowAll || panelState.retired.length <= PREVIEW;
      const rows = showAll ? panelState.retired : panelState.retired.slice(0, PREVIEW);
      for (const r of rows) section.appendChild(renderRetiredRow(r));
      if (panelState.retired.length > PREVIEW) {
        const more = el("button", "me-add-btn");
        more.textContent = showAll ? "Show fewer" : `Show all ${panelState.retired.length} (newest first)`;
        more.addEventListener("click", () => { panelState.retiredShowAll = !panelState.retiredShowAll; renderPanel(); });
        section.appendChild(more);
      }
    }
  }
  return section;
}

function renderRetiredRow(r) {
  const wrap = el("div", "me-entry");
  const body = el("div", "me-entry-body");

  const summary = el("span", "me-entry-summary");
  summary.textContent = r.summary;
  summary.title = r.summary;
  body.appendChild(summary);

  const meta = el("div", "me-entry-meta");
  const when = el("span", "me-status-badge");
  when.textContent = r.supersededAt ? `retired ${String(r.supersededAt).slice(0, 10)}` : "retired";
  when.style.background = "transparent";
  when.style.opacity = "0.7";
  meta.appendChild(when);
  body.appendChild(meta);

  // Supersession history, inline — ONE truncated line (full text on hover), same
  // discipline as the lane entries; the old wrapping turned each row into a wall.
  const rep = el("div");
  rep.textContent = r.replacedBy ? `↳ replaced by: ${r.replacedBy.summary}` : "↳ replacement no longer present";
  rep.title = r.replacedBy ? r.replacedBy.summary : "";
  rep.style.cssText = "font-size:11px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;";
  body.appendChild(rep);

  const actions = el("div", "me-entry-actions");
  const busy = panelState.retiredBusy === r.id;
  const restore = el("button", "me-btn-done");
  restore.textContent = "Restore";
  restore.title = "Bring this fact back; keep its replacement too (undo a false merge)";
  restore.disabled = busy;
  restore.addEventListener("click", () => doRollback(r.id, false));
  const flip = el("button", "me-btn-done");
  flip.textContent = "Restore as canonical ⇄";
  flip.title = "Bring this back AND retire its replacement (the curator picked the wrong one)";
  flip.disabled = busy;
  flip.addEventListener("click", () => doRollback(r.id, true));
  actions.append(restore, flip);

  wrap.append(body, actions);
  return wrap;
}

async function loadRetired() {
  const session = panelState.session;
  if (!session?.characterId) { panelState.retired = []; renderPanel(); return; }
  panelState.retiredLoading = true;
  renderPanel();
  const nameParam = session.characterName ? `&characterName=${encodeURIComponent(session.characterName)}` : "";
  const res = await memFetch(`/api/retired?characterId=${encodeURIComponent(session.characterId)}${nameParam}`).catch(() => null);
  panelState.retired = res?.retired ?? [];
  panelState.retiredLoading = false;
  renderPanel();
}

async function doRollback(id, flip) {
  const session = panelState.session;
  if (!session?.characterId) return;
  panelState.retiredBusy = id;
  renderPanel();
  await memFetch("/api/rollback", {
    method: "POST",
    body: JSON.stringify({ characterId: session.characterId, characterName: session.characterName, id, flip }),
  }).catch(() => {});
  panelState.retiredBusy = null;
  panelState.retired = null; // force a fresh list (the restored fact drops out; a flip retires its replacement)
  await loadRetired();
}

function renderLaneSection(lane, entries) {
  const section = el("div", "me-section");

  // Header
  const hdr = el("div", "me-section-header");
  const dot_ = el("span", "me-section-dot");
  dot_.style.background = lane.color;
  const label = el("span", "me-section-label");
  label.textContent = lane.label;
  const count = el("span", "me-section-count");
  count.textContent = entries.length;
  hdr.append(dot_, label, count);
  section.appendChild(hdr);

  if (entries.length === 0 && panelState.addingLane !== lane.key) {
    const empty = el("div", "me-section-empty");
    empty.textContent = "Nothing here yet.";
    section.appendChild(empty);
  }

  for (const entry of entries) {
    section.appendChild(renderEntry(entry, lane));
  }

  if (panelState.addingLane === lane.key) {
    section.appendChild(renderAddForm(lane.key));
  } else {
    const addBtn = el("button", "me-add-btn");
    addBtn.textContent = lane.addLabel;
    addBtn.addEventListener("click", () => {
      panelState.addingLane = lane.key;
      panelState.addingSummary = "";
      renderPanel();
    });
    section.appendChild(addBtn);
  }

  return section;
}

function renderEntry(entry, lane) {
  const wrap = el("div", "me-entry");

  const body = el("div", "me-entry-body");
  const summary = el("span", "me-entry-summary");
  summary.title = entry.summary;
  summary.textContent = entry.summary;

  const meta = el("div", "me-entry-meta");
  const statusCfg = STATUS_BADGE[entry.status ?? "open"] ?? STATUS_BADGE.open;
  const badge = el("span", "me-status-badge");
  badge.textContent = statusCfg.label;
  badge.style.background = statusCfg.bg;
  badge.style.color = statusCfg.fg;
  meta.appendChild(badge);

  // Retrieval/recitation stats (15y): is this memory actually getting used?
  const rc = entry.retrievalCount ?? 0;
  const rec = entry.recitationCount ?? 0;
  if (rc > 0 || rec > 0) {
    const stats = el("span", "me-status-badge");
    stats.textContent = `⟲${rc}${rec > 0 ? ` ✓${rec}` : ""}`;
    stats.style.background = "transparent";
    stats.style.opacity = "0.7";
    stats.title = `retrieved into context ${rc}×${rec > 0 ? `, demonstrably used ${rec}×` : ""}` +
      (entry.lastRetrievedAt ? ` — last ${String(entry.lastRetrievedAt).slice(0, 10)}` : "");
    meta.appendChild(stats);
  }

  body.append(summary, meta);

  const actions = el("div", "me-entry-actions");

  if (lane.key === "open_threads" && entry.status !== "done") {
    const doneBtn = el("button", "me-btn-done");
    doneBtn.textContent = "✓";
    doneBtn.title = "Mark done";
    doneBtn.addEventListener("click", () => markEntryDone(entry));
    actions.appendChild(doneBtn);
  }

  const delBtn = el("button", "me-btn-delete");
  delBtn.textContent = "×";
  delBtn.title = "Delete";
  delBtn.addEventListener("click", () => removeEntry(entry));
  actions.appendChild(delBtn);

  wrap.append(body, actions);
  return wrap;
}

function renderAddForm(laneKey) {
  const form = el("div", "me-add-form");

  const input = el("input", "me-add-input");
  input.type = "text";
  input.placeholder = "Summary…";
  input.maxLength = 200;
  input.value = panelState.addingSummary;
  form.appendChild(input);

  const row = el("div", "me-add-form-row");
  const submitBtn = el("button", "me-btn-primary");
  submitBtn.textContent = "Add";
  const cancelBtn = el("button", "me-btn-cancel");
  cancelBtn.textContent = "Cancel";
  row.append(submitBtn, cancelBtn);
  form.appendChild(row);

  input.addEventListener("input", e => { panelState.addingSummary = e.target.value; });
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); addEntry(laneKey, input.value); }
    if (e.key === "Escape") { panelState.addingLane = null; renderPanel(); }
  });
  submitBtn.addEventListener("click", () => addEntry(laneKey, input.value));
  cancelBtn.addEventListener("click", () => { panelState.addingLane = null; renderPanel(); });

  // Autofocus after render cycle completes
  marinara.setTimeout(() => input.focus(), 30);

  return form;
}

function renderBookmarksSection(bookmarks) {
  const section = el("div", "me-section");

  const hdr = el("div", "me-section-header");
  const dot_ = el("span", "me-section-dot");
  dot_.style.background = "#f59e0b";
  const label = el("span", "me-section-label");
  label.textContent = "Bookmarks";
  const count = el("span", "me-section-count");
  count.textContent = bookmarks.length;
  hdr.append(dot_, label, count);
  section.appendChild(hdr);

  if (bookmarks.length === 0) {
    const empty = el("div", "me-section-empty");
    empty.textContent = "No active bookmarks.";
    section.appendChild(empty);
    return section;
  }

  for (const bm of bookmarks) {
    section.appendChild(renderBookmark(bm));
  }

  return section;
}

function renderBookmark(bm) {
  const wrap = el("div", "me-bookmark");

  const row = el("div", "me-bm-row");
  const topic = el("span", "me-bm-topic");
  topic.textContent = bm.topic;
  topic.title = bm.topic;

  const barWrap = el("div", "me-bm-bar-wrap");
  const bar = el("div", "me-bm-bar");
  const fill = el("div", "me-bm-fill");
  fill.style.width = `${Math.round(bm.weight * 100)}%`;
  bar.appendChild(fill);
  const pct = el("span", "me-bm-pct");
  pct.textContent = `${Math.round(bm.weight * 100)}%`;
  barWrap.append(bar, pct);

  const delBtn = el("button", "me-btn-delete");
  delBtn.textContent = "×";
  delBtn.title = "Delete bookmark";
  delBtn.addEventListener("click", () => removeBookmark(bm));

  row.append(topic, barWrap, delBtn);
  wrap.appendChild(row);

  const summary = el("div", "me-bm-summary");
  summary.textContent = bm.summary;
  wrap.appendChild(summary);

  const why = el("div", "me-bm-why");
  why.textContent = bm.why;
  wrap.appendChild(why);

  return wrap;
}

// ── Identity section render ───────────────────────────────────────────────────

function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = "✓";
    marinara.setTimeout(() => { btn.textContent = orig; }, 1200);
  }).catch(() => {});
}

function renderIdentitySection() {
  if (!panelState.session) return el("div", "");
  const { characterId, chatId } = panelState.session;

  const wrap = el("div", "me-identity-section");

  const toggleBtn = el("button", "me-identity-toggle");
  const dot_ = el("span", "me-section-dot");
  dot_.style.background = "#6366f1";
  dot_.style.flexShrink = "0";
  const label = el("span", "me-section-label");
  label.textContent = "Identity";
  const chevron = el("span", "me-import-chevron");
  chevron.textContent = "▶";
  if (panelState.identityExpanded) chevron.classList.add("open");
  toggleBtn.append(dot_, label, chevron);
  wrap.appendChild(toggleBtn);

  toggleBtn.addEventListener("click", () => {
    panelState.identityExpanded = !panelState.identityExpanded;
    if (panelState.identityExpanded && panelState.identityKey === null) {
      loadIdentityInfo();
    } else {
      renderPanel();
    }
  });

  if (!panelState.identityExpanded) return wrap;

  const body = el("div", "me-identity-body");

  if (panelState.identityLoading) {
    const msg = el("div", "me-loading"); msg.textContent = "Loading…";
    body.appendChild(msg); wrap.appendChild(body); return wrap;
  }

  // Character ID row
  const charRow = el("div", "me-id-field");
  const charLbl = el("span", "me-id-label"); charLbl.textContent = "Card ID";
  const charVal = el("span", "me-id-value"); charVal.textContent = characterId; charVal.title = characterId;
  const charCopy = el("button", "me-id-copy"); charCopy.textContent = "⎘"; charCopy.title = "Copy";
  charCopy.addEventListener("click", () => copyToClipboard(characterId, charCopy));
  charRow.append(charLbl, charVal, charCopy);
  body.appendChild(charRow);

  // Chat ID row
  const chatRow = el("div", "me-id-field");
  const chatLbl = el("span", "me-id-label"); chatLbl.textContent = "Chat ID";
  const chatVal = el("span", "me-id-value"); chatVal.textContent = chatId; chatVal.title = chatId;
  const chatCopy = el("button", "me-id-copy"); chatCopy.textContent = "⎘"; chatCopy.title = "Copy";
  chatCopy.addEventListener("click", () => copyToClipboard(chatId, chatCopy));
  chatRow.append(chatLbl, chatVal, chatCopy);
  body.appendChild(chatRow);

  // Identity key row
  if (panelState.identityKey) {
    const keyRow = el("div", "me-id-field");
    const keyLbl = el("span", "me-id-label"); keyLbl.textContent = "Key";
    const keyVal = el("span", "me-id-value"); keyVal.textContent = panelState.identityKey; keyVal.title = panelState.identityKey;
    const keyCopy = el("button", "me-id-copy"); keyCopy.textContent = "⎘"; keyCopy.title = "Copy";
    keyCopy.addEventListener("click", () => copyToClipboard(panelState.identityKey, keyCopy));
    keyRow.append(keyLbl, keyVal, keyCopy);
    body.appendChild(keyRow);
  }

  // Rename form — updates the display name stored in the identity map
  const renameLbl = el("div", "me-relink-label");
  renameLbl.textContent = "Display name:";
  body.appendChild(renameLbl);

  const renameRow = el("div", "me-relink-row");
  const renameInput = el("input", "me-relink-input");
  renameInput.type = "text";
  renameInput.placeholder = "Character name…";
  renameInput.value = panelState.renameInput || (panelState.session?.characterName ?? "");
  renameInput.addEventListener("input", e => { panelState.renameInput = e.target.value; panelState.renameStatus = null; });
  const renameBtn = el("button", "me-btn-primary");
  renameBtn.textContent = "Save";
  renameBtn.style.flexShrink = "0";
  renameBtn.addEventListener("click", () => doRename(panelState.identityKey ?? ""));
  renameRow.append(renameInput, renameBtn);
  body.appendChild(renameRow);

  if (panelState.renameStatus === "ok") {
    const ok = el("div", "me-relink-ok"); ok.textContent = "✓ Name updated";
    body.appendChild(ok);
  } else if (panelState.renameStatus) {
    const err = el("div", "me-relink-err"); err.textContent = panelState.renameStatus;
    body.appendChild(err);
  }

  // Relink form — points a new card ID at this character's memory bucket
  const relinkLbl = el("div", "me-relink-label");
  relinkLbl.textContent = "Card recreated? Link new ID to this identity:";
  body.appendChild(relinkLbl);

  const relinkRow = el("div", "me-relink-row");
  const relinkInput = el("input", "me-relink-input");
  relinkInput.type = "text";
  relinkInput.placeholder = "New card ID…";
  relinkInput.value = panelState.relinkInput;
  relinkInput.addEventListener("input", e => { panelState.relinkInput = e.target.value; panelState.relinkStatus = null; });

  const relinkBtn = el("button", "me-btn-primary");
  relinkBtn.textContent = "Relink";
  relinkBtn.style.flexShrink = "0";
  relinkBtn.addEventListener("click", () => doRelink(panelState.identityKey ?? ""));
  relinkRow.append(relinkInput, relinkBtn);
  body.appendChild(relinkRow);

  if (panelState.relinkStatus === "ok") {
    const ok = el("div", "me-relink-ok"); ok.textContent = "✓ Relinked successfully";
    body.appendChild(ok);
  } else if (panelState.relinkStatus) {
    const err = el("div", "me-relink-err"); err.textContent = panelState.relinkStatus;
    body.appendChild(err);
  }

  wrap.appendChild(body);
  return wrap;
}

async function loadIdentityInfo() {
  if (!panelState.session) return;
  panelState.identityLoading = true;
  renderPanel();
  try {
    const res = await memFetch("/api/identity");
    const entries = Array.isArray(res?.entries) ? res.entries : [];
    const match = entries.find(e => String(e.characterId) === String(panelState.session.characterId));
    panelState.identityKey = match?.identityKey ?? null;
  } catch {
    panelState.identityKey = null;
  }
  panelState.identityLoading = false;
  renderPanel();
}

async function doRename(identityKey) {
  const name = panelState.renameInput.trim();
  if (!name || !identityKey) {
    panelState.renameStatus = "Enter a name and ensure identity key is loaded.";
    renderPanel(); return;
  }
  try {
    const res = await memFetch("/api/identity/name", {
      method: "PATCH",
      body: JSON.stringify({ identityKey, name }),
    });
    if (res?.ok) {
      panelState.renameStatus = "ok";
      panelState.renameInput = "";
      if (panelState.session) panelState.session.characterName = name;
    } else {
      panelState.renameStatus = res?.error ?? "Rename failed.";
    }
  } catch (err) {
    panelState.renameStatus = String(err);
  }
  renderPanel();
}

async function doRelink(identityKey) {
  const newId = panelState.relinkInput.trim();
  if (!newId || !identityKey) {
    panelState.relinkStatus = "Enter a card ID and ensure identity key is loaded.";
    renderPanel(); return;
  }
  try {
    const res = await memFetch("/api/identity/relink", {
      method: "POST",
      body: JSON.stringify({ characterId: newId, identityKey }),
    });
    if (res?.ok) {
      panelState.relinkStatus = "ok";
      panelState.relinkInput = "";
    } else {
      panelState.relinkStatus = res?.error ?? "Relink failed.";
    }
  } catch (err) {
    panelState.relinkStatus = String(err);
  }
  renderPanel();
}

// ── Story ingest helpers ──────────────────────────────────────────────────────

// Safe base64 encode for large ArrayBuffers (avoids call-stack overflow).
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Singleton hidden file input — created once, reused across renders.
let _ingestFileInput = null;
function getIngestFileInput() {
  if (!_ingestFileInput) {
    _ingestFileInput = document.createElement("input");
    _ingestFileInput.type = "file";
    _ingestFileInput.accept = ".txt,.docx";
    _ingestFileInput.style.display = "none";
    document.body.appendChild(_ingestFileInput);
    marinara.onCleanup(() => { _ingestFileInput?.remove(); _ingestFileInput = null; });
    _ingestFileInput.addEventListener("change", () => {
      const file = _ingestFileInput.files?.[0];
      if (file) loadIngestFile(file);
      _ingestFileInput.value = "";  // allow re-selecting the same file
    });
  }
  return _ingestFileInput;
}

async function loadIngestFile(file) {
  const name = file.name;
  const ext = name.split(".").pop()?.toLowerCase();
  panelState.ingestFileName = name;
  panelState.ingestResult = null;

  if (ext === "txt") {
    const reader = new FileReader();
    reader.onload = e => {
      panelState.ingestText = e.target.result;
      renderPanel();
    };
    reader.readAsText(file);
  } else if (ext === "docx") {
    panelState.ingestRunning = true;
    panelState.ingestStatus = "Reading .docx…";
    renderPanel();
    try {
      const ab = await file.arrayBuffer();
      const b64 = arrayBufferToBase64(ab);
      const res = await memFetch("/api/extract-text", {
        method: "POST",
        body: JSON.stringify({ filename: name, data: b64 }),
      });
      if (res?.error) throw new Error(res.error);
      panelState.ingestText = res.text ?? "";
    } catch (err) {
      panelState.ingestResult = { error: `Could not read .docx: ${err.message}` };
      panelState.ingestFileName = null;
    }
    panelState.ingestRunning = false;
    panelState.ingestStatus = "";
    renderPanel();
  }
}

async function doStoryIngest() {
  if (!panelState.session || !panelState.ingestText.trim()) return;
  const { characterId, characterName } = panelState.session;

  const ac = new AbortController();
  panelState.ingestAbort = ac;
  panelState.ingestRunning = true;
  panelState.ingestStatus = "Analyzing story…";
  panelState.ingestResult = null;
  panelState.ingestClearResult = null;
  renderPanel();

  // Build per-character assignments (and persist each one's remembered names).
  const assignments = panelState.ingestAssignments
    .filter(a => a.characterId)
    .map(a => {
      setSavedCharNames(a.characterId, a.names);
      return {
        characterId: a.characterId,
        characterName: a.characterName,
        names: (a.names || "").split(",").map(s => s.trim()).filter(Boolean),
      };
    });

  try {
    const body = {
      characterId,
      characterName: characterName ?? "the character",
      text: panelState.ingestText,
    };
    const pov = panelState.ingestPovChar.trim();
    if (pov) body.povCharacter = pov;
    if (assignments.length) body.assignments = assignments;
    if (panelState.ingestUseExternal) body.useExternal = true;
    // Label the sidecar-console progress output with the file name.
    if (panelState.ingestFileName) body.title = panelState.ingestFileName;

    const res = await memFetch("/api/ingest-story", { method: "POST", body: JSON.stringify(body), signal: ac.signal });
    if (res?.error) throw new Error(res.error);
    panelState.ingestResult = {
      beats:          res.beats,
      chunksTotal:    res.chunksTotal,
      skipped:        res.perCharacter?.reduce((s, c) => s + (c.skipped || 0), 0) ?? 0,
      parseMethod:    res.parseMethod,
      speakers:       res.speakers ?? [],
      perCharacter:   res.perCharacter ?? [],
      pending:        res.pending ?? 0,       // beats held for speaker resolution
      autoRouted:     res.autoRouted ?? 0,    // beats routed via an existing alias
    };
    // A fresh batch may have created pending speakers — invalidate the cache so
    // the Pending tab (and its count) reload on next view.
    panelState.pendingSpeakers = null;
    notifyIngestDone(characterName, res.beats ?? 0);
  } catch (err) {
    if (err?.name === "AbortError") {
      panelState.ingestResult = { cancelled: true };
    } else {
      panelState.ingestResult = { error: err.message ?? "Ingest failed" };
      notifyIngestDone(characterName, 0);  // badge still appears so they know it finished
    }
  }

  panelState.ingestAbort = null;
  panelState.ingestRunning = false;
  panelState.ingestStatus = "";
  renderPanel();
}

function cancelStoryIngest() {
  if (!panelState.ingestAbort) return;
  panelState.ingestAbort.abort();
  panelState.ingestStatus = "Cancelling…";
  renderPanel();
}

async function doClearBeats() {
  if (!panelState.session) return;
  if (!confirm("Delete all saved beats for this character? This cannot be undone.")) return;
  panelState.ingestClearRunning = true;
  panelState.ingestClearResult = null;
  renderPanel();
  try {
    const { characterId } = panelState.session;
    const res = await memFetch(`/api/beats/${encodeURIComponent(characterId)}`, { method: "DELETE" });
    if (res?.error) throw new Error(res.error);
    panelState.ingestClearResult = { deleted: res.deleted ?? 0 };
  } catch (err) {
    panelState.ingestClearResult = { error: err.message ?? "Failed to clear beats" };
  }
  panelState.ingestClearRunning = false;
  renderPanel();
}

// ── Story ingest section render ───────────────────────────────────────────────

function renderStoryIngestSection() {
  const wrap = el("div", "me-ingest-section");

  const toggleBtn = el("button", "me-ingest-toggle");
  const dot_ = el("span", "me-section-dot");
  dot_.style.background = "#8b5cf6";
  dot_.style.flexShrink = "0";
  const label = el("span", "me-section-label");
  label.textContent = "Story Ingest";
  const chevron = el("span", "me-import-chevron");
  chevron.textContent = "▶";
  if (panelState.ingestExpanded) chevron.classList.add("open");
  toggleBtn.append(dot_, label, chevron);
  wrap.appendChild(toggleBtn);

  toggleBtn.addEventListener("click", () => {
    panelState.ingestExpanded = !panelState.ingestExpanded;
    renderPanel();
  });

  if (!panelState.ingestExpanded) return wrap;

  const body = el("div", "me-ingest-body");

  // Loading state — replace body with spinner while a fetch is in flight
  if (panelState.ingestRunning) {
    const runWrap = el("div", "me-ingest-running");
    const spinner = el("span", "me-spinner");
    const statusTxt = el("span");
    statusTxt.textContent = panelState.ingestStatus || "Working…";
    runWrap.append(spinner, statusTxt);
    body.appendChild(runWrap);

    const hint = el("div", "me-ingest-hint");
    hint.textContent = "Long stories run in the sidecar console — watch there for the live progress bar. You can cancel and restart anytime.";
    body.appendChild(hint);

    const cancelRow = el("div", "me-ingest-bottom");
    const cancelBtn = el("button", "me-btn-danger");
    cancelBtn.textContent = "Cancel import";
    cancelBtn.addEventListener("click", cancelStoryIngest);
    cancelRow.appendChild(cancelBtn);
    body.appendChild(cancelRow);

    wrap.appendChild(body);
    return wrap;
  }

  // Initialize the character assignments for the open chat's character, once per
  // character switch. Each row maps a character to the speaker label(s) they
  // appear as in the story. Speaker names are remembered per character.
  const cid = panelState.session?.characterId ?? null;
  if (panelState.ingestAssignmentsFor !== cid) {
    panelState.ingestAssignments = cid
      ? [{ characterId: cid, characterName: panelState.session.characterName ?? cid, names: getSavedCharNames(cid) }]
      : [];
    panelState.ingestAssignmentsFor = cid;
  }
  if (!panelState.allCharacters && !panelState.allCharactersLoading) loadAllCharacters();

  // POV character field
  const povRow = el("div", "me-ingest-row");
  const povLbl = el("span", "me-ingest-lbl");
  povLbl.textContent = "POV char";
  const povInput = el("input", "me-ingest-input");
  povInput.type = "text";
  povInput.placeholder = "e.g. Mark (optional)";
  povInput.value = panelState.ingestPovChar;
  povInput.addEventListener("input", e => { panelState.ingestPovChar = e.target.value; });
  povRow.append(povLbl, povInput);
  body.appendChild(povRow);

  // ── Characters in this story (multi-character routing) ──────────────────────
  const charsTitle = el("div", "me-ingest-sublabel");
  charsTitle.textContent = "Characters in this story";
  body.appendChild(charsTitle);

  panelState.ingestAssignments.forEach((asg, idx) => {
    const row = el("div", "me-ingest-row");

    const sel = el("select", "me-ingest-input");
    const ph = el("option");
    ph.value = "";
    ph.textContent = panelState.allCharactersLoading ? "loading…" : "pick character…";
    sel.appendChild(ph);
    for (const c of (panelState.allCharacters ?? [])) {
      const o = el("option");
      o.value = c.id;
      o.textContent = c.name;
      if (c.id === asg.characterId) o.selected = true;
      sel.appendChild(o);
    }
    // Create a brand-new character inline, so a story can be imported to a card
    // that doesn't exist yet without round-tripping through the Pending tab.
    const newOpt = el("option");
    newOpt.value = "__new__";
    newOpt.textContent = "+ New character…";
    sel.appendChild(newOpt);
    sel.value = asg.characterId || "";
    sel.addEventListener("change", async e => {
      const val = e.target.value;
      if (val === "__new__") {
        const nm = (window.prompt("New character name:", asg.names || "") || "").trim();
        if (!nm) { sel.value = asg.characterId || ""; return; } // cancelled — revert
        sel.disabled = true;
        try {
          const c = await createCharacterCard(nm);
          asg.characterId = c.id;
          asg.characterName = c.name;
          if (!asg.names) { asg.names = nm; setSavedCharNames(c.id, nm); }
          panelState.allCharacters = null;   // pull the new card into the list
          await loadAllCharacters();          // repopulates + re-renders with asg set
        } catch (err) {
          window.alert(`Create character failed: ${err?.message ?? err}`);
          sel.value = asg.characterId || "";
          sel.disabled = false;
        }
        return;
      }
      const c = (panelState.allCharacters ?? []).find(x => x.id === val);
      asg.characterId = val;
      asg.characterName = c?.name ?? "";
      asg.names = getSavedCharNames(asg.characterId); // load this character's remembered names
      renderPanel();
    });

    const namesInput = el("input", "me-ingest-input");
    namesInput.type = "text";
    namesInput.placeholder = "speaker name(s)";
    namesInput.value = asg.names;
    namesInput.title = "How this character is labeled in the story (comma-separated). Remembered.";
    namesInput.addEventListener("input", e => {
      asg.names = e.target.value;
      setSavedCharNames(asg.characterId, e.target.value);
    });

    row.append(sel, namesInput);
    if (panelState.ingestAssignments.length > 1) {
      const rm = el("button", "me-ingest-clear");
      rm.textContent = "×";
      rm.title = "Remove character";
      rm.addEventListener("click", () => { panelState.ingestAssignments.splice(idx, 1); renderPanel(); });
      row.appendChild(rm);
    }
    body.appendChild(row);
  });

  const addCharBtn = el("button", "me-add-btn");
  addCharBtn.textContent = "+ add character";
  addCharBtn.addEventListener("click", () => {
    panelState.ingestAssignments.push({ characterId: "", characterName: "", names: "" });
    renderPanel();
  });
  body.appendChild(addCharBtn);

  // External-API attribution toggle (faster, bigger windows, more consistent).
  const extRow = el("label", "me-ingest-check");
  const extBox = el("input");
  extBox.type = "checkbox";
  extBox.checked = panelState.ingestUseExternal;
  extBox.addEventListener("change", e => { panelState.ingestUseExternal = e.target.checked; });
  const extTxt = el("span");
  extTxt.textContent = "Use external API for attribution (faster, fewer windows)";
  extRow.append(extBox, extTxt);
  body.appendChild(extRow);

  // Hint
  const savingHint = el("div", "me-ingest-hint");
  savingHint.textContent = "One pass routes beats to each character by their speaker label(s). Leave names blank to match by the character's display name.";
  body.appendChild(savingHint);

  // File upload row
  const fileRow = el("div", "me-ingest-file-row");
  const fileBtn = el("button", "me-ingest-file-btn");
  fileBtn.textContent = "📎 Load file";
  fileBtn.disabled = panelState.ingestRunning;
  fileBtn.addEventListener("click", () => getIngestFileInput().click());

  if (panelState.ingestFileName) {
    const fnEl = el("span", "me-ingest-filename");
    fnEl.textContent = panelState.ingestFileName;
    fnEl.title = panelState.ingestFileName;
    const clearBtn = el("button", "me-ingest-clear");
    clearBtn.textContent = "×";
    clearBtn.title = "Clear";
    clearBtn.addEventListener("click", () => {
      panelState.ingestFileName = null;
      panelState.ingestText = "";
      panelState.ingestResult = null;
      renderPanel();
    });
    fileRow.append(fileBtn, fnEl, clearBtn);
  } else {
    const hint = el("span", "me-ingest-filename");
    hint.textContent = ".txt or .docx";
    hint.style.color = "#4b5563";
    fileRow.append(fileBtn, hint);
  }
  body.appendChild(fileRow);

  // Textarea
  const orLbl = el("div", "me-ingest-or");
  orLbl.textContent = "or paste text:";
  body.appendChild(orLbl);

  const textarea = el("textarea", "me-ingest-textarea");
  textarea.rows = 6;
  textarea.placeholder = "Paste story text here…";
  textarea.value = panelState.ingestText;
  textarea.addEventListener("input", e => {
    panelState.ingestText = e.target.value;
    panelState.ingestResult = null;
  });
  body.appendChild(textarea);

  // Bottom row: run button + char count
  const bottom = el("div", "me-ingest-bottom");
  const runBtn = el("button", "me-btn-primary");
  runBtn.disabled = panelState.ingestRunning || !panelState.ingestText.trim() || !panelState.session;
  runBtn.textContent = panelState.ingestRunning ? "Analyzing…" : "Analyze";
  runBtn.addEventListener("click", () => {
    // Must be synchronous in the click handler — Firefox rejects requestPermission from async fns.
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
    doStoryIngest();
  });
  const countEl = el("span", "me-ingest-count");
  const len = panelState.ingestText.length;
  countEl.textContent = len > 0 ? `${len.toLocaleString()} chars` : "";
  bottom.append(runBtn, countEl);
  body.appendChild(bottom);

  // Result display
  if (panelState.ingestResult) {
    const resultEl = el("div", "me-ingest-result");
    if (panelState.ingestResult.cancelled) {
      resultEl.textContent = "Import cancelled — re-run the same file to resume where it left off.";
    } else if (panelState.ingestResult.error) {
      resultEl.className = "me-ingest-result me-ingest-err";
      resultEl.textContent = `✗ ${panelState.ingestResult.error}`;
    } else {
      resultEl.className = "me-ingest-result me-ingest-ok";
      const { beats, chunksTotal, skipped, parseMethod, speakers, perCharacter } = panelState.ingestResult;
      const beatCount = beats ?? 0;
      const methodLabel = { "pre-attributed": "pre-attributed", "local-llm": "local model", "external-llm": "external API", "paragraph": "paragraph split" }[parseMethod] ?? parseMethod ?? "";
      const lines = [`✓ ${beatCount} beat${beatCount === 1 ? "" : "s"} from ${chunksTotal} chunks`];
      if (methodLabel) lines.push(`via ${methodLabel}`);
      if (skipped > 0) lines.push(`${skipped} resumed`);
      resultEl.textContent = lines.join(" · ");
      // Per-character breakdown when more than one character was assigned.
      if (perCharacter && perCharacter.length > 1) {
        for (const pc of perCharacter) {
          const l = el("div");
          l.style.cssText = "margin-top:3px; font-size:10px; color:#8b8680;";
          l.textContent = `${pc.characterName}: ${pc.beats} beat${pc.beats === 1 ? "" : "s"}`
            + (pc.skipped ? ` (${pc.skipped} resumed)` : "")
            + (pc.chunksFailed ? `, ${pc.chunksFailed} failed` : "");
          resultEl.appendChild(l);
        }
      }
      if (speakers?.length) {
        const speakerEl = el("div");
        speakerEl.style.cssText = "margin-top:4px; font-size:10px; color:#6b7280;";
        speakerEl.textContent = "Speakers: " + speakers.join(", ");
        resultEl.appendChild(speakerEl);
      }
      if (panelState.ingestResult.autoRouted > 0) {
        const ar = el("div");
        ar.style.cssText = "margin-top:3px; font-size:10px; color:#8b8680;";
        ar.textContent = `${panelState.ingestResult.autoRouted} auto-routed via a known alias`;
        resultEl.appendChild(ar);
      }
      const pend = panelState.ingestResult.pending ?? 0;
      if (pend > 0) {
        const pe = el("div");
        pe.style.cssText = "margin-top:6px; font-size:11px;";
        const txt = el("span");
        txt.textContent = `${pend} beat${pend === 1 ? "" : "s"} waiting for speaker resolution — `;
        const link = el("button", "me-link-btn");
        link.textContent = "Resolve now";
        link.addEventListener("click", () => setActiveTab("pending"));
        pe.append(txt, link);
        resultEl.appendChild(pe);
      }
    }
    body.appendChild(resultEl);
  }

  // Clear beats row — always visible when expanded and not running
  const clearRow = el("div", "me-ingest-clear-row");
  const clearBtn = el("button", "me-btn-danger");
  clearBtn.textContent = panelState.ingestClearRunning ? "Clearing…" : "Clear all beats";
  clearBtn.disabled = panelState.ingestClearRunning || !panelState.session;
  clearBtn.title = "Delete all saved beats for this character";
  clearBtn.addEventListener("click", doClearBeats);
  clearRow.appendChild(clearBtn);

  if (panelState.ingestClearResult) {
    const clearMsg = el("span");
    if (panelState.ingestClearResult.error) {
      clearMsg.className = "me-ingest-err";
      clearMsg.textContent = `✗ ${panelState.ingestClearResult.error}`;
    } else {
      clearMsg.className = "me-ingest-ok";
      const n = panelState.ingestClearResult.deleted;
      clearMsg.textContent = `✓ ${n} beat${n === 1 ? "" : "s"} removed`;
    }
    clearRow.appendChild(clearMsg);
  }

  body.appendChild(clearRow);

  wrap.appendChild(body);
  return wrap;
}

// ── Import section render ─────────────────────────────────────────────────────

function renderImportSection() {
  const wrap = el("div", "me-import-section");

  const toggleBtn = el("button", "me-import-toggle");
  const dot_ = el("span", "me-section-dot");
  dot_.style.background = "#6b7280";
  dot_.style.flexShrink = "0";
  const label = el("span", "me-section-label");
  label.textContent = "Import from past chats";
  const chevron = el("span", "me-import-chevron");
  chevron.textContent = "▶";
  if (panelState.importExpanded) chevron.classList.add("open");
  toggleBtn.append(dot_, label, chevron);
  wrap.appendChild(toggleBtn);

  toggleBtn.addEventListener("click", () => {
    panelState.importExpanded = !panelState.importExpanded;
    if (panelState.importExpanded && panelState.importChats === null) {
      loadImportChats();
    } else {
      renderPanel();
    }
  });

  if (!panelState.importExpanded) return wrap;

  const body = el("div", "me-import-body");

  if (panelState.importChatsLoading) {
    const msg = el("div", "me-loading"); msg.textContent = "Loading chats…";
    body.appendChild(msg); wrap.appendChild(body); return wrap;
  }

  if (panelState.importChatsError) {
    const msg = el("div", "me-error"); msg.textContent = panelState.importChatsError;
    body.appendChild(msg); wrap.appendChild(body); return wrap;
  }

  const allChats = panelState.importChats ?? [];

  // Load hidden chat IDs from localStorage
  let hiddenIds;
  try { hiddenIds = new Set(JSON.parse(localStorage.getItem(HIDDEN_IMPORTS_KEY) ?? "[]")); }
  catch { hiddenIds = new Set(); }

  const hideChat = (id) => {
    hiddenIds.add(id);
    localStorage.setItem(HIDDEN_IMPORTS_KEY, JSON.stringify([...hiddenIds]));
    renderPanel();
  };
  const showAllHidden = () => {
    localStorage.removeItem(HIDDEN_IMPORTS_KEY);
    renderPanel();
  };

  // Apply search filter + hidden filter
  const q = (panelState.importFilter ?? "").toLowerCase().trim();
  const visible = allChats.filter(c => !hiddenIds.has(c.id));
  const chats   = q
    ? visible.filter(c => c.name.toLowerCase().includes(q) || c.folderName.toLowerCase().includes(q))
    : visible;
  const hiddenCount = allChats.length - visible.length;

  if (allChats.length === 0) {
    const msg = el("div", "me-section-empty");
    msg.textContent = "No other chats found for this character.";
    body.appendChild(msg); wrap.appendChild(body); return wrap;
  }

  // Search box
  const search = el("input", "me-import-search");
  search.type = "text";
  search.placeholder = "Filter by name or folder…";
  search.value = panelState.importFilter ?? "";
  search.addEventListener("input", e => {
    panelState.importFilter = e.target.value;
    renderPanel();
  });
  body.appendChild(search);

  const anyBusy = panelState.importAllActive || panelState.importingSet.size > 0;

  // Import all / import filtered button
  const allBtn = el("button", "me-import-all-btn");
  allBtn.disabled = anyBusy || chats.length === 0;
  if (panelState.importAllActive && panelState.importAllProgress) {
    const { current, total, phase } = panelState.importAllProgress;
    allBtn.textContent = `${phase === "estimating" ? "Estimating" : "Analyzing"}… (${current}/${total})`;
  } else if (q) {
    allBtn.textContent = `Import filtered (${chats.length})`;
  } else {
    allBtn.textContent = `Import all (${chats.length} chat${chats.length === 1 ? "" : "s"})`;
  }
  allBtn.addEventListener("click", () => importAllChats(chats));
  body.appendChild(allBtn);

  const warning = el("div", "me-import-warning");
  warning.textContent = "⚠ This may take some time";
  body.appendChild(warning);

  // Scrollable list
  const listEl = el("div", "me-import-list");

  if (chats.length === 0) {
    const empty = el("div", "me-section-empty"); empty.style.padding = "6px 10px";
    empty.textContent = q ? "No chats match that filter." : "All chats hidden.";
    listEl.appendChild(empty);
  }

  for (const chat of chats) {
    const row = el("div", "me-chat-row");

    const info = el("div", "me-chat-info");
    const nameEl = el("span", "me-chat-name");
    nameEl.textContent = chat.name; nameEl.title = chat.name;
    info.appendChild(nameEl);
    if (chat.folderName) {
      const folderEl = el("span", "me-chat-folder");
      folderEl.textContent = `📁 ${chat.folderName}`;
      info.appendChild(folderEl);
    }
    row.appendChild(info);

    const result = panelState.importResults[chat.id];
    const isImporting = panelState.importingSet.has(chat.id);

    if (isImporting) {
      const cp = panelState.importChatProgress;
      const spin = el("span", "me-chat-import-btn");
      spin.textContent = (cp && cp.total > 0) ? `${cp.current}/${cp.total}` : "…";
      spin.style.border = "none"; spin.style.cursor = "default";
      row.appendChild(spin);
    } else if (result?.error) {
      const errEl = el("span", "me-import-err");
      errEl.textContent = "Error"; errEl.title = result.error;
      row.appendChild(errEl);
    } else if (result) {
      const okEl = el("span", "me-import-ok");
      okEl.textContent = `+${result.count}`;
      okEl.title = `${result.count} emotional beat${result.count === 1 ? "" : "s"} added as retrievable memory`
        + (result.skipped ? ` (${result.skipped} already done, skipped)` : "");
      row.appendChild(okEl);
      // Re-import without a page reload: replaces this chat's imported entries
      // (re-imports clear by sourceChatId; beats are idempotent by id).
      const reBtn = el("button", "me-chat-import-btn");
      reBtn.textContent = "↻";
      reBtn.title = "Re-import this chat (replaces its previously imported entries)";
      reBtn.disabled = anyBusy;
      reBtn.addEventListener("click", () => importOneChat(chat));
      row.appendChild(reBtn);
    } else {
      const importBtn = el("button", "me-chat-import-btn");
      importBtn.textContent = "Import"; importBtn.disabled = anyBusy;
      importBtn.addEventListener("click", () => importOneChat(chat));
      row.appendChild(importBtn);
    }

    // Hide button — removes from list, stored in localStorage
    const hideBtn = el("button", "me-chat-hide-btn");
    hideBtn.textContent = "×"; hideBtn.title = "Hide from this list";
    hideBtn.addEventListener("click", () => hideChat(chat.id));
    row.appendChild(hideBtn);

    listEl.appendChild(row);
  }

  body.appendChild(listEl);

  // Show hidden count with restore link
  if (hiddenCount > 0) {
    const restoreRow = el("div", "me-import-hidden-row");
    restoreRow.textContent = `${hiddenCount} hidden — click to restore`;
    restoreRow.title = "Restore all hidden chats";
    restoreRow.addEventListener("click", showAllHidden);
    body.appendChild(restoreRow);
  }

  wrap.appendChild(body);
  return wrap;
}

// ── Import data functions ─────────────────────────────────────────────────────

// ── First-run onboarding import ─────────────────────────────────────────────

const ONBOARDED_KEY = `${marinara.extensionId}:onboarded`;
function isOnboarded() { try { return localStorage.getItem(ONBOARDED_KEY) === "1"; } catch { return false; } }
function setOnboarded() { try { localStorage.setItem(ONBOARDED_KEY, "1"); } catch { /* ignore */ } }

function skipOnboarding() { setOnboarded(); renderPanel(); }
function finishOnboarding() { setOnboarded(); closePanel(); }

function setImportScope(scope) {
  if (panelState.importScope === scope) return;
  panelState.importScope = scope;
  panelState.importChosen = null; // selection is scope-specific
  renderPanel();
}

// Load every chat (across all characters), each tagged with its character, for
// the "all characters" scope. The "this character" scope reuses loadImportChats.
async function loadAllChatsForImport() {
  if (panelState.importChatsAll || !panelState.session) return;
  await loadAllCharacters(); // populates panelState.allCharacters [{id,name}]
  const nameById = new Map((panelState.allCharacters ?? []).map(c => [c.id, c.name]));
  try {
    const [chatsRes, foldersRes] = await Promise.all([
      marinara.apiFetch("/chats"),
      marinara.apiFetch("/chat-folders").catch(() => []),
    ]);
    const list    = Array.isArray(chatsRes)   ? chatsRes   : (chatsRes?.chats   ?? chatsRes?.data   ?? []);
    const folders = Array.isArray(foldersRes) ? foldersRes : (foldersRes?.folders ?? foldersRes?.data ?? []);
    const folderMap = new Map(folders.map(f => { const d = parseData(f); return [String(f.id ?? d.id), String(f.name ?? d.name ?? "")]; }));
    const openChatId = String(panelState.session.chatId);
    panelState.importChatsAll = list
      .map(c => {
        const d = parseData(c);
        const id = String(c.id ?? d.id);
        const characterId = getChatCharacterId(c);
        return {
          id,
          name: String(c.name ?? c.title ?? d.name ?? d.title ?? `Chat ${shorten(id, 8)}`),
          folderName: folderMap.get(String(c.folderId ?? d.folderId ?? "")) ?? "",
          characterId,
          characterName: nameById.get(characterId) ?? "Unknown",
        };
      })
      .filter(c => c.id && c.characterId && c.id !== openChatId)
      .sort((a, b) => a.characterName.localeCompare(b.characterName) || a.name.localeCompare(b.name));
  } catch {
    panelState.importChatsAll = [];
  }
}

// The chat list for the current scope (loading as needed). Each chat carries its
// characterId/characterName so import routes beats to the right character.
async function getScopeChats() {
  if (panelState.importScope === "all") {
    await loadAllChatsForImport();
    return panelState.importChatsAll ?? [];
  }
  if (panelState.importChats === null) await loadImportChats();
  const { characterId, characterName } = panelState.session ?? {};
  return (panelState.importChats ?? []).map(c => ({ ...c, characterId, characterName }));
}

// Open the per-chat chooser (all selected by default) for the current scope.
async function openChooser() {
  panelState.importFlow = "estimating"; // show a brief "scanning" while listing
  renderPanel();
  const chats = await getScopeChats();
  panelState.importChosen = new Set(chats.map(c => c.id));
  panelState.importFlow = "choosing";
  renderPanel();
}

function toggleChosen(id) {
  if (!panelState.importChosen) return;
  if (panelState.importChosen.has(id)) panelState.importChosen.delete(id);
  else panelState.importChosen.add(id);
  renderPanel();
}

async function setAllChosen(on) {
  const chats = await getScopeChats();
  panelState.importChosen = on ? new Set(chats.map(c => c.id)) : new Set();
  renderPanel();
}

// Estimate (free) over a target chat list, then move to the "ready" gate.
async function onboardScan(targets) {
  if (!panelState.session) return;
  panelState.importTargets = targets;
  panelState.importFlow = "estimating";
  panelState.importFlowStats = null;
  renderPanel();

  let calls = 0, tokens = 0, counted = 0, characters = new Set();
  panelState._onboardMsgs = {};
  for (const chat of targets) {
    panelState.importFlowProgress = { current: ++counted, total: targets.length, startMs: 0 };
    renderPanel();
    characters.add(chat.characterId);
    try {
      const messages = await fetchChatMessages(chat.id);
      panelState._onboardMsgs[chat.id] = messages;
      if (!messages.length) continue;
      const est = await memFetch("/api/estimate-beats", {
        method: "POST",
        body: JSON.stringify({ messages, characterName: chat.characterName ?? "the character" }),
      });
      calls += est.analysisCalls ?? 0;
      tokens += est.estTokens ?? 0;
    } catch { /* uncountable — skip in estimate */ }
  }

  panelState.importFlowStats = { chats: targets.length, calls, tokens, characters: characters.size };
  panelState.importFlowProgress = null;
  panelState.importFlow = "ready";
  renderPanel();
}

// Begin with the full scope (the "Import all" button).
async function onboardScanAll() {
  const chats = await getScopeChats();
  onboardScan(chats);
}

// Begin with the chosen subset (from the chooser).
function onboardScanChosen() {
  const chosen = panelState.importChosen ?? new Set();
  // resolve chosen ids against the scope list we already loaded
  const pool = panelState.importScope === "all"
    ? (panelState.importChatsAll ?? [])
    : (panelState.importChats ?? []).map(c => ({ ...c, characterId: panelState.session?.characterId, characterName: panelState.session?.characterName }));
  onboardScan(pool.filter(c => chosen.has(c.id)));
}

// Run the import over importTargets, one chat at a time, skipping failures.
async function onboardRun() {
  if (!panelState.session) return;
  const targets = panelState.importTargets ?? [];
  panelState.importCancel = false;
  panelState.importFlow = "running";
  panelState.importFlowProgress = { current: 0, total: targets.length, startMs: Date.now() };
  renderPanel();

  let moments = 0, failed = 0, done = 0;
  for (const chat of targets) {
    if (panelState.importCancel) break;
    done++;
    panelState.importFlowProgress = { current: done, total: targets.length, startMs: panelState.importFlowProgress.startMs };
    renderPanel();
    try {
      await importOneChat(chat, panelState._onboardMsgs[chat.id]); // graceful: catches internally
      const r = panelState.importResults[chat.id];
      if (r?.cancelled) { done--; break; } // aborted mid-chat — don't count it
      if (r?.error) failed++;
      else moments += r?.count ?? 0;
    } catch (err) {
      console.error("[ME] onboarding import skipped a chat:", chat.id, err);
      failed++;
    }
  }

  panelState.importFlowResult = { moments, chats: done - failed, failed, cancelled: panelState.importCancel };
  panelState.importFlowProgress = null;
  panelState.importFlow = "done";
  panelState._onboardMsgs = {};
  setOnboarded(); // they've engaged; don't nag again
  renderPanel();
}

function cancelOnboarding() {
  panelState.importCancel = true;
  if (panelState.importAbort) panelState.importAbort.abort(); // stop the in-flight chat too
  renderPanel();
}

async function loadImportChats() {
  if (!panelState.session) return;
  panelState.importChatsLoading = true;
  panelState.importChatsError = null;
  renderPanel();

  try {
    const { characterId, chatId } = panelState.session;
    const [chatsRes, foldersRes] = await Promise.all([
      marinara.apiFetch("/chats"),
      marinara.apiFetch("/chat-folders").catch(() => []),
    ]);
    const list    = Array.isArray(chatsRes)   ? chatsRes   : (chatsRes?.chats   ?? chatsRes?.data   ?? []);
    const folders = Array.isArray(foldersRes) ? foldersRes : (foldersRes?.folders ?? foldersRes?.data ?? []);

    // Build folderId → name lookup
    const folderMap = new Map(folders.map(f => {
      const d = parseData(f);
      return [String(f.id ?? d.id), String(f.name ?? d.name ?? "")];
    }));

    panelState.importChats = list
      .filter(c => {
        const id = c.id ?? parseData(c).id;
        if (String(id) === String(chatId)) return false;
        // Shared scenes count: the character may be ANY participant, not just
        // the chat's primary — a Mari-led scene with Priya co-starring belongs
        // in Priya's import list too. (Since cx4, import routes each beat by
        // its analyzed subject, so importing from either side lands beats on
        // the right ledgers — import a shared scene ONCE, from either list.)
        return getChatCharacterId(c) === String(characterId) ||
               getChatParticipantIds(c).includes(String(characterId));
      })
      .map(c => {
        const d = parseData(c);
        const id = String(c.id ?? d.id);
        const folderId = String(c.folderId ?? d.folderId ?? "");
        const shared = getChatCharacterId(c) !== String(characterId);
        const baseName = String(c.name ?? c.title ?? d.name ?? d.title ?? `Chat ${shorten(id, 8)}`);
        return {
          id,
          name:       shared ? `${baseName} (shared)` : baseName,
          folderName: folderMap.get(folderId) ?? "",
        };
      })
      .sort((a, b) => {
        // Sort: folder name first, then chat name
        const f = a.folderName.localeCompare(b.folderName);
        return f !== 0 ? f : a.name.localeCompare(b.name);
      });
  } catch {
    panelState.importChatsError = "Failed to load chat list.";
    panelState.importChats = [];
  }

  panelState.importChatsLoading = false;
  renderPanel();
}

async function fetchChatMessages(chatId) {
  try {
    const res = await marinara.apiFetch(`/chats/${chatId}/messages`);
    const list = Array.isArray(res) ? res : (res?.messages ?? res?.data ?? []);
    // Map each message's characterId -> name so group-chat / multi-character
    // messages carry their real speaker (the analyzer routes by speaker name).
    await loadAllCharacters();
    const nameById = new Map((panelState.allCharacters ?? []).map(c => [String(c.id), c.name]));
    return list
      .map(m => {
        const d = parseData(m);
        const role    = m.role    ?? d.role;
        const content = m.content ?? d.content;
        if (!role || !content) return null;
        const msg = { role: String(role), content: String(content) };
        // Tag assistant messages with their sending character (Marinara stores
        // it per-message as characterId). User messages stay "user".
        if (msg.role !== "user") {
          const name = nameById.get(String(m.characterId ?? d.characterId ?? ""));
          if (name) msg.speaker = name;
        }
        return msg;
      })
      .filter(Boolean)
      .slice(-5000); // generous cap — long RP chats (1k+ messages) import in full
  } catch {
    return [];
  }
}

async function importOneChat(chat, preFetched) {
  if (!panelState.session) return;
  // Use the chat's own character when present (all-characters import); otherwise
  // the open session's character (single-character / Import tab).
  const characterId = chat.characterId ?? panelState.session.characterId;
  const characterName = chat.characterName ?? panelState.session.characterName;
  if (!characterId) return;
  panelState.importingSet.add(chat.id);
  renderPanel();

  const ac = new AbortController();
  panelState.importAbort = ac;
  try {
    const messages = preFetched ?? await fetchChatMessages(chat.id);
    if (messages.length === 0) {
      panelState.importResults[chat.id] = { count: 0 };
    } else {
      // Granular import: run the full sentiment pipeline (beats + retrievable
      // companion entries). The response streams NDJSON — per-chunk progress
      // events, then a final result — so we can show within-chat progress and
      // cancel a long chat (100+ calls) mid-run. Per-beat dedup makes re-running
      // safe.
      const resp = await fetch(`${MEMORY_EXTENDER}/api/analyze-beats`, {
        method: "POST",
        // Raw fetch (NDJSON stream — memFetch would consume the body); needs
        // the CSRF token explicitly.
        headers: { "Content-Type": "application/json", "x-me-csrf": await getCsrfToken() },
        signal: ac.signal,
        body: JSON.stringify({
          characterId,
          characterName: characterName ?? "the character",
          messages,
          sourceType: "chat",
          title: chat.name || chat.title || `chat ${shorten(chat.id)}`,
          chatId: chat.id, // tags entries for clean re-import
        }),
      });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "", result = null, cancelled = false, errMsg = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let evt; try { evt = JSON.parse(line); } catch { continue; }
          if (evt.type === "progress") {
            panelState.importChatProgress = { current: evt.current, total: evt.total };
            renderPanel();
          } else if (evt.type === "done") { result = evt.result; }
          else if (evt.type === "cancelled") { cancelled = true; }
          else if (evt.type === "error") { errMsg = evt.error; }
        }
      }
      panelState.importChatProgress = null;
      if (cancelled) panelState.importResults[chat.id] = { cancelled: true };
      else if (errMsg) throw new Error(errMsg);
      else if (result) panelState.importResults[chat.id] = { count: result.beats?.length ?? 0, skipped: result.skipped ?? 0 };
      else throw new Error("no result returned");
    }
  } catch (err) {
    panelState.importChatProgress = null;
    if (err?.name === "AbortError") {
      // Cancelled mid-chat — partial beats are saved server-side; resume later.
      panelState.importResults[chat.id] = { cancelled: true };
    } else {
      console.error("[ME] import failed for chat", chat.id, ":", err);
      panelState.importResults[chat.id] = { error: String(err) };
    }
  }

  panelState.importAbort = null;
  panelState.importingSet.delete(chat.id);
  renderPanel();
}

async function importAllChats(chats) {
  if (!panelState.session) return;
  const { characterName } = panelState.session;
  const pending = chats.filter(c => !panelState.importResults[c.id]);

  // ── Pre-flight estimate (free: chunk+classify only, no analysis calls) ──────
  panelState.importAllActive = true;
  panelState.importAllProgress = { current: 0, total: pending.length, phase: "estimating" };
  renderPanel();

  let calls = 0, tokens = 0;
  const cachedMsgs = {};
  for (let i = 0; i < pending.length; i++) {
    panelState.importAllProgress = { current: i + 1, total: pending.length, phase: "estimating" };
    renderPanel();
    try {
      const messages = await fetchChatMessages(pending[i].id);
      cachedMsgs[pending[i].id] = messages;
      if (!messages.length) continue;
      const est = await memFetch("/api/estimate-beats", {
        method: "POST",
        body: JSON.stringify({ messages, characterName: characterName ?? "the character" }),
      });
      calls += est.analysisCalls ?? 0;
      tokens += est.estTokens ?? 0;
    } catch { /* skip uncountable chat */ }
  }

  panelState.importAllActive = false;
  panelState.importAllProgress = null;
  renderPanel();

  const proceed = confirm(
    `Granular import of ${pending.length} chat${pending.length === 1 ? "" : "s"} will make about ` +
    `${calls.toLocaleString()} analysis call${calls === 1 ? "" : "s"} (~${tokens.toLocaleString()} tokens).\n\n` +
    `This runs one chat at a time and can take a while / use API credits. Proceed?`
  );
  if (!proceed) return;

  // ── Run ─────────────────────────────────────────────────────────────────────
  panelState.importAllActive = true;
  panelState.importAllProgress = { current: 0, total: pending.length, phase: "analyzing" };
  renderPanel();

  for (let i = 0; i < pending.length; i++) {
    if (panelState.importResults[pending[i].id]) continue; // skip if done since
    panelState.importAllProgress = { current: i + 1, total: pending.length, phase: "analyzing" };
    await importOneChat(pending[i], cachedMsgs[pending[i].id]); // reuse fetched messages
  }

  panelState.importAllActive = false;
  panelState.importAllProgress = null;
  renderPanel();
}

// ── Recitation detection ──────────────────────────────────────────────────────

const RECITATION_STOPWORDS = new Set(
  ("a an and are as at be been but by for from had has have he her his i if in into is it its " +
   "me my no not of on or our she that the their them then they this to up was we were what when " +
   "which who will with would you your").split(" ")
);

// Asymmetric containment: what fraction of the SUMMARY's meaningful words appear
// in the response. Symmetric Jaccard fails here — a short summary vs. a long
// response has a huge union, driving the score to ~0 even on a clear match.
// Stopwords are dropped so coincidental "the"/"a"/"in" overlap can't trip it.
function summaryOverlap(summary, responseText) {
  const tokenize = s => s.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);
  const summaryWords = new Set(
    tokenize(summary).filter(w => w.length > 2 && !RECITATION_STOPWORDS.has(w))
  );
  if (summaryWords.size === 0) return 0;
  const textWords = new Set(tokenize(responseText));
  let hit = 0;
  for (const w of summaryWords) if (textWords.has(w)) hit++;
  return hit / summaryWords.size;
}

async function detectRecitations(surfaced, responseText) {
  if (!surfaced?.length || !responseText) return;

  // Each surfaced entry is self-contained (id + summary + scope + scopeId), so no
  // panel state or extra fetch is needed and every scope is covered. Compare each
  // surfaced summary against the response; a clear overlap means the model used it.
  const RECITATION_THRESHOLD = 0.3;
  for (const e of surfaced) {
    if (!e?.id || !e.summary) continue;
    if (summaryOverlap(e.summary, responseText) >= RECITATION_THRESHOLD) {
      dbg(`recitation detected for entry ${e.id} (${e.scope}): "${e.summary.slice(0, 50)}"`);
      await memFetch(`/api/entries/${e.id}/recite`, {
        method: "POST",
        body: JSON.stringify({ scope: e.scope, scopeId: e.scopeId }),
      }).catch(() => {});
    }
  }
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadPanelData() {
  if (!panelState.session) return;
  panelState.loading = true;
  panelState.error = null;
  renderPanel();

  try {
    const { chatId } = panelState.session;
    const [entries, bookmarks] = await Promise.all([
      memFetch(`/api/entries?scope=chat&scopeId=${encodeURIComponent(chatId)}`),
      memFetch(`/api/bookmarks?scope=chat&scopeId=${encodeURIComponent(chatId)}`),
    ]);
    panelState.chatEntries = Array.isArray(entries) ? entries : [];
    panelState.bookmarks = Array.isArray(bookmarks) ? bookmarks : [];
    // Update availability (uo4) — best effort, never blocks the panel.
    memFetch("/api/health").then(h => {
      if (h && panelState.health?.updateAvailable !== h.updateAvailable) { panelState.health = h; renderPanel(); }
      else panelState.health = h;
    }).catch(() => {});
  } catch {
    panelState.error = "Failed to load. Is the Memory Extender running?";
    panelState.chatEntries = [];
    panelState.bookmarks = [];
  }

  panelState.loading = false;
  renderPanel();

  // Refresh the Pending count in the background so the tab badge is live without
  // having to open the tab. Cheap, non-blocking, never throws into the UI.
  memFetch("/api/pending-speakers")
    .then((res) => { panelState.pendingSpeakers = res?.speakers ?? []; renderPanel(); })
    .catch(() => {});
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function markEntryDone(entry) {
  if (!panelState.session) return;
  await memFetch(`/api/entries/${entry.id}`, {
    method: "PATCH",
    body: JSON.stringify({ scope: "chat", scopeId: panelState.session.chatId, status: "done" }),
  }).catch(() => {});
  await loadPanelData();
}

async function removeEntry(entry) {
  if (!panelState.session) return;
  const { chatId } = panelState.session;
  await memFetch(
    `/api/entries/${entry.id}?scope=chat&scopeId=${encodeURIComponent(chatId)}`,
    { method: "DELETE" },
  ).catch(() => {});
  await loadPanelData();
}

async function addEntry(laneKey, rawSummary) {
  const summary = (rawSummary ?? "").trim();
  if (!summary || !panelState.session) return;

  await memFetch("/api/entries", {
    method: "POST",
    body: JSON.stringify({
      scope: "chat",
      scopeId: panelState.session.chatId,
      lane: laneKey,
      summary,
      content: "",
    }),
  }).catch(() => {});

  panelState.addingLane = null;
  panelState.addingSummary = "";
  await loadPanelData();
}

async function removeBookmark(bm) {
  if (!panelState.session) return;
  const { chatId } = panelState.session;
  await memFetch(
    `/api/bookmarks/${bm.id}?scope=chat&scopeId=${encodeURIComponent(chatId)}`,
    { method: "DELETE" },
  ).catch(() => {});
  await loadPanelData();
}

// ── Panel open / close ────────────────────────────────────────────────────────

// True while any import is running, so reopening the panel can jump straight back
// to its progress (and the toggle can show it's still going).
function importInFlight() {
  return panelState.ingestRunning
    || panelState.importFlow === "running" || panelState.importFlow === "estimating"
    || (panelState.importingSet && panelState.importingSet.size > 0);
}

async function openPanel() {
  if (!panel) return;
  panel.classList.add("open");
  clearIngestBadge();
  if (!currentSession) currentSession = await resolveSession();
  panelState.session = currentSession;

  // If an import is running, show its live progress immediately. Don't wipe the
  // view behind a "Loading…" data refetch — that round-trip competes with the
  // busy sidecar and is exactly why the progress felt unreachable after closing.
  // Route to the view that's actually showing the progress.
  if (importInFlight()) {
    panelState.loading = false;
    if (panelState.ingestRunning) { panelState.activeTab = "import"; panelState.ingestExpanded = true; }
    else if (panelState.importingSet && panelState.importingSet.size > 0) { panelState.activeTab = "import"; panelState.importExpanded = true; }
    // The onboarding chat import renders its own progress when !isOnboarded().
    renderPanel();
    return;
  }

  panelState.loading = true;
  renderPanel();
  if (panelState.session) await loadPanelData();
  else { panelState.loading = false; renderPanel(); }
}

function closePanel() {
  panel?.classList.remove("open");
  panelState.addingLane = null;
}


// ── Regex script auto-install ─────────────────────────────────────────────────
// Keeps the Marinara regex script in sync with REGEX_MANIFEST. Strips both
// legacy <remember>/<bookmark> XML tags and new [remember: ...]/[bookmark: ...]
// bracket commands from AI output. Bumping REGEX_INSTALLED_KEY forces a refresh.

const OLD_REGEX_SCRIPT_NAMES = ["Marinara Extender: Strip bookmark tags"];

async function ensureRegexScript() {
  if (localStorage.getItem(REGEX_INSTALLED_KEY)) return;
  try {
    const scripts = await marinara.apiFetch("/regex-scripts");
    const list = Array.isArray(scripts) ? scripts : [];

    // Remove any old-named script from a previous version.
    for (const s of list) {
      const d = parseData(s);
      const name = s.name ?? d.name;
      if (OLD_REGEX_SCRIPT_NAMES.includes(name)) {
        const id = s.id ?? d.id;
        if (id) await marinara.apiFetch(`/regex-scripts/${id}`, { method: "DELETE" }).catch(() => {});
      }
    }

    // Find current script by name and create or update it.
    const current = list.find(s => {
      const d = parseData(s);
      return (s.name ?? d.name) === REGEX_SCRIPT_NAME;
    });
    if (!current) {
      await marinara.apiFetch("/regex-scripts", { method: "POST", body: JSON.stringify(REGEX_MANIFEST) });
    } else {
      const d = parseData(current);
      const existingRegex = current.findRegex ?? d.findRegex;
      if (existingRegex !== REGEX_MANIFEST.findRegex) {
        const id = current.id ?? d.id;
        await marinara.apiFetch(`/regex-scripts/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ findRegex: REGEX_MANIFEST.findRegex, name: REGEX_SCRIPT_NAME }),
        });
      }
    }

    localStorage.setItem(REGEX_INSTALLED_KEY, "1");
  } catch (err) {
    console.error("[ME] ensureRegexScript failed:", err);
  }
}

ensureRegexScript();

// ── Pre-turn context refresh (MarinaraExtender-1ba) ───────────────────────────
// The memory block used to be assembled AFTER each response, for the next one —
// a one-turn recall lag that made characters deny things they remembered one
// message later ("there was no porsche thomas"). Fix: intercept the engine's
// /api/generate request, refresh the block against the OUTGOING user message,
// THEN let generation proceed. Hard time budget — on any failure or timeout the
// request continues with the previous block (i.e., the old behavior).

const PRE_TURN_BUDGET_MS = 800;
let lorebookIdCache = {}; // characterId → lorebookId (ensureLorebook is slow-ish)

async function preTurnRefresh(rawBody) {
  let body;
  try { body = typeof rawBody === "string" ? JSON.parse(rawBody) : null; } catch { return; }
  const chatId = body?.chatId ? String(body.chatId) : null;
  const userText = typeof body?.userMessage === "string" ? body.userMessage : "";
  if (!chatId || !userText.trim()) return;
  // Resolve the generating chat's character. currentSession is the fast path,
  // but the FIRST message of a new or freshly-switched chat generates before
  // the session tracker catches up — and that turn is where a stale block
  // bites hardest, because the lorebook only holds the generic chat-load
  // block (found live: total porsche blackout on the first question of a
  // fresh chat). So instead of skipping, resolve from the chat row itself.
  let characterId, characterName;
  if (currentSession && String(currentSession.chatId) === chatId) {
    ({ characterId, characterName } = currentSession);
  } else {
    try {
      const chat = await marinara.apiFetch(`/chats/${chatId}`);
      characterId = getChatCharacterId(chat);
      if (characterId) {
        const char = await marinara.apiFetch(`/characters/${characterId}`).catch(() => null);
        characterName = char?.name ?? parseData(char)?.name ?? null;
      }
    } catch { /* engine API hiccup — fall through to the skip below */ }
    if (!characterId) {
      dbg(`pre-turn skipped — could not resolve character for chat ${chatId}`);
      return;
    }
  }

  // The time budget applies to the SIDECAR call only. Once a fresh block
  // exists, the lorebook write runs to completion unconditionally — it nukes
  // and recreates the memory entries, and abandoning it mid-write would let
  // the model generate with NO memory at all (worse than the lag).
  const res = await Promise.race([
    memFetch("/api/pre-turn", {
      method: "POST",
      body: JSON.stringify({ characterId, characterName, chatId, userText }),
    }),
    new Promise((resolve) => setTimeout(() => resolve(null), PRE_TURN_BUDGET_MS)),
  ]).catch(() => null);
  if (!res?.memoryBlock) {
    console.info("[ME] pre-turn: no refreshed block (timeout or sidecar down) — generating with the previous context");
    return;
  }

  let lorebookId = lorebookIdCache[characterId];
  if (!lorebookId) {
    lorebookId = await ensureLorebook(characterId, characterName);
    if (lorebookId) lorebookIdCache[characterId] = lorebookId;
  }
  if (!lorebookId) return;
  await writeMemoryToLorebook(lorebookId, res.memoryBlock);
  console.info(`[ME] pre-turn: context refreshed before generation (${res.surfaced} entries)`);
}

(function installPreTurnHook() {
  // Install exactly once per page context. If the loader ever re-evaluates this
  // script in the same window (re-injection without a full reload), a second
  // wrap would fire preTurnRefresh once PER layer on every /api/generate — and
  // each wrap has its own _lorebookWriteChain, so the nuke-and-recreate cycles
  // race and the lorebook can be empty/partial exactly when generation runs.
  if (window.__marinaraExtenderFetchHooked) return;
  window.__marinaraExtenderFetchHooked = true;
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    try {
      const url = typeof input === "string" ? input : (input?.url ?? "");
      const method = (init?.method ?? (typeof input === "object" ? input?.method : "") ?? "GET").toUpperCase();
      if (method === "POST" && /\/api\/generate(\?|$)/.test(url)) {
        await preTurnRefresh(init?.body).catch(() => {});
      }
    } catch { /* interception must never break generation */ }
    return origFetch(input, init);
  };
})();

// ── Session resolution ────────────────────────────────────────────────────────
// Marinara is a pure SPA — location.href never changes. We capture chatId from
// Marinara's own generation events, with a header-based fallback for the first
// panel open before any generation has fired.

let lastKnownChatId = null;

async function resolveSession() {
  // Primary: chatId captured from Marinara's own generation events.
  const chatId = lastKnownChatId;
  if (chatId) {
    try {
      const chat = await marinara.apiFetch(`/chats/${chatId}`);
      const characterId = getChatCharacterId(chat);
      if (!characterId) return null;

      let characterName = null;
      try {
        const char = await marinara.apiFetch(`/characters/${characterId}`);
        const charData = parseData(char);
        characterName = char?.name ?? charData?.name ?? null;
      } catch { /* name is optional */ }

      const participantIds = getChatParticipantIds(chat);

      // Active persona name — the sidecar maps it to "user" during subject
      // routing so facts about the player land in the session ledger instead
      // of being demoted to chat scope.
      let personaName = null;
      const personaId = chat?.personaId ?? parseData(chat)?.personaId;
      if (personaId) {
        try {
          const personas = await marinara.apiFetch("/personas");
          const list = Array.isArray(personas) ? personas : (personas?.personas ?? personas?.data ?? []);
          const p = list.find(x => String(x.id ?? parseData(x).id) === String(personaId));
          personaName = p ? (p.name ?? parseData(p)?.name ?? null) : null;
        } catch { /* persona name is optional */ }
      }

      // Scene chats are usually named for the arc ("Scene: Jurisprudence,
      // Soft Launch") — the sidecar offers the title to the analyzer as a
      // new-thread label hint.
      const sceneTitle = chat?.name ?? chat?.title ?? parseData(chat)?.name ?? null;

      return { characterId: String(characterId), chatId: String(chatId), characterName, participantIds, personaName, sceneTitle };
    } catch (e) {
      console.error("[ME] resolveSession primary path error:", e);
      return null;
    }
  }

  // Fallback: read the character name from the header avatar img[alt] and look it up.
  const header = document.querySelector('.mari-messages-scroll > .sticky.top-0');
  const charNameFromUI = header?.querySelector('img[alt]')?.alt?.trim();
  if (!charNameFromUI) return null;

  try {
    const chars = await marinara.apiFetch("/characters");
    const list = Array.isArray(chars) ? chars : (chars?.characters ?? chars?.data ?? []);
    const found = list.find(c => {
      const d = parseData(c);
      return (c.name ?? d.name ?? "") === charNameFromUI;
    });
    if (!found) return null;

    const foundData = parseData(found);
    const characterId = String(found.id ?? foundData.id);
    const characterName = found.name ?? foundData.name ?? charNameFromUI;

    // Pick the most recently updated chat for this character.
    const allChats = await marinara.apiFetch("/chats");
    const chatList = Array.isArray(allChats) ? allChats : (allChats?.chats ?? allChats?.data ?? []);
    const charChats = chatList
      .filter(c => getChatCharacterId(c) === characterId)
      .sort((a, b) => {
        const aUp = a.updatedAt ?? parseData(a).updatedAt ?? a.createdAt ?? 0;
        const bUp = b.updatedAt ?? parseData(b).updatedAt ?? b.createdAt ?? 0;
        return new Date(bUp) - new Date(aUp);
      });

    if (charChats.length === 0) return null;
    const latest = charChats[0];
    const latestData = parseData(latest);
    const resolvedChatId = String(latest.id ?? latestData.id);
    lastKnownChatId = resolvedChatId;
    return { characterId, chatId: resolvedChatId, characterName };
  } catch (e) {
    console.error("[ME] resolveSession fallback error:", e);
    return null;
  }
}

// ── Session + lorebook state ──────────────────────────────────────────────────

let currentSession = null;
const lastMsgId = {};      // chatId → last processed assistant message id
const lastSurfaced = {};   // chatId → entries surfaced into context on the PREVIOUS turn

// Last-turn memory activity for the panel (MarinaraExtender-15y): what the
// character had in context this turn, visible without reading sidecar logs.
let lastTurnActivity = null; // { at, chatId, surfaced: [{id,summary,scope}], created, bookmarks }

// ── Scene-recap sync — recap-layer FLOOR (MarinaraExtender-2cu) ───────────────
// The engine persists each concluded scene's prose summary as a narrator
// "returned from their scene" message in the ORIGIN chat. This pass finds
// concluded scenes, pairs them with their summaries, and feeds the sidecar
// once per participant. The sidecar is idempotent per (character, scene), so
// re-running is free; throttled to avoid hammering the engine API.

const SCENE_SYNC_INTERVAL_MS = 10 * 60 * 1000;
let lastSceneSync = 0;

function chatMeta(c) {
  const m = c?.metadata ?? parseData(c)?.metadata;
  if (typeof m === "string") { try { return JSON.parse(m); } catch { return {}; } }
  return m ?? {};
}

async function syncSceneRecaps(force = false) {
  if (!force && Date.now() - lastSceneSync < SCENE_SYNC_INTERVAL_MS) return;
  lastSceneSync = Date.now();
  try {
    const chatsRes = await marinara.apiFetch("/chats");
    const list = Array.isArray(chatsRes) ? chatsRes : (chatsRes?.chats ?? chatsRes?.data ?? []);
    const concluded = list.filter(c => chatMeta(c).sceneStatus === "concluded");
    if (concluded.length === 0) return;

    await loadAllCharacters();
    const nameById = new Map((panelState.allCharacters ?? []).map(c => [String(c.id), c.name]));

    // Group scenes by origin chat so each origin's messages are fetched once.
    const byOrigin = new Map();
    for (const s of concluded) {
      const origin = chatMeta(s).sceneOriginChatId;
      if (!origin) continue;
      if (!byOrigin.has(origin)) byOrigin.set(origin, []);
      byOrigin.get(origin).push(s);
    }

    let ingested = 0;
    for (const [originId, scenes] of byOrigin) {
      const res = await marinara.apiFetch(`/chats/${originId}/messages`).catch(() => null);
      const msgs = Array.isArray(res) ? res : (res?.messages ?? res?.data ?? []);
      const returns = msgs
        .map(m => ({ role: m.role ?? parseData(m).role, content: String(m.content ?? parseData(m).content ?? ""), createdAt: String(m.createdAt ?? parseData(m).createdAt ?? "") }))
        .filter(m => m.role === "narrator" && /returned from .{0,30}scene/i.test(m.content.slice(0, 120)));
      if (returns.length === 0) continue;

      // Pair scenes with return summaries by CONTENT, not timestamp. The
      // return message never names its scene, and a scene chat's updatedAt
      // drifts whenever the chat is touched — nearest-timestamp pairing was
      // found live attaching wrong summaries to 36 of 56 recaps (the "Test
      // Drive Transgression" recap described a couch morning). The right
      // summary shares distinctive vocabulary with its scene's transcript,
      // so score every (scene, return) pair by content-word overlap and
      // assign greedily best-first. Timestamp survives only as the fallback
      // when a scene's transcript can't be fetched.
      const pairByContent = new Map(); // sceneId -> return message
      if (scenes.length > 1 || returns.length > 1) {
        const scored = [];
        for (const scene of scenes) {
          const sid = String(scene.id ?? parseData(scene).id);
          const sres = await marinara.apiFetch(`/chats/${sid}/messages`).catch(() => null);
          const smsgs = Array.isArray(sres) ? sres : (sres?.messages ?? sres?.data ?? []);
          const sceneText = smsgs.map(m => String(m.content ?? parseData(m).content ?? "")).join("\n").toLowerCase();
          if (!sceneText) continue;
          for (let i = 0; i < returns.length; i++) {
            const words = [...new Set(returns[i].content.toLowerCase().match(/[a-z]{4,}/g) ?? [])];
            const hits = words.filter(w => sceneText.includes(w)).length;
            scored.push({ sid, ri: i, score: words.length ? hits / words.length : 0 });
          }
        }
        scored.sort((a, b) => b.score - a.score);
        const takenScene = new Set(), takenReturn = new Set();
        for (const { sid, ri, score } of scored) {
          if (score < 0.3) break; // below this, content gives no verdict
          if (takenScene.has(sid) || takenReturn.has(ri)) continue;
          takenScene.add(sid); takenReturn.add(ri);
          pairByContent.set(sid, returns[ri]);
        }
      }

      for (const scene of scenes) {
        const sceneId = String(scene.id ?? parseData(scene).id);
        const sceneTime = Date.parse(scene.updatedAt ?? parseData(scene).updatedAt ?? scene.createdAt ?? "") || 0;
        const best = pairByContent.get(sceneId) ?? returns.reduce((a, b) =>
          Math.abs((Date.parse(b.createdAt) || 0) - sceneTime) < Math.abs((Date.parse(a.createdAt) || 0) - sceneTime) ? b : a);
        // Strip the "*…returned from their scene…*" lead; the body is the summary.
        const summary = best.content.replace(/^\*[^*]*\*\s*/s, "").trim();
        if (summary.length < 20) continue;

        const sceneName = String(scene.name ?? scene.title ?? parseData(scene).name ?? "");
        for (const pid of getChatParticipantIds(scene)) {
          const r = await memFetch("/api/scene-recap", {
            method: "POST",
            body: JSON.stringify({
              characterId: pid,
              characterName: nameById.get(String(pid)),
              summary,
              sceneChatId: sceneId,
              sceneName,
              concludedAt: best.createdAt,
            }),
          }).catch(() => null);
          if (r?.ok && !r.alreadyIngested) ingested++;
        }
      }
    }
    if (ingested > 0) console.info(`[ME:recap] synced ${ingested} scene recap ingestion(s)`);
  } catch (e) { dbg("syncSceneRecaps failed:", e); }
}
                           // (recitation compares the current response against the memory
                           //  that was actually live when that response was generated)
const SNAPSHOT_KEY = `${marinara.extensionId}:snapshot-time`;
const HIDDEN_IMPORTS_KEY = `${marinara.extensionId}:hidden-imports`;
const SNAPSHOT_INTERVAL_MS = 30 * 60 * 1000;  // 30 minutes

function getSnapshotTime(chatId) {
  try { return JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? "{}")[chatId] ?? 0; }
  catch { return 0; }
}
function setSnapshotTime(chatId, ts) {
  try {
    const map = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? "{}");
    map[chatId] = ts;
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(map));
  } catch { /* storage full or unavailable */ }
}

async function refreshSession() {
  currentSession = await resolveSession();
  if (currentSession) {
    // Sync current memory block into the lorebook on chat load
    syncMemoryBlock(currentSession).catch(() => {});
  }
}

// ── Lorebook helpers ──────────────────────────────────────────────────────────

// Split the combined memoryBlock into the static instructions portion and the
// per-turn <memory> content portion. Search for "\n\n<memory>" not "<memory>"
// to avoid the prose mention of the tag inside the instructions text itself.
function splitMemoryBlock(memoryBlock) {
  const idx = memoryBlock.indexOf('\n\n<memory>');
  if (idx === -1) return { instructions: memoryBlock.trim(), content: '' };
  return {
    instructions: memoryBlock.slice(0, idx).trim(),
    content: memoryBlock.slice(idx + 2).trim(),
  };
}

// Find or create the lorebook container for this character. Returns lorebookId.
// No caching — always does a fresh lookup so deletions are handled correctly.
// The engine enforces a per-lorebook injection budget (default 2048 tokens)
// and silently DROPS entries that would exceed it. Our memory block grows
// with the ledger — Priya's crossed ~2300 tokens and her memory entry simply
// stopped being injected, with every upstream link (pre-turn, loader, write)
// green. The budget must be guaranteed, not assumed: set on create, healed
// on every lookup of a pre-existing lorebook.
const ME_LOREBOOK_TOKEN_BUDGET = 16384;

async function ensureLorebook(characterId, characterName) {
  const lorebookName = `Marinara Extender — ${characterName ?? characterId}`;
  let lorebookId = null;

  try {
    const res = await marinara.apiFetch("/lorebooks");
    const list = Array.isArray(res) ? res : (res?.lorebooks ?? res?.data ?? []);
    for (const lb of list) {
      const d = parseData(lb);
      const name   = lb.name   ?? d.name   ?? "";
      const charId = String(lb.characterId ?? d.characterId ?? "");
      if (name.startsWith("Marinara Extender") && charId === String(characterId)) {
        lorebookId = String(lb.id ?? d.id);
        const budget = Number(lb.tokenBudget ?? d.tokenBudget ?? 0);
        if (budget < ME_LOREBOOK_TOKEN_BUDGET) {
          await marinara.apiFetch(`/lorebooks/${lorebookId}`, {
            method: "PATCH",
            body: JSON.stringify({ tokenBudget: ME_LOREBOOK_TOKEN_BUDGET }),
          }).catch(() => {});
          console.info(`[ME] lorebook ${lorebookId} tokenBudget raised ${budget} → ${ME_LOREBOOK_TOKEN_BUDGET} (entries above the budget are silently dropped by the engine)`);
        }
        break;
      }
    }
  } catch { /* will create below */ }

  if (!lorebookId) {
    dbg(`ensureLorebook: not found — creating "${lorebookName}" for characterId=${characterId}`);
    try {
      const res = await marinara.apiFetch("/lorebooks", {
        method: "POST",
        body: JSON.stringify({ name: lorebookName, characterId, enabled: true, tokenBudget: ME_LOREBOOK_TOKEN_BUDGET }),
      });
      dbg(`ensureLorebook: POST response keys=${Object.keys(res ?? {}).join(",")} raw=${JSON.stringify(res).slice(0, 200)}`);
      const d = parseData(res);
      const rawId = res.id ?? d.id ?? res.data?.id;
      lorebookId = rawId != null ? String(rawId) : null;
      if (!lorebookId || lorebookId === "undefined") {
        console.error("[ME] lorebook create returned no usable ID — response:", JSON.stringify(res).slice(0, 300));
        return null;
      }
      console.info(`[ME] lorebook created for ${characterName ?? characterId} — id=${lorebookId}`);
    } catch (err) {
      console.error("[ME] lorebook create failed:", err);
      return null;
    }
  } else {
    dbg(`ensureLorebook: found existing lorebookId=${lorebookId}`);
  }

  return lorebookId;
}

// Nuke every "Memory System" entry in the lorebook, then create exactly 2 fresh ones.
// No caching, no ID tracking, no dedup logic. Absolute correctness every cycle.
const ENTRY_BASE = { keys: [], constant: true, locked: false, role: "system", noVector: true, sticky: 0, cooldown: 0, delay: 0, ephemeral: 0 };

// Mutex: only one lorebook write at a time. Concurrent calls wait for the current one to finish.
let _lorebookWriteChain = Promise.resolve();

async function writeMemoryToLorebook(lorebookId, memoryBlock) {
  // Serialize all lorebook writes so concurrent calls don't each see an empty lorebook.
  const result = _lorebookWriteChain.then(() => _doWriteMemoryToLorebook(lorebookId, memoryBlock));
  _lorebookWriteChain = result.catch(() => {});
  return result;
}

async function _doWriteMemoryToLorebook(lorebookId, memoryBlock) {
  const { instructions, content } = splitMemoryBlock(memoryBlock);
  dbg(`writeMemoryToLorebook: lb=${lorebookId} instr=${instructions.length} content=${content.length}`);
  if (content) dbg(`  content preview: ${content.slice(0, 120).replace(/\n/g, "↵")}…`);

  // Step 1 — delete ALL entries. This lorebook belongs entirely to us.
  try {
    const res = await marinara.apiFetch(`/lorebooks/${lorebookId}/entries`);
    const list = Array.isArray(res) ? res : (res?.entries ?? res?.data ?? []);
    dbg(`[ME:sweep] lorebook=${lorebookId} found ${list.length} entries`);
    if (list.length > 0) dbg(`[ME:sweep] first entry raw:`, JSON.stringify(list[0]).slice(0, 400));
    for (const entry of list) {
      const d  = parseData(entry);
      // Try every known ID field Marinara might use.
      const id = String(entry.id ?? d.id ?? d.uid ?? d._id ?? "");
      dbg(`[ME:sweep]  entry id="${id}" name="${entry.name ?? d.name ?? "?"}"`);
      if (!id || id === "undefined") { dbg("[ME:sweep]  SKIP — no usable id"); continue; }
      const unlockBody = await marinara.apiFetch(`/lorebooks/${lorebookId}/entries/${id}`, {
        method: "PATCH", body: JSON.stringify({ locked: false }),
      }).catch(e => ({ _err: String(e) }));
      dbg(`[ME:sweep]  unlock ${id}:`, JSON.stringify(unlockBody).slice(0, 100));
      const delBody = await fetch(`/api/lorebooks/${lorebookId}/entries/${id}`, { method: "DELETE" })
        .then(r => r.status === 204 || r.headers.get("content-length") === "0" ? {} : r.json())
        .catch(e => ({ _err: String(e) }));
      dbg(`[ME:sweep]  delete ${id}:`, JSON.stringify(delBody).slice(0, 100));
    }
  } catch (err) { console.error("[ME] entry sweep failed:", err); }

  // Step 2 — create exactly 2 fresh entries.
  await Promise.all([
    marinara.apiFetch(`/lorebooks/${lorebookId}/entries`, {
      method: "POST",
      body: JSON.stringify({ ...ENTRY_BASE, name: "Memory System — Instructions", content: instructions, order: 0, enabled: true }),
    }).catch(err => console.error("[ME] instructions create failed:", err)),
    marinara.apiFetch(`/lorebooks/${lorebookId}/entries`, {
      method: "POST",
      body: JSON.stringify({ ...ENTRY_BASE, name: "Memory System — Active Context", content, order: 1, enabled: content !== "" }),
    }).catch(err => console.error("[ME] content create failed:", err)),
  ]);

  dbg(`writeMemoryToLorebook: done`);
}

// Strip memory commands from the visible chat DOM.
// Native [remember: ...] / [bookmark: ...] commands are stripped by Marinara Engine
// before messages are saved, so they're only visible during streaming. This handler
// catches them in text nodes during that window, plus legacy <remember>/<bookmark>
// XML tags from older character cards.
const VISIBLE_TAG_RE = /<(?:bookmark|remember|context|commands)\b[^>]*>[\s\S]*?<\/(?:bookmark|remember|context|commands)>/gi;
const BRACKET_CMD_RE = /\[(?:remember|bookmark):[^\]]*\]/gi;
function stripVisibleMemoryTags() {
  const scroll = document.querySelector('.mari-messages-scroll');
  if (!scroll) return;

  // Pass 1 — legacy XML tags rendered as actual DOM elements.
  for (const el of scroll.querySelectorAll('bookmark, remember, context, commands')) {
    el.remove();
  }

  // Pass 2 — XML or bracket commands rendered as literal text inside text nodes.
  const walker = document.createTreeWalker(scroll, NodeFilter.SHOW_TEXT);
  const toStrip = [];
  let node;
  while ((node = walker.nextNode())) {
    VISIBLE_TAG_RE.lastIndex = 0;
    BRACKET_CMD_RE.lastIndex = 0;
    if (VISIBLE_TAG_RE.test(node.textContent) || BRACKET_CMD_RE.test(node.textContent)) {
      toStrip.push(node);
    }
  }
  for (const n of toStrip) {
    VISIBLE_TAG_RE.lastIndex = 0;
    BRACKET_CMD_RE.lastIndex = 0;
    n.textContent = n.textContent
      .replace(VISIBLE_TAG_RE, '')
      .replace(BRACKET_CMD_RE, '')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd();
  }
}

async function syncMemoryBlock(session) {
  dbg(`syncMemoryBlock: char=${session.characterId} chat=${session.chatId}`);
  try {
    const nameParam = session.characterName ? `&characterName=${encodeURIComponent(session.characterName)}` : "";
    const res = await memFetch(
      `/api/memory-block?characterId=${encodeURIComponent(session.characterId)}&chatId=${encodeURIComponent(session.chatId)}${nameParam}`,
    );
    dbg(`syncMemoryBlock: sidecar response memoryBlock length=${res?.memoryBlock?.length ?? "null"}`);
    if (!res?.memoryBlock) { dbg("syncMemoryBlock: empty memoryBlock — skipping lorebook write"); return; }
    const lorebookId = await ensureLorebook(session.characterId, session.characterName);
    dbg(`syncMemoryBlock: lorebookId=${lorebookId}`);
    if (!lorebookId) { dbg("syncMemoryBlock: no lorebook — aborting"); return; }
    await writeMemoryToLorebook(lorebookId, res.memoryBlock);
    console.info(`[ME] memory loaded for ${session.characterName ?? session.characterId}`);
  } catch (err) { dbg("syncMemoryBlock: caught error (sidecar down?)", err); }
}

// ── Post-generation hook ──────────────────────────────────────────────────────

async function checkForNewMessage() {
  if (!currentSession) { dbg("checkForNewMessage: no session — skip"); return; }
  const { characterId, chatId } = currentSession;
  try {
    const res = await marinara.apiFetch(`/chats/${chatId}/messages`);
    const msgs = Array.isArray(res) ? res : (res?.messages ?? res?.data ?? []);
    dbg(`checkForNewMessage: ${msgs.length} messages in chat`);

    const last = [...msgs].reverse().find(m => {
      const role = m.role ?? parseData(m).role;
      return role === "assistant" || role === "character";
    });
    if (!last) { dbg("checkForNewMessage: no assistant message found"); return; }

    const lastD = parseData(last);
    const msgId = String(last.id ?? lastD.id ?? "");
    const content = String(last.content ?? lastD.content ?? "");
    if (msgId && msgId === lastMsgId[chatId]) { dbg(`checkForNewMessage: msgId=${msgId} already processed`); return; }
    lastMsgId[chatId] = msgId;

    if (!content) { dbg("checkForNewMessage: last message has no content"); return; }

    // Find the last user message immediately before this AI response.
    const lastIdx = msgs.findLastIndex(m => {
      const id = String(m.id ?? parseData(m).id ?? "");
      return id === msgId;
    });
    const lastUserMsg = lastIdx > 0 ? [...msgs].slice(0, lastIdx).reverse().find(m => {
      const role = m.role ?? parseData(m).role;
      return role === "user";
    }) : null;
    const userContent = lastUserMsg ? String(lastUserMsg.content ?? parseData(lastUserMsg).content ?? "") : "";

    dbg(`checkForNewMessage: new message msgId=${msgId} contentLength=${content.length} userContentLength=${userContent.length} — calling process-turn`);

    // Tier 1: snapshot every 30 minutes of active chat.
    const now = Date.now();
    const lastSnap = getSnapshotTime(chatId);
    if (lastSnap === 0) {
      // First time seeing this chat — seed the timer without snapshotting.
      setSnapshotTime(chatId, now);
    } else if (now - lastSnap >= SNAPSHOT_INTERVAL_MS) {
      setSnapshotTime(chatId, now);
      const snapMsgs = msgs.slice(-40).map(m => {
        const d = parseData(m);
        return { role: m.role ?? d.role ?? "user", content: String(m.content ?? d.content ?? "") };
      }).filter(m => m.content);
      dbg(`checkForNewMessage: firing 30-min snapshot — ${snapMsgs.length} messages`);
      memFetch("/api/snapshot", {
        method: "POST",
        body: JSON.stringify({ characterId, characterName: currentSession?.characterName, messages: snapMsgs }),
      }).then(r => console.info(`[ME:snapshot] done — created=${r?.created ?? 0}`))
        .catch(err => dbg("snapshot failed:", err));
    }

    const result = await memFetch("/api/process-turn", {
      method: "POST",
      // characterName matters: without it the sidecar falls back to the identity
      // key ("professor_mari") as the chunk speaker, and the analyzer mirrors
      // that identifier style back into subject names and thread labels.
      // participantIds scope the subject roster to characters actually in the
      // scene; personaName routes player-facts to "user" instead of chat scope.
      body: JSON.stringify({
        characterId,
        characterName: currentSession?.characterName,
        participantIds: currentSession?.participantIds,
        personaName: currentSession?.personaName,
        sceneTitle: currentSession?.sceneTitle,
        chatId, turnNumber: msgs.length, messageText: content, userMessageText: userContent,
      }),
    });
    dbg(`checkForNewMessage: process-turn response memoryBlock length=${result?.memoryBlock?.length ?? "null"} created=${result?.created} bookmarks=${result?.bookmarksExtracted}`);
    if (!result?.memoryBlock) { dbg("checkForNewMessage: no memoryBlock in response — aborting"); return; }

    const lorebookId = await ensureLorebook(characterId, currentSession?.characterName);
    if (!lorebookId) return;
    await writeMemoryToLorebook(lorebookId, result.memoryBlock);

    // Recitation detection — did this response actually use a memory that was live
    // when it was generated? Compare against the PREVIOUS turn's surfaced set, not
    // this turn's: the memory block we just built is for the NEXT response, and an
    // entry created from this very response would otherwise self-match and inflate.
    // Fire-and-forget: never blocks the lorebook update.
    const priorSurfaced = lastSurfaced[chatId];
    if (Array.isArray(priorSurfaced) && priorSurfaced.length > 0 && content) {
      detectRecitations(priorSurfaced, content).catch(() => {});
    }
    if (Array.isArray(result.surfaced)) lastSurfaced[chatId] = result.surfaced;

    // Scene-recap floor: opportunistically sync concluded scenes (throttled;
    // sidecar is idempotent). Fire-and-forget — never blocks the turn.
    syncSceneRecaps().catch(() => {});

    // Panel observability: record what this turn put in context, and refresh
    // the panel if it's open so the activity line updates live.
    lastTurnActivity = {
      at: Date.now(),
      chatId,
      surfaced: Array.isArray(result.surfaced) ? result.surfaced : [],
      created: result.created ?? 0,
      bookmarks: result.bookmarksExtracted ?? 0,
    };
    if (panel?.classList.contains("open")) renderPanel();

    const charLabel = currentSession?.characterName ?? characterId;
    const saved = (result.created ?? 0) + (result.bookmarksExtracted ?? 0);
    if (saved > 0) {
      const parts = [];
      if (result.created > 0) parts.push(`${result.created} ledger entr${result.created === 1 ? "y" : "ies"}`);
      if (result.bookmarksExtracted > 0) parts.push(`${result.bookmarksExtracted} bookmark${result.bookmarksExtracted === 1 ? "" : "s"}`);
      console.info(`[ME] memory saved for ${charLabel}: ${parts.join(", ")}`);
    }

    // If the character created new ledger entries, refresh the panel.
    if (result.created > 0 && panel?.classList.contains("open")) {
      await loadPanelData();
    }
  } catch (err) {
    console.error("[ME] post-gen hook failed:", err);
  }
}

let msgDebounceTimer = null;
marinara.observe('.mari-messages-scroll', () => {
  // Strip tags immediately on any DOM change — don't wait for the lorebook pipeline.
  stripVisibleMemoryTags();
  clearTimeout(msgDebounceTimer);
  msgDebounceTimer = setTimeout(checkForNewMessage, 1200);
});
marinara.onCleanup(() => clearTimeout(msgDebounceTimer));

// ── SPA navigation ────────────────────────────────────────────────────────────
// Marinara is a pure SPA — location.href never changes. Use Marinara's own
// generation events to detect active chatId and chat switches.

marinara.on(window, "marinara:generation-complete", async e => {
  if (!e.detail?.chatId) return;
  const chatId = String(e.detail.chatId);
  lastKnownChatId = chatId;
  if (currentSession?.chatId !== chatId) {
    // Chat switched or first generation — rebuild the full session first.
    panelState.session = null;
    panelState.importChats = null;
    panelState.importExpanded = false;
    panelState.identityKey = null;
    panelState.identityExpanded = false;
    panelState.relinkStatus = null;
    panelState.relinkInput = "";
    panelState.renameStatus = null;
    panelState.renameInput = "";
    panelState.ingestRunning = false;
    panelState.ingestResult = null;
    panelState.ingestFileName = null;
    panelState.ingestClearResult = null;
    await refreshSession();
  }
  // Call explicitly here so we're guaranteed currentSession is set,
  // rather than relying on the DOM observer which races against refreshSession.
  await checkForNewMessage();
});

marinara.on(window, "marinara:mari-phase", e => {
  if (e.detail?.chatId) lastKnownChatId = String(e.detail.chatId);
});

marinara.on(window, "marinara:generation-error", e => {
  if (e.detail?.chatId) lastKnownChatId = String(e.detail.chatId);
});

// Also watch the header for character name changes (catches manual chat switches
// before any generation fires in the new chat).
let lastHeaderCharName = null;
marinara.observe('.mari-messages-scroll > .sticky.top-0', async () => {
  const header = document.querySelector('.mari-messages-scroll > .sticky.top-0');
  const name = header?.querySelector('img[alt]')?.alt?.trim() ?? null;
  if (name && name !== lastHeaderCharName) {
    lastHeaderCharName = name;
    lastKnownChatId = null; // force a fresh resolve for the new character
    panelState.session = null;
    panelState.importChats = null;
    panelState.importExpanded = false;
    panelState.identityKey = null;
    panelState.identityExpanded = false;
    panelState.relinkStatus = null;
    panelState.relinkInput = "";
    panelState.renameStatus = null;
    panelState.renameInput = "";
    panelState.ingestRunning = false;
    panelState.ingestResult = null;
    panelState.ingestFileName = null;
    panelState.ingestClearResult = null;
    await refreshSession();
  }
});

// Initialize session on load
refreshSession();
