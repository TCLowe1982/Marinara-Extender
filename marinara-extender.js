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

const MEMORY_EXTENDER = "http://127.0.0.1:3001";
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
  const raw = chat?.characterIds ?? d?.characterIds;
  if (raw) {
    try {
      const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(arr) && arr.length > 0) return String(arr[0]);
    } catch {}
  }
  return null;
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

async function memFetch(path, options = {}) {
  const r = await fetch(`${MEMORY_EXTENDER}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  return r.json();
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
  // Story ingest section
  ingestExpanded: false,
  ingestPovChar: "",
  ingestText: "",
  ingestFileName: null,
  ingestRunning: false,
  ingestStatus: "",    // short message shown while running
  ingestResult: null,
  ingestClearRunning: false,
  ingestClearResult: null,
  // Settings section
  settingsExpanded: false,
  stripTagsEnabled: null,   // null = not yet loaded
  stripTagsScriptId: null,
  stripTagsLoading: false,
  // Identity section
  identityExpanded: false,
  identityKey: null,       // loaded from /api/identity on expand
  identityLoading: false,
  relinkInput: "",
  relinkStatus: null,      // null | "ok" | string (error message)
  renameInput: "",
  renameStatus: null,      // null | "ok" | string (error message)
};

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

function renderPanel() {
  if (!panel) return;
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

  // Session info line
  if (panelState.session) {
    const info = el("div", "me-panel-info");
    const charLabel = panelState.session.characterName ?? shorten(panelState.session.characterId);
    info.textContent = `chat/${shorten(panelState.session.chatId)} · ${charLabel}`;
    panel.appendChild(info);
  }

  // Scrollable content
  const content = el("div", "me-panel-content");

  if (panelState.loading) {
    const msg = el("div", "me-loading");
    msg.textContent = "Loading…";
    content.appendChild(msg);
  } else if (!panelState.session) {
    const msg = el("div", "me-empty");
    msg.textContent = "Open a chat with a character to use the ledger.";
    content.appendChild(msg);
  } else if (panelState.error) {
    const msg = el("div", "me-error");
    msg.textContent = panelState.error;
    content.appendChild(msg);
  } else {
    for (const lane of LANES) {
      const entries = panelState.chatEntries.filter(e => e.lane === lane.key);
      content.appendChild(renderLaneSection(lane, entries));
    }
    content.appendChild(renderBookmarksSection(panelState.bookmarks));
    content.appendChild(renderIdentitySection());
    content.appendChild(renderImportSection());
    content.appendChild(renderStoryIngestSection());
  }

  // Settings is always rendered regardless of session state
  content.appendChild(renderSettingsSection());

  panel.appendChild(content);
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
  panelState.ingestRunning = true;
  panelState.ingestStatus = "Analyzing story…";
  panelState.ingestResult = null;
  panelState.ingestClearResult = null;
  renderPanel();

  try {
    const { characterId, characterName } = panelState.session;
    const body = {
      characterId,
      characterName: characterName ?? "the character",
      text: panelState.ingestText,
    };
    const pov = panelState.ingestPovChar.trim();
    if (pov) body.povCharacter = pov;

    const res = await memFetch("/api/ingest-story", { method: "POST", body: JSON.stringify(body) });
    if (res?.error) throw new Error(res.error);
    panelState.ingestResult = {
      beats:          res.beats,
      chunksTotal:    res.chunksTotal,
      chunksAnalyzed: res.chunksAnalyzed,
      chunksFiltered: res.chunksFiltered,
      chunksFailed:   res.chunksFailed,
      parseMethod:    res.parseMethod,
      speakers:       res.speakers ?? [],
    };
    notifyIngestDone(characterName, res.beats?.length ?? 0);
  } catch (err) {
    panelState.ingestResult = { error: err.message ?? "Ingest failed" };
    notifyIngestDone(characterName, 0);  // badge still appears so they know it finished
  }

  panelState.ingestRunning = false;
  panelState.ingestStatus = "";
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
    hint.textContent = "Long stories can take 1–2 minutes — the model reads each chunk individually.";
    body.appendChild(hint);

    wrap.appendChild(body);
    return wrap;
  }

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

  // Saving-for hint — shows which character's beats will be stored
  const savingHint = el("div", "me-ingest-hint");
  const charLabel = panelState.session?.characterName ?? "this character";
  savingHint.textContent = `Saves beats for: ${charLabel}. Open each character's chat and run separately for multi-character stories.`;
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
    if (panelState.ingestResult.error) {
      resultEl.className = "me-ingest-result me-ingest-err";
      resultEl.textContent = `✗ ${panelState.ingestResult.error}`;
    } else {
      resultEl.className = "me-ingest-result me-ingest-ok";
      const { beats, chunksTotal, chunksFiltered, chunksFailed, parseMethod, speakers } = panelState.ingestResult;
      const beatCount = beats?.length ?? 0;
      const methodLabel = { "pre-attributed": "pre-attributed", "local-llm": "local model", "external-llm": "external API", "paragraph": "paragraph split" }[parseMethod] ?? parseMethod ?? "";
      const lines = [`✓ ${beatCount} beat${beatCount === 1 ? "" : "s"} from ${chunksTotal} chunks`];
      if (methodLabel) lines.push(`via ${methodLabel}`);
      if (chunksFiltered > 0) lines.push(`${chunksFiltered} filtered`);
      if (chunksFailed  > 0) lines.push(`${chunksFailed} failed`);
      resultEl.textContent = lines.join(" · ");
      if (speakers?.length) {
        const speakerEl = el("div");
        speakerEl.style.cssText = "margin-top:4px; font-size:10px; color:#6b7280;";
        speakerEl.textContent = "Speakers: " + speakers.join(", ");
        resultEl.appendChild(speakerEl);
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
    const { current, total } = panelState.importAllProgress;
    allBtn.textContent = `Digesting… (${current}/${total})`;
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
      const spin = el("span", "me-chat-import-btn"); spin.textContent = "…"; spin.style.border = "none"; spin.style.cursor = "default";
      row.appendChild(spin);
    } else if (result?.error) {
      const errEl = el("span", "me-import-err");
      errEl.textContent = "Error"; errEl.title = result.error;
      row.appendChild(errEl);
    } else if (result) {
      const okEl = el("span", "me-import-ok");
      okEl.textContent = `+${result.count}`;
      okEl.title = `${result.count} memor${result.count === 1 ? "y" : "ies"} added to character memory`;
      row.appendChild(okEl);
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
        return getChatCharacterId(c) === String(characterId) && String(id) !== String(chatId);
      })
      .map(c => {
        const d = parseData(c);
        const id = String(c.id ?? d.id);
        const folderId = String(c.folderId ?? d.folderId ?? "");
        return {
          id,
          name:       String(c.name ?? c.title ?? d.name ?? d.title ?? `Chat ${shorten(id, 8)}`),
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
    return list
      .map(m => {
        const d = parseData(m);
        const role    = m.role    ?? d.role;
        const content = m.content ?? d.content;
        return (role && content) ? { role: String(role), content: String(content) } : null;
      })
      .filter(Boolean)
      .slice(-200); // cap at 200 most-recent messages
  } catch {
    return [];
  }
}

async function importOneChat(chat) {
  if (!panelState.session) return;
  const { characterId, characterName } = panelState.session;
  panelState.importingSet.add(chat.id);
  renderPanel();

  try {
    const messages = await fetchChatMessages(chat.id);
    if (messages.length === 0) {
      panelState.importResults[chat.id] = { count: 0 };
    } else {
      const result = await memFetch("/api/digest", {
        method: "POST",
        body: JSON.stringify({ characterId, characterName: characterName ?? "the character", messages }),
      });
      if (result?.error) throw new Error(result.detail ?? result.error);
      panelState.importResults[chat.id] = { count: result.created ?? 0 };
    }
  } catch (err) {
    console.error("[ME] import failed for chat", chat.id, ":", err);
    panelState.importResults[chat.id] = { error: String(err) };
  }

  panelState.importingSet.delete(chat.id);
  renderPanel();
}

async function importAllChats(chats) {
  if (!panelState.session) return;
  panelState.importAllActive = true;
  panelState.importAllProgress = { current: 0, total: chats.length };
  renderPanel();

  for (let i = 0; i < chats.length; i++) {
    if (panelState.importResults[chats[i].id]) continue; // skip already-done
    panelState.importAllProgress = { current: i + 1, total: chats.length };
    await importOneChat(chats[i]); // updates panel internally
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
  } catch {
    panelState.error = "Failed to load. Is the Memory Extender running?";
    panelState.chatEntries = [];
    panelState.bookmarks = [];
  }

  panelState.loading = false;
  renderPanel();
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

async function openPanel() {
  if (!panel) return;
  panel.classList.add("open");
  clearIngestBadge();
  if (!currentSession) currentSession = await resolveSession();
  panelState.session = currentSession;
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

      return { characterId: String(characterId), chatId: String(chatId), characterName };
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
        break;
      }
    }
  } catch { /* will create below */ }

  if (!lorebookId) {
    dbg(`ensureLorebook: not found — creating "${lorebookName}" for characterId=${characterId}`);
    try {
      const res = await marinara.apiFetch("/lorebooks", {
        method: "POST",
        body: JSON.stringify({ name: lorebookName, characterId, enabled: true }),
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
    const res = await memFetch(
      `/api/memory-block?characterId=${encodeURIComponent(session.characterId)}&chatId=${encodeURIComponent(session.chatId)}`,
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
      body: JSON.stringify({ characterId, chatId, turnNumber: msgs.length, messageText: content, userMessageText: userContent }),
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
