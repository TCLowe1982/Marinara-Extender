# Marinara Extender

Persistent scoped memory for [Marinara Engine](https://github.com/Pasta-Devs/Marinara-Engine) characters.

Characters forget. Marinara Extender gives them a filing cabinet — YAML files on disk, organized by scope, loaded surgically every turn so the context window doesn't bloat. The character can bookmark things mid-reply, and those bookmarks decay and resurface naturally over time.

---

## How it works

Marinara Extender is two components:

**Sidecar** — a local Node.js server that sits between Marinara and your LLM. On every generation turn it runs a two-pass loader: first reads lightweight index files from all three scopes (global → character → chat), then loads only the specific entries relevant to this turn. It prepends a `<memory>` block to the system prompt, streams the response through, and post-processes it to extract any `<bookmark>` tags the character wrote.

**Extension** — client-side JS that registers the active character and chat with the sidecar before each turn, and provides a ledger panel for viewing and managing threads, topics, and bookmarks without touching YAML directly.

```
Marinara UI  ──[Extension]──▶  POST /api/register-session
                                        │
Marinara server ──────────────▶  POST /v1/chat/completions
                                        │
                               Sidecar (localhost:3001)
                               ├── load indexes (pass 1)
                               ├── load entries (pass 2)
                               ├── inject <memory> block
                               ├── forward to real LLM ──▶  streams back
                               └── extract bookmarks, run decay
```

---

## Prerequisites

- [Marinara Engine](https://github.com/Pasta-Devs/Marinara-Engine) installed and running
- Node.js 20+

---

## Installation

### 1. Start the sidecar

```bash
cd sidecar
npm install
npm run dev          # development (tsx watch)
# or
npm start            # production (compiled)
```

Environment variables (all optional):

| Variable | Default | Description |
|---|---|---|
| `MARINARA_EXTENDER_UPSTREAM` | `https://api.openai.com` | Your real LLM base URL |
| `MARINARA_EXTENDER_PORT` | `3001` | Port the sidecar listens on |
| `MARINARA_EXTENDER_DATA` | `./data` | Where YAML files are stored |
| `MARINARA_EXTENDER_DIGEST_MODEL` | `gpt-4o-mini` | Model used for past-chat imports |

### 2. Open the setup page

Once the sidecar is running, open **[http://127.0.0.1:3001/setup](http://127.0.0.1:3001/setup)** in your browser. It walks through the remaining steps with copy buttons for everything — no file system hunting needed.

The steps on that page:

**Create a Marinara connection** — In Marinara → Settings → Connections, add a new connection using the Base URL copied from the setup page (`http://127.0.0.1:3001`). Set your real API key and usual model. The key is forwarded transparently to the upstream and never stored.

If you use multiple LLM providers (OpenAI for some characters, Anthropic for others, a local Ollama for quick chats), see [Multiple upstreams](#multiple-upstreams-optional) below.

**Install the extension** — In Marinara → Settings → Extensions, add a new extension. Click **Copy extension code** on the setup page and paste into the JS field. The extension will:

- Auto-install the bookmark tag-stripping regex script on first run
- Show a `≡` toggle button and a status dot at the bottom-left of the UI
- Register sessions with the sidecar before each generation turn

If the regex script auto-install fails, a banner appears with the manual configuration values.

**Character cards** — No editing needed. The sidecar injects memory instructions automatically on every request. The `character-prompt-snippet.md` file is available if you want to fine-tune instructions for a specific character; the sidecar ignores the duplicate.

**Switch chats** — For each chat where you want memory active, open the chat settings and switch the connection to the sidecar one. Chats on their original connection are unaffected.

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

Each turn, all bookmark weights decay by ×0.97. On turns where a bookmark's weight passes a random roll, it surfaces as a soft callback in the `<memory>` block — the character may weave it in naturally. Bookmarks below weight 0.1 are pruned automatically.

The bookmark tags are stripped from visible output by the regex script.

---

## Ledger panel

Click the `≡` button at the bottom-left to open the ledger panel. It shows the active chat's threads, topics, agenda items, and bookmarks. You can:

- **Create** threads, topics, and agenda items with a summary
- **Mark threads done** — done entries are hidden from the loader and the panel by default
- **Delete** any entry or bookmark
- **Refresh** to sync with the current YAML state

The panel only shows chat-scope data. Character-scope and global entries can be managed via the management API directly (see below).

---

## Importing past chats

The ledger panel has an **Import from past chats** section at the bottom. It lists all other chats for the current character and lets you extract persistent memories from them using the LLM.

- **Import** — digest a single chat. The LLM reads the conversation and extracts threads, topics, and agenda items worth remembering.
- **Import all** — digest every listed chat sequentially. A warning is shown: *This may take some time.* Each chat is processed one at a time; progress is shown inline.

Imported entries go into the **character scope**, so they're available across all future chats with that character — not just the one you're currently in.

The import uses the model configured in `MARINARA_EXTENDER_DIGEST_MODEL` (default: `gpt-4o-mini`). It reuses the API key from the most recent generation request through the sidecar; no extra configuration is needed as long as you've made at least one request first.

> **Note:** Because imports write to the character scope, they can't easily be undone in bulk. If something goes wrong — unexpected entries, duplicates, entries in the wrong lane — please [open an issue](https://github.com/Pasta-Devs/Marinara-Engine/issues) with a description of what happened. Individual entries can always be deleted via the management API.

---

## Management API

The sidecar exposes a REST API on `http://127.0.0.1:3001/api/*`.

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
GET    /api/health            # { ok: true, upstream: "..." }
POST   /api/register-session  { characterId, chatId, turnNumber }
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

---

## Multiple upstreams (optional)

By default one connection pointing at `http://127.0.0.1:3001` handles everything. If you use more than one LLM provider you can route each to its own upstream without touching any config you've already set up.

### Option A — profiles.yaml

Copy `sidecar/profiles.example.yaml` to `sidecar/profiles.yaml` and fill in your upstreams:

```yaml
openai:     https://api.openai.com
openrouter: https://openrouter.ai/api
local:      http://127.0.0.1:11434
```

### Option B — environment variables

```bash
MARINARA_EXTENDER_PROFILE_OPENAI=https://api.openai.com
MARINARA_EXTENDER_PROFILE_LOCAL=http://127.0.0.1:11434
```

Variable name after the `MARINARA_EXTENDER_PROFILE_` prefix becomes the profile name (case-insensitive).

### Creating the Marinara connections

For each profile, add a connection in Marinara → Settings → Connections:

- **Base URL:** `http://127.0.0.1:3001/p/<profile-name>`
- **API Key:** your key for that provider
- **Model:** the model you use on that provider

Then assign connections to chats as usual. Chats using the plain `http://127.0.0.1:3001` connection are unaffected.

---

## Security note

The sidecar forwards the `Authorization` header from Marinara's request to the upstream LLM. Your API key is never stored by the sidecar — it passes through from Marinara's encrypted connection store. Do not expose the sidecar port outside localhost.
