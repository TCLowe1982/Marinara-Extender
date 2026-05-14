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
const REGEX_INSTALLED_KEY = `${marinara.extensionId}:regex-installed`;
const REGEX_SCRIPT_NAME = "Marinara Extender: Strip bookmark tags";

const REGEX_MANIFEST = {
  name: REGEX_SCRIPT_NAME,
  enabled: true,
  findRegex: "<bookmark[^>]*>[\\s\\S]*?<\\/bookmark>",
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
  /* Toggle button — sits in the chat header alongside Marinara's own icons */
  .me-toggle-btn {
    background: none; border: none; border-radius: 4px;
    color: var(--muted-foreground, #9ca3af);
    font-size: 16px; line-height: 1; cursor: pointer;
    padding: 4px 6px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    transition: color 0.15s, background 0.15s;
  }
  .me-toggle-btn:hover { background: rgba(255,255,255,0.08); color: #e8e5e0; }
  .me-toggle-btn.sidecar-down { color: #f87171; }

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
  .me-import-all-btn {
    display: block; width: calc(100% - 20px); margin: 6px 10px 0;
    background: #252320; border: 1px solid #3d3a36;
    border-radius: 4px; color: #e8e5e0; font-size: 11px;
    cursor: pointer; padding: 5px 8px; font-family: inherit; text-align: center;
  }
  .me-import-all-btn:hover:not(:disabled) { border-color: #f97316; color: #f97316; }
  .me-import-all-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .me-import-warning { margin: 4px 10px 0; font-size: 10px; color: #f59e0b; text-align: center; }
  .me-chat-row { display: flex; align-items: center; gap: 6px; padding: 3px 10px; }
  .me-chat-row:hover { background: #1e1c19; }
  .me-chat-name { flex: 1; min-width: 0; font-size: 11px; color: #c9c5bf; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .me-chat-import-btn {
    flex-shrink: 0; background: none; border: 1px solid #3d3a36;
    border-radius: 3px; color: #9ca3af; font-size: 10px;
    cursor: pointer; padding: 2px 6px; font-family: inherit;
  }
  .me-chat-import-btn:hover:not(:disabled) { border-color: #60a5fa; color: #60a5fa; }
  .me-chat-import-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .me-import-ok  { flex-shrink: 0; font-size: 10px; color: #34d399; }
  .me-import-err { flex-shrink: 0; font-size: 10px; color: #f87171; }

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
  btn.className = 'me-toggle-btn';
  btn.title = 'Marinara Extender';
  btn.innerHTML = '&#8801;';
  btn.addEventListener('click', () => {
    panel?.classList.contains('open') ? closePanel() : openPanel();
  });
  header.appendChild(btn);
}

injectToggle();
marinara.observe(document.body, injectToggle);
marinara.onCleanup(() => document.getElementById('me-toggle')?.remove());

// ── Sidecar health (shown via button colour) ──────────────────────────────────

async function checkSidecar() {
  const btn = document.getElementById('me-toggle');
  try {
    const r = await fetch(`${MEMORY_EXTENDER}/api/health`, { signal: AbortSignal.timeout(2000) });
    btn?.classList.toggle('sidecar-down', !r.ok);
  } catch {
    btn?.classList.add('sidecar-down');
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
};

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
    content.appendChild(renderImportSection());
  }

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

  const chats = panelState.importChats ?? [];

  if (chats.length === 0) {
    const msg = el("div", "me-section-empty");
    msg.textContent = "No other chats found for this character.";
    body.appendChild(msg); wrap.appendChild(body); return wrap;
  }

  const anyBusy = panelState.importAllActive || panelState.importingSet.size > 0;

  // Import all button + warning
  const allBtn = el("button", "me-import-all-btn");
  allBtn.disabled = anyBusy;
  if (panelState.importAllActive && panelState.importAllProgress) {
    const { current, total } = panelState.importAllProgress;
    allBtn.textContent = `Digesting… (${current}/${total})`;
  } else {
    allBtn.textContent = `Import all (${chats.length} chat${chats.length === 1 ? "" : "s"})`;
  }
  allBtn.addEventListener("click", () => importAllChats(chats));
  body.appendChild(allBtn);

  const warning = el("div", "me-import-warning");
  warning.textContent = "⚠ This may take some time";
  body.appendChild(warning);

  // Per-chat rows
  for (const chat of chats) {
    const row = el("div", "me-chat-row");
    const nameEl = el("span", "me-chat-name");
    nameEl.textContent = chat.name; nameEl.title = chat.name;
    row.appendChild(nameEl);

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

    body.appendChild(row);
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
    const res = await marinara.apiFetch("/chats");
    const list = Array.isArray(res) ? res : (res?.chats ?? res?.data ?? []);

    panelState.importChats = list
      .filter(c => {
        const d = parseData(c);
        const cid = c.characterId ?? c.character_id ?? d.characterId ?? d.character_id;
        const id  = c.id ?? d.id;
        return String(cid) === String(characterId) && String(id) !== String(chatId);
      })
      .map(c => {
        const d = parseData(c);
        return {
          id:   String(c.id ?? d.id),
          name: String(c.name ?? c.title ?? d.name ?? d.title ?? `Chat ${shorten(String(c.id ?? ""), 8)}`),
        };
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

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadPanelData() {
  if (!panelState.session) return;
  panelState.loading = true;
  panelState.error = null;
  renderPanel();

  try {
    const { chatId } = panelState.session;
    console.log("[ME] loadPanelData — fetching entries/bookmarks for chatId:", chatId);
    const [entries, bookmarks] = await Promise.all([
      memFetch(`/api/entries?scope=chat&scopeId=${encodeURIComponent(chatId)}`),
      memFetch(`/api/bookmarks?scope=chat&scopeId=${encodeURIComponent(chatId)}`),
    ]);
    console.log("[ME] entries:", entries, "bookmarks:", bookmarks);
    panelState.chatEntries = Array.isArray(entries) ? entries : [];
    panelState.bookmarks = Array.isArray(bookmarks) ? bookmarks : [];
  } catch (e) {
    console.error("[ME] loadPanelData error:", e);
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
  if (!currentSession) currentSession = await resolveSession();
  console.log("[ME] openPanel — session:", currentSession);
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

function showSetupBanner() {
  const banner = marinara.addElement(document.body, "div", { id: "me-setup-banner" });
  if (!banner) return;
  banner.innerHTML = `
    <button title="Dismiss">✕</button>
    <strong>Marinara Extender setup needed</strong><br>
    Add a regex script in <em>Settings → Regex Scripts</em>:<br><br>
    Name: <code>${REGEX_SCRIPT_NAME}</code><br>
    Find: <code>&lt;bookmark[^&gt;]*&gt;[\\s\\S]*?&lt;\\/bookmark&gt;</code><br>
    Replace: <em>(empty)</em> · Placement: <code>AI Output</code> · Flags: <code>gi</code>
  `;
  banner.querySelector("button")?.addEventListener("click", () => banner.remove());
}

async function ensureRegexScript() {
  if (localStorage.getItem(REGEX_INSTALLED_KEY)) return;
  try {
    const scripts = await marinara.apiFetch("/regex-scripts");
    const exists = Array.isArray(scripts) &&
      scripts.some(s => s.name === REGEX_SCRIPT_NAME || parseData(s).name === REGEX_SCRIPT_NAME);
    if (!exists) {
      await marinara.apiFetch("/regex-scripts", { method: "POST", body: JSON.stringify(REGEX_MANIFEST) });
    }
    localStorage.setItem(REGEX_INSTALLED_KEY, "1");
  } catch {
    showSetupBanner();
  }
}

ensureRegexScript();

// ── Session resolution ────────────────────────────────────────────────────────

async function resolveSession() {
  const url = location.pathname + location.hash + location.search;
  const match = url.match(/[/#]chat[/#]([^/?&#]+)/);
  console.log("[ME] resolveSession — url:", url, "hash:", location.hash, "match:", match?.[1] ?? null);

  // DOM recon — log what's available so we can find the chat ID
  console.log("[ME] document.title:", document.title);
  const header = document.querySelector('.mari-messages-scroll > .sticky.top-0');
  console.log("[ME] header innerHTML:", header?.innerHTML?.slice(0, 400));
  const allDataIds = [...document.querySelectorAll('[data-id],[data-chat-id],[data-chat],[data-character-id]')]
    .map(el => ({ tag: el.tagName, attrs: el.dataset }));
  console.log("[ME] data-id elements:", allDataIds);
  // Log any links or buttons with UUIDs in them
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|^\d+$/;
  const withIds = [...document.querySelectorAll('a[href],button,h1,h2,[class*="chat"],[class*="title"]')]
    .map(el => ({ tag: el.tagName, cls: el.className?.toString?.().slice(0,60), text: el.textContent?.trim().slice(0,60), href: el.getAttribute?.('href') }))
    .filter(el => el.href || (el.text && uuidRe.test(el.text)));
  console.log("[ME] potential ID elements:", withIds.slice(0, 10));

  if (!match) return null;
  const chatId = match[1];
  try {
    const chat = await marinara.apiFetch(`/chats/${chatId}`);
    console.log("[ME] chat API response:", JSON.stringify(chat));
    const chatData = parseData(chat);
    console.log("[ME] chatData (parsed):", JSON.stringify(chatData));
    const characterId = chat?.characterId ?? chat?.character_id ?? chatData?.characterId ?? chatData?.character_id;
    console.log("[ME] characterId resolved:", characterId);
    if (!characterId) return null;

    let characterName = null;
    try {
      const char = await marinara.apiFetch(`/characters/${characterId}`);
      const charData = parseData(char);
      characterName = char?.name ?? charData?.name ?? null;
      console.log("[ME] characterName resolved:", characterName);
    } catch (e) { console.warn("[ME] character name fetch failed:", e); }

    return { characterId: String(characterId), chatId, characterName };
  } catch (e) {
    console.error("[ME] resolveSession error:", e);
    return null;
  }
}

// ── Session + lorebook state ──────────────────────────────────────────────────

let currentSession = null;
const lorebookCache = {};  // characterId → { lorebookId, entryId }
const lastMsgId = {};      // chatId → last processed assistant message id

async function refreshSession() {
  currentSession = await resolveSession();
  if (currentSession) {
    ensureLorebookEntry(currentSession.characterId).catch(() => {});
    // Sync current memory block into the lorebook on chat load
    syncMemoryBlock(currentSession).catch(() => {});
  }
}

// ── Lorebook helpers ──────────────────────────────────────────────────────────

const ME_LOREBOOK_NAME = "Marinara Extender Memory";
const ME_ENTRY_COMMENT = "marinara-extender-memory-block";

async function ensureLorebookEntry(characterId) {
  if (lorebookCache[characterId]) return lorebookCache[characterId];

  let lorebookId = null;
  let entryId = null;

  // Find existing lorebook for this character
  try {
    const res = await marinara.apiFetch("/lorebooks");
    const list = Array.isArray(res) ? res : (res?.lorebooks ?? res?.data ?? []);
    for (const lb of list) {
      const d = lb.data ?? lb;
      if ((d.name ?? lb.name) === ME_LOREBOOK_NAME &&
          String(d.characterId ?? lb.characterId ?? "") === String(characterId)) {
        lorebookId = String(lb.id ?? d.id);
        break;
      }
    }
  } catch { /* will create below */ }

  // Create if not found
  if (!lorebookId) {
    try {
      const res = await marinara.apiFetch("/lorebooks", {
        method: "POST",
        body: JSON.stringify({ name: ME_LOREBOOK_NAME, characterId, enabled: true }),
      });
      const d = res.data ?? res;
      lorebookId = String(d.id ?? res.id);
    } catch (err) {
      console.error("[ME] lorebook create failed:", err);
      return null;
    }
  }

  // Find our entry by comment marker
  try {
    const res = await marinara.apiFetch(`/lorebooks/${lorebookId}`);
    const d = res.data ?? res;
    const entries = d.entries ?? [];
    for (const e of entries) {
      const ed = e.data ?? e;
      if ((ed.comment ?? e.comment) === ME_ENTRY_COMMENT) {
        entryId = String(e.id ?? ed.id);
        break;
      }
    }
  } catch { /* will create below */ }

  // Create entry if not found
  if (!entryId) {
    try {
      const res = await marinara.apiFetch(`/lorebooks/${lorebookId}/entries`, {
        method: "POST",
        body: JSON.stringify({
          content: "",
          keys: [],
          comment: ME_ENTRY_COMMENT,
          constant: true,
          enabled: true,
          order: 0,
        }),
      });
      const d = res.data ?? res;
      entryId = String(d.id ?? res.id);
    } catch (err) {
      console.error("[ME] entry create failed:", err);
      return null;
    }
  }

  const result = { lorebookId, entryId };
  lorebookCache[characterId] = result;
  return result;
}

async function updateLorebook(lorebookId, entryId, memoryBlock) {
  try {
    await marinara.apiFetch(`/lorebooks/${lorebookId}/entries/${entryId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: memoryBlock, enabled: true }),
    });
  } catch (err) {
    console.error("[ME] lorebook update failed:", err);
  }
}

async function syncMemoryBlock(session) {
  try {
    const res = await memFetch(
      `/api/memory-block?characterId=${encodeURIComponent(session.characterId)}&chatId=${encodeURIComponent(session.chatId)}`,
    );
    if (!res?.memoryBlock) return;
    const entry = await ensureLorebookEntry(session.characterId);
    if (!entry) return;
    await updateLorebook(entry.lorebookId, entry.entryId, res.memoryBlock);
  } catch { /* sidecar down — fine */ }
}

// ── Post-generation hook ──────────────────────────────────────────────────────

async function checkForNewMessage() {
  if (!currentSession) return;
  const { characterId, chatId } = currentSession;
  try {
    const res = await marinara.apiFetch(`/chats/${chatId}/messages`);
    const msgs = Array.isArray(res) ? res : (res?.messages ?? res?.data ?? []);

    const last = [...msgs].reverse().find(m => {
      const role = m.role ?? parseData(m).role;
      return role === "assistant" || role === "character";
    });
    if (!last) return;

    const lastD = parseData(last);
    const msgId = String(last.id ?? lastD.id ?? "");
    if (msgId && msgId === lastMsgId[chatId]) return;
    lastMsgId[chatId] = msgId;

    const content = String(last.content ?? lastD.content ?? "");
    if (!content) return;

    const result = await memFetch("/api/process-turn", {
      method: "POST",
      body: JSON.stringify({ characterId, chatId, turnNumber: msgs.length, messageText: content }),
    });
    if (!result?.memoryBlock) return;

    const entry = await ensureLorebookEntry(characterId);
    if (!entry) return;
    await updateLorebook(entry.lorebookId, entry.entryId, result.memoryBlock);
  } catch (err) {
    console.error("[ME] post-gen hook failed:", err);
  }
}

let msgDebounceTimer = null;
marinara.observe('.mari-messages-scroll', () => {
  clearTimeout(msgDebounceTimer);
  msgDebounceTimer = setTimeout(checkForNewMessage, 1200);
});
marinara.onCleanup(() => clearTimeout(msgDebounceTimer));

// ── SPA navigation ────────────────────────────────────────────────────────────

let lastUrl = location.href;
marinara.setInterval(async () => {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  panelState.session = null;
  panelState.importChats = null;
  panelState.importExpanded = false;
  await refreshSession();
}, 1000);

// Initialize session on load
refreshSession();
