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

## Prompt-context injection — the 771t seam (verified against shipped 2.4.3)

This is the mechanism that kills the one-turn recall lag. **It ships today; no Engine change is required to reach it.**

```ts
// activate({ api })
api.registerPromptContext(contributor): Cleanup
// "Contribute text to each turn's system prompt. Requires the `prompt-context` permission."
```

Called from `generate.routes.ts:3159` **during prompt assembly**, before dispatch; returned blocks are appended to the system message. That pre-generation timing is the whole point — on the lorebook path retrieval is scored against the turn that already happened.

What the contributor receives (`capability-prompt-context.service.ts`):

```ts
{ chatId, chatMeta, mode, targetCharacterIds?, personaId? }
// returns: string | { text?, provides? } | null
```

### Three things that will cost you an evening

1. **`registerService` fails SILENTLY.** `registerService(key, service)` accepts *any* string, so registering `"<id>:prompt-context"` — the convention on the unmerged `feat/memory-injection-consumer` branch — is accepted, **never consulted**, and the package still reports `active/ready`. No error, no warning. The symptom is "she misses cold", indistinguishable from a retrieval bug. Only `registerPromptContext(fn)` is consulted. **Assert on first invocation**, and treat "registered but never invoked after N turns" as a fault. (A missing `prompt-context` permission *does* throw loudly — that half is safe.)

2. **There are no `messages`.** The request carries no prompt content, so there is no outgoing user message to score against — `latestUserText(messages)` is impossible here. The call site *has* them (`injectCapabilityContexts` takes `messages: typeof finalMessages`) and does not pass them. Workaround: fetch the latest user message by `chatId` over the Engine REST API. **Its precondition is unproven** — if the message is not committed when the contributor fires you get turn N-1, silently, and N-1 is topically adjacent to N so it produces plausible rows and looks like it works. Verify with `scripts/preturn-canary.mjs`, which grades on an exact nonce, never on "a message came back".

3. **The deadline is `CONTRIBUTOR_TIMEOUT_MS = 2_000`**, not the branch's 300 s. `loadContext` is ~390 ms post-hdq1 and fits with room; at the pre-hdq1 ~1,279 ms it would have fit thinly and a larger store would have blown it. hdq1 is a prerequisite for this path.

### Scoring arrival without a receipt

The shipped API has no acceptance callback, so "assembled but never shipped" and "shipped and she answered over it" have identical symptoms — and every recall test is unscoreable until they can be told apart. **The Engine already persists the evidence:** the assistant message's `extra.cachedPrompt` is the array of dispatched messages (system message measured at 58 KB). Search it for the block verbatim:

- **present** → it shipped; a wrong answer is *precedence*
- **absent** → it never shipped; that is *arrival*

**Retention is a rolling window of the last two assistant messages per chat** (measured across six chats of 22–233 messages; older ones are pruned). So read it within two turns — which is when `/api/prompt-accepted` would fire anyway. Post-hoc and pruned, so it cannot bound a live turn the way a real receipt would, but it makes the tests scoreable.

### The upstream ask, if we want the real thing

Pass the assembled `messages` (or just the outgoing user text) to `CapabilityPromptContextRequest` — a one-line change at a call site that already holds them. A receipt/acceptance callback is the larger change and may be unnecessary given `cachedPrompt`. Both are implemented on `feat/memory-injection-consumer`, which is best read as **the reference implementation for that ask, not something to merge locally** — the Engine we ship against is the released build, not our branch.

### State of play

`marinara-extender` v1.0.0 already exists (manifest, `agents.json`, `server.mjs`) in the *dev checkout's* `dev-data`, where it fired exactly once on install day. It registers via `registerService` and so **would never be invoked** on the shipped Engine. Porting it to `registerPromptContext` is Extender-side work. No shipped package uses `registerPromptContext` at all — we would be its first consumer on this install.

## Landed: how pre-turn injection actually works (2026-08-30)

771t is **fixed and user-confirmed** — cold recall on the first ask, in Conversation. The path:

```
Engine assembles prompt
  -> calls our contributor (api.registerPromptContext; every chat, no agent check)
  -> package reports { chatId, characterId, mode, agentActive }   [thin broker only]
  -> sidecar POST /api/pre-turn
       decideInjection(mode, agentActive)          injection-policy.ts
       latestUserMessage(chatId)                   engine-client.ts (request carries no messages)
       loadContext(recentText = that message)      ~390ms post-hdq1
  -> block returned, appended to the system message before dispatch
```

**Four things had to be true at once, and each looked like the bug on its own:**

1. Register via `registerPromptContext`, never `registerService` — the latter is accepted, never consulted, and still reports `active/ready`.
2. Resolve the outgoing message ourselves; the request carries no prompt content. The sidecar logs which message id it scored against — that line is the proof it ranked turn N and not N-1.
3. Gate per mode, not on `activeAgentIds` alone — Conversation has no agent picker, so that gate makes the feature unreachable there.
4. **Only one path may publish.** See below; this is the one that will bite again.

### Never run both memory paths at once

The lorebook entries and the contributor carry the SAME memory. Both are large (36KB vs 29KB when measured) and they compete for one prompt budget: the dispatched system message came back at 20,854 chars — smaller than either contribution alone — with the instructions kept and every memory row trimmed away. The character then answers honestly that she has nothing, two seconds after the loader selected the exact canon rows.

`MARINARA_EXTENDER_LOREBOOK_SYNC=0` stops the lorebook WRITE while capture keeps running. Default on, because it is the only path without the package installed. **Disabling the writer is not enough** — existing entries stay `enabled+constant` and keep consuming budget until they are disabled too.

The lorebook copy is also the one-turn-late one by construction (written after the turn completes), so leaving it alongside a working contributor spends the budget to carry a stale answer.

### Diagnosing a miss

The stages are individually observable, so do not guess which one failed:

| symptom | where to look |
|---|---|
| contributor never runs | no `[ME:pre-turn]` in sidecar log; Engine log for `contributor INVOKED`; the 10-minute silence warning |
| ranked on the wrong turn | `[ME:pre-turn] … scored against msg:<id>: "<text>"` — it names the message |
| built but never shipped | `extra.cachedPrompt` on the assistant message — the dispatched prompt, kept for the last 2 per chat |
| shipped and ignored | present in `cachedPrompt` but answered over — that is precedence, not arrival |

`cachedPrompt` is what separates arrival from precedence without an acceptance receipt. It is post-hoc and pruned after two turns, so read it within two turns of the generation.
