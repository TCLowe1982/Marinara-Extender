# Marinara Extender: The Client Extension

*The browser side — how the sidecar's memory block reaches Marinara. Grounded in `setup.ts` (serving) and the extension itself, `marinara-extender.js` (one ~4400-line file at the **repo root**, served at `GET /marinara-extender.js`). It's an ordinary Marinara client extension using the `marinara` API — for that API itself, defer to the **marinara-engine-expert** skill.*

## Two-file model: loader + live extension

- **The loader** (`buildLoaderJs`, `setup.ts`) is pasted/uploaded **once** into Marinara → Settings → Extensions. The user gets it from `GET /loader.js` (or the `/setup` page). It has the sidecar port baked in.
- **The live extension** is fetched **fresh on every Marinara load** by the loader: `fetch(SIDECAR + "/marinara-extender.js?ts=" + Date.now())`. So updating the Extender means updating the server file + reloading Marinara — **never re-uploading**.

The loader runs the fetched code via a **blob `<script>`**, not `eval`/`new Function` — Marinara's CSP allows `blob:` but not eval. It bridges the scoped `marinara` API in through a temporary global (`window.__marinaraExtender`) and sets **`window.__meSidecar`** = the address it fetched from. The extension reads `__meSidecar` instead of hardcoding `127.0.0.1:3001`, so a **remote / Tailscale install is configured in exactly one place** — the loader's `SIDECAR` line. If the fetch fails, the loader shows a platform-honest on-page banner ("memory server not running" on Windows; "not reachable from this device" on mobile — the sidecar runs on a computer).

The served file is **version-stamped**: `setup.ts` replaces a `__ME_VERSION__` placeholder with `buildVersion()` so the panel can detect a **stale tab** running old extension code (an invisible failure that once made a shipped fix look broken).

## The extension ↔ sidecar contract

Three calls carry the whole loop (the extension uses `memFetch` for the sidecar's `/api/*`, and `marinara.apiFetch` for Marinara's own API):

1. **On chat load** → `GET /api/memory-block` (`syncMemoryBlock`) — read-only; populates the lorebook before the first turn.
2. **After each AI response** → `POST /api/process-turn` with the AI + user text; the returned `memoryBlock` is written to the lorebook (`refreshMemory` → `writeMemoryToLorebook`). In group scenes each participant's memory refreshes into **its own** lorebook.
3. **On detected recall** → `POST /api/entries/:id/recite` — when the extension spots a surfaced entry's summary used in the response, it bumps the recitation count (the promotion signal).

## The two constant lorebook entries (the injection mechanism)

This is how memory actually enters generation. Per character, the extension maintains a dedicated lorebook **`Marinara Extender — {name}`** (`ensureLorebook`):

- **Token budget forced to `16384`** (`ME_LOREBOOK_TOKEN_BUDGET`). The engine's default per-lorebook budget is **2048 and it silently drops entries over it** — a memory block that grew past ~2300 tokens simply stopped injecting with every upstream check green. The budget is set on create and **healed on every lookup**.
- Each turn, `writeMemoryToLorebook` (serialized through a `_lorebookWriteChain` **mutex** so concurrent refreshes don't each see an empty lorebook) **deletes every entry, then creates exactly two** — "absolute correctness every cycle, no caching/dedup":
  - **`Memory System — Instructions`** (order 0) — the static how-to-use-memory text. `splitMemoryBlock` takes everything before the `\n\n<memory>` marker.
  - **`Memory System — Active Context`** (order 1) — the live memory (everything after the marker); enabled only when non-empty.
- Both entries use `ENTRY_BASE`: **`constant: true`** (always injected, not keyword-gated — `keys: []`), `role: "system"`, `noVector: true`, unlocked. Marinara injects them on every generation.

## Command stripping — three layers

Native `[remember:]` / `[bookmark:]` commands are stripped by **Marinara Engine itself before a message is saved**, so they're only ever visible during the **streaming window**. The extension covers that window and legacy XML tags three ways:

1. **A Marinara regex script** it auto-installs (`REGEX_MANIFEST`, "Marinara Extender: Strip memory tags", v5) — strips both `<remember>/<bookmark>` XML and `[remember:]/[bookmark:]` brackets from `ai_output`. The durable strip; toggleable in the panel's Settings (off = tags visible, for debugging).
2. **CSS** hiding `bookmark, remember, context, commands` elements (React-proof, unlike `el.remove()`).
3. **`stripVisibleMemoryTags`** — a DOM TreeWalker that catches tags rendered as literal text mid-stream (`VISIBLE_TAG_RE` + `BRACKET_CMD_RE`).

## The panel UI (brief)

A `≡` toggle button injected into the chat header (via `marinara.observe`, so it survives React re-renders); its color reflects health (`checkSidecar` every 15s — red = sidecar down, orange = Ollama down). The panel (`#me-panel`) has tabs and sections for: the three **lanes** (UI labels *Open Threads* / *User Topics* / *Character Agenda* → `open_threads`/`user_topics`/`character_topics`), a **scope toggle** (Chat | Character), **bookmarks**, **Import** (digest past chats), **Story ingest**, **Pending speakers** (the holding-pool resolution UI — map / create card / ignore), **Identity** (view/relink the stable key), **Recently deleted** / **Retired** (restore), and **Settings** (strip-tags toggle, cleanup, backup, backfill tiers).

## Security & contributor notes

- **CSRF** — `memFetch` fetches `/api/csrf-token`, sends `x-me-csrf` on mutations, and **retries once on a 403** (a sidecar restart mints a new token; 403 means "refresh and retry", not "fail"). GET needs no token.
- **It's one big file at the repo root** (`marinara-extender.js`), not under `memory-extender/src/`. Edit it there; the sidecar serves it version-stamped. Restart isn't needed — reload Marinara (the loader re-fetches).
- **The engine's per-lorebook token budget is a recurring silent-failure source** — if memory stops injecting with everything else green, check the lorebook's `tokenBudget`.
- **Keep lorebook writes serialized.** The nuke-and-recreate cycle racing against itself leaves the lorebook empty/partial exactly when generation runs — that's what `_lorebookWriteChain` prevents.
- For anything about the `marinara` extension API, lorebook entry fields, or engine behavior, that's the **marinara-engine-expert** skill's domain.
