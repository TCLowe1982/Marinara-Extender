# Marinara Extender: Architecture

*Condensed from the live source in `memory-extender/src/`. When a detail matters, open the cited file — the code is authoritative; this is a map.*

> ## ⚠️ POST-EXTENSION ARCHITECTURE — poller + capability package (epic `hq7` RETIRED)
>
> **Marinara Engine v2.3.4 removed client extensions entirely** (no compat mode; retained extension records and `extension-storage:*` are permanently erased on first 2.3.4 startup). The loader + `marinara-extender.js` bridge described below **no longer works on current Engine** — `references/extension.md` documents a dead surface, kept only until slice 8 replaces it.
>
> **The replacement is TWO paths, and the inference proxy is NOT one of them any more.** The proxy line (epic `hq7`, slices 1–8) was **retired 2026-08-30**; see the retirement note below before proposing anything that routes chat through the sidecar.
>
> 1. **Poller (provider-agnostic).** The sidecar talks to the engine's REST API server-to-server from localhost: it detects finished turns, ingests them, and writes the memory block back through the **lorebook API** — exactly what the extension did, minus the browser. **Built and live-verified end-to-end on the `poller-fallback` branch — NOT merged, and running as an explicit TEMP FIX** (2026-07-23) while the maintainer waits to see where Marinara's official direction lands (the dev signalled an extension re-enable *and* a first-party memory agent). Do not merge to master or extend it without a fresh decision; it exists to stop the bleed, not to be the permanent architecture.
>
> | Module | Slice | Does |
> |---|---|---|
> | `engine-client.ts` | `7nx` ✅ | Transport: engine base URL, the static CSRF header, optional Basic auth, actionable CSRF/401/unreachable errors, typed wrappers. Endpoints **ported from the working extension**, not inferred from engine source. |
> | `poller.ts` | `23i` ✅ | Detection, **two detectors sharing one watermark**. *Pull:* polls `GET /api/chats` and compares `lastMessageAt`. *Push:* `handleTurnNotification()` consumes the engine's turn-complete hook. Both run `buildTurns` behind a per-chat lock (`withChatLock`) against `poller-state.yaml`, so whichever notices a turn first, the other stands down. |
> | `lorebook-writer.ts` | `lxp` ✅ | Write-back: forced 16384 budget, nuke-and-recreate two constant entries, unlock-before-delete, serialized per character. |
> | `turn-bridge.ts` | — | Glue: detected turn → `POST /api/process-turn` (the sidecar's own endpoint) → write the returned `memoryBlock` to the lorebook. |
>
> **Enable with `MARINARA_EXTENDER_POLLER=1`** (`_POLLER_INTERVAL_MS`, default 5000). **Off by default in code** — it nuke-and-recreates real lorebooks, and if the extension is ever re-enabled both paths would write the same entries.
>
> **Push detector — `MARINARA_EXTENDER_TURN_HOOK=1`** (`4kbt`, 2026-07-30). Serves `POST /api/engine/turn-complete`; the engine calls it when a turn finishes. Requires the engine side too: `TURN_NOTIFY_URL=http://127.0.0.1:3001/api/engine/turn-complete`, which needs the `feat/turn-complete-notification` engine branch (see `hkdq`) — **stock Marinara does not send this**. Independent of the poller flag: either alone, or both (the lock and shared watermark make the overlap a no-op). The endpoint is always registered but inert without the flag, and it **answers immediately and ingests in the background** because the engine sends it on the generation path under a 2s timeout.
>
> The two detectors differ deliberately on first sighting: an unseen chat is **baselined** by the poller (a sweep sees every chat's whole history at once) but **ingested** by the hook (a notification is evidence *that* turn just finished, so dropping it loses a real turn). The push path also trusts the notification's `assistantMessageId` rather than re-deriving the turn through `extractNewTurns` — direct evidence beats inference — and **declines** a notification whose message is not in the fetched tail rather than blaming the newest turn.
>
> Live verification: `npm run smoke:turn-hook` (read-only, scratch data dir, no `onTurn`) — 8/8 against both a dev engine and the maintainer's 94-chat install.
>
> **Live status (2026-07-23):** enabled in the maintainer's `.env` and running against their install (91 chats baselined, 0 errors). Detection latency ≈ one poll interval (5s). Data backed up first to `marinara-extender-backups/pre-poller-<stamp>/`. **Revert path when Marinara's fix lands:** remove the `MARINARA_EXTENDER_POLLER` line from `.env`, kill the sidecar, the `start.ps1` watchdog relaunches it without the poller, and the extension resumes as primary. A one-off outage-gap backfill (`scripts/backfill-gap-tags.ts`) recovered the `[remember:]`/`[bookmark:]` tags emitted while the extension was dark — reusable pattern via `/api/ingest-commands` (remembers dedup; bookmarks do NOT, so gate them on topic-absence).
>
> **Engine version pin — v2.4.3 (`34442e26d`), updated 2026-08-20 from v2.4.0.** The maintainer's Engine is deliberately **pinned to a tag on a detached HEAD**, not tracking `main`, and the AI_Startup stack launches it `start.bat --skip-update` so a boot can never fast-forward it. To move it, `git checkout --detach vX.Y.Z` and let `start.bat` notice the version/commit mismatch and rebuild — **never** lift the freeze by passing `-EngineUpdate`, which fast-forwards to whatever `main` is (that was 1,395 commits at the time of the 2.4.3 bump). **The poller contract survived 2.4.0→2.4.3 unchanged**, verified both by source diff and by live HTTP: `lastMessageAt`, per-message `characterId`, `activeSwipeIndex`, `swipeCount`, unbounded-vs-`?limit=N` semantics and the lorebook entry vocabulary are all intact; the lorebook schema gained only two nullable columns. The one rewrite is in our favour — `listMessagesPaginated` now does a DB-level `ORDER BY DESC` + `LIMIT` + `.reverse()` instead of reading the whole chat and slicing the tail, and the poller passes a limit on every tick. It also now throws `InvalidMessageCursorError` on a bad `before` cursor, which cannot reach us because production never sends one. **Before any Engine bump, back up `packages/server/data/storage/`** (~692 MB; that store already carries a `corrupted-2026-06-10/` folder) — the migrations run forward and rolling back after them is not clean.
>
> 2. **Capability package (`registerPromptContext`, capability API 1.8 / Engine 2.4.3).** The sidecar contributes memory *while the Engine assembles the prompt* — no proxy, no lorebook artifact, no one-turn lag. This is the injection path that shipped, and it is what `771t` closed on. ~~Inference proxy~~ — **retired 2026-08-30**, see the retirement note below.
>
> **⛔ Historical, and the reason a proxy could never have been the only path: it structurally cannot serve the three CLI-login providers** — `claude_subscription`, `openai_chatgpt`, `grok_subscription` (`LOCAL_AUTH_PROVIDERS`). For those the engine drives a vendor SDK **in-process** off a local CLI login: `claude_subscription` uses `@anthropic-ai/claude-agent-sdk` with credentials the Claude Code CLI stored. There is no base URL and no API key field to redirect, and `ANTHROPIC_BASE_URL` appears nowhere in the engine repo. This is inherent, not a gap to patch. **If a user is on Claude/ChatGPT/Grok Subscription, the poller is the only option.**
>
> **What makes the poller possible:** engine CSRF is a **static header**, not a per-session token — `CSRF_HEADER = "x-marinara-csrf"`, `CSRF_HEADER_VALUE = "1"` (`packages/shared/src/constants/security.ts`) — and loopback origins are auto-trusted. So a non-browser client on 127.0.0.1 can both read and mutate the engine API.
>
> **Honest trade-off:** the lorebook mechanism **survives** on the poller path, so `e87` (over-budget silent drop) and `s19` (stale cache) are **not** killed — only the proxy path would have done that. (`axu`, duplicate lorebooks, *is* fixed: the write-back serializes the whole ensure+write cycle per character, where the extension serialized only the entry write.) Injection also stays one turn behind (written after turn N, injected at N+1), exactly as the extension always behaved.
>
> **Poller design notes that cost real debugging to learn:**
>
> - Detection polls `lastMessageAt` rather than `fs.watch`-ing the engine's data dir. One cheap call says which chats moved; measured at **10–13ms per quiet tick over a real 91-chat library**. `fs.watch` would be lower-latency but binds to internal on-disk layout, and its atomic rename pattern makes events noisy.
> - `GET /chats/:id/messages?limit=N` returns the **newest N ascending**; **unbounded it returns the entire history** (195 messages on a real chat), so the limit is not optional.
> - Messages carry their **own `characterId`**, so group scenes name the actual speaker per message.
> - **Regeneration is a swipe** — `activeSwipeIndex` changes on the *same* message id; the engine re-rolls in place rather than appending. Requires the field on *both* sides before claiming a regeneration, or every unchanged message looks re-rolled and the turn is re-ingested every tick.
> - **⛔ POLLING CANNOT DETECT A REGENERATION AT ALL** (`4kbt`, measured 2026-07-30). A swipe rewrites the message in place and moves **nothing** the poll gate looks at: the message's `createdAt` and the chat's `lastMessageAt`/`updatedAt` are all byte-identical before and after (verified across two consecutive swipes, `activeSwipeIndex` 0 → 2, `swipeCount` → 3, content changed each time). So `selectChangedChats` never emits the chat, and `extractNewTurns`' swipe branch — which is itself correct — is **unreachable on the poll path**. Reading `extractNewTurns` alone gives the wrong answer about whether re-rolls are handled; you have to check what can reach it. The damage is worse than a missed turn: the user re-rolls *because* they rejected that text, and the sidecar goes on remembering the rejected version. **Only the push detector sees swipes.**
> - **Detection is only half of it** (`s2lw`, fixed 2026-08-04). `4kbt` made the sidecar *know* a re-roll happened; `regenerated` then reached a `console.info` and stopped. So a swipe deposited the new reply's facts **beside** the thrown-away reply's and both surfaced as recall. The response side now retires everything derived from the losing swipe.
> - **The identity of a moment is the PAIR `(sourceMessageId, sourceSwipeIndex)`, never the message id alone.** A re-roll keeps the id and moves only the swipe, so an id-only match declares the re-rolled reply "the same moment" as the one the user threw away — the **kept** text is skipped as a duplicate while the **discarded** text stays, logged as an ordinary `skipped duplicate`. The pair mirrors `ChatWatermark` (`lastMessageId` + `lastSwipeIndex`), so there is one notion of identity in the codebase, not two.
> - **`turnStart` is useless on the live path** (`06pq`, fixed 2026-08-04). The poller reads a 10-message tail and has no absolute position, so it sent no `turnNumber` and `process-turn` defaulted it to `0` — measured: 462 rows at `turnStart=0`, 99 at `-1`, against a normal spread from the import path. That made dedup's same-moment proof (`|Δ turnStart| <= window`) **vacuously true**, inverting a guard whose own comment records why it exists (37% of Mari's vulnerability beats collapsed on byte-identical boilerplate). `sameMoment` now prefers the pair and falls back to chat+turn for import-path and legacy rows.
> - **Retirement is a third reason: `discardedAt`.** Not `deletedAt` (the user deleted nothing, and it would appear in *Recently deleted* attributing an act to them they never performed) and not `supersededBy` (documented as "id of the replacing entry" — a re-roll is *n*-in/*m*-out across scopes and **often replaces with nothing**, since the new text need not trip the same thresholds; that empty case is the common one). Cold, full fidelity, excluded from cold recall.
> - **Retire BEFORE ingesting the new swipe, and await it.** Otherwise incoming beats are ranked against a ledger that still holds the thrown-away version and dedup can skip a new beat as a duplicate of a memory on its way out — the outcome would depend on which ran first.
> - **Entangled discards go to the held review lane** (`a90l`, `appendHeld`). Retirement settles a clean case; it cannot unwind what the fact already caused. Signals: recited (strongest — the character *said* it), retrieved, on a thread, or **orphaning** an older fact it had superseded (retire it and the older fact is left dead in cold behind a retired entry). Not gated by `MARINARA_EXTENDER_RECONCILE` — that flag gates the curator's *agent spend*; this lane is a human surface and spends nothing.
> - **The lane has a UI** (`4z0h`), at `/memory` as its **own sidebar entry** ("Needs you") — deliberately *not* under *Recently deleted*, which would reassert the conflation `discardedAt` exists to prevent. Hidden entirely when empty; an always-visible `0` trains the eye to skip the row. `GET /api/held` (filtered to `discarded-swipe`; the same file also carries the curator's withheld verdicts, a different lane with different actions) and `POST /api/held/resolve` (`dismiss` | `restore-entry` | `restore-displaced`), which checks the record is outstanding **first**, then restores, then stamps — a failed restore leaves it in the lane, and a stale tab gets "already settled" instead of a true-but-irrelevant error.
> - **Three retirement reasons, three guarded restores.** `restoreDiscardedEntry` → `discardedAt`, `restoreDeletedEntry` → `deletedAt`, `restoreSupersededEntry` → `supersededBy`. Widening any one guard would let it undo a retirement another mechanism performed for a different cause; tested in both directions.
> - `held.jsonl` gained ids and a `resolvedAt` stamp. Records are **stamped, not deleted** — the lane holds what is outstanding, but the file is the only evidence the withholding happened. `readHeld` skips torn lines rather than losing the lane to one truncated write.
> - **Mockup first**, against invented entries: `memory-extender/docs/mockups/held-review.html`. That is what surfaced the two missing pieces above (no discarded-restore, no removal path) before the build started, rather than halfway through it.
> - **Two traps in `ui.ts`:** `.why` is already a *pill modifier*, so the lane's block styles are `.hl-why`; and the whole view lives inside a `String.raw` template, where **a backtick in a comment terminates the page**.
> - **Known limit, logged not hidden:** a turn's entries can land in *any* character's ledger (tier-2 routes by analyzed subject) and there is no reverse index from message id to scope, so retirement covers the session character and chat scopes only.
> - **A thread label must name a SCENE, never a person** (`oknn`, fixed 2026-08-04). `turn-bridge` passes the **chat's name** as `sceneTitle`, and the analyzer used to be told to *prefer the scene title* as a new thread's label. Marinara defaults a chat to its character's name, so every beat in a default-named chat landed on a "thread" that was really just the chat: measured, `"Dr. Mari Zielińska"` held 66% of one chat's beats, `"Dr Z"` 79% of another's, and several chats had a single thread holding **100%**. The same prompt also said "never name the participants — the cast is not the story", so it contradicted itself and the later, more specific line won.
> - The tell that it was the *chat title* and not a bad model: `"proxy integration fix"` and `"fable extender development"` look like healthy event-shaped threads and are **also just chat titles**, descriptively named. Label quality tracked how the user named the conversation, not what the analyzer found.
> - Fixed in three places — `sceneTitle` is suppressed before it reaches the analyzer when it names a person, the prompt says "this names the SCENE, not a person", and the mint **refuses** rather than warning (`looksCastList` fired all along; it warned to a console and minted anyway).
> - `titleNamesAPerson()` is the discriminator, and **`looksCastList` alone is not enough**: it drops tokens under 3 chars, so `"Dr Z"` reduces to an empty token list and returns `false` — the exact label that caused the bug slipped through the guard written to catch it. Hence the honorific+initial test.
> - **Over-suppression is the real risk here, not under-suppression.** Whole-label similarity only: an early version used `tokenContainment`, which matches when a name's tokens appear *anywhere*, and killed `"Priya confesses the trial was rigged"` for containing "Priya". Naming a participant is fine; being nothing *but* a participant is not. Live registry: 7 of 210 refused (929 beats), and `"RP: Breakfest with Priya"` is correctly **kept**.
> - A never-seen chat must be **baselined, not ingested**, or a fresh install replays every chat's history at once.
> - The bridge calls the sidecar's own `/api/process-turn` over loopback rather than importing it: that handler is a large inline route with fire-and-forget tiers, and going through it reuses the exact path the extension used instead of a parallel implementation that can drift.
>
> ### 🪦 The inference proxy is RETIRED (epic `hq7`, closed 2026-08-30)
>
> **Do not revive this without re-reading why it died.** The plan was to point Marinara at a sidecar-hosted proxy so every chat generation flowed through us, restoring both capabilities lost when v2.3.4 removed client extensions. Slice 1 was built and green (`proxy.ts`, 26 tests, two wire formats); slices 2–8 were never built. All are closed.
>
> **What replaced each half — both already ship:**
>
> - **Injection → the capability package's `registerPromptContext`** (capability API 1.8, Engine 2.4.3). Contributes memory *while the prompt is assembled*, so recall is scored against the message being answered rather than the previous turn. This is what `olea` said to ask the Engine for; it arrived, and `771t` closed on it. Strictly better than splicing a system message in transit.
> - **Capture → the poller.** Watermark-based rather than a live response tee, which is the one real capability given up.
>
> **Why it was retired rather than finished — the costs are structural:**
>
> 1. It puts the memory sidecar in the **critical path of all inference**. Today a dead sidecar degrades memory and the turn proceeds; that graceful degradation is deliberate in the capability broker. With the proxy, **dead sidecar = dead chat**.
> 2. **`073`: the sidecar dies repeatedly and silently** (~30 deaths in one log). Every one would have been a broken conversation. This doc already said so, in the section this note replaces: *"A dead sidecar means no chat at all, not degraded memory — which is why `073` was promoted to P0."* That was written as a caution; it reads better as a verdict.
> 3. It carries the user's **provider credentials**.
> 4. It sat **outside `/api/`, exempt from the CSRF guard** — necessary, since Marinara's provider client cannot send `x-me-csrf`, but real surface.
> 5. It owned **two wire formats forever** and had to track provider drift in both.
>
> **Findings worth keeping, still true and dearly bought:**
>
> - **Marinara's native Anthropic connection has a user-editable `baseUrl`** — verified in `packages/shared/src/constants/providers.ts`: only `LOCAL_AUTH_PROVIDERS` (`openai_chatgpt` / `claude_subscription` / `grok_subscription`) hide it; `baseUrl` is a generic per-connection field in `connection.schema.ts`. This is why no OpenAI→Anthropic translation layer was ever needed. **If anything ever needs to sit between Marinara and a provider again, start here.**
> - **Anthropic takes `system` as a top-level request parameter**, not a `role: "system"` message. Relevant to any future injection work on that format.
> - On **Opus 4.7/4.8 and Fable 5** the Anthropic API rejects `temperature`/`top_p`/`top_k` and last-assistant-turn prefill with a **400**. Roleplay frontends commonly send both. Upstream constraint, not a proxy bug.
> - Marinara's **Agents / Images / Videos** connections must stay **direct**. Moot now, but it is why `kxk` exists: injecting memory into a tracker prompt and ingesting a summary call as a "turn" poisons the store.
>
> **Code removed** (`6ecv`): `proxy.ts`, `proxy.integration.test.ts`, the `registerProxyRoutes` wiring, and `proxyUpstream()`/`anthropicUpstream()` in `llm-config.ts`. Git history preserves them.
>
> **⚠️ SURVIVOR, DO NOT DELETE BY ASSOCIATION:** `POST /v1/chat/completions` in `index.ts` is the **Rewrite Assistant relay** — a different route from the retired `/proxy/v1/chat/completions`. It deliberately picks the model and key for its caller and never sat in the chat path. `GET/POST /api/config` in `setup.ts` likewise stays. Neither has automated coverage; that is `n4n`, still open.

## The two components

Marinara Extender is a **sidecar + a thin extension**:

1. **Memory Extender sidecar** — a local **Fastify** HTTP server (`index.ts`) bound to **`127.0.0.1:3001`** (`MARINARA_EXTENDER_PORT`). It owns all logic and stores memory as **plain YAML files on disk**. It exposes a REST API the extension calls, plus **two distinct OpenAI-compatible endpoints that must not be confused**:
   - **`/v1/chat/completions`** — the **Rewrite Assistant relay** (`nqy`, `handleChatCompletions` in `index.ts`). Deliberately *picks* the model and key for its caller: local model first, external API as fallback. Rebuilds the request body, so it drops unknown parameters and forces `stream: false`. For the sidecar's own analysis-grade model, not for chat.
   - ~~**`/proxy/v1/chat/completions`** — the engine-facing proxy~~ **REMOVED 2026-08-30** (`6ecv`, epic `hq7` retired). `proxy.ts` and its routes are gone from the tree. Only the Rewrite Assistant relay above remains, and it is a *different route with the opposite contract* — do not conflate them.
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

**This changes with `hq7`.** Under the *extension* model the user's normal chat generation was never proxied — it went straight from Marinara to their provider, and the sidecar's local model was only for *analysis* (extraction, classification, rendering). Under the *proxy* model chat generation **does** flow through the sidecar (`/proxy/v1/chat/completions`) on its way to the user's provider. The analysis/chat split itself is unchanged: the sidecar still uses its own small local model for analysis and merely *forwards* chat to whatever provider the user configured in Marinara — it never answers a chat turn itself.

## Security & process

- **Binds loopback only.** CORS (`cors.ts`) allows responses to be *read* only by loopback origins or an explicitly configured `MARINARA_EXTENDER_ALLOWED_ORIGIN`.
- **CSRF** (`csrf.ts`) — a per-process token is required for non-GET `/api/*` from browsers; non-browser clients (no `Origin`) pass through. The token is minted at startup, so a sidecar restart invalidates old tokens and the extension refreshes on a 403.
- **LLM config** (`llm-config.ts`) — local OpenAI-compatible endpoint primary (Ollama `dolphin3:8b` default); external API (`_API_KEY`, `_DIGEST_MODEL` = `gpt-4o-mini`) is an opt-in fallback. Set `_LOCAL_URL` empty to go external-only.

## Storage (`storage.ts`, `paths.ts`)

Under `memory-extender/data/` (or `MARINARA_EXTENDER_DATA`). Per scope: an **`index.json`** (fast-scan metadata) plus the full entry files, which stay **YAML**, in **lane-named subdirs**. The split is deliberate — see *Index format* below. Key files:

- `global/`, `characters/{identityKey}/`, `chats/{chatId}/` — the three scopes. Each holds `index.json` (hot), `index.cold.json` (cold archive), `bookmarks.yaml`, and entry files under lane subdirs **`threads/` / `user-topics/` / `char-topics/`** (one per lane; *not* a flat `entries/`).

#### Index format — JSON, and only the index (hdq1)

The index is JSON; **entry files are still YAML and are not affected**. Measured on the live store, one 3.86 MB / 8,906-row character index:

| | YAML | JSON |
|---|---|---|
| parse | 890 ms | **10 ms** |
| stringify | 348 ms | 12 ms |

Parse was 890 ms of `loadContext`'s ~1,279 ms — the format cost more than every piece of work the loader exists to do, combined, per load per scope. Stringify is paid inside a serialized write lock on every retrieval count and tier change. Nobody hand-edits a 9,000-row index, so its readability bought nothing; entry files hold the memory prose, are read and edited by hand, and stay YAML.

When touching this:
- `indexPath()` / `coldIndexPath()` always return the **JSON** name so they stay stable `serializedWrite` lock keys. `legacyIndexPath()` / `legacyColdIndexPath()` are read-only fallbacks.
- `readIndexFile()` tries JSON, falls back to legacy YAML. On **corrupt** JSON it returns null and does **not** fall through — a corrupt index and an absent one must stay distinguishable, or `upsertIndexEntry`'s guard rebuilds the whole index from one entry.
- Use `indexFileExists()` (both names), never `exists(indexPath())`, in any guard.
- `writeIndexFile()` writes JSON then renames a superseded YAML to `.superseded`.
- Scripts must read indexes via `scripts/read-index.mjs`. Opening `index.yaml` by name now returns **zero rows silently** — an audit that answers "no problems" because it cannot find the data.
- Migration: `scripts/migrate-index-json.mjs` (dry run by default, `--write` to convert).
- Character scope also holds `beats.yaml` (+ `beats/`), `arcs.yaml`, `arc-memberships.yaml`.
- Cross-cutting: `threads/registry.yaml`, `identity-map.yaml` (ephemeral card IDs → stable identity keys), `holding-pool.yaml` (orphan beats awaiting speaker resolution), `supersession-candidates.yaml`, `reconcile-queue.yaml`.

**All writes are atomic** — temp file + fsync + rename, with per-path serialization to prevent read-modify-write races and torn files. Never write these YAMLs directly; use the `storage.ts` helpers.

## The turn lifecycle — `POST /api/process-turn` (`api.ts`)

The orchestration site. End-to-end when a turn arrives:

1. **Resolve identity** — `resolveIdentity(cardId, name)` → stable `identityKey` (`identity.ts`); ephemeral Marinara card IDs map to a durable slug via `identity-map.yaml`.
2. **Extract commands** — `extractRememberTags` (`writer.ts`) pulls `[remember: …]` / `<remember>…</remember>` into entries **synchronously** (blocks the response; deduped via Jaccard against the target lane). `[bookmark:]` tags are parsed too.
3. **Soft clock** *(gated, off by default — `MARINARA_EXTENDER_TIMESENSE=1`)* — infers narrative time-of-day from AI text and presence from the user message; attaches `timeContext` to entries. Not wall-clock.
4. **Assemble the memory block** — `loadContext` (`loader.ts`): load all three scope indexes in parallel → drop `done` / superseded / **`provenance: "unplayed"`** rows → rank entries per scope (relevance → recency → proven value/score → lane priority) under per-scope token budgets (chat 4000 / character 2000 / global 1000) → on a topical miss, surface one best **cold** entry per scope (rehydrates it; unplayed skipped here too) → load selected entry files → roll bookmarks by weight → render recaps → assemble `<memory>` block, prepend instructions. Credit-stamping (lastAccessed/retrievalCount) stays off the hot path, but is no longer unjoinable — `awaitPendingCredit()` exists for teardown/shutdown, and a test that deletes its data dir must await it or race an in-flight index write.

   **Relevance is accumulated evidence, not a fraction of the summary** (`MarinaraExtender-vrw`, fixed 2026-07-29). Each distinct meaningful term found in `recentText` contributes weight; the score saturates at `1 - exp(-0.357 × evidence)`, so one term ≈ 0.30, two ≈ 0.51, three ≈ 0.66. A term capitalised **mid-summary** is treated as a name and weighted **2.5×**, so one matched name (≈0.59) beats two matched common words (≈0.51).

   **The scoring vocabulary lives in `relevance.ts`, not the loader** (`tp5`, 2026-08-04) — because it now runs on **two sides of a persistence boundary**: `harvestBodyTerms` extracts names when an entry is written, `relevanceScore` compares them when it is ranked. If the two ever tokenised differently the stored terms would silently never match, and every test exercising one side alone would still pass. Anything touching stopwords, tokenisation or name detection must change in that one module. Body terms score at `BODY_TERM_WEIGHT` (1.0) — real evidence, deliberately below a summary name, so a passing mention becomes findable without outranking the entry a name is actually about. A term present in **both** is counted **once at name weight**, which is how the sentence-case blind spot gets repaired rather than double-counted.

   Why it matters, because the old form looks harmless: it was `hit / words.size`, which divided by summary length and therefore punished a memory for its own detail. On the live stores `wants to remember past crimes` (0.250) outranked every substantive record of a named person (0.083), and an entry recording that the author had *forgotten* a name outranked the entry containing it. Two traps found the hard way — (a) removing the divisor **alone** regressed 3 of 5 measured cues, because thousands of rows then tie at one match and recency decides; the name weight is what restores discrimination. (b) corpus IDF is **not** a valid substitute: in one store `remember` (df=5) is rarer than `erica` (df=17), so IDF would have boosted the noise term. Weighting must come from a general-English prior or an explicit entity field, never corpus statistics.

   `RELEVANCE_CREDIT_THRESHOLD` is **0.29** — deliberately just under the one-ordinary-match score (0.2999), so a single genuine topical hit earns summon credit and a zero-match recency rider never does. It is a threshold *on* the score: **change the scorer and you must recalibrate it.**
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

- **Memory browser (UI)** — `GET /` and `GET /memory` serve a self-contained page (no CDN, no build step, no external fonts). It is the user's only way to read and manage their own memories now that the browser extension is dead, and it works with no package installed and whatever Engine version is present. Read + edit/delete/restore/purge over the entry API below; per-memory **Why?** renders `sph8` receipt verdicts in plain language. Mutations carry `x-me-csrf` and retry once on a 403, because the token is per-process and a tab outlives a sidecar restart.
  **A served page nothing links to does not exist** (`c2wd`). The browser shipped 2026-08-04 and was **invisible for six days** — it answered on both routes the whole time and the only `href="/memory"` in the repo was its own header linking to itself, so the sole access path was typing the address. The fix is four links (startup banner, `/setup` button, launcher `[M]`, page header nav), and the guard is `ui-access-point.test.ts`, which pins **reachability, not markup**. That shape matters: the failure was *silent* — every route returned 200 and every test passed — so route coverage can never catch it and only an assertion on the link can.
- **Entries** — `GET/POST /api/entries`, `GET/PATCH/DELETE /api/entries/:id`, `/restore`, `/recite`, `GET /api/deleted`. `DELETE` is **soft** by default (recoverable from cold); `?purge=true` destroys, and is **cold-only** — it 404s on a live entry, so one action can never destroy a memory.
- **Bookmarks** — `GET /api/bookmarks`, `PATCH/DELETE /api/bookmarks/:id`.
- **Memory core** — `POST /api/process-turn`, `GET /api/memory-block`, `POST /api/ingest-commands`.
- **Import/analysis** — `POST /api/digest|snapshot|analyze-beats|estimate-beats`, `GET /api/beats`.
- **Maintenance** — `POST /api/cleanup|promote-all`.
- **Reconcile** *(opt-in `MARINARA_EXTENDER_RECONCILE`)* — `GET /api/reconcile-queue`, `POST /api/reconcile-apply|reconcile-hold`.
- **Threads/arcs/identity/aliases/holding-pool** — `GET /api/threads|arcs|identity|aliases|pending-speakers`, plus mutators.
- **Config/info** — `GET/POST /api/config`, `GET /api/scopes`, `GET /api/health`, `GET /api/csrf-token`.
- **Setup/extension** — `GET /setup`, `GET /loader.js`, `GET /marinara-extender.js`.
- **Rewrite Assistant relay (CSRF-exempt)** — `POST /v1/chat/completions`, `POST /chat/completions`. (The engine-facing proxy routes `/proxy/v1/*` and `/anthropic/v1/*` were **removed** with epic `hq7`.)

## Known sharp edges (from the source — candidates for beads issues)

- "Summoned" credit uses **lexical relevance only** (`loader.ts`); semantic pulls aren't counted toward promotion.
- Thread-sibling relevance lift (~0.75 factor) is **not documented as empirically tuned**.
- ~~**Retrieval scores `summary` only — never `content`**~~ — **FIXED 2026-08-04 (`tp5`).** Ranking now also matches `IndexEntry.bodyTerms`. The body itself is still never read during ranking, and deliberately so: the loader ranks over the index precisely to avoid opening thousands of entry files per turn. What moved onto the row is the *searchable residue* — the names a body mentions, harvested at write time by `harvestBodyTerms` and compared at read time by `relevanceScore`, both in `relevance.ts`. Reachability on the measured corpus went 43% → 84%. **Two residual traps:** a store that predates the fix needs `scripts/backfill-body-terms.mjs` (missing `bodyTerms` means *unharvested*, not *no names*), and a mention that is never capitalised stays invisible — that is `76aw`, not a bigger term list.
- **A summary's leading token is scored as sentence case, not a name** — and 20% of character summaries open on one, overwhelmingly the subject's own name ("Lara has borderline personality disorder"). So one character memory in five scored its own subject as an ordinary word. `tp5` mitigates this where the body confirms the name (the term is kept at harvest and scored once at name weight), but an entry whose body never repeats its subject is still affected. Worth knowing before concluding a ranking is mis-tuned.
- **No coreference between an entity's names** (`MarinaraExtender-76aw`, open). `Erica` and `Cathmore` are unrelated tokens, so a surname cue reaches roughly half the material a forename cue does. `aliases.ts` already implements the needed matching (`normalizeLabel`, `jaroWinkler`, `tokenContainment`) but it is a **speaker-routing** table — `loader.ts` imports it **zero** times, and `data/aliases.yaml` holds only characters who *speak*, so a mentioned-but-silent person never gets a record. Also needs **which-world tags**: one name can span two entities (TC-the-user b.1982 vs character Thomas b.~2000), and resolving a date against the wrong one is what produced the chimera below.
- **The all-caps wart** in the name heuristic: `summaryTerms` treats any capitalised mid-summary token as a name, so ALL-CAPS emphasis collects 2.5× weight. Harmless today and loosely correlates with importance, but it should die when a real entity field lands.
- **Chimera fusion** (`MarinaraExtender-hhdr`, open) — the digest welds individually **true** fragments into one **false** composite; only the joins are invented. It is invisible to atom-level fact-checking (every part verifies) and to human review (it reads fluent — one lived six weeks while the character *joked* about its impossible date and filed it as flavour). Detection must test **relations** — who did what, to whom, starting when. Repair rule: **reattach before delete** — a wrong-looking detail in a chimera is usually a true detail wired to the wrong node. A first repair attempt struck a date as fabricated when the date was true, destroying canon.
- **A blocking startup diagnostic can starve the async one beside it.** `logIndexHealth()` is a synchronous `YAML.parse`/`JSON.parse` over every index in the store; the embeddings probe next to it is a `fetch` with an `AbortSignal` deadline. Fired in the wrong order, the sync scan blocks the event loop past that deadline and the timer wins the race against the socket callback — the banner reported `Ollama is not running` while Ollama answered in 5 ms and every semantic feature ran normally. Fixed by ordering (`d795f46`), and `index.ts` carries a comment saying to keep new blocking startup work **above** the probe. The general lesson is broader than the one bug: **any short `AbortSignal.timeout` is only as good as the promise that nothing blocks the loop between the request and its response.** `embeddingsStatus(timeoutMs)` is parameterised because its two callers differ — `/api/health` keeps 1.5 s because the watchdog polls it on a 6 s budget and taskkills on overrun, while startup passes 5 s.
- If `supersession-candidates.yaml` is lost, recorded corrections are forgotten (entries/beats persist).
- `fsync` failure is logged once but non-fatal — NTFS may not durably sync on all systems.

When the code disagrees with this map, the **code wins** — flag the drift so the reference gets fixed.
