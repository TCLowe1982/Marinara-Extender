# Marinara Extender: Data Model & Storage

*Grounded in `memory-extender/src/storage.ts`. Field names, tier thresholds, and the on-disk layout are taken from the code — open `storage.ts` when a detail must be exact.*

## The five core types (`storage.ts`)

```ts
type Scope           = "global" | "character" | "chat";
type Lane            = "open_threads" | "user_topics" | "character_topics";
type EntryStatus     = "open" | "in_progress" | "done" | "deferred";
type MemoryTier      = "short" | "long" | "core" | "secondary_core";
type EntryProvenance = "played" | "unplayed";
```

- **Scope** — *global* (rules everywhere) · *character* (per stable identity, persists across all that character's chats) · *chat* (this conversation only).

  **On a `[remember:]` tag, an unrecognised scope falls back to `character`** — the same default as an omitted one (`c0b7`, fixed 2026-08-04; case and whitespace are normalised first, and a bad value is warned once per distinct value). It used to fall to `chat`, the *narrowest* scope, so invalid and absent disagreed in the damaging direction: a typo'd `scope="charcter"` buried the memory in the conversation that produced it, silently, where it died with that chat. The value is emitted by a **model**, so casing and near-miss synonyms are exactly what arrives. Two things worth knowing: `lane` has the same shape but its fallback *is* its default, so a lane typo is harmless — scope was the only field where the two disagreed; and `global` IS reachable from a tag — TC ruled 2026-08-04 that the parser was right and the prompt was the bug (`t6ox`, fixed). The prompt now teaches all three and marks global as rare. `prompt-vocabulary.test.ts` asserts the taught vocabulary equals the accepted one as a SET, so drift fails in both directions.

  A fourth **persona** tier is designed but blocked (`0qx6`): facts about the persona known to all characters who interact with them. It must not ship flat — without the epistemic layer (`1m9`) underneath it leaks every secret to every character on first contact, which is worse than today.
- **Lane** — *open_threads* (tasks/promises/follow-ups, status-tracked) · *user_topics* (facts about the human player) · *character_topics* (lore, emotional moments, callbacks).
- **EntryStatus** — *done* is filtered out of the Current working set by default; *deferred* is parked but tracked.
- **MemoryTier** — the durability ladder (below).
- **EntryProvenance** — *played* (default when absent) vs *unplayed*. **`unplayed` is OUTLINE**: canon the author established out of character for an arc that has not been played. Stored at full fidelity so it can be built on, and excluded from **every** recall path — `selectEntries` and `coldRecall` both filter it, so archival can't launder it back into hot via rehydrate. The reason is hard: a character able to "remember" an unplayed scene is the confabulation machine the Erica Test exists to detect. Deliberately **not** a widened `EntryStatus` — same reasoning as `supersededBy` (widening a serialized enum breaks consumers silently).

## The index/entry split

Each record exists in two forms, deliberately:

- **`IndexEntry`** (`storage.ts`) — lightweight metadata row kept in the per-scope `index.yaml`. The loader scans **only these** every turn, so the hot path stays bounded. Holds: `id`, `path`, `summary` (≤120 chars), `tokens`, `lane`, `status`, `lastAccessed`, the tier fields, `sourceChatId`, `citesChatId`, `threadId`, `turnStart`, `provenance`, `bodyTerms`, and the supersede/delete markers.

  **`sourceChatId` vs `citesChatId` (fqnl, 2026-08-19) — two meanings, two fields.** `sourceChatId` means *"this import OWNS me"*: `removeEntriesBySourceChat` purges by it on re-import, so it may only be stamped on entries a re-import will recreate (pipeline companions). `citesChatId` means *"this chat is my receipt"* and the purge **never reads it** — so paths whose entries a re-import would purge-and-not-recreate can finally record provenance: `[remember:]` tags, `/api/ingest-commands`, and the long-form story path (whose `sourceChatId` absence is a recorded deliberate decision at its pipeline call in `api.ts`). The provenance guard (`fact-support-scan.mjs`) reads `citesChatId ?? sourceChatId`. Inertness is pinned by `cites-chat-id.test.ts`; if the purge ever learns to read `citesChatId`, stamping remember-tags becomes a data-loss bug. Backfilling the 9,109 legacy unprovenanced entries is separate and mostly impossible (their receipts were never recorded); the fix is forward-looking.

  **`bodyTerms`** (`tp5`, 2026-08-04) — up to 12 lowercase names harvested from the entry's **body**, so a subject mentioned only there is still matchable without the loader opening the file. Written by `harvestBodyTerms` (`relevance.ts`) at entry creation; existing rows are populated by `scripts/backfill-body-terms.mjs`. **Absent means "not yet harvested", never "this entry has no names"** — the backfill deliberately skips unreadable entry files rather than recording an empty list. Costs ~23% index growth, which is the price of the hot path staying index-only.
- **`Entry`** (`storage.ts`) — the full record (adds `content`, `created`, `timeContext`), stored in its own file and loaded **on demand** only when the entry is selected for injection.

Tier fields **and `provenance`** are **mirrored** onto both so the loader never has to open entry files to rank or to filter.

> **The index still has no `content`, and never will.** This remains the most consequential shape fact: retrieval can only score what is on the index row. "Just also search the content" means either opening thousands of entry files per turn or carrying whole bodies in a multi-megabyte index that is re-read every turn and rewritten on every upsert. Neither is viable.
>
> What shipped instead (`tp5`, 2026-08-04) is the **searchable residue**: `bodyTerms`, the names a body mentions, harvested at ingest. Reachability on the measured corpus went 43% → 84% for ~23% index growth. So the rule for anyone adding a new signal is unchanged — **put a bounded, derived field on the row; never the source text.**

- **`Bookmark`** (`storage.ts`) — a decaying soft signal: `topic`, `summary`, `weight` (0.0–1.0), `why` (unresolved|important|emotional|promised|curious|follow-up), `createdTurn`, `lastSeenTurn`, `decayRate` (default **0.97**). Weight ×= decayRate each turn; surfaced into the block by a weighted random roll.

## The tier lifecycle (the `Tier` and `EntryStatus` unions in `storage.ts`)

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

### ⚠️ "Without retrieval" means **summoned**, not loaded (`gwny`, fixed 2026-08-24)

Every row above measures staleness with `daysSinceRetrieval` = **`lastRetrievedAt ?? lastAccessed`**, and `lastRetrievedAt` is written *only* on demonstrable use (`recordRecitation`). Measured on the live store, **87% of hot entries have no `lastRetrievedAt` at all** — so for seven entries in eight, **`lastAccessed` IS the decay clock.**

The loader used to stamp `lastAccessed` on *every loaded entry*, including ones that merely rode in on the recency fallback, while gating only `retrievalCount` on relevance. That made entries **immortal by exposure**: loaded as filler → clock reset → still available as filler. Measured before the fix: **8,320 hot vs 420 cold (19.8:1)**, only **17** entries cold-eligible, **48.7% massed in the 60–90 day band** (not an age distribution — a population being pushed back from the edge), and **4,242** entries never summoned, never used, and unable to age out.

**The fix is one line in `loader.ts`** — a non-summoned entry is skipped entirely, no clock and no write: `if (!summoned) return Promise.resolve();`. `lastRetrievedAt` is still never written by the loader; being loaded, even when summoned, is not being used.

- **Do NOT "fix" this by falling back to a creation date.** Measured: that makes **7,009 entries cold-eligible on the next pass** (vs **7** — the same 7 as today — for the shipped fix), and `IndexEntry` carries no `created` at all, so it needs a schema change plus a backfill. Leaving the field alone gets there for free: `lastAccessed` is **initialised at creation**, so a never-summoned entry keeps its creation date and ages from there.
- **Migration is a curve, not a step** — existing values are untouched; entries age out only as they stop being summoned (3,401 within 30 days, 1,406 at 30–60, 2,472 at 60–90).
- Skipping the write also removes **thousands of identical-row index rewrites per turn**. Possibly relevant to `3lru` (1.5 GB peak) and `96eo` (orphaned temp files); neither confirmed.
- ⚠️ **This bug was silent in both directions** — the whole suite passed with it wrong *and* with it fixed, because nothing pinned who may touch the clock. `decay-clock.test.ts` now does, and its pins were **verified to fail against the old behaviour** before being kept (2 of 4 do; the other 2 are guards). A pin that cannot fail on the old code is worth nothing.
- The **4,242 already-immortal entries are not relocated** by this. They age normally from here, up to 90 days from their last stamp. Force-ageing them is a separate decision with its own blast radius.

## Hot / cold / supersede / delete — nothing is destroyed lightly

A central design choice: **demotion is a tier move, not a delete.** Entry *files* are essentially never moved or removed on the automatic path — only the index **row** moves between hot and cold.

- **Cold archive** (`index.cold.yaml`, `storage.ts`) — a second per-scope index for stale non-core rows. The loader does **not** read it each turn — only on a recall miss — so the per-turn scan stays bounded. `moveToCold` adds to cold *first* then removes from hot (a crash can't lose the row). `promoteFromCold` rehydrates one row on recall.
- **Supersession (FR2)** (`supersedeEntry`, `storage.ts`) — a newer fact replaces an older one: the old row gets `supersededBy`/`supersededAt` (mirrored onto the entry file so the fact carries its own history) and is moved to cold. Still queryable ("you said Mei before — did you mean Lin?"), out of Current. `restoreSupersededEntry` reverses it.
- **User delete** (`softDeleteEntry`, `storage.ts`) — also a tier move to cold, marked `deletedAt` (and, unlike supersede, **no** `supersededBy`). Shows in the "Recently deleted" view; cold recall skips `deletedAt` rows. `restoreDeletedEntry` brings it back; `purgeColdEntry` is the separate, dig-for-it permanent removal.

> Note: `supersededBy` is a **separate field, not an `EntryStatus` value** — there's a code comment warning that widening a serialized enum breaks empirical consumers silently. Respect that when adding states.

## On-disk layout (`storage.ts` path helpers)

Root: `memory-extender/data/` (or `MARINARA_EXTENDER_DATA`). `scopeDir`:

- `global/`
- `characters/{identityKey}/`
- `chats/{chatId}/`

Inside a scope dir:

- **`index.yaml`** — the hot `ScopeIndex` (array of `IndexEntry`).
- **`index.cold.yaml`** — the cold archive index.
- **Entry files in lane-named subdirs** (`writeEntry`, `storage.ts`): `open_threads → threads/`, `user_topics → user-topics/`, `character_topics → char-topics/`, each holding `{entryId}.yaml`. **Not** a flat `entries/` dir.
- **`bookmarks.yaml`** — `Bookmark[]`.
- Character scope also holds beats (`beats.yaml` + `beats/`) and arcs (`arcs.yaml`, `arc-memberships.yaml`).

Cross-cutting standalone files (under `data/`, via `mutateYamlFile`): `threads/registry.yaml`, `identity-map.yaml`, `holding-pool.yaml`, `supersession-candidates.yaml`, `reconcile-queue.yaml`.

## Write discipline (don't bypass it)

- **All writes are atomic + durable** — `atomicWriteFile` (`storage.ts`): write a temp file → `fsync` the writable handle → `rename` over the target (atomic; replaces on Windows). The `fsync` is what survives a hard crash; it must be on the *writable* handle (an `fsync` on a read handle fails EPERM on Windows — the bug that lost engine tables on 2026-06-10). Windows `rename` retries transient `EPERM`/`EBUSY`/`EACCES` with backoff.
- **Per-path write serialization** — `serializedWrite` (`storage.ts`) chains writes to the same file so concurrent read-modify-write (e.g. two `upsertIndexEntry`) can't corrupt the index. Use `upsertIndexEntry` / `mutateIndex` / `mutateBookmarks` / `mutateYamlFile`, never a raw write.
- **Guard against blind overwrite** — `upsertIndexEntry` refuses to overwrite an *unreadable* index (would orphan every other row); it throws and points at `scripts/repair-indexes.mjs`.
- **Input safety** — `assertSafeId` (`storage.ts`) rejects ids containing path separators / `..` / null bytes before they're interpolated into a filesystem path. `stripLoneSurrogates` removes torn UTF-16 halves from truncated text so a split emoji can't make the whole LLM request body fail to encode.
- **Tokens** — `estimateTokens` is `ceil(len/4)` (`storage.ts`); a rough chars÷4 estimate, used for budget accounting.

## Quick map: which function for which job

- Add/replace an index row → `upsertIndexEntry`. Mutate one in place (bump a counter) → `mutateIndex`.
- Write/read a full entry → `writeEntry` / `readEntry` (lane subdir is derived from `entry.lane`).
- Archive / rehydrate → `moveToCold` / `promoteFromCold`.
- Replace a fact → `supersedeEntry` (+ `restoreSupersededEntry`).
- User delete / restore / purge → `softDeleteEntry` / `restoreDeletedEntry` / `purgeColdEntry`; list via `listDeleted`.
- Re-import a chat cleanly → `removeEntriesBySourceChat` (skips `recap-*` rows — those aren't import artifacts).
