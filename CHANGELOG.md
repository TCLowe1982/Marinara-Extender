# Changelog

All notable changes to Marinara Extender are documented here.

## v1.0.0 — 2026-06-05

First public release. Persistent, scoped, local-first memory for [Marinara Engine](https://github.com/Pasta-Devs/Marinara-Engine) characters.

### Highlights

- **Three-scope, three-lane memory** (chat → character → global) loaded surgically each turn within a token budget, so the context window doesn't bloat.
- **Local-first & private** — analysis runs on your own model (Ollama by default); the sidecar binds `127.0.0.1`, CORS is locked to loopback, and nothing leaves your machine. An external OpenAI-compatible API is an optional fallback.
- **Emotional-beat imports** — turn past chats (or pasted prose) into retrievable memory at conversation granularity, with motivations and relational dynamics — resumable, with an up-front cost estimate.
- **Speaker resolution** — imports never drop unrecognized speakers; they wait in a Pending tab to be routed to a character (alias table + holding pool), and mappings stick across future imports.
- **Tiered cold storage** — stale memories are archived (not summarized, not deleted) out of the hot index and brought back on a topical recall miss. Bounds growth without losing anything.
- **Bookmarks** that decay and resurface naturally as soft callbacks.
- **Paste-once self-updating extension loader** — install once; future updates need only a Marinara reload.
- **Data protection** — one-click full backup, plus automatic index snapshots before destructive operations.

### Install

See the [README](./README.md). In short: run `start.ps1` (Windows) or `npm start` in `memory-extender/`, open `http://127.0.0.1:3001/setup`, and upload the loader into Marinara → Settings → Extensions. A local [Ollama](https://ollama.com) with the default model works with no configuration.

### Notes & known limitations

- **The default local model is uncensored** (`dolphin3:8b`, ~5 GB pull). This is deliberate — an alignment-tuned model refuses to classify adult roleplay content, which breaks the analysis pipeline. Swap it via `MARINARA_EXTENDER_LOCAL_MODEL` if you prefer.
- **First run is a multi-step local install** (Node 20+, Ollama, model pull, extension upload). `start.ps1` smooths this on Windows; macOS/Linux users run the npm commands manually.
- **Fact corrections aren't yet reconciled** — if you correct a previously-saved fact ("actually her name is Lin"), dedup may keep the older value. Lane-aware supersession is planned for a follow-up release.
- **Cold storage is forward-looking** — entries archive only after ~90 days without retrieval, so there's no day-one change to existing data.

### License

[AGPL-3.0-only](./LICENSE) — the same license as Marinara Engine.
