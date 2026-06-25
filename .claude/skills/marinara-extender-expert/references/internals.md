# Marinara Extender: Internals

*The subsystems behind the pipeline. Grounded in `dedup.ts`, `apply-gate.ts`, `reconcile.ts`, `promotion.ts`, `holding-pool.ts` (+ `identity.ts`/`aliases.ts`/`threads.ts`). This is the densest reference — open the cited file before changing behavior.*

## The write gate: the dedup matrix (`dedup.ts`)

**Every capture path writes through `createEntryIfUnique`** — it's the single gate that stops the automated tiers from regenerating duplicates faster than cleanup removes them. `createEntry` (unconditional, `force`) exists only for callers that have *already* adjudicated (the FR3 curator). The decision is **lane- and kind-aware** (`decide`, `dedup.ts:187`):

- **`character_topics` + `kind:"incident"`** (beats) — *feelings accumulate.* An incident **never collapses into a trait** (an event resembling a standing pattern is the arc growing, not a dupe). Incident-vs-incident dedups at a **higher** bar (`INCIDENT_DEDUP_THRESHOLD = 0.6`) **and** requires proof of the *same moment*: same `sourceChatId` and within `SAME_MOMENT_TURN_WINDOW = 5` turns. Without that proof both persist — because the analyzer emits identical boilerplate for genuinely distinct moments (measured: 78 byte-identical summaries collapsing distinct beats). → `skip` only on a real re-capture (swipe/regen).
- **`user_topics`** (facts) — *facts supersede.* A similarity hit whose symmetric difference is a few **content** words is the **correction signature** ("sister is Mei" → "sister is Lin") — the meaning-carrying token is exactly what Jaccard ignores. `correctionSignature` (`dedup.ts:91`): Jaccard ≥ `CORRECTION_MIN_JACCARD = 0.5`, symdiff of 1–4 non-function content words → `create-correction`. Plain restatements → `skip`.
- **traits / `open_threads` / legacy (kind-less)** — aggressive default: any hit ≥ `DEDUP_SIMILARITY_THRESHOLD = 0.35` → `skip`.

Similarity is `jaccardSimilarity` on lowercased word bags (`dedup.ts:65`). **Pass the right `kind`** (`incident` vs `trait`) or the matrix misfires.

## The fact-reconciliation chain: FR1 → FR2 → FR3

This is the Extender's signature discipline — **a wrong memory is worse than a missing one**, so corrections are gated, not auto-applied. Three stages:

**FR1 — structural signal (`dedup.ts`).** When the matrix would `skip` a **fact** collision (`user_topics`, or `character_topics` trait) and the reconcile queue is enabled, it fires `enqueueReconcileTask` — advisory, fire-and-forget, never blocks the save. When it rules `create-correction`, it calls `supersedeEntry` and records a `SupersessionCandidate` to `data/supersession-candidates.yaml`.

**FR2 — supersession (`storage.ts:supersedeEntry`).** A newer fact replaces an older one as a **tier move, not a delete**: the old entry gets `supersededBy`/`supersededAt` (mirrored onto its file) and moves to cold, still queryable as a negative fact ("you said Mei before — did you mean Lin?").

**FR3 — the agentic curator (`reconcile.ts`).** The hard part: *deciding* how a candidate relates to existing same-subject facts. A tool-using **Claude Agent SDK** agent that `search_entries` → `read_entry` → records **one** verdict via `decide`:

| Verdict | Action |
|---|---|
| CREATE | no related fact — save new |
| DUPLICATE | already represented — no-op |
| UPDATE | newer/corrected — save new, supersede old |
| NEGATE | disproves existing — save new, supersede old (kept as negative fact) |
| EXPAND | both true, complementary — keep both |
| DISTINCT | false collision — keep both |

Key properties (all in `reconcile.ts`):
- **No write tool.** The act is deferred to `applyDecision` so dry-run and `--apply` share one path and the agent can never mutate memory directly.
- **Bounded view** — `selectLedgerView` (cap **50**) pins the flagged colliding entry, then fills by lexical relevance. This is **deliberately the Ledger Pattern**: feeding a 4250-entry ledger to the curator would triage and miss.
- **Opt-in + offline + additive.** Gated on `MARINARA_EXTENDER_RECONCILE`; runs via `scripts/reconcile-facts.mjs`, **not** the live turn path. `drainReconcileQueue` is **SHADOW by default** (records the proposed verdict to the audit log, applies nothing — the rollout gate); `apply:true` executes through the apply-gate.
- **⚠️ This is the ONE Anthropic-coupled subsystem.** It resolves credentials via `ANTHROPIC_API_KEY` → logged-in Claude CLI → claude.ai session. The entire rest of the Extender is OpenAI-compatible/local (Ollama). Keep it that way — don't couple the core to Anthropic.
- `clusterCurator` is a second interaction for the ledger-hygiene **sweep**: judge a flagged cluster of stored facts at once → `merge` (pick canonical, retire the rest) or `distinct`.

**The apply-gate (`apply-gate.ts`)** decides whether an FR3 verdict auto-applies. **Two stages, second never overrides first:**
1. **Domain-sensitive flags** — a verdict whose text matches the (deliberately tight) **trauma lexicon** ALWAYS holds for human review, *regardless of confidence*. Rationale (the M13 case): a wrong merge on a trauma memory is asymmetric — it can permanently erase a lead, while a right merge saves one near-dup row. Unrecoverable downside + ~0 upside → never auto-apply.
2. **Confidence** — for everything else: the curator's self-reported `high` auto-applies; `medium`/`low`/unknown hold.

`hold` **never means drop** — held items are recorded with reasons to the review lane. Auto fires only on non-sensitive + high-confidence. **This is the gate new write paths (e.g. the `1m9` epistemic "hiding" lane) should reuse** — a falsely-extracted hiding fact is exactly the asymmetric-downside case this exists for.

## Identity & aliases — the routing backbone (`identity.ts`, `aliases.ts`)

Why memory lands in the right ledger:
- **`resolveIdentity(cardId, name)`** — maps an *ephemeral* Marinara card id to a *stable* `identityKey` (slug), persisted in `identity-map.yaml`, so a character's memory survives across sessions/re-links.
- **`resolveNameToKey(subject)`** — maps an analyzer-attributed subject name to an identity key (the subject-routing call in both Tier-2 and Tier-3). Returns null for unknown → holding pool (beats) or chat-scope `[about:]` (facts).
- **`buildSubjectRoster`** — the known-cast context handed to the analyzer.
- **`USER_IDENTITY_KEY`** — the reserved key for the human player. Persona names are registered under it (`addAlias`) so the alias-learner can **never** attach the player's name to a character (the 50e bug: "Thomas" learned as an alias of Mari, routing the player's facts into her ledger).
- `normalizeLabel` / `matchesSessionName` — label normalization + fuzzy session-name matching used throughout routing.

## The holding pool — orphan beats (`holding-pool.ts`)

When a beat's subject resolves to **no** known character, it is **held, not dropped** (`holding-pool.yaml`). It stores the **classification** (chunk + cheap scores), **not** an analyzed beat — deep analysis is **deferred to claim time** so orphans the user ignores never cost analyzer tokens. Deterministic `beatId` makes adds and migration idempotent.

`routeOrphans` decides per normalized label:
- **exact single alias** → auto-route now (the user already taught us this name);
- **collision (>1 match)** → hold with **no** suggestion (force manual);
- **fuzzy near-miss** → hold **with** a suggestion (never auto-routed);
- **miss** → hold.

`migratePendingBeats(label, identityKey)` runs the deferred analysis on claim, encodes beats under the character, **and writes the companion entry** (same rule as the pipeline — a routed beat with no companion is unrecallable). `ignoreSpeaker` → a 30-day recoverable bucket (`IGNORED_TTL_DAYS`, `holding-pool-ignored.yaml`); `restoreIgnored` undoes it; `purgeExpiredIgnored` hard-deletes past TTL. `orphanCharacterBeats` cascades a deleted character's beats back into the pool for re-mapping.

## Threads & arcs (`threads.ts`, `arcs.ts`, `arc-promotion.ts`)

- **Narrative threads** — minted at Tier-2 ingest, **scene-scoped per chat**, via fuzzy label resolution (`resolveOrMintThread`) so label drift doesn't double-mint. Used by the loader to lift co-mentioned beats into Current via thread-sibling relevance. `autoCloseStaleThreads` runs in the promotion pass.
- **Thread-unit cold archival** (`promotion.ts:106`) — members of an **active** thread never go cold; a **closed** thread's members archive **together**, only once *every* member is stale. The arc is never split across hot and cold.
- **Arcs** — *scene* (floor) and *through-line* (ceiling). `arc-promotion` (every 60 turns) clusters beats into/onto through-line arcs via the renderer (one LLM call per touched arc — hence the slow cadence). Through-line recaps are surfaced by `recap-activation` (semantic, embedding-based) even when keywords don't match.

## Promotion engine (`promotion.ts`)

The tier ladder/constants live in `data-model.md`; the engine specifics:
- `computeScore = retrievalCount + recitationCount × 3`; `nextTier` applies the transitions; `runPromotion(scope, scopeId)` runs every 20 turns under a **serialized `mutateIndex`** so it can't clobber concurrent Tier-2/3/retrieval writes on the same index.
- **`recordRecitation`** (fired by `/api/entries/:id/recite` when the extension detects memory use) bumps `recitationCount`, stamps `lastRetrievedAt` (the honest recency signal — *demonstrable use is retrieval*), **rehydrates from cold first** if needed, and may tip the tier immediately.
- `runPromotionAll` is the backfill (also prunes ghost entries with empty summaries — the only automatic hard-delete).

## Contributor invariants

- **Write through `createEntryIfUnique`** with the correct `kind`. Bypass it (`createEntry`/`force`) only when something authoritative has already adjudicated (the curator).
- **New fact-write paths reuse the apply-gate** — don't auto-commit a correction/merge that a trauma flag or low confidence should hold. This is the whole reason the foundation beats naive memory systems.
- **Keep the core provider-agnostic.** Only the FR3 curator may touch the Agent SDK / Anthropic auth, and only opt-in + offline.
- **Never guess a subject** into a permanent ledger — hold it (beats) or chat-scope it (facts).
- **Routed/encoded beats always get a companion entry** — the loader reads the entry index, not the beats store.
