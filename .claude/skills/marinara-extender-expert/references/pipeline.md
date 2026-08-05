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

### ⚠️ The substrate is an 8B local model — write for mimicry, not obedience

`callLlm` in the analyzer tries **local first** and only falls back, so `dolphin3:8b` performs every beat analysis. Small models do not follow instructions, they follow **examples**: compliance degrades with prompt length, imitation does not. Every failure prosecuted on 2026-08-04/05 is that signature — example-copying, later-instruction-wins, advisory guards ignored. The prompt suite was written for a frontier model's obedience and deployed on hardware that runs on proximity.

**House law: PROMPT ASKS, CODE ENFORCES.** Strip every rule from a prompt that a validator can hold instead. Measured on the tier-2 prompts: 13 bullet rules, of which **8 are validator-shaped** (sentence count, weight normalisation, subject-in-roster, genre/echo rejection, salience clamp, JSON-only, and the whole thread rule). Five remain — which is the rule budget, arrived at from the audit rather than imposed on it.

**The attention tax is measurable, so measure it before adding a line.** ~880 tokens of system prompt, **80% identical across all ten emotion prompts**. `subtext` fires on **78 of 8,836 beats (1%)** and rides unconditionally on the other 99%. Thread rules waste ~198 tokens on the 73% of calls that produce no thread. Expected waste: **240 of 880 tokens per call**. Conditional assembly is not tidiness at this scale — an 8B pays for every irrelevant line.

**A chunk must clear a content floor before it can become a beat** (`s8qe`, shipped 2026-08-05). `min_chunk_tokens: 2` in `sentiment-config.yaml`, enforced in `classifyChunk` **before** scoring — so a structural pattern can't smuggle a sub-floor chunk through (a lone quoted `"ok."` scores 0.75 and is one token). It returns a clean no-beat: empty scores, `null` primaryEmotion, because callers branch on that too.

The floor exists because **the salience gate is emotion-keyed, not content-keyed**. It asks whether a chunk looks *emotional*, and one word can answer yes: the bare token `open` matches a vulnerability keyword, scores 0.59, clears 0.40. 513 such chunks reached the analyzer and **89.1% came back echoing a prompt example** (against ~5% everywhere else), with only 15.6% distinct.

Three things about this are worth carrying, because two plausible answers were measured and rejected:

- **The "U-shape" was one spike, not a slope.** The original 0–500 bucket read 21% echo; subdivided, *everything from 10 chars up* sits at the healthy 3–6%, and the average came entirely from 515 beats at 88.7%. **A 500-char floor would have discarded 2,099 unique real beats** to catch 93 further echoes. Coarse buckets hide the thing you're about to set a threshold from.
- **The axis is RAW tokens, not content words.** `skeletonTokens` looks like the principled choice and fails exactly where it matters: **for a short utterance the function words are the content**. `"I love you,"` has one content word — same as the junk token `open` — but three raw tokens against one. A content-word floor would have silently destroyed `"I love you,"` at salience 1.0, `"All of me,"`, `"You are a LIAR,"`.
- **It's a cause fix, not a symptom fix.** `rejectAsEcho` is a blocklist of sentences already seen; the floor removes the *condition*, so the next invented sentence — which no blocklist can know — is never generated. It sits beneath `4ghy` (the chunker minting `speaker: "status", text: "open"` from a `status: open` line), which is the actual root cause and still open.

**The sub-floor stratum was retired 2026-08-05** (517 beats + 12 live entries; 439 companions had already gone in the 0y2i pass and are invisible to a live-index scan because `retireEntries` moves rows to **cold**). Mark-don't-delete throughout: `retiredAt`/`retiredReason` on the beat and its index row, and **`readAllBeats` excludes retired by default** — load-bearing, because `/api/beats-to-entries` rebuilds companion entries from that list and a leak would resurrect them. Arc promotion and scene arcs filter too. Store-wide echo went **9.8% → 4.9%**.

Any bulk corpus change now files its own footnote in `stats-events.yaml` (`stats-events.ts`), and `chunk-floor-scan` prints a banner refusing to let pre- and post-event numbers be compared naively (`--include-retired` reproduces the old curve). A retirement that removes one stratum changes every curve ever measured, silently — without the event, a later scan reads "echo declined on its own."

### The prompt bench verdict (`s6cu`, 2026-08-05) — **SHORT + off-planet ships**

n=60/arm, quarantined (poller off, sidecar stopped, 0 leaked verified), scored with the shipped guard's own `echoesPhrases`.

| arm | sysTok | no-beat | echo | boilerplate | distinct |
|---|---|---|---|---|---|
| LONG+in-domain | 820 | 3% | 3% | 7% | 100% |
| LONG+off-planet | 909 | 2% | 2% | 10% | 100% |
| SHORT+no-example | 195 | 2% | 0% | 15% | 100% |
| **SHORT+off-planet** | **303** | **0%** | **3%** | **5%** | **97%** |
| SHORT+in-domain | 214 | 0% | 7% | 2% | 95% |

The pre-registered rule (`bd memories pre-registered`) decides it mechanically: `LONG+in-domain` fails the validity floor; off-planet is carried (beats baseline by 10 on boilerplate, ≥5 needed); in-domain fails **twice** (3 points where 10 required, 7% echo where <2% required — "disqualified at any specificity"); ties go **down** the ladder.

Three things worth carrying:
- **The ladder is real in both directions.** Echo rises monotonically with bait (0% → 3% → 7%) while boilerplate falls (15% → 5% → 2%). Bait genuinely buys specificity; the rule's integers are where it stops being worth the price.
- **Compression is free.** SHORT+off-planet matches or beats the LONG arm on every axis at **a third of the tokens**. Nobody pre-registered this.
- **The referee change was not academic.** That arm returned *"The subject insists **that** the boat was green"* — the exact inserted-word dressing that beat the substring guard in production. A substring referee would have flattered it. Never grade echo with anything weaker than `echoesPhrases`.

`SHORT+in-domain` returned *"admits she's afraid the memory loss means she was never real"* three times verbatim — the original disease, reproduced live under controlled conditions.

### Contamination routing (`hjt9`) — built, measured, **not wired**

Two kinds, two instruments, and conflating them is the trap: `code-filter.ts` scores **code-shaped** content structurally (1.0% of the store, 8/8 hand-read genuine) but caught 3 echoes against 864 — it is *not* an echo fix. `paste-prior.ts` handles **prose-shaped** contamination by provenance, because "insists the boat was green" has no braces to find.

Two hard-won rules live there: **size is a prior, never a verdict** (all 116 chunks ≥6000 chars are spared by structure — the largest are 40KB RP scenes; a naive 6KB rule would have taken every one), and **route the partition, not the chunk** (a fence marks *those lines*, not the message around them — the same line-vs-chunk error was made twice, one file apart). Disposition is always route-and-mark, never drop.

The **cap** is the other arm and is now split out as `dkib`: monotonic degradation above 2000 chars (8% → 12.3% → 14.7%), but only ~42 echoes against the floor's 457. Split or window it — never truncate. Re-measure with `scripts/chunk-floor-scan.mjs` (read-only; scores echo with the shipped skeleton matcher, so reuse it as the referee rather than writing a second scorer).

**Guards must match shape, not characters.** The first echo guard held `"insists the boat was green"`; the model wrote `"insists **that** the boat was green"` and it sailed through into a real ledger 90 minutes after shipping. Use `skeletonTokens` + ordered-subsequence matching (`analyzer.ts`) — strip function words, stem, require ≥3 content stems in order. Any scorer or bench that grades echo must use the **same** matcher, or the referee undercounts exactly the way the guard did.

**Never bench a prompt without quiescing capture.** The live poller ingests the session's own working notes: 141 beat files in 90 minutes during one run, 14 carrying prompt artifacts, one filed under `speaker: BAD`. Set `MARINARA_EXTENDER_POLLER=0`, and verify afterwards by grepping the store for the arms' own example skeletons.

### ⚠️ Prompt examples get returned verbatim (`pifl`)

The analyzer's `SHARED_RULES` illustrated *"two different moments can never produce the same sentence"* with a concrete example — and that example became **the most repeated sentence in the store**: 669 beats, across 4 characters, 37 chats and 35 days, with 542 ledger entries carrying it as their summary. In total **792 of 8,703 beats (9%) echoed a prompt example**, and *both* sides leaked — 107 beats opened with a paraphrase of the "too vague" example the rule was warning against.

How the alternatives were ruled out, because two plausible theories were wrong first:

- **Not a recall/injection loop** — only 1% of the source chunks that produced it mention anything like it, so the analyzer was not reading it back out of the text.
- **Not the model** — **zero** story-imported beats echo it, and the import path runs the same analyzer with a different context assembly.
- **One field collapses, the rest is fine** — an `[anger]` beat carrying a vulnerability motivation while `relationalDynamics` tracks the real text. The trigger is a huge chunk (6–8KB, sometimes not emotional at all — one was a discussion of `pipeline.ts`). Given nothing specific to say, the model returns the nearest phrasing it has been shown, and the prompt is nearest.

**The rule to carry forward: never write a prompt example that could plausibly be real output for this domain.** Illustrate the *shape* from an unrelated one. And back it with a deterministic guard — `echoesAnExample()` rejects an analysis whose motivation matches any example (returning `null`, the existing unusable-analysis path). Rewording is necessary and is not sufficient.

`PROMPT_EXAMPLE_ECHOES` deliberately **keeps retired examples**. The old wording is what the stored beats echo, so deleting a line silently re-opens the hole it closed.

This also poisoned two other investigations before it was found: it manufactured apparent subject misrouting (when motivation collapses, the subject is assigned loosely, so beats scatter across ledgers — see `bwgh`) and it inflated the written-vs-played confound by an order of magnitude (`7pcm`, where aurora's 129 chat beats turned out to be 112 echoes + 17 real). **Measure the echo rate before trusting any beat-level statistic.**

### Tier 3 — Ambient facts (`api.ts:734`)
`classifyAmbient` extracts durable identity/preference/history facts from throwaway lines. Same subject routing, with one difference: facts have **no holding-pool lane**, so an unknown subject is **demoted to chat scope** tagged `[about: subject]` rather than parked. Character-scope facts get `kind: "trait"` (the trait side of the dedup matrix vs. beats' `kind: "incident"`).

**A sentence can carry two facts about different people** (2tro). Given *"I was in the Army, and Mari is Polish."* the extractor kept `"Mari is Polish"` and dropped the user's clause outright — fact loss, not phrasing, because **retrieval scores the summary** and tp5's `bodyTerms` only rescues body-only *names* (`"my fourth sapper stakes"` has none). Both prompts (`SYSTEM_PROMPT`, `SCENE_FACTS_SYSTEM_PROMPT`) now teach the split explicitly; `user-clause.ts` is the deterministic net under them, applied in `classifyAmbient` and `classifySceneFacts`, restoring the clause as a verbatim `[user: …]` **prefix** (prefix, because the summary is truncated at 120 chars downstream).

Its trigger conditions are all narrow on purpose — it writes an *attribution* into permanent memory. Two are worth knowing before you loosen anything:

- **Only the user's own words count.** A character's dialogue is first-person too; the clause is claimed only when every content word in it appears in what the *user* said (`userSpokenLines` splits the `User:`/`Scene:` labels in the scene path).
- **The survivor must be positively about someone else** — an explicit non-user `subject`, or a summary that *opens with* a roster name. Measured, not assumed: without this test a live-store scan produced 169 hits, nearly all summaries that carried the user perfectly well and simply never named them (*"Speaks three languages"*, *"Was medicated through high school"*). Accepting a third-party *mention* anywhere still left 39. Subject position only → 4, two of which are the issue's verified cases. `scripts/user-clause-scan.mjs` re-runs that measurement read-only.

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
