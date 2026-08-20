# Marinara Extender: The Capability Package Contract

*The in-Engine surface. Grounded in the Engine's own `capabilityPackageManifestSchema` (`packages/shared/src/schemas/capability-package.schema.ts`) and read against **Engine v2.4.3 (`34442e26d`)**, which is the version the maintainer's install is pinned to. **Contracts, not coordinates** (`umz1`): everything below names a field, an enum member, an endpoint or a validation rule, because those survive refactors and line numbers do not.*

> **Why this file exists.** The browser-extension path is dead (`references/extension.md`) and the sidecar-served memory browser (`hwlj` Option B) shipped. What remains is Option A — a package that mounts our UI *inside* the Engine. That has been blocked less by effort than by not knowing the contract. This is the contract.

## Manifest identity and version gating

| Field | Shape | Notes |
|---|---|---|
| `id` | `^[a-z0-9]+(?:-[a-z0-9]+)*$`, ≤80 | kebab-case only |
| `name` | 1–120 chars | |
| `version` | `^\d+\.\d+\.\d+(-prerelease)?$` | strict semver |
| `description` | ≤2000 chars, defaults `""` | |
| `localizations` | per-locale `{name?, description?, homeBrowserTab{label?, ariaLabel?}}` | partial/unknown locales fall back to canonical |
| `engine` | `{min, maxExclusive}` | **the Engine version gate** — both required |
| `kind` | ≥1 of `agent` \| `maps` \| `conversation-calls` \| `turn-game` | |
| `schemaVersion` | `1` \| `2` (discriminated union) | v2 additionally requires `capabilityApi` |
| `capabilityApi` | v2 only | feature gate, e.g. `contributions.assets` needs **≥ 1.10** |

`schemaVersion` and `capabilityApi` are two different gates and are easy to conflate. `schemaVersion` selects the manifest *shape*; `capabilityApi` declares the *runtime feature level* required. Newer runtimes serve older declared levels — you declare a higher `capabilityApi` to **require** a feature, not to receive it.

## Entrypoints

```jsonc
"entrypoints": { "server": "...", "client": "...", "agents": "...", "knowledge": "..." }  // all optional, .strict()
```

**`client` is the one that matters for us.** It is app-level UI, *not* the opaque-origin sandboxed Worker that Personal Extensions get — that distinction is the entire reason Option A is viable where the browser extension was not (see the 2026-08-02 ruling in `extension.md`).

## Permissions

The complete enum — there are exactly nine, and `ui` is among them:

`agent-runtime` · `chat-read` · `chat-write` · `conversation-actions` · `network` · `prompt-context` · `routes` · `storage` · `ui`

> **`ui` is the permission `hwlj` was waiting on.** It exists and is declarable.
>
> **⚠️ `network` is declared but its enforcement is UNVERIFIED.** A search of `packages/server/src` for the permission string found no enforcement site, which means it is either enforced client-side, enforced by a name this search did not match, or currently advisory. **Do not design around "we declare `network`, therefore the client may call `127.0.0.1:3001`" until someone has actually confirmed it.** That single question decides whether Option A can reuse the existing sidecar UI wholesale or must broker everything through the `server` entrypoint, so it is worth settling *first*.

## Contribution slots

```
conversation-surface · conversation-toolbar · chat-settings · spatial-workspace
chat-runtime · game-world-map · home-browser-tab · game-surface
```

**`home-browser-tab`** — "Adds a top-level destination to Home's browser shell." **New in the 2.4.x line and the best fit for the memory browser.** `chat-settings` (the slot Option A was originally written against) puts memory management inside a per-chat pane; what Option B actually built is a whole management application — browse, edit, merge, identity/alias repair, receipts. That is a top-level destination.

Its descriptor and rules:

```jsonc
"contributions": {
  "slots": ["home-browser-tab"],
  "homeBrowserTab": {
    "label": "Memories",        // 1–40 chars, required
    "ariaLabel": "...",         // ≤100, optional
    "iconPaths": ["icon.png"]   // 1–2 images, must match .gif|.jpg|.jpeg|.png|.webp
  }
}
```

Validated **at install**, not at render — a package that gets this wrong fails with a clear reason instead of mounting an empty screen later:

- declaring `home-browser-tab` **without** `entrypoints.client` → rejected
- declaring `home-browser-tab` **without** `contributions.homeBrowserTab` → rejected
- any `iconPaths` entry **not present in `files[]`** → rejected, *whether or not* the slot is declared (an unpinned or traversal-shaped icon path would otherwise reach the resolver unvalidated)

Other slots' options: `gameSurface{surfaceClass}` (declared, not pushed at runtime, so theming applies on first paint), `conversationGame{command: /^\/[a-z0-9-]+$/, aliases[], playerLabel}`, `agentDetail{agentIds: 1–32}`.

## Hash-pinned files — the integrity contract

```jsonc
"files": [ { "path": "client.js", "sha256": "<64 hex>", "bytes": 12345 } ]   // min 1, bytes ≤ 100 MB
```

Every served path must be declared here with its digest. This is the mechanism behind the vetting question: content is pinned, so what was reviewed is what runs.

**Static assets** (`contributions.assets.paths`, 1–256 entries, requires `schemaVersion: 2` + `capabilityApi ≥ 1.10`) are served over **`/api/capability-packages/:id/assets/*`** through the same chain: path containment → `files[]` membership → passive content-type allowlist → **hash re-verification on every read**. The allowlist is images plus JSON only — **never SVG, HTML or scripts**, because those would be active documents on a same-origin route.

## Catalog provenance — the trust marking

```jsonc
"provenance": { "kind": "official" | "custom", "url": "https://..." }   // on the CATALOG, optional
```

This is the Engine's answer, as of 2.4.3, to *how a package is marked as trusted* — the question the maintainer's Engine update freeze is waiting on (see `bd memories` → the-engine-update-freeze-and-what-it-was). Catalogs declare where they came from and whether they are official.

> **Do not read this as "the verdict landed."** That is TC's call, not an inference from a schema. It is evidence the mechanism is taking shape. The freeze stays until TC says otherwise, and Engine updates are taken by **moving the pin** (`git checkout --detach vX.Y.Z`), never by lifting it.

## What this means for us

- **Option A is now mostly a packaging job, not a rewrite** — the UI exists in `ui.ts`; `home-browser-tab` is a near 1:1 mount point for it.
- **Settle the `network` question first.** It decides the whole architecture: direct sidecar calls from the client, versus brokering through the `server` entrypoint.
- `7zro` (prototype the package, dev-install) is the natural first half and is unblocked.
- The `engine.min`/`engine.maxExclusive` gate means our manifest must state the Engine range it supports — and the install is pinned at **2.4.3**, so that is the range to test against.
