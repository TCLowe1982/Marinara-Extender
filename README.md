# Marinara Extender

Persistent scoped memory for [Marinara Engine](https://github.com/Pasta-Devs/Marinara-Engine) characters.

Characters forget. Marinara Extender gives them a filing cabinet — YAML files on disk, organized by scope, loaded surgically every turn so the context window doesn't bloat. The character can bookmark things mid-reply, and those bookmarks decay and resurface naturally over time.

---

## How it works

Marinara Extender is two components:

**Memory Extender server (the sidecar)** — a local Node.js server that owns all the logic and stores memory as plain YAML files. Each turn it: extracts `[remember:]` / `[bookmark:]` commands from the AI's reply, analyzes the exchange into emotional beats and ambient facts (via a local model), promotes/demotes memories across tiers (including cold-archiving stale ones), and assembles the memory block to inject next turn. It exposes a REST API the extension calls.

**Extension** — client-side JS installed in Marinara. After each AI response it sends the turn to the sidecar, gets back the assembled block, and writes it into the character's lorebook as **two always-on system entries** — *Memory System — Instructions* (how to use memory) and *Memory System — Active Context* (what's relevant right now) — which Marinara injects on every generation. The bracket commands are stripped from visible chat by a regex script the extension installs automatically.

```text
                          ┌── Memory Extender sidecar (localhost:3001) ──┐
 Extension (post-turn) ──▶│  parse [remember:]/[bookmark:] commands       │
   sends the AI turn      │  analyze beats + ambient facts (local model)  │
                          │  promote / demote tiers · cold-archive stale  │
                          │  assemble <memory_system> + <memory> block    │
                          └───────────────────────┬──────────────────────┘
                                                  │ block
                          ┌───────────────────────▼──────────────────────┐
                          │  2 constant system lorebook entries (per char)│
                          └───────────────────────┬──────────────────────┘
                                                  │ injected by Marinara every turn
                                                  ▼
                                         Next generation turn
```

Analysis runs on your **local model** (Ollama by default) — no key, nothing leaves your machine; an external OpenAI-compatible API is an optional fallback. Your normal chat LLM calls still go straight from Marinara to your provider; the sidecar never proxies them.

---

## Prerequisites

- [Marinara Engine](https://github.com/Pasta-Devs/Marinara-Engine) installed and running
- Node.js 20+
- A local model server for analysis. [Ollama](https://ollama.com) is the default — the launcher offers to pull the chat model (`dolphin3:8b`) and the embedder (`nomic-embed-text`) for you. **Any OpenAI-compatible server also works** (KoboldCpp, LM Studio, llama.cpp): point `MARINARA_EXTENDER_LOCAL_URL` at it (e.g. `http://127.0.0.1:5001/v1`) and the launcher skips the Ollama steps. An external OpenAI-compatible API key is an optional fallback.

---

## Installation

First, get the code. **Cloning is recommended** — it keeps the one-click updater working:

```bash
git clone https://github.com/TCLowe1982/Marinara-Extender
```

No git? Download the ZIP from GitHub and unzip it anywhere — everything still runs; you'd just update by re-downloading until the no-git updater lands.

### 1. Start the Memory Extender server

On Windows, double-click **`Marinara_Extender_Start.bat`** (or run `start.ps1`) — it installs dependencies on first run, starts Ollama and the server, and shows a live status bar.

Or start it manually:

```bash
cd memory-extender
npm install
npm run dev          # development (tsx watch)
# or
npm start            # production (compiled)
```

### 2. Install the extension — once

Open **[http://127.0.0.1:3001/setup](http://127.0.0.1:3001/setup)** and **download the loader**. In Marinara → Settings → Extensions, add a new extension named **Marinara Extender** and **upload that file**.

You only do this once. The loader pulls the live extension from your running server every time Marinara loads, so future updates just need a Marinara reload — never another upload. (Prefer the whole file? The setup page also offers the full extension as an offline fallback, but you'd re-upload it on every update.)

### 3. Open any character chat

That's it. The extension detects the active character and chat automatically and starts working from the first response. (If the panel button doesn't appear, the server isn't running — start it and reload Marinara.)

---

## Environment variables

**All optional** — a local Ollama running the default model works with **no `.env` at all**. Set values in `memory-extender/.env` or as system environment variables. Paths (`.env`, data dir) resolve relative to the install, so it doesn't matter where you launch from.

**Local inference (the primary path):**

| Variable | Default | Description |
| --- | --- | --- |
| `MARINARA_EXTENDER_LOCAL_URL` | `http://127.0.0.1:11434/v1` | OpenAI-compatible local endpoint (Ollama by default; any compatible server works). Set it **empty** to disable local and use the external API only. |
| `MARINARA_EXTENDER_LOCAL_MODEL` | `dolphin3:8b` | Local model for analysis/imports. Uncensored on purpose — an alignment-tuned model refuses to classify adult roleplay content, which breaks the pipeline. |
| `MARINARA_EXTENDER_EMBED_MODEL` | — | Optional Ollama embedding model for semantic chunk merging (e.g. `nomic-embed-text`). Unset = turn-based grouping. |

**External API (optional fallback — only used when local is unavailable):**

| Variable | Default | Description |
| --- | --- | --- |
| `MARINARA_EXTENDER_API_KEY` | — | API key for the external fallback. |
| `MARINARA_EXTENDER_DIGEST_UPSTREAM` | `https://api.openai.com` | OpenAI-compatible base URL for the fallback. |
| `MARINARA_EXTENDER_DIGEST_MODEL` | `gpt-4o-mini` | Fallback model. |

**Server & behavior:**

| Variable | Default | Description |
| --- | --- | --- |
| `MARINARA_EXTENDER_PORT` | `3001` | Port the server listens on (binds `127.0.0.1` only). |
| `MARINARA_EXTENDER_DATA` | `<install>/data` | Where YAML files are stored (resolved relative to the install). |
| `MARINARA_EXTENDER_ALLOWED_ORIGIN` | — | Extra CORS origin to allow, if you run Marinara on a non-loopback URL. |
| `MARINARA_EXTENDER_TIMESENSE` | `0` | Conversational time-sense (narrative time + presence). Off for v1.0. |
| `MARINARA_EXTENDER_PROGRESS` | `1` | Console progress bar during imports. |
| `MARINARA_EXTENDER_BUDGET_CHAT` / `_CHARACTER` / `_GLOBAL` | `4000` / `2000` / `1000` | Per-scope token budgets for the memory loaded each turn. See [Tuning how much memory is injected](#tuning-how-much-memory-is-injected-token-budget). |
| `MARINARA_EXTENDER_EIDETIC` | `0` | Inject every entry regardless of budget (testing only). |

### Tuning how much memory is injected (token budget)

The extender deliberately keeps its footprint small. Each turn it injects up to a per-scope token budget — chat **4000**, character **2000**, global **1000** (≈7k tokens total by default). To change it, set the three budget variables in `memory-extender/.env`:

```ini
MARINARA_EXTENDER_BUDGET_CHAT=4000
MARINARA_EXTENDER_BUDGET_CHARACTER=2000
MARINARA_EXTENDER_BUDGET_GLOBAL=1000
```

- **Read live — no restart needed.** The budgets are re-read on every turn, so a change takes effect on your next message. The launcher's **`[L] View log`** command shows the effective usage per turn (e.g. `char:45/2000 tokens`), so you can see what your setting actually costs.
- **Lower** them to shrink token cost and latency; **raise** them to let characters carry more context per turn.
- **Keep the total under the engine's lorebook injection budget.** The Marinara Engine silently drops lorebook entries that exceed a lorebook's `tokenBudget` (the extender sets this to **16384**). Your three budgets plus the instruction header must fit under that ceiling, or memory quietly stops being injected. The defaults (~7k) sit well below it; if you raise the total past ~15k, raise the engine lorebook's token budget to match.

---

## The memory model

### Three scopes

Data is organized into three nested scopes, each with its own directory:

```text
data/
├── global/                  # conventions and rules that apply to all characters
├── characters/<id>/         # a specific character's persistent arc and lore
└── chats/<id>/              # the active scratchpad for one conversation
```

The loader walks chat → character → global with configurable token budgets (chat: 4k, character: 2k, global: 1k). Only entries within budget are loaded. Oldest-accessed entries are dropped first when the budget is tight.

### Three lanes

Within each scope, entries are divided into three lanes:

| Lane | Purpose |
| --- | --- |
| `open_threads` | Tasks and issues being tracked. The only lane with a "done" lifecycle. |
| `user_topics` | Things the user keeps coming back to — kids, work, running jokes. |
| `character_topics` | The character's own agenda. Things she wants to bring up. |

The loader prioritizes `open_threads` first, then `user_topics`, then `character_topics` within each scope's token budget.

### Bookmarks

The character can bookmark mid-reply by writing a bracket command anywhere in its response:

```text
[bookmark: topic="sister-situation", weight=0.8, why="unresolved", summary="User's sister going through a rough patch — they cut the topic short."]
```

| Field | Required | Notes |
| --- | --- | --- |
| `topic` | Yes | kebab-case identifier |
| `weight` | No | 0.1–0.9, defaults to 0.5 |
| `why` | No | `unresolved`, `important`, `emotional`, `promised`, `curious`, `follow-up` |
| `summary` | No | one-line description shown when it resurfaces |

The character also saves durable facts the same way: `[remember: lane="user_topics", content="..."]` (lanes: `user_topics`, `open_threads`, `character_topics`; add `scope="chat"` to keep it to one conversation).

Each turn, all bookmark weights decay by ×0.97. On turns where a bookmark's weight passes a random roll, it surfaces as a soft callback in the memory block — the character may weave it in naturally. Bookmarks below weight 0.1 are pruned automatically.

These bracket commands (and any legacy `<bookmark>`/`<remember>` XML) are stripped from visible chat by a regex script the extension installs automatically.

---

## Ledger panel

Click the `≡` button in the chat header to open the ledger panel. It has four tabs:

- **Memory** — the active chat's threads, topics, agenda items, and bookmarks. Create entries, mark threads done (hidden from the loader once done), delete, and refresh.
- **Import** — pull memory out of past conversations (see below) and analyze pasted prose/story text into emotional beats.
- **Pending** — speakers from imports that didn't match a known character. Route each to a card (or create one) so its memories file correctly; once mapped, future imports route that name automatically.
- **Settings** — toggles, identity/relink tools, and maintenance (cleanup, etc.).

The Memory tab shows chat-scope data; character-scope and global entries can be managed via the API (see below).

---

## Importing past chats

The **Import** tab lists the character's other chats and turns them into persistent memory at the same granularity as a live conversation — running the full sentiment pipeline to extract emotional beats (with their motivations and relational dynamics), not just a shallow summary.

- **Import one** — analyze a single chat into beats + retrievable entries.
- **Import all** — analyze every listed chat sequentially, with honest progress and a cost estimate up front. Long runs are resumable, and re-importing a chat cleanly replaces its prior entries.
- **Story / prose** — paste narrative text and assign its speakers to characters; unrecognized speakers land in the **Pending** tab rather than being dropped.

Imported entries go into the **character scope**, so they're available across all future chats with that character.

The import calls an LLM to analyze each conversation. By default it uses your **local model** (Ollama, `dolphin3:8b`) — no API key needed. If local inference is unavailable, it falls back to the external API, which requires `MARINARA_EXTENDER_API_KEY`. See [Environment variables](#environment-variables).

> **Note:** Because imports write to the character scope, they can't easily be undone in bulk. Individual entries can always be deleted via the management API.

---

## Management API

The Memory Extender server exposes a REST API on `http://127.0.0.1:3001/api/*`.

### Entries

```http
GET    /api/entries?scope=&scopeId=&lane=&status=
GET    /api/entries/:id?scope=&scopeId=
POST   /api/entries          { scope, scopeId, lane, summary, content, status? }
PATCH  /api/entries/:id      { scope, scopeId, summary?, content?, status? }
DELETE /api/entries/:id?scope=&scopeId=
```

`GET /api/entries` hides `done` entries by default. Pass `?status=all` to include them.

### Bookmarks

```http
GET    /api/bookmarks?scope=&scopeId=
PATCH  /api/bookmarks/:id    { scope, scopeId, weight?, why?, summary? }
DELETE /api/bookmarks/:id?scope=&scopeId=
```

### Scopes and health

```http
GET    /api/scopes            # lists all scopes that have data, with counts
GET    /api/health            # { ok: true, ollama: "ok" | "unavailable" | "not_configured" }
GET    /api/memory-block?characterId=&chatId=   # current memory block (read-only)
POST   /api/process-turn      { characterId, chatId, turnNumber, messageText }
```

### Beats & imports

```http
POST   /api/estimate-beats    # pre-flight cost estimate (chunk + classify, no LLM)
POST   /api/analyze-beats     # analyze a chat into emotional beats (NDJSON progress stream)
POST   /api/ingest-story      # analyze pasted prose, with per-speaker assignment
GET    /api/beats?characterId=&full=
DELETE /api/beats/:characterId
POST   /api/beats-to-entries  # backfill retrievable entries from stored beats
```

### Speaker resolution (holding pool + alias table)

```http
GET    /api/pending-speakers          # unresolved speaker labels + counts + suggestion
POST   /api/resolve-speaker           { label, action: "map"|"create"|"ignore", characterId?, characterName? }
GET|POST|DELETE /api/aliases          # alias table read / add (409 on collision) / remove
GET    /api/ignored-speakers          # + POST /api/restore-speaker { label }
POST   /api/orphan-character          { characterId } — return a deleted character's beats to the pool
```

### Maintenance

```http
POST   /api/cleanup           # prune ghosts, dedupe, mark transients done
POST   /api/backup            # full copy of the data dir to a timestamped folder
GET    /api/identity          # + POST /api/identity/relink, PATCH /api/identity/name
```

### Setup (browser-facing)

```http
GET    /setup                 # one-stop install page
GET    /loader.js             # the paste-once extension loader
GET    /marinara-extender.js  # the full extension file
POST   /api/save-key          { apiKey } — store the optional external API key in .env
```

---

## Data files

All data lives under the configured `data/` directory as plain YAML — diffable, inspectable with any text editor, and easy to back up.

```text
data/
├── chats/<chatId>/              # one conversation's scratchpad
│   ├── index.yaml               # hot lookup table: id → path, summary, tokens, lane, tier, status
│   ├── index.cold.yaml          # cold archive: stale entries, retained but out of the hot scan
│   ├── threads/ user-topics/ char-topics/   # the entry files (thread-/utopic-/ctopic-<id>.yaml)
│   ├── bookmarks.yaml           # decaying bookmark list
│   └── soft-clock.yaml          # conversational time-of-day state (when time-sense is on)
├── characters/<id>/             # a character's persistent memory (same layout) plus:
│   └── beats/                   # emotional beats from imports/live chat (index.yaml + beat-<id>.yaml)
├── global/                      # conventions that apply to every character
├── aliases.yaml                 # speaker-label → character map
├── holding-pool.yaml            # orphan beats awaiting speaker resolution
├── identity-map.yaml            # characterId → stable identity key
└── .snapshots/                  # automatic index snapshots taken before destructive ops
```

Indexes update automatically on every create/patch/delete; don't hand-edit them — edit the entry YAML files directly if needed. Full backups land in a sibling `marinara-extender-backups/` folder (via the Settings "Back up my memories" button or `POST /api/backup`).

---

## License

[AGPL-3.0-only](./LICENSE) — the same license as Marinara Engine. If you run a modified version (including as a network service), you must make your changes available under the same terms.
