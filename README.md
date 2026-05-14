# Marinara Extender

Persistent scoped memory for [Marinara Engine](https://github.com/Pasta-Devs/Marinara-Engine) characters.

Characters forget. Marinara Extender gives them a filing cabinet — YAML files on disk, organized by scope, loaded surgically every turn so the context window doesn't bloat. The character can bookmark things mid-reply, and those bookmarks decay and resurface naturally over time.

---

## How it works

Marinara Extender is two components:

**Memory Extender server** — a local Node.js server that stores your memory data as YAML files and handles all the logic: loading relevant entries, building the memory block, extracting bookmarks, and running decay. It exposes a REST API that the extension calls.

**Extension** — client-side JS installed in Marinara. After each AI response it sends the message text to the memory server, which extracts any bookmarks and returns an updated memory block. The extension writes that block into a lorebook entry so Marinara injects it automatically on the next turn.

```
                         ┌─── Memory Extender (localhost:3001) ───┐
Extension (post-turn) ──▶│  extract bookmarks · run decay         │
                         │  build memory block                     │
                         └──────────────────┬────────────────────-┘
                                            │ memoryBlock
                         ┌──────────────────▼─────────────────────┐
                         │  Lorebook entry (updated by extension)  │
                         └──────────────────┬────────────────────-┘
                                            │ injected by Marinara
                                            ▼
                                   Next generation turn
```

No proxy. No special connection. Your LLM calls go straight from Marinara to your provider as normal.

---

## Prerequisites

- [Marinara Engine](https://github.com/Pasta-Devs/Marinara-Engine) installed and running
- Node.js 20+

---

## Installation

### 1. Install the extension

Download [marinara-extender.js](./marinara-extender.js) from this repo. In Marinara → Settings → Extensions, add a new extension named **Marinara Extender** and upload the file.

### 2. Start the Memory Extender server

```bash
cd memory-extender
npm install
npm run dev          # development (tsx watch)
# or
npm start            # production (compiled)
```

Then open **[http://127.0.0.1:3001/setup](http://127.0.0.1:3001/setup)** to confirm everything is running.

### 3. Open any character chat

That's it. The extension detects the active character and chat automatically, keeps the lorebook entry up to date, and starts tracking bookmarks from the first response.

---

## Environment variables

All optional. Set them in `memory-extender/.env` or as system environment variables.

| Variable | Default | Description |
|---|---|---|
| `MARINARA_EXTENDER_PORT` | `3001` | Port the server listens on |
| `MARINARA_EXTENDER_DATA` | `./data` | Where YAML files are stored |
| `MARINARA_EXTENDER_API_KEY` | — | API key used for past-chat imports (see below) |
| `MARINARA_EXTENDER_DIGEST_MODEL` | `gpt-4o-mini` | Model used for past-chat imports |

---

## The memory model

### Three scopes

Data is organized into three nested scopes, each with its own directory:

```
data/
├── global/                  # conventions and rules that apply to all characters
├── characters/<id>/         # a specific character's persistent arc and lore
└── chats/<id>/              # the active scratchpad for one conversation
```

The loader walks chat → character → global with configurable token budgets (chat: 4k, character: 2k, global: 1k). Only entries within budget are loaded. Oldest-accessed entries are dropped first when the budget is tight.

### Three lanes

Within each scope, entries are divided into three lanes:

| Lane | Purpose |
|---|---|
| `open_threads` | Tasks and issues being tracked. The only lane with a "done" lifecycle. |
| `user_topics` | Things the user keeps coming back to — kids, work, running jokes. |
| `character_topics` | The character's own agenda. Things she wants to bring up. |

The loader prioritizes `open_threads` first, then `user_topics`, then `character_topics` within each scope's token budget.

### Bookmarks

The character can bookmark mid-reply by writing a tag anywhere in its response:

```
<bookmark topic="sister-situation" weight="0.8" why="unresolved">User's sister going through a rough patch — they cut the topic short.</bookmark>
```

| Attribute | Required | Notes |
|---|---|---|
| `topic` | Yes | kebab-case identifier |
| `weight` | No | 0.1–1.0, defaults to 0.5 |
| `why` | No | `unresolved`, `important`, `emotional`, `promised`, `curious`, `follow-up` |

Each turn, all bookmark weights decay by ×0.97. On turns where a bookmark's weight passes a random roll, it surfaces as a soft callback in the memory block — the character may weave it in naturally. Bookmarks below weight 0.1 are pruned automatically.

The bookmark tags are stripped from visible output by a regex script the extension installs automatically.

---

## Ledger panel

Click the `≡` button in the chat header to open the ledger panel. It shows the active chat's threads, topics, agenda items, and bookmarks. You can:

- **Create** threads, topics, and agenda items with a summary
- **Mark threads done** — done entries are hidden from the loader and the panel by default
- **Delete** any entry or bookmark
- **Refresh** to sync with the current YAML state

The panel only shows chat-scope data. Character-scope and global entries can be managed via the management API directly (see below).

---

## Importing past chats

The ledger panel has an **Import from past chats** section at the bottom. It lists all other chats for the current character and lets you extract persistent memories from them using an LLM.

- **Import** — digest a single chat. The LLM reads the conversation and extracts threads, topics, and agenda items worth remembering.
- **Import all** — digest every listed chat sequentially. Each chat is processed one at a time; progress is shown inline.

Imported entries go into the **character scope**, so they're available across all future chats with that character.

The import calls an LLM directly and requires an API key. Set `MARINARA_EXTENDER_API_KEY` in `memory-extender/.env` before using this feature. The model is configurable via `MARINARA_EXTENDER_DIGEST_MODEL` (default: `gpt-4o-mini`).

> **Note:** Because imports write to the character scope, they can't easily be undone in bulk. Individual entries can always be deleted via the management API.

---

## Management API

The Memory Extender server exposes a REST API on `http://127.0.0.1:3001/api/*`.

### Entries

```
GET    /api/entries?scope=&scopeId=&lane=&status=
GET    /api/entries/:id?scope=&scopeId=
POST   /api/entries          { scope, scopeId, lane, summary, content, status? }
PATCH  /api/entries/:id      { scope, scopeId, summary?, content?, status? }
DELETE /api/entries/:id?scope=&scopeId=
```

`GET /api/entries` hides `done` entries by default. Pass `?status=all` to include them.

### Bookmarks

```
GET    /api/bookmarks?scope=&scopeId=
PATCH  /api/bookmarks/:id    { scope, scopeId, weight?, why?, summary? }
DELETE /api/bookmarks/:id?scope=&scopeId=
```

### Scopes

```
GET    /api/scopes            # lists all scopes that have data, with counts
```

### Other

```
GET    /api/health            # { ok: true }
GET    /api/memory-block?characterId=&chatId=   # current memory block (read-only)
POST   /api/process-turn      { characterId, chatId, turnNumber, messageText }
```

---

## Data files

All data lives under the configured `data/` directory as plain YAML — diffable, inspectable with any text editor, and easy to back up.

```
data/chats/<chatId>/
├── index.yaml          # flat lookup table: id → path, summary, tokens, lane, status
├── threads/
│   └── thread-<id>.yaml
├── user-topics/
│   └── utopic-<id>.yaml
├── char-topics/
│   └── ctopic-<id>.yaml
└── bookmarks.yaml      # decaying bookmark list
```

Indexes are updated automatically whenever an entry is created, patched, or deleted. You should not edit index files by hand; edit the entry YAML files directly if you need to make manual changes.
