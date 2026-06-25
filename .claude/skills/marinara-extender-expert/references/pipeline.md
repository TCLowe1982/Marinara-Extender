# Marinara Extender: The Ingestion Pipeline

*Grounded in `api.ts` (`/api/process-turn`) and `sentiment/pipeline.ts`. This is how a turn becomes memory. Open those files when an order or threshold must be exact.*

## Two entry points, one memory store

1. **Live, per-turn** — `POST /api/process-turn` (`api.ts:507`), fired by the extension after each AI response. Fast: a short synchronous spine, then everything expensive runs **fire-and-forget**.
2. **Batch import** — `runSentimentPipeline` (`sentiment/pipeline.ts:89`), reached via `/api/analyze-beats`, story import, and the long-form path. Windowed, resumable, the full Ledger-Pattern treatment.

Both produce the same artifacts: **beats** (emotional moments), **companion ledger entries** (what the loader actually injects), **facts**, **threads**, and tier/promotion bookkeeping.

## The synchronous spine of a turn (what blocks the response)

Only these run before `/api/process-turn` returns (`api.ts:513–591`):

1. **`resolveIdentity(characterId, characterName)`** → stable `identityKey`.
2. **Soft clock** *(gated; off by default)* — `updateSoftClock` → `timeCtx` attached to new entries.
3. **`extractRememberTags(messageText)`** (`writer.ts`) → create entries **synchronously**, deduped per scope+lane via `isDuplicate` with a per-message `indexCache` so two `[remember:]` tags in one message can't double-write. Summaries under 10 chars are skipped; `truncateSummary` caps length.
4. **`processResponse`** → extract `[bookmark:]` tags + **decay all bookmarks ×0.97**.
5. **`loadContext({ recentText: userMessageText + "\n" + messageText })`** → assemble the `<memory>` block. `recentText` drives Current relevance ranking.
6. **Return** `{ memoryBlock, created, bookmarksExtracted, surfaced }` (`api.ts:803`).

Everything below is kicked off as `void (async () => …)()` **after** the block is computed — it never delays the response.

## The fire-and-forget tiers (async, never block)

### Tier 2 — Sentiment / beats (`api.ts:623`, the richest path)
1. Build chunks: the user message (unless it's a long-form story, below) and the AI message — each is **one chunk** (`turnStart/turnEnd` set from `turnNumber`).
2. `classifyChunks(chunks, "chat")` → keep only `passesThreshold` (the fast keyword/salience gate; nothing passes → return early, no LLM spend).
3. `buildSubjectRoster` + `listActiveThreads` for context.
4. `analyzeChunks(passing, …)` → per beat: **emotion, motivation, relational dynamics, outcome, subtext, subject, thread label**.
5. **Subject routing** — `chunk.speaker` is the *session* label (the whole AI message is one chunk), so in multi-character RP it names the session character even when the beat is about a co-star. The analyzer's **`subject`** says whose inner state it is → `resolveNameToKey(subject)` routes the beat to that identity's ledger. **Unknown subject → holding pool (`addPending`), never guessed into a permanent ledger.** Player/persona subjects stay in the session ledger.
6. **Thread** — `resolveOrMintThread` matches the analyzer's label against the chat's active threads (fuzzy; labels drift), minting only when genuinely new.
7. `encodeBeat` → store the beat, **and** `createEntryIfUnique` a companion entry (`lane: character_topics`, `kind: "incident"`, summary `[emotion] motivation`).

### Tier 3 — Ambient facts (`api.ts:734`)
`classifyAmbient` extracts durable identity/preference/history facts from throwaway lines. Same subject routing, with one difference: facts have **no holding-pool lane**, so an unknown subject is **demoted to chat scope** tagged `[about: subject]` rather than parked. Character-scope facts get `kind: "trait"` (the trait side of the dedup matrix vs. beats' `kind: "incident"`).

### Long-form story (`api.ts:787`)
When `userMessageText.length > LONG_USER_MSG_CHARS` (default 1500), the single user chunk is **skipped by Tier 2** and instead routed through the full `runSentimentPipeline` (windowed, every passing window analyzed, subject-routed) — so a multi-page memory told in one message lands with import-parity richness instead of collapsing to ~1 beat.

### Promotion & arc passes (cadenced)
- **Promotion — every 20 turns** (`api.ts:602`): `runPromotion("character")` + `runPromotion("chat")` + `autoCloseStaleThreads()`.
- **Arc promotion — every 60 turns** (`api.ts:612`): `runArcPromotion` clusters beats into/onto through-line arcs; spends one renderer LLM call per touched arc (hence the slower cadence).

## Tier 1 — Snapshot (the periodic digest)

Separate from the per-turn path: `digest.ts`, via `/api/snapshot` / `/api/digest`, called roughly every 30 minutes of active chat. An LLM digests recent messages into character-scope entries — a coarse safety net beneath the per-turn beat/fact capture. (See `digest.ts` for specifics.)

## The batch pipeline = the Ledger Pattern (`sentiment/pipeline.ts`)

`runSentimentPipeline` is the pattern applied literally — invoke the `ledger-pattern` skill when touching it:

- **Stage 0 — chunk** (`chunkMessages`): break messages on dialogue/narrator boundaries. POV relabel turns first-person "Narrator" into a named character.
- **Stage 1 — classify** (`classifyChunks`): fast keyword/salience filter → `passing`. For **chat** imports `analyzeAll` is true (the whole scene is one speaker label, so it can only be split by analyzed *subject*, not speaker); **story** imports keep the speaker pre-filter.
- **Stages 2+3 — analyze & encode, one chunk at a time** (`pipeline.ts:167`): each chunk → `analyzeChunk` (with its true before/after neighbors + roster) → subject-route → `encodeBeat` + companion entry. **Persisted incrementally** — the on-disk beat store *is* the ledger: a cancel/crash keeps every completed beat, and a re-run resumes via deterministic `beatIdForChunk` (skipping done chunks while still ensuring their companion entry exists). `forceReanalyze` bypasses the resume skip when a re-import's purpose is re-routing subjects.
- **Narrative-position boost** (`pipeline.ts:60`, `×1.3`): the final 20% of a story carries climax/resolution weight, so its beats' salience is boosted.
- **Durable-fact pass** (`ingestSceneFacts`, 1dn): runs over the **full** chunk set, not just salient ones — identity/lore facts live *below* the beat salience threshold, so they'd never become beats; captured separately. Guarded so a fact-pass failure can't fail an import that already saved beats.

## Cadence & threshold quick-reference

| Thing | Value | Where |
|---|---|---|
| Promotion pass | every **20** turns | `api.ts:602` |
| Arc promotion | every **60** turns | `api.ts:612` |
| Snapshot/digest | ~every **30 min** active | `digest.ts` |
| Long-form trip | user msg > **1500** chars | `LONG_USER_MSG_CHARS` |
| Bookmark decay | **×0.97** per turn | `writer.ts` / `storage.ts` |
| Narrative boost | **×1.3**, final 20% | `pipeline.ts:60` |

## Invariants & gotchas

- **Every beat needs a companion ledger entry.** The loader builds the injected `<memory>` block from the **entry index, not the beats store** (`pipeline.ts:255–259`). A beat with no companion entry is invisible to recall. Never encode a beat without `createEntryIfUnique`.
- **Never guess a subject into a permanent ledger.** Unknown subject → holding pool (beats) or chat-scope `[about: …]` (facts). Guessing pollutes a character's memory irreversibly.
- **Fire-and-forget must never block or throw into the response.** Each tier is wrapped in its own `try/catch` and `void`-ed. A failed tier logs a warning; the turn still returns its block.
- **Dedup is `kind`-aware** — `incident` (beats) vs `trait` (ambient facts) go through different bars in the dedup matrix (`dedup.ts`). Pass the right `kind` or dedup misfires.
- **The import path is windowed + resumable by design** — don't "optimize" it into one big call; that's the exact failure the Ledger Pattern exists to prevent.
