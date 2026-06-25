# Marinara Extender: Architecture

*Condensed from the live source in `memory-extender/src/`. When a detail matters, open the cited file — the code is authoritative; this is a map.*

## The two components

Marinara Extender is a **sidecar + a thin extension**:

1. **Memory Extender sidecar** — a local **Fastify** HTTP server (`index.ts`) bound to **`127.0.0.1:3001`** (`MARINARA_EXTENDER_PORT`). It owns all logic and stores memory as **plain YAML files on disk**. It exposes a REST API the extension calls, and an OpenAI-compatible **inference proxy** (`/v1/chat/completions`) that routes analysis calls to a local model first, external API as fallback.
2. **Client extension** — a lightweight **loader** pasted once into Marinara → Settings → Extensions. On every Marinara load it fetches the live extension (`GET /marinara-extender.js`) from the sidecar, so updates need only a Marinara reload. The extension sends each turn to the sidecar and writes the returned memory block into the character's lorebook as **two constant (always-on) system entries**.

```text
  Marinara (browser)                      Memory Extender sidecar (127.0.0.1:3001)
  ┌────────────────────┐  POST /api/process-turn  ┌──────────────────────────────┐
  │ extension (loader  │ ───────turn text────────▶ │ resolve identity             │
  │ fetches live .js)  │                           │ extract [remember]/[bookmark]│
  │                    │                           │ assemble memory block        │
  │ 2 constant         │ ◀──── <memory> block ──── │ (fire-and-forget tiers run)  │
  │ lorebook entries   │                           └──────────────────────────────┘
  └─────────┬──────────┘                                      │ YAML on disk
            │ injected by Marinara every turn                 ▼
            ▼                                          memory-extender/data/
     next generation
```

The user's **normal chat generation is never proxied** — it goes straight from Marinara to their provider. The sidecar's local model is only for *analysis* (extraction, classification, rendering).

## Security & process

- **Binds loopback only.** CORS (`cors.ts`) allows responses to be *read* only by loopback origins or an explicitly configured `MARINARA_EXTENDER_ALLOWED_ORIGIN`.
- **CSRF** (`csrf.ts`) — a per-process token is required for non-GET `/api/*` from browsers; non-browser clients (no `Origin`) pass through. The token is minted at startup, so a sidecar restart invalidates old tokens and the extension refreshes on a 403.
- **LLM config** (`llm-config.ts`) — local OpenAI-compatible endpoint primary (Ollama `dolphin3:8b` default); external API (`_API_KEY`, `_DIGEST_MODEL` = `gpt-4o-mini`) is an opt-in fallback. Set `_LOCAL_URL` empty to go external-only.

## Storage (`storage.ts`, `paths.ts`)

YAML files under `memory-extender/data/` (or `MARINARA_EXTENDER_DATA`). Per scope: an `index.yaml` (fast-scan metadata) plus the full entry files in **lane-named subdirs**. Key files:

- `global/`, `characters/{identityKey}/`, `chats/{chatId}/` — the three scopes. Each holds `index.yaml` (hot), `index.cold.yaml` (cold archive), `bookmarks.yaml`, and entry files under lane subdirs **`threads/` / `user-topics/` / `char-topics/`** (one per lane; *not* a flat `entries/`).
- Character scope also holds `beats.yaml` (+ `beats/`), `arcs.yaml`, `arc-memberships.yaml`.
- Cross-cutting: `threads/registry.yaml`, `identity-map.yaml` (ephemeral card IDs → stable identity keys), `holding-pool.yaml` (orphan beats awaiting speaker resolution), `supersession-candidates.yaml`, `reconcile-queue.yaml`.

**All writes are atomic** — temp file + fsync + rename, with per-path serialization to prevent read-modify-write races and torn files. Never write these YAMLs directly; use the `storage.ts` helpers.

## The turn lifecycle — `POST /api/process-turn` (`api.ts`)

The orchestration site. End-to-end when a turn arrives:

1. **Resolve identity** — `resolveIdentity(cardId, name)` → stable `identityKey` (`identity.ts`); ephemeral Marinara card IDs map to a durable slug via `identity-map.yaml`.
2. **Extract commands** — `extractRememberTags` (`writer.ts`) pulls `[remember: …]` / `<remember>…</remember>` into entries **synchronously** (blocks the response; deduped via Jaccard against the target lane). `[bookmark:]` tags are parsed too.
3. **Soft clock** *(gated, off by default — `MARINARA_EXTENDER_TIMESENSE=1`)* — infers narrative time-of-day from AI text and presence from the user message; attaches `timeContext` to entries. Not wall-clock.
4. **Assemble the memory block** — `loadContext` (`loader.ts`): load all three scope indexes in parallel → rank entries per scope (relevance → recency → proven value/score → lane priority) under per-scope token budgets (chat 4000 / character 2000 / global 1000) → on a topical miss, surface one best **cold** entry per scope (rehydrates it) → load selected entry files → roll bookmarks by weight → render recaps → assemble `<memory>` block, prepend instructions. Credit-stamping (lastAccessed/retrievalCount) is fire-and-forget.
5. **Bookmark decay** — `processResponse` (`writer.ts`): every existing bookmark's weight ×= `decayRate` (0.97) each turn; new ones seed from the tag. Visible `[remember:]`/`[bookmark:]` tags are stripped from output.
6. **Fire-and-forget tiers (async — never block the response):**
   - **Tier-2 sentiment** (`sentiment/pipeline.ts`) — chunk (`chunker`) → fast classify (`classifier`, salience-gated) → deep LLM analyze (`analyzer`: emotion, motivation, relational dynamics, outcome, thread label, subject) → encode beat (`encoder`) + companion ledger entry, **subject-routed** to the right character's ledger (unknown subjects → holding pool).
   - **Tier-3 ambient** (`ambient.ts`) — extract durable identity/preference facts from candidate sentences, classify scope/lane, subject-route.
   - **Long-form story** — when the user message exceeds `LONG_USER_MSG_CHARS` (default 1500), route through the full pipeline with windowed ingestion (Ledger Pattern).
   - **Promotion** (every 20 turns, `promotion.ts`) — tier transitions (short→long→core, demotions, secondary_core after 3 cycles) and cold archival of stale non-core entries (90 days).
   - **Arc promotion** (every 60 turns, `arc-promotion.ts`) — cluster beats into/onto through-line arcs.
7. **Respond** — `{ memoryBlock, created, bookmarksExtracted, surfaced[] }`.

`GET /api/memory-block` is the **read-only** sibling: same assembly, no state change — called on session load to populate the lorebook before the first turn.

## The three ingestion tiers (mental model)

- **Tier 1 — Snapshot** (`digest.ts`, `POST /api/snapshot`/`/api/digest`) — periodic (every ~30 min of active chat) LLM digest of recent messages into character-scope entries.
- **Tier 2 — Sentiment/beats** (`sentiment/`) — per-turn emotional-beat capture, the richest path; produces beats + incident entries + narrative threads.
- **Tier 3 — Ambient facts** (`ambient.ts`, `facts.ts`) — per-turn durable-fact capture (identity, preferences, history).

All three run off the hot path so the turn response is fast.

## REST surface (high level — see `api.ts` for the full list)

- **Entries** — `GET/POST /api/entries`, `GET/PATCH/DELETE /api/entries/:id`, `/restore`, `/recite`, `GET /api/deleted`.
- **Bookmarks** — `GET /api/bookmarks`, `PATCH/DELETE /api/bookmarks/:id`.
- **Memory core** — `POST /api/process-turn`, `GET /api/memory-block`, `POST /api/ingest-commands`.
- **Import/analysis** — `POST /api/digest|snapshot|analyze-beats|estimate-beats`, `GET /api/beats`.
- **Maintenance** — `POST /api/cleanup|promote-all`.
- **Reconcile** *(opt-in `MARINARA_EXTENDER_RECONCILE`)* — `GET /api/reconcile-queue`, `POST /api/reconcile-apply|reconcile-hold`.
- **Threads/arcs/identity/aliases/holding-pool** — `GET /api/threads|arcs|identities|aliases|pending-speakers`, plus mutators.
- **Config/info** — `GET/POST /api/config`, `GET /api/scopes`, `GET /api/health`, `GET /api/csrf-token`.
- **Setup/extension** — `GET /setup`, `GET /loader.js`, `GET /marinara-extender.js`.
- **Inference proxy (CSRF-exempt)** — `POST /v1/chat/completions`, `POST /chat/completions`.

## Known sharp edges (from the source — candidates for beads issues)

- "Summoned" credit uses **lexical relevance only** (`loader.ts`); semantic pulls aren't counted toward promotion.
- Thread-sibling relevance lift (~0.75 factor) is **not documented as empirically tuned**.
- If `supersession-candidates.yaml` is lost, recorded corrections are forgotten (entries/beats persist).
- `fsync` failure is logged once but non-fatal — NTFS may not durably sync on all systems.

When the code disagrees with this map, the **code wins** — flag the drift so the reference gets fixed.
