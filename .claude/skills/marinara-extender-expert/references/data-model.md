# Marinara Extender: Data Model & Storage

*Grounded in `memory-extender/src/storage.ts`. Field names, tier thresholds, and the on-disk layout are taken from the code — open `storage.ts` when a detail must be exact.*

## The four core types (`storage.ts:12–95`)

```ts
type Scope       = "global" | "character" | "chat";
type Lane        = "open_threads" | "user_topics" | "character_topics";
type EntryStatus = "open" | "in_progress" | "done" | "deferred";
type MemoryTier  = "short" | "long" | "core" | "secondary_core";
```

- **Scope** — *global* (rules everywhere) · *character* (per stable identity, persists across all that character's chats) · *chat* (this conversation only).
- **Lane** — *open_threads* (tasks/promises/follow-ups, status-tracked) · *user_topics* (facts about the human player) · *character_topics* (lore, emotional moments, callbacks).
- **EntryStatus** — *done* is filtered out of the Current working set by default; *deferred* is parked but tracked.
- **MemoryTier** — the durability ladder (below).

## The index/entry split

Each record exists in two forms, deliberately:

- **`IndexEntry`** (`storage.ts:30`) — lightweight metadata row kept in the per-scope `index.yaml`. The loader scans **only these** every turn, so the hot path stays bounded. Holds: `id`, `path`, `summary` (≤120 chars), `tokens`, `lane`, `status`, `lastAccessed`, the tier fields, `sourceChatId`, `threadId`, `turnStart`, and the supersede/delete markers.
- **`Entry`** (`storage.ts:62`) — the full record (adds `content`, `created`, `timeContext`), stored in its own file and loaded **on demand** only when the entry is selected for injection.

Tier fields are **mirrored** onto both so the loader never has to open entry files to rank.

- **`Bookmark`** (`storage.ts:86`) — a decaying soft signal: `topic`, `summary`, `weight` (0.0–1.0), `why` (unresolved|important|emotional|promised|curious|follow-up), `createdTurn`, `lastSeenTurn`, `decayRate` (default **0.97**). Weight ×= decayRate each turn; surfaced into the block by a weighted random roll.

## The tier lifecycle (`storage.ts:17–28`)

Score = **`retrievalCount + (recitationCount × 3)`**. Constants are exported from `storage.ts`:

| Transition | Trigger | Constant |
|---|---|---|
| short → **long** | score ≥ 5 | `TIER_SCORE_LONG = 5` |
| long → **core** | score ≥ 25 → never pruned | `TIER_SCORE_CORE = 25` |
| → **secondary_core** | cycled 3+ times → permanent | `TIER_SECONDARY_CORE_CYCLES = 3` |
| long → short (demote) | 30 days without retrieval | `TIER_DAYS_LONG_DEMOTES = 30` |
| short → pruned | 14 days, if it was ever summoned | `TIER_DAYS_SHORT_PRUNES = 14` |
| non-core → **cold archive** | 90 days without retrieval | `TIER_DAYS_COLD = 90` |

Promotion runs every 20 turns (see `promotion.ts` / the pipeline reference). `core`/`secondary_core` are never pruned.

## Hot / cold / supersede / delete — nothing is destroyed lightly

A central design choice: **demotion is a tier move, not a delete.** Entry *files* are essentially never moved or removed on the automatic path — only the index **row** moves between hot and cold.

- **Cold archive** (`index.cold.yaml`, `storage.ts:318`) — a second per-scope index for stale non-core rows. The loader does **not** read it each turn — only on a recall miss — so the per-turn scan stays bounded. `moveToCold` adds to cold *first* then removes from hot (a crash can't lose the row). `promoteFromCold` rehydrates one row on recall.
- **Supersession (FR2)** (`supersedeEntry`, `storage.ts:359`) — a newer fact replaces an older one: the old row gets `supersededBy`/`supersededAt` (mirrored onto the entry file so the fact carries its own history) and is moved to cold. Still queryable ("you said Mei before — did you mean Lin?"), out of Current. `restoreSupersededEntry` reverses it.
- **User delete** (`softDeleteEntry`, `storage.ts:447`) — also a tier move to cold, marked `deletedAt` (and, unlike supersede, **no** `supersededBy`). Shows in the "Recently deleted" view; cold recall skips `deletedAt` rows. `restoreDeletedEntry` brings it back; `purgeColdEntry` is the separate, dig-for-it permanent removal.

> Note: `supersededBy` is a **separate field, not an `EntryStatus` value** — there's a code comment warning that widening a serialized enum breaks empirical consumers silently. Respect that when adding states.

## On-disk layout (`storage.ts` path helpers)

Root: `memory-extender/data/` (or `MARINARA_EXTENDER_DATA`). `scopeDir`:

- `global/`
- `characters/{identityKey}/`
- `chats/{chatId}/`

Inside a scope dir:

- **`index.yaml`** — the hot `ScopeIndex` (array of `IndexEntry`).
- **`index.cold.yaml`** — the cold archive index.
- **Entry files in lane-named subdirs** (`writeEntry`, `storage.ts:596`): `open_threads → threads/`, `user_topics → user-topics/`, `character_topics → char-topics/`, each holding `{entryId}.yaml`. **Not** a flat `entries/` dir.
- **`bookmarks.yaml`** — `Bookmark[]`.
- Character scope also holds beats (`beats.yaml` + `beats/`) and arcs (`arcs.yaml`, `arc-memberships.yaml`).

Cross-cutting standalone files (under `data/`, via `mutateYamlFile`): `threads/registry.yaml`, `identity-map.yaml`, `holding-pool.yaml`, `supersession-candidates.yaml`, `reconcile-queue.yaml`.

## Write discipline (don't bypass it)

- **All writes are atomic + durable** — `atomicWriteFile` (`storage.ts:184`): write a temp file → `fsync` the writable handle → `rename` over the target (atomic; replaces on Windows). The `fsync` is what survives a hard crash; it must be on the *writable* handle (an `fsync` on a read handle fails EPERM on Windows — the bug that lost engine tables on 2026-06-10). Windows `rename` retries transient `EPERM`/`EBUSY`/`EACCES` with backoff.
- **Per-path write serialization** — `serializedWrite` (`storage.ts:240`) chains writes to the same file so concurrent read-modify-write (e.g. two `upsertIndexEntry`) can't corrupt the index. Use `upsertIndexEntry` / `mutateIndex` / `mutateBookmarks` / `mutateYamlFile`, never a raw write.
- **Guard against blind overwrite** — `upsertIndexEntry` refuses to overwrite an *unreadable* index (would orphan every other row); it throws and points at `scripts/repair-indexes.mjs`.
- **Input safety** — `assertSafeId` (`storage.ts:113`) rejects ids containing path separators / `..` / null bytes before they're interpolated into a filesystem path. `stripLoneSurrogates` removes torn UTF-16 halves from truncated text so a split emoji can't make the whole LLM request body fail to encode.
- **Tokens** — `estimateTokens` is `ceil(len/4)` (`storage.ts:661`); a rough chars÷4 estimate, used for budget accounting.

## Quick map: which function for which job

- Add/replace an index row → `upsertIndexEntry`. Mutate one in place (bump a counter) → `mutateIndex`.
- Write/read a full entry → `writeEntry` / `readEntry` (lane subdir is derived from `entry.lane`).
- Archive / rehydrate → `moveToCold` / `promoteFromCold`.
- Replace a fact → `supersedeEntry` (+ `restoreSupersededEntry`).
- User delete / restore / purge → `softDeleteEntry` / `restoreDeletedEntry` / `purgeColdEntry`; list via `listDeleted`.
- Re-import a chat cleanly → `removeEntriesBySourceChat` (skips `recap-*` rows — those aren't import artifacts).
