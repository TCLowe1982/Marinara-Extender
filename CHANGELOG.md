# Changelog

All notable changes to Marinara Extender are documented here.

## Unreleased

### Added

- **OpenAI-compatible inference proxy** — `POST /v1/chat/completions` (alias `/chat/completions`) routes generation
  through this sidecar's existing model connection: local model first (with a per-request `model` override),
  external API as fallback. Lets a tool like the Rewrite Assistant run rewrites *and* memory analysis from one
  model instance on lighter installs — point its Direct API at `http://127.0.0.1:3001/v1`. The endpoint is outside
  `/api/` (CSRF-exempt for generic OpenAI clients); CORS still limits response reads to loopback origins.

## v1.2.0 — 2026-06-20

Story-layer completion, recoverable memory management, and a guided install.

### Highlights

- **Recap layer, end to end.** Recaps are now the canonical retrieval unit: the loader injects a "Story so far" — scene-arc and through-line recaps — *above* the raw beats, surfaced by relevance **and** embedding similarity, so the right arc appears even without keyword overlap. Beats stay underneath for detail.
- **Recoverable delete.** Deleting a memory tiers it to cold, not oblivion — a **Recently deleted** view restores it; permanent erase is a separate, deliberate step. Curator-superseded facts are restorable from **Retired**.
- **Memory tab, scoped & sortable.** A **Chat | Character** toggle exposes durable character memory (not just the active chat), with collapsible groups and newest / most-used / oldest sorting.
- **Guest characters keep their voice.** In multi-character scenes, every participant's own ledger/recaps are refreshed each turn (dual-retrieval), so a guest answers from their own canon, not just the visible scene.
- **Long stories land in one telling.** A long user message is routed through windowed granular ingestion, so a multi-page memory becomes rich beats instead of one — no re-import.
- **Guided, quieter install.** First-run onboarding (chat + embed model pull, the extension-install bridge, Ollama-not-installed guidance) with quiet repeat launches, plus **bring-your-own-backend** support — point `MARINARA_EXTENDER_LOCAL_URL` at KoboldCpp / LM Studio / llama.cpp and the launcher adapts.
- **Build code in the version string** so a stale tab is identifiable at a glance.

### Notes

- Launcher renamed to **`Marinara_Extender_Start.bat`** (matches `Marinara_Extender_Update.bat`).
- Facts stated about a character route to that character's ledger; scope isolation otherwise holds (a character doesn't bleed another's traits).

## v1.1.x — 2026-06

Rolled up from the per-release notes in [`memory-extender/docs/`](./memory-extender/docs/):

- **v1.1 — "The story, not just the facts."** Recap-layer generation (scene recaps + through-line arcs), narrative threads, multi-character subject attribution, incident-accumulate / fact-supersede reconciliation, atomic fsync'd writes, CSRF on mutating routes, embeddings on by default, one-click updates. See `docs/RELEASE-v1.1.md`.
- **v1.1.3 — "The sidecar heals itself."** Crash watchdog (auto-relaunch in ~10–15s), a crash breadcrumb in the log, consolidated launcher. See `docs/RELEASE-v1.1.3.md`.

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
