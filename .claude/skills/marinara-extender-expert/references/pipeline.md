# Marinara Extender: The Ingestion Pipeline

*Grounded in `api.ts` (`/api/process-turn`) and `sentiment/pipeline.ts`. This is how a turn becomes memory. Open those files when an order or threshold must be exact.*

## Two entry points, one memory store

1. **Live, per-turn** — `POST /api/process-turn` (`api.ts`), fired by the extension after each AI response. Fast: a short synchronous spine, then everything expensive runs **fire-and-forget**.
2. **Batch import** — `runSentimentPipeline` (`sentiment/pipeline.ts`), reached via `/api/analyze-beats`, story import, and the long-form path. Windowed, resumable, the full Ledger-Pattern treatment.

Both produce the same artifacts: **beats** (emotional moments), **companion ledger entries** (what the loader actually injects), **facts**, **threads**, and tier/promotion bookkeeping.

## The synchronous spine of a turn (what blocks the response)

Only these run before `/api/process-turn` returns (`api.ts`):

1. **`resolveIdentity(characterId, characterName)`** → stable `identityKey`.
2. **Soft clock** *(gated; off by default)* — `updateSoftClock` → `timeCtx` attached to new entries.
3. **`extractRememberTags(messageText)`** (`writer.ts`) → create entries **synchronously**, deduped per scope+lane via `isDuplicate` with a per-message `indexCache` so two `[remember:]` tags in one message can't double-write. Summaries under 10 chars are skipped; `truncateSummary` caps length.
4. **`processResponse`** → extract `[bookmark:]` tags + **decay all bookmarks ×0.97**.
5. **`loadContext({ recentText: userMessageText + "\n" + messageText })`** → assemble the `<memory>` block. `recentText` drives Current relevance ranking.
6. **Return** `{ memoryBlock, created, bookmarksExtracted, surfaced }` (`api.ts`).

Everything below is kicked off as `void (async () => …)()` **after** the block is computed — it never delays the response.

## The fire-and-forget tiers (async, never block)

### Tier 2 — Sentiment / beats (`api.ts`, the richest path)
1. Build chunks: the user message (unless it's a long-form story, below) and the AI message — each is **one chunk**. `turnStart/turnEnd` come from `turnNumber`, **which the poller never sends** — see *Identity is provenance* below before you trust either field. Each chunk also carries its own `messageId` (2pbi); the two halves of a turn are two different engine messages and must not share one.
2. `classifyChunks(chunks, "chat")` → keep only `passesThreshold` (the fast keyword/salience gate; nothing passes → return early, no LLM spend).
3. `buildSubjectRoster` + `listActiveThreads` for context.
4. `analyzeChunks(passing, …)` → per beat: **emotion, motivation, relational dynamics, outcome, subtext, subject, thread label**.
5. **Subject routing** — `chunk.speaker` is the *session* label (the whole AI message is one chunk), so in multi-character RP it names the session character even when the beat is about a co-star. The analyzer's **`subject`** says whose inner state it is → `resolveNameToKey(subject)` routes the beat to that identity's ledger. **Unknown subject → holding pool (`addPending`), never guessed into a permanent ledger.** Player/persona subjects stay in the session ledger.
6. **Thread** — `resolveOrMintThread` matches the analyzer's label against the chat's active threads (fuzzy; labels drift), minting only when genuinely new.
7. `encodeBeat` → store the beat, **and** `createEntryIfUnique` a companion entry (`lane: character_topics`, `kind: "incident"`, summary `[emotion] motivation`).

### ⚠️ The substrate is an 8B local model — write for mimicry, not obedience

`callLlm` in the analyzer tries **local first** and only falls back, so `dolphin3:8b` performs every beat analysis. Small models do not follow instructions, they follow **examples**: compliance degrades with prompt length, imitation does not. Every failure prosecuted on 2026-08-04/05 is that signature — example-copying, later-instruction-wins, advisory guards ignored. The prompt suite was written for a frontier model's obedience and deployed on hardware that runs on proximity.

**House law: PROMPT ASKS, CODE ENFORCES.** Strip every rule from a prompt that a validator can hold instead. Measured on the tier-2 prompts: 13 bullet rules, of which **8 are validator-shaped** (sentence count, weight normalisation, subject-in-roster, genre/echo rejection, salience clamp, JSON-only, and the whole thread rule). Five remain — which is the rule budget, arrived at from the audit rather than imposed on it.

**The attention tax is measurable, so measure it before adding a line.** The pre-vikj prompt ran ~880 tokens (1246 for dysregulation), **80% identical across all ten emotions**, with `subtext` firing on 1% of beats while riding on all of them. **The vikj rewrite shipped 2026-08-20** (`challengerPrompt` in `analyzer.ts` — the constants keep their `CHALLENGER_` birth names to say which side of the sealed bench they came from): 529 tokens typical, 585 for dysregulation, one template instantiated per emotion via `CHALLENGER_FIELDS`, everything validator-shaped removed per packet §4, `{"no_beat": true}` taught explicitly (the parser had accepted it since 08-05 while the prompt said "say so" with nowhere to say it). The sealed challenger bench shipped it with **no author's exemption: x-echo 0% vs champion 12%, boilerplate 0% vs 3%, validity better (0% vs 2% invalid), distinct 97%, thread-emission 55%** at n=60/arm, quarantined, `echoesPhrases` as referee, verdict computed mechanically by `prompt-bench-v2.mjs --v3`. The five-arm v2 mode is historical — its LONG template no longer exists in code and it aborts by design. `subtext` still rides unconditionally (the conditional needs a classifier signal that doesn't exist; separate ticket).

**A chunk must clear a content floor before it can become a beat** (`s8qe`, shipped 2026-08-05). `min_chunk_tokens: 2` in `sentiment-config.yaml`, enforced in `classifyChunk` **before** scoring — so a structural pattern can't smuggle a sub-floor chunk through (a lone quoted `"ok."` scores 0.75 and is one token). It returns a clean no-beat: empty scores, `null` primaryEmotion, because callers branch on that too.

The floor exists because **the salience gate is emotion-keyed, not content-keyed**. It asks whether a chunk looks *emotional*, and one word can answer yes: the bare token `open` matches a vulnerability keyword, scores 0.59, clears 0.40. 513 such chunks reached the analyzer and **89.1% came back echoing a prompt example** (against ~5% everywhere else), with only 15.6% distinct.

Three things about this are worth carrying, because two plausible answers were measured and rejected:

- **The "U-shape" was one spike, not a slope.** The original 0–500 bucket read 21% echo; subdivided, *everything from 10 chars up* sits at the healthy 3–6%, and the average came entirely from 515 beats at 88.7%. **A 500-char floor would have discarded 2,099 unique real beats** to catch 93 further echoes. Coarse buckets hide the thing you're about to set a threshold from.
- **The axis is RAW tokens, not content words.** `skeletonTokens` looks like the principled choice and fails exactly where it matters: **for a short utterance the function words are the content**. `"I love you,"` has one content word — same as the junk token `open` — but three raw tokens against one. A content-word floor would have silently destroyed `"I love you,"` at salience 1.0, `"All of me,"`, `"You are a LIAR,"`.
- **It's a cause fix, not a symptom fix.** `rejectAsEcho` is a blocklist of sentences already seen; the floor removes the *condition*, so the next invented sentence — which no blocklist can know — is never generated. It sits beneath `4ghy` (the chunker minting `speaker: "status", text: "open"` from a `status: open` line), whose fixes have since shipped in layers — shape rule + recurrence floor (4ghy), ops routing at Stage -1 (hjt9); the one residue (unfenced prose-payload headings) is `03vh`.

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

### Three guards shipped alongside the verdict

- **The decline path.** `{"no_beat": true}` is now a legal reply (`parseAnalysisJson`);
  `reason` is tolerated, never required; the boolean is required (`"true"` and `1`
  don't count). Before it, the prompt told the model to decline and the schema gave it
  nowhere to say so — obeyable only by emitting malformed JSON. **`isDeclineResponse`
  is exported and the bench counts `declined` apart from `no-beat`**, because "JSON
  validity must not drop a point" is a sealed ship condition and a prompt that
  declines correctly must not be scored as if it emitted garbage.
- **The thread rule is conditional** on the user prompt carrying an `Active threads`
  block. **The no-list variant keeps the MINTING half** — every chat starts at zero
  threads, so minting is the only path by which a first thread is ever born, and
  deleting the block outright would sterilise thread creation silently. Measured
  saving is **23 tokens, not the ~120 estimated**, because the surviving label
  teaching is most of the block.
- **`bait-warrant.test.ts` enforces the arrest-warrant law.** It extracts every quoted
  illustration from the *built* prompt across all ten emotions and fails on any the
  echo ledger cannot arrest. Not a hand-maintained list — that rots. Thread-rule bait
  is quarantined in `KNOWN_UNCOVERED`, which may only ever shrink (`n9bv`).

### Contamination routing (`hjt9`) — built, measured, **not wired**

Two kinds, two instruments, and conflating them is the trap: `code-filter.ts` scores **code-shaped** content structurally (1.0% of the store, 8/8 hand-read genuine) but caught 3 echoes against 864 — it is *not* an echo fix. `paste-prior.ts` handles **prose-shaped** contamination by provenance, because "insists the boat was green" has no braces to find.

Two hard-won rules live there: **size is a prior, never a verdict** (all 116 chunks ≥6000 chars are spared by structure — the largest are 40KB RP scenes; a naive 6KB rule would have taken every one), and **route the partition, not the chunk** (a fence marks *those lines*, not the message around them — the same line-vs-chunk error was made twice, one file apart). Disposition is always route-and-mark, never drop.

The **cap** is the other arm and is now split out as `dkib`: monotonic degradation above 2000 chars (8% → 12.3% → 14.7%), but only ~42 echoes against the floor's 457. Split or window it — never truncate. Re-measure with `scripts/chunk-floor-scan.mjs` (read-only; scores echo with the shipped skeleton matcher, so reuse it as the referee rather than writing a second scorer).

**Guards must match shape, not characters.** The first echo guard held `"insists the boat was green"`; the model wrote `"insists **that** the boat was green"` and it sailed through into a real ledger 90 minutes after shipping. Use `skeletonTokens` + ordered-subsequence matching (`analyzer.ts`) — strip function words, stem, require ≥3 content stems in order. Any scorer or bench that grades echo must use the **same** matcher, or the referee undercounts exactly the way the guard did.

**Never bench a prompt without quiescing capture.** The live poller ingests the session's own working notes: 141 beat files in 90 minutes during one run, 14 carrying prompt artifacts, one filed under `speaker: BAD`. Set `MARINARA_EXTENDER_POLLER=0`, and verify afterwards by grepping the store for the arms' own example skeletons.

### The third category — prose that is nobody's speech (`mln9`, sized 2026-08-23)

`pe4o` gates on **our own prompt** (coverage against `ownPromptSignatures`). `hjt9` routes **code and structured payloads**. Neither reaches *third-party product documentation pasted for discussion* — Engine release notes are not our prompt, and they are prose: full sentences, ordinary vocabulary, no fences. **Measured: 6 beats store-wide** (`scripts/changelog-scan.mjs`, read-only), all `professor_mari`, 2 of them on the current build. Not legacy residue.

**mln9's predicted discriminator was falsified by the measurement, and instructively.** It hypothesised release notes show *no first/second person, no dialogue, dense proper nouns*. Scored that way the top 14 beats contained **zero** changelogs — they were the `hjt9`/`4ghy` code-and-log populations — while a plain release-notes paste ranked **1666th of 9,433**. Cause: user-facing release notes **address the reader** ("customize *your* experience"), so their person-rate runs *higher* than ordinary chat. The signal was not weak, it was **inverted**.

- **What separates them is the absolute count of sentence-initial enumeration verbs.** Positives 4, 6, 20, 26, 36, 53; every negative 0 or 1. No overlap, no tuning.
- **Count, not rate.** Per-100-words inverts for the same reason: the clearest positive (3,544 words, 20 openers) scores 0.56/100w — *below* a 224-word work note with one `Added` at 0.45. Length dilutes the signal it should confirm.
- **Density is structure; presence is vocabulary.** 33 beats contain ≥1 opener and would trip a presence blocklist; only 6 carry ≥3. The other 27 are real RP dialogue and genuine work notes. That gap is why the blocklist ban is right *and* why using the token is not one.
- **The genus split has a measure.** A character *reacting* to a changelog is ABOUT-WORK — a real utterance, and retiring it is the `fqnl` error with the sign flipped. Topic cannot separate paste from reaction; **dialogue rate** does, by 4× (pastes 0.003–0.016, reactions 0.063–0.076).
- **Coverage was measured, not assumed** — two nets that fail differently (enumeration verbs; issue-reference density). The 2 beats caught by refs alone were both ABOUT-WORK, so the nets disagree *semantically*, not by coverage failure.

⚠️ **The nine in the original report were never one population** — 5 changelogs, 1 ABOUT-WORK, 2 self-ingested *session reports*, 1 debug paste with a minted speaker. Three of the six carry a speaker minted from the changelog's own first line (`4ghy` overlap). The sibling class — **our own session reports** ("Done — committed (644a280) and pushed") — is `6cna`, unsized, and carries *no* enumeration structure, so it will evade this signal too.

**The detector** is `classifyChangelog` (`sentiment/changelog.ts`), benched 2026-08-23 and **WIRED 2026-08-24**. `OPENER_FLOOR = 3` sentence-initial enumeration verbs (case-sensitive — "i added a note" is not a list item), `DIALOGUE_CEILING = 0.03` spares anything that is somebody talking. Returns the split, never a boolean: `reason` distinguishes `below-floor` (not a list) from `dialogue` (a list, but it's an ABOUT-WORK save worth counting separately).

**Disposition is route-and-mark, never drop** (`hjt9`'s rule, and it has been the key throughout). A convicted message's **full text** — not an excerpt — goes to `data/changelog-lane.jsonl` before the message is emptied, so a suppressed paste is still evidence of what was discussed. It is a **sink, not a recall lane**: append-only, never read back, never injected. **Its own file, not `ops-lane.jsonl`** — the ops lane counts *lines of structure*, this counts *whole messages of third-party prose*; one ledger answering two questions is how a number stops meaning anything.

⚠️ **The lane records the SAVES too.** `spared-dialogue` is written whenever a message enumerated like release notes but was talking. Without those rows the ledger could only show what was suppressed, and "did it ever eat a real utterance" would be unanswerable by division — the exact hole `5x5y` sat in for three months.

- **Stage -1a in `pipeline.ts`, before `routeOps`** — not after, because `routeOps` *reduces* the message and reducing first can drop enumeration lines and pull a real changelog under the floor. Detect on what arrived, not on what survived.
- `classifyChunk` carries a second gate (`suppressedReason: "changelog"`) as **defence in depth** for story imports and re-analysis of stored text. A chunk-level *miss* is expected and accepted: a long changelog split across chunks divides its openers and each piece can fall under the floor. Do not lower the floor to fix that — the message gate is the one that sees the whole document.
- **Verified against the documents that did the damage** (house law #5): all six offenders suppress at both gates, both ABOUT-WORK beats survive, sink preserves full text.
- The six already in the store are **not** cleaned by this — that is `wct1`, and it must not be done by predicate sweep.

- **Held-out positives, and leakage verified rather than assumed.** 38 Engine CHANGELOG releases rendered into paste form → 29 held out, **9 excluded** for 8-word shingle overlap with the stored six. Benching against raw markdown would bench a document nobody pastes; the rendered form is why a real positive reads "Added Added optional image generation".
- **Pre-registered verdict rule, written into the script before the first run** — `s6cu`'s pilot was unadjudicable because its rule came after its results. Presence (A0) is **disqualified**: 100% recall but **27 bulk false positives**, precision 18.2%. Density (A1/A2): 93% recall, **0 FP**, precision 100%.
- ⚠️ **Floor 2 dominates floor 3 on every measured axis** (100% vs 93% recall, both at zero FP across 9,429 beats). **3 ships anyway, on the asymmetry** — at floor 2 the only thing sparing a real work note is the ceiling, at a 1.4× margin on a population of one. A miss costs today's behaviour; a false positive destroys a true record. One-line change if that trade is ever re-taken.
- ⚠️ **Sweep a parameter through the REAL decision path, or don't sweep it.** The first floor sweep varied the floor with *no ceiling*, reported 1 FP at floor 2, and made floor 3 look necessary. With the ceiling applied — as production runs — that FP is spared and the trade inverts.
- **The ceiling nearly got deleted for paying no rent.** At floor 3 it never runs (both ABOUT-WORK beats carry zero openers, so the floor already spares them) and A1/A2 come out identical. The sweep saved it: it removes 14 FPs at floor 1 and the last one at floor 2. **Load-bearing everywhere except the shipped floor** — the two constants are not independent. Exercised by three *synthetic* mixed-message controls (same device as `heading-mint-scan.mjs`), because the store contains no paste-and-reaction-in-one-turn message.
- **Runs at MESSAGE level**, beside `routeOps` — see the granularity law above. Enumeration survives chunking better than fences (sentence-terminal punctuation still marks items, which is why every flattened stored positive is still detectable), but a changelog *split* across chunks divides its openers and can drop under the floor. Both shapes benched; both pass.
- Pinned in `changelog.test.ts` (13 tests, must-not-fire cases first, excerpts are real beats). **Wiring is a separate slice** and should probably follow `hjt9`'s "route-and-mark, never drop".

### ⚠️ Prompt examples get returned verbatim (`pifl`)

The analyzer's `SHARED_RULES` illustrated *"two different moments can never produce the same sentence"* with a concrete example — and that example became **the most repeated sentence in the store**: 669 beats, across 4 characters, 37 chats and 35 days, with 542 ledger entries carrying it as their summary. In total **792 of 8,703 beats (9%) echoed a prompt example**, and *both* sides leaked — 107 beats opened with a paraphrase of the "too vague" example the rule was warning against.

How the alternatives were ruled out, because two plausible theories were wrong first:

- **Not a recall/injection loop** — only 1% of the source chunks that produced it mention anything like it, so the analyzer was not reading it back out of the text.
- **Not the model** — **zero** story-imported beats echo it, and the import path runs the same analyzer with a different context assembly.
- **One field collapses, the rest is fine** — an `[anger]` beat carrying a vulnerability motivation while `relationalDynamics` tracks the real text. The trigger is a huge chunk (6–8KB, sometimes not emotional at all — one was a discussion of `pipeline.ts`). Given nothing specific to say, the model returns the nearest phrasing it has been shown, and the prompt is nearest.

**The rule to carry forward: never write a prompt example that could plausibly be real output for this domain.** Illustrate the *shape* from an unrelated one. And back it with a deterministic guard — `echoesAnExample()` rejects an analysis whose motivation matches any example (returning `null`, the existing unusable-analysis path). Rewording is necessary and is not sufficient.

`PROMPT_EXAMPLE_ECHOES` deliberately **keeps retired examples**. The old wording is what the stored beats echo, so deleting a line silently re-opens the hole it closed.

This also poisoned two other investigations before it was found: it manufactured apparent subject misrouting (when motivation collapses, the subject is assigned loosely, so beats scatter across ledgers — see `bwgh`) and it inflated the written-vs-played confound by an order of magnitude (`7pcm`, where aurora's 129 chat beats turned out to be 112 echoes + 17 real). **Measure the echo rate before trusting any beat-level statistic.**

### ⚠ Fact provenance — the receipt is written by the model (`fqnl`)

`classifyAmbient` asks the model for `{text: <original sentence>, fact: <claim>}` and
the write path stores **`content: capContent(fact.text)`**. So an entry's body is the
model's *claim about* its source, not a captured quotation. **A model that invents a
fact invents its receipt with it** — fluent, internally consistent, and fictional.
Never treat `content` on a fact entry as evidence without checking it against the
Engine's chat log.

`fact-support.ts` + `scripts/fact-support-scan.mjs` do that check. Four things learned
the hard way, all of which cost a wrong answer first:

- **A provenance failure is TRIAGE, not a verdict.** It proves the receipt didn't come
  from the cited chat, which is equally consistent with a stale `sourceChatId`. Of 8
  flagged entries, **7 were stale provenance with true content** — four Aurora facts
  carrying the `professor_mari` chat she was migrated from. Retiring on the predicate
  would have destroyed them. `scripts/retire-unsupported-facts.mjs` therefore takes a
  hand-listed target set, never a predicate.
- **Count the missing words; don't average them.** The Kraków receipt scores 0.83
  corpus overlap because five of its six distinctive words are ordinary vocabulary
  found in any long chat. The one word that matters drowns. `receiptMissingWords`
  (count) convicts where `receiptCorpusOverlap` (ratio) acquits.
- **Checking a fact against its own stored sentence does not work at this fidelity.**
  The receipt is one sentence; the extractor saw the whole turn, so a fact
  legitimately draws a name from a neighbour. Calibration went 2048 → 1697 → 1441 and
  the residue was still mostly legitimate. The fix is storing more context at write
  time, not a better matcher.
- **The word existing is not the claim existing.** "neurolog" appears 11 times and
  "Kraków" 31 — none as an assertion about Mari. Corpus-wide claim analysis is what
  convicts; the provenance test only agrees.

**The structural gap: 9109 live entries carry no `sourceChatId` at all** (5410 do).
Silence there is not innocence, and no provenance guard is general until every write
path records it.

### Tier 3 — Ambient facts (`api.ts`)
`classifyAmbient` extracts durable identity/preference/history facts from throwaway lines. Same subject routing, with one difference: facts have **no holding-pool lane**, so an unknown subject is **demoted to chat scope** tagged `[about: subject]` rather than parked. Character-scope facts get `kind: "trait"` (the trait side of the dedup matrix vs. beats' `kind: "incident"`).

**A sentence can carry two facts about different people** (2tro). Given *"I was in the Army, and Mari is Polish."* the extractor kept `"Mari is Polish"` and dropped the user's clause outright — fact loss, not phrasing, because **retrieval scores the summary** and tp5's `bodyTerms` only rescues body-only *names* (`"my fourth sapper stakes"` has none). Both prompts (`SYSTEM_PROMPT`, `SCENE_FACTS_SYSTEM_PROMPT`) now teach the split explicitly; `user-clause.ts` is the deterministic net under them, applied in `classifyAmbient` and `classifySceneFacts`, restoring the clause as a verbatim `[user: …]` **prefix** (prefix, because the summary is truncated at 120 chars downstream).

Its trigger conditions are all narrow on purpose — it writes an *attribution* into permanent memory. Two are worth knowing before you loosen anything:

- **Only the user's own words count.** A character's dialogue is first-person too; the clause is claimed only when every content word in it appears in what the *user* said (`userSpokenLines` splits the `User:`/`Scene:` labels in the scene path).
- **The survivor must be positively about someone else** — an explicit non-user `subject`, or a summary that *opens with* a roster name. Measured, not assumed: without this test a live-store scan produced 169 hits, nearly all summaries that carried the user perfectly well and simply never named them (*"Speaks three languages"*, *"Was medicated through high school"*). Accepting a third-party *mention* anywhere still left 39. Subject position only → 4, two of which are the issue's verified cases. `scripts/user-clause-scan.mjs` re-runs that measurement read-only.

### Long-form story (`api.ts`)
When `userMessageText.length > LONG_USER_MSG_CHARS` (default 1500), the single user chunk is **skipped by Tier 2** and instead routed through the full `runSentimentPipeline` (windowed, every passing window analyzed, subject-routed) — so a multi-page memory told in one message lands with import-parity richness instead of collapsing to ~1 beat.

### Promotion & arc passes (cadenced)
- **Promotion — every 20 turns** (`api.ts`): `runPromotion("character")` + `runPromotion("chat")` + `autoCloseStaleThreads()`.
- **Arc promotion — every 60 turns** (`api.ts`): `runArcPromotion` clusters beats into/onto through-line arcs; spends one renderer LLM call per touched arc (hence the slower cadence).

## Tier 1 — Snapshot (the periodic digest)

Separate from the per-turn path: `digest.ts`, via `/api/snapshot` / `/api/digest`, called roughly every 30 minutes of active chat. An LLM digests recent messages into character-scope entries — a coarse safety net beneath the per-turn beat/fact capture. (See `digest.ts` for specifics.)

## The batch pipeline = the Ledger Pattern (`sentiment/pipeline.ts`)

`runSentimentPipeline` is the pattern applied literally — invoke the `ledger-pattern` skill when touching it:

- **Stage 0 — chunk** (`chunkMessages`): break messages on dialogue/narrator boundaries. POV relabel turns first-person "Narrator" into a named character.
- **Stage 1 — classify** (`classifyChunks`): fast keyword/salience filter → `passing`. For **chat** imports `analyzeAll` is true (the whole scene is one speaker label, so it can only be split by analyzed *subject*, not speaker); **story** imports keep the speaker pre-filter. **Three gates run before scoring**, each setting `suppressedReason` so a guard working and a guard misfiring are never indistinguishable — see *Stage-1 gates* below.
- **Stages 2+3 — analyze & encode, one chunk at a time** (`runSentimentPipeline`, `sentiment/pipeline.ts`): each chunk → `analyzeChunk` (with its true before/after neighbors + roster) → subject-route → `encodeBeat` + companion entry. **Persisted incrementally** — the on-disk beat store *is* the ledger: a cancel/crash keeps every completed beat, and a re-run resumes via deterministic `beatIdForChunk` (skipping done chunks while still ensuring their companion entry exists) — **but that determinism is over the chunk's *interpretation*, not its provenance; see *Identity is provenance* above before relying on it.** `forceReanalyze` bypasses the resume skip when a re-import's purpose is re-routing subjects.
- **Narrative-position boost** (`NARRATIVE_POSITION_BOOST`, `sentiment/pipeline.ts`): the final 20% of a story carries climax/resolution weight, so its beats' salience is boosted.
- **Durable-fact pass** (`ingestSceneFacts`, 1dn): runs over the **full** chunk set, not just salient ones — identity/lore facts live *below* the beat salience threshold, so they'd never become beats; captured separately. Guarded so a fact-pass failure can't fail an import that already saved beats.

## ⚠ Identity is provenance — `turnStart` is not a position in the chat (`r0kc`/`2pbi`)

**`turnIndex` counts across the array the caller passed in, not across the chat.** `parseTurns` starts at 0 every invocation, and the live path invokes the pipeline once per turn. The poller cannot do better — it reads a trailing window, not an absolute position — so `turnNumber` defaults to 0 and every live turn in every chat stamps `turnStart` −1 for the user line and 0 for the reply.

**Measured over all 8,841 stored beats:** one chat holds **25 distinct beats on `turnStart` 0** and 11 on −1; another holds 22 and 7. Any key of the form `chatId + turnStart + turnEnd` merges them.

Three consequences a reader needs before touching this area:

- **Every improvement to an interpretation moves ids.** `beatIdForChunk` hashes `speaker` and `text`, both readings of a chunk rather than facts about it. **Measured: 171 stored beats carry a `beat-<hash>` id that no longer recomputes, and all 171 trace to a single afternoon's re-attribution** (`5dqr`, which unmangled `NarratorNarrator07` → `Narrator` and 19 other timestamp-mangled labels). `unmangle-speakers.mjs` declares it in its own header — the churn is not hypothetical, it is a documented cost someone accepted because the alternative was worse.

  **Do not quote a larger number.** A further 560 beats also fail to recompute and have nothing to do with this: they carry random 10-char ids with no `beat-` prefix, written 2026-05-23 to 06-02 before deterministic ids existed, and travelled across `professor_mari`'s card migrations intact. They never derived from content. Counting the two together produces "8.3% of the store has drifted", which was claimed once in commit `0427ca5` and is wrong.
- **Provenance flows: `DigestMessage.messageId/swipeIndex` → `DialogueTurn` (+ `ordinal`) → `Chunk` (+ `ordinalStart/End`).** `ordinal` is the position *within one message* and resets per message — that is the whole difference from `turnIndex`, and collapsing the two would inherit the flaw.

### What matching uses now (`r0kc`, shipped)

`provenanceKeyForChunk` → `<messageId>:<swipe>:<ordinal>`, stored on the beat as `provenanceKey` and mirrored into the beat index. **Resume and dedup match on it first, falling back to `beatIdForChunk`.** That fallback is permanent, not debt: pre-2pbi beats and the story importer recorded no message id, and there is nothing to backfill one from.

- **`-` for the swipe means "this source has no swipes"** (the user's half of a turn) — a fact, not a gap.
- **`ordinalEnd` is deliberately out of the key.** Where a chunk starts is provenance; how far it runs is the chunker's merge settings.
- **`beatIdFor` derives the FILENAME from provenance when there is any.** The plan was to leave filenames alone entirely, and it could not survive contact: the legacy hash gives one filename to two different moments that happen to read the same — someone saying "I know." twice in a chat. Resume hid that by skipping the second as a duplicate, so the loss looked like deduplication. Nothing stored is renamed; only new beats get provenance-derived names.
- **`encodeBeat(..., reuseId)`** lets a forced re-import land *on* the beat a chunk already produced instead of beside it. The pipeline passes it only when the beat is staying in the same bucket — a subject-routed beat is going to a ledger this character's index cannot speak for.
- **Still on the legacy key:** the holding pool (`addPending` keys records by `beatIdForChunk`). Switching it would risk double-stacking the records already in `holding-pool.yaml`, so it is a separate decision.

**The pair stays a pair.** A re-roll keeps the message id and moves only the swipe index, so an id alone cannot separate "the same turn read twice" from "the user threw that reply away". The entry layer settled this first (`06pq`/`s2lw`, `IndexEntry.sourceMessageId` + `sourceSwipeIndex`); the beat layer mirrors those names deliberately rather than inventing a second vocabulary for one idea.

**A turn is TWO messages.** `/api/process-turn` historically knew only the assistant's id and stamped it on both halves — so a turn's user line and its reply counted as one moment for dedup, and a re-roll retired the user's entry although the user retracted nothing. `DetectedTurn.precedingUserMessageId` carries the other one; `poller.precedingUserMessageFor` finds the row that `precedingUserTextFor` used to read and discard.

**Still unprovenanced, by construction:** the story importer (no chat, no messages) and the long-form user-story path (a synthetic one-message array). ~25% of stored beats have no `sourceChatId` at all. Tagging the long-form path is *not* inert — `removeEntriesBySourceChat` purges by that field on re-import, and the import path chunks one long message differently, so tagging it would make a re-import delete memories it will not reproduce.

## ⚠ Retiring a beat did not take it out of recall — now it does (`pe4o`/`41uo`)

**The loader never reads the beat store for general recall.** It ranks over the ENTRY index and excludes on `deletedAt` / `discardedAt` / `supersededBy` / `provenance === "unplayed"`. `retiredAt` is not on that list and cannot be — it lives on the *beat*, and the beat was never the recallable copy.

So `retireBeats` alone removed a record from statistics and arc promotion and left the half that reaches the model exactly where it was. **Measured across all 541 retired beats: 24 of 24 pe4o retirements and 366 of 517 s8qe sub-floor retirements still had a live companion entry** — every caller in the store's history made the same mistake, so it was the function's bug, not the callers'.

**`retireBeats` now retires the companion entry itself (41uo, 2026-08-10)**, veto included, after marking the beats. Opt out with `{ companions: false }` only when the caller handles entries with per-entry reasons. `retireEntries` (`storage.ts`, 0y2i) remains the entry-side tier move: cold, full fidelity, out of recall, reason recorded, never listed as user-deleted.

**THE JOIN NEEDS A VETO, and this is the part that bites.** A companion is found by matching `companionEntryFromBeat(beat).summary` against the index — and summaries are *not* unique, because the model copies prompt illustrations verbatim. `"[fear] admits she's afraid the memory loss means she was never real"` is byte-identical across dozens of live beats. On pe4o's first dry run the naive join would have retired **32 entries belonging to beats nobody was retiring**. The rule (now inside `retireBeats`): retire a companion only when **no surviving beat** would produce that summary; report the rest and leave them. Machine text left in recall is recoverable, a real memory removed is not.

**The veto's verdict on the 366** (`scripts/retire-s8qe-companions.mjs`, 2026-08-10): retirable = **zero**. 348 of them share the pifl illustration summary with **90 live beats** — retiring them would take the only recallable copy of records nobody retired. That population is `lko9` (the pifl-echo stratum), not a retirement job.

Same shape as *count utterances, never hits* — one string, many records — except here it destroys instead of miscounting.

**Latent sibling (`dekl`, 0 instances today):** recap footnotes call `readBeat` directly, which does no retirement check, so a retired beat cited as a footnote is re-rendered into the prompt.

## Stage-1 gates (`classifier.ts`) — what never reaches the analyzer

Three gates run before scoring. Each sets `suppressedReason` on the result, because a chunk refused for being machine text must be distinguishable from one that was merely dull — otherwise nobody measuring "how much are we skipping" can tell a guard working from a guard misfiring.

| Gate | `suppressedReason` | Rejects |
|---|---|---|
| Content floor | `content-floor` | under `min_chunk_tokens` (2 raw tokens) |
| Self-prompt | `self-prompt` | ≥40% of the chunk is our own system prompt |
| Ops/meta | `ops-lane` | nothing survives partitioning as prose |

**Self-ingestion (`self-prompt.ts`, pe4o).** Prompt text pasted into a chat for review — the project's own required workflow — was being chunked, scored, analysed and filed under a character. 65 live records were built that way, 62 on one character, 47 in a single day; it is also the root of the bait rot, since the boat example's probe became corroborable because the *prompt containing it* was ingested. Signatures are **derived from the live prompt**, never hand-listed, for the same reason `bait-warrant` reads the built prompt: a hand list rots silently. `docs/PROMPTS.md` catalog furniture is registered too — the doc is generated *from* the prompts and exists to be pasted.

**Ops/meta (`ops-lane.ts`, hjt9).** `routeOps` splits a chunk into prose and structure. Structure goes to `data/ops-lane.jsonl` — **a sink, not a fourth lane**: `storage.ts`'s `Lane` type means a *recall* lane, so filing ops content there would classify it correctly and then feed it to the model anyway. The prose half is what continues, and `classifyChunk` returns the **reduced** chunk, so the analyzer's prompt, the stored beat's text and the echo guard's corroboration evidence all see what a person said rather than what they pasted. That is how "the escape hatch must not accept a paste of the phrase as the speaker having said it" is enforced — structurally, not with another special case inside the guard.

## House law: measure before you reason — and measure the measurement

**A rule that reads correct is not evidence. Run it against the store before you write it.** Every defect prosecuted on 2026-08-05/06 was found by measurement and none by review, including three written that same day by the person reviewing them.

The maxim alone changes nothing — this codebase's own objection to advisory guards applies to advice about guards. What makes it operational are the failure modes it names:

**1. The candidate rule must meet the real census, not a hypothesis.** A shape rule for the speaker bug (reject digits / all-lowercase / SHOUTY) looked obviously right and would have **rejected `user` (1,721 beats) and `professor_mari` (810)** — the two most important speakers in the store — because those come from `msg.role` and `characterName`, never from `SPEAKER_PREFIX_RE`. It also cheerfully kept `"Extract the emotional beat as JSON"` and `"Co-Authored-By"`. Reasoning produced a rule wrong in both directions at once; one run against 570 real labels showed it in seconds.

**2. Measure twice — the first measurement is the one that lies.** Three inflated counts in a single session, each looking like a bigger, scarier version of the true finding, which is exactly what makes them hard to catch:

| Reported | True | What it actually counted |
|---|---|---|
| 1,100 | 65 | whole-YAML scanning matched stored **field values** (`subpattern: bpd_testing`) |
| 683 | — | short bait fragments matched **quotations** of the phrase |
| 636 | 34 | one retired bait phrase matched 596 records — the **known pifl echo population** |

The generalisation: **when measuring contamination, the contamination's own artifacts are the largest false-positive source.** Only source text — `text` on a beat, `content` on an entry — answers "was this ingested". `bait-rot` hit the same wall and needed a `spoken` vs `derived` split before its number meant anything.

**3. A precision number is only valid for the scope it was measured in.** `code-filter`'s rules were measured safe at chunk level, where they touch the ops-shaped 1%. Per-line routing applied them to *every* chunk, and they began dropping markdown blockquotes of character-card prose and lines of dialogue. Widening a detector's scope invalidates its measurement and requires re-measuring.

**4. Measure at the granularity the code actually runs at.** The paste prior was declared "not doing decisive work" from a chunk-level scan. But the chunker joins turns with a space, so the evidence was destroyed before the detector saw it — mean score 0.061 whole-message against 0.003 at best chunk, a 20× collapse. The prior was never weak; the measurement was taken downstream of the shredder.

**The cheap version, when a full corpus run is not possible:** state the gap rather than skipping the step. The `4ghy` residue rule cannot be corpus-measured because the store keeps the minted speaker but not the line that produced it — so the honest move is a conservative rule whose failure mode is *unattributed* rather than *wrong person*, with the gap written down.

**5. Measure the fix against the documents that did the damage** (`hjt9`/`03vh`, 2026-08-10). `scripts/heading-mint-scan.mjs` runs the real Stage -1 + chunker over the actual offenders. Findings: **PROMPTS.md pasted whole mints zero speakers** — because `dump-prompts` fences every rendered prompt and fenced content routes to the ops sink, *not* because anything understands headings; the same `Format:` line outside a fence still mints. `analyzer.ts` source pasted whole still mints `"Format"` ×18 (score 0.566, *under* the 0.6 paste threshold — the size prior misses it, and a monologue rule is circular because heading families interleave with each other). The disarmed cases and both must-not-breaks (pasted transcripts keep minting; RP prose untouched) are pinned in `heading-speaker-mint.test.ts`; the unfenced-prose-heading residue is `03vh`, calibration-blocked with a collect-forward recommendation.

**6. A hypothesised discriminator can be *inverted*, not merely weak — so build the calibration set before the detector** (`mln9`, 2026-08-23). The issue named its expected signals (no first/second person, no dialogue, dense proper nouns) and they were plausible enough that the first scan implemented them directly. Scored that way, **zero** of the top 14 hits were the thing being hunted, and a textbook positive ranked 1666th. What caught it was cheap and should have come first: pull the handful of *known* positives, run the scorer, and look at **where they rank**. A detector that cannot rank its own known examples is not imprecise, it is measuring something else — and every count it produces will be a confident number about the wrong population. Note the asymmetry with rule #1: a census tells you what a rule would *hit*, but only labelled positives tell you what it would **miss**.

## House law: return the split, never a boolean

**A verdict about a whole chunk misfiles everything wrapped around the thing it detected.** A detector answers *"is this chunk X?"* when the honest question is *"which lines of it are X?"* Both read as correct code, and they diverge exactly on the material that matters most — real conversation with something pasted into the middle of it. The failure is silent: the prose dies with the paste and nobody sees it go.

Three incidents, all found by **measurement, never by review**:

- `code-shape-scan` — a chunk at 0.64 ops-shaped whose prose was *"god yeah dotenv loading is sonnet's KRYPTONITE…"* around a fenced block. Real memory.
- `paste-prior`'s fence override (`if (fenced) score = max(score, 0.9)`) — all six riskiest calls were Mari's own messages, e.g. *"TC. LOOK AT IT. look at your progress bar"* around one pasted log, routed whole at 0.90.
- the self-prompt gate — suppressed on **any** matching line, killing 2,242 characters of *"Read-only. Here's the smell, ranked…"* for quoting one schema line.

**The remedy.** Return the partition. When the unit genuinely cannot be split — every affected record in this store is a *single line* — use a **coverage ratio** rather than any-hit; that is the same idea at a granularity where lines do not exist.

**The sibling failure: a precision number is only valid for the scope it was measured in.** `code-filter`'s `shell-command` and `bare-literal` were measured safe at chunk level, where they touch the ops-shaped 1%. Per-line routing applied them to *every* chunk, and they began dropping markdown blockquotes of character-card prose (`> Do not proactively suggest breaks…`) and lines of dialogue (`"Zielińska. Party of three. Five-thirty."`). Widening a detector's scope invalidates its precision measurement and requires re-measuring. Fixing both took 310 touched chunks down to 140.

## Bait & the echo guard — four layers

The prompt's illustrations are **bait**: concrete enough to teach shape, absurd enough to self-flag, and registered in `PROMPT_EXAMPLE_ECHOES` so a parroted one is arrested.

- **`bait-select.mjs`** picks bait by **anti-join against the whole corpus**, not by ear. Two shipped examples went in-domain within 48 hours of being chosen by ear. Enforces: every content word under a frequency ceiling (25) except speech-act scaffolding; ≥2 zero-occurrence probe words; probe stems that prefix *no* raw corpus word. `--generate` mints candidates from a lexicon so no sentence is ever hand-written into a file or a message.
- **`bait-warrant.test.ts`** — every quoted illustration in the built prompt must be arrestable.
- **`bait-tripwire.ts`** — fires at ingestion when a bait word appears in a chunk. Generated bait has **no escape hatch**: its words are corpus-absent by construction, so their appearance means contamination, not authenticity. The hatch stays open for human-plausible legacy phrases, where the premise still holds.
- **`bait-rot.mjs`** — the inverse of `bait-warrant`: can the *store* now corroborate a warrant? Runs on `start.ps1` (non-blocking) and `.githooks/pre-push` (blocking). Exits non-zero on **current** rot only; failing forever on retired rot trains everyone to ignore it.

## The invented-name guard (`name-guard.ts`, `epf4`)

A *different* failure from echo, and a blocklist cannot reach it: **the model invents a partner when the chunk gives it none.** Measured over the 62 live beats on the vikj build, two intimate-source beats attributed the scene to "Professor Alexei Kowalski" and "Dr. Alexei Petrov" — names absent from their own source text. Two surnames for one invented person is the tell that this is filler generated on demand, not a wrong inference. The partner in those scenes is the **user**, and `motivation` becomes the companion entry's summary, so a fabricated person becomes retrievable and later reads as real.

Runs in `parseAnalysisJson` beside `rejectAsEcho`, over `motivation`, `relationalDynamics` and `outcome`. It reuses `factSupport` (`fact-support.ts`) rather than re-deriving proper-noun extraction — that module already owns the sentence-starter trap, possessive stripping, the truncation-fragment rule and the 3-char stem match that stops "Polish" convicting "Poland".

Three design rules, each the conservative direction:

- **Neutralise, never reject.** The beat is a real moment and only the noun is false, so the unsupported name (with any honorific) is replaced by `someone`. Rejecting would destroy a real memory to remove one wrong word — the false-positive cost this project treats as strictly worse than the bug.
- **Never infer the right answer.** It would be easy to substitute "the user", since the partner usually is. Inferring an identity is the behaviour being fixed. `4ghy` already ruled this shape: an unrecognised label leaves the record **unattributed**.
- **Exemptions load inside the guard, not from callers.** A caller that forgot to pass them would convict *real* names — the dangerous, silent direction. `knownNames()` (memoised, 5 min) reads alias canonicals + aliases, the identity-map roster and the declared user identity, and returns **`null`** when it cannot read them. Null disables the guard entirely: an empty list would mean "nobody is real" and strip every name in the store.

**Countable on purpose** (`5x5y`): every substitution appends to `data/name-guard.jsonl` with before/after. Subtext sat at 0.7% for months and read as working because nobody could put a denominator under it; a guard that fires silently is that failure wearing a fix.

**Known deliberate miss**, pinned in `name-guard.test.ts`: an invented surname welded to a real given name inside one span ("Mari Kowalski") escapes, because the guard only collapses a span whose *every* capitalised token is unsupported. Widening that would delete true names to remove false ones. If the shape appears in the store, fix it with per-token substitution inside the span.

## Subtext enforcement (`intimacy.ts` + `enforceSubtext`, `5x5y`)

**The field never worked.** `subtext` has been requested since May and was emitted on **11 of 1,574** beats whose own source is intimate — **0.7%**, peaking at 0.8% in June and never higher. It was not a regression and vikj did not break it: normalising by qualifying content per month shows no decay to explain. It was an **optional field that nothing enforced**, which is the advisory-guard failure with a longer fuse.

> **Method warning, worth more than the fix.** The first diagnosis compared raw counts across months and reported a "7-week silent failure". Activity had collapsed at the same time (1,339 → 156 → 79 intimate beats), so "subtext stopped" and "the content stopped" predicted the same observation. **Normalise by exposure before attributing a change to a date** — see `bd memories count-vs-rate`. A near-zero base rate is especially dangerous, because every quiet period "confirms" the story.

**The detector** (`classifyIntimacy`) is deliberately **high precision, low recall**, because the errors are asymmetric: a false positive demands a subtext for a chunk that has none, the model invents one, and the invention is filed as fact (`epf4`). A false negative just leaves today's behaviour. Nothing existing could be reused — the `desire` lexicon is about *wanting* and fires on a chunk about a sleep-debt ledger.

- **STRONG markers decide; WEAK markers only inform.** Convicting on two weak markers was tried and dropped after measurement: it added 298 store-wide hits at ~40% precision (firing on "in bed talking about polyamory and GDPR", on pasted telemetry, on a director's stage note) to gain **3** true catches. Weak markers are still collected as evidence for diagnosing a wrong call.
- Recall against the only ground truth available — beats where the model volunteered a subtext unprompted — is **12/17** on strong markers alone.
- `scripts/intimacy-scan.mjs` measures it: `--weak-only` shows the risky class, `--near-miss` shows what recall costs. **Measure the eras separately** — pre-`pe4o`/`hjt9` beats are full of conversation *about* intimate fiction (pasted beat dumps, story planning, literary critique), so a whole-store precision number badly understates the live path.
  - ⚠️ **The instrument has a known blind spot (`mjqe`).** It filters on a `beat-` filename prefix, but **both** conventions are live in this store (`beat-<hex>.yaml` and a bare `<id>.yaml`), so it silently skips **568 of 9,445 beats** — including *all* of `lara`, `lara_2` and `lara_3`. The blind spot is not uniform across characters, so it is a bias, not a sampling error. This does **not** overturn the 0.7% headline (a ~6% denominator shift cannot rescue a near-zero rate); read those numbers as measured on 94% of the store until `mjqe` lands. Any new scan must iterate on `.yaml` alone — `scripts/changelog-scan.mjs` does, and says why in a comment.

**The enforcement** runs after `parseAnalysisJson`: if the chunk is intimate and subtext is absent, **one** retry appends `SUBTEXT_RETRY` (readable at `/prompts`, reviewed 2026-08-21). Then the subtext is **grafted** onto the original analysis — the first answer's other fields were fine, and the retry exists to fill one gap, not re-litigate the beat.

**A second refusal is an accepted outcome.** Enforcement whose only accepted answer is a filled field produces *invented* subtext, not subtext, so the instruction carries an explicit escape hatch and the miss is recorded instead. Every required case appends to `data/subtext-enforcement.jsonl` with outcome (`first-try` | `after-retry` | `declined` | `retry-failed`), the markers that triggered it, and an excerpt — so the rate is a division anyone can read. That ledger is the actual fix: the original failure survived three months because nobody could put a denominator under it.

**Single-channel exposure.** Bait appears in the system prompt and in no other artifact the pipeline can ingest. It lives in `src/sentiment/bait.json`, is never quoted in source, tests or docs, and is redacted from `docs/PROMPTS.md` and `bait-audit` output. **Rotation, not secrecy, is the defence** — anti-join costs seconds, so anything exposed is replaced.

**When counting contamination, the contamination's own artifacts are the largest false-positive source.** Measured three times in one session, each inflated number looking like a scarier version of the true finding: whole-YAML scanning counted stored *field values* (1,100 vs 65); short bait fragments counted quotations (683); the pifl phrase matched 596 records alone (636 vs 34). Only source text — `text` on a beat, `content` on an entry — answers "was this ingested".

## Cadence & threshold quick-reference

| Thing | Value | Where |
|---|---|---|
| Promotion pass | every **20** turns | `api.ts` |
| Arc promotion | every **60** turns | `api.ts` |
| Snapshot/digest | ~every **30 min** active | `digest.ts` |
| Long-form trip | user msg > **1500** chars | `LONG_USER_MSG_CHARS` |
| Bookmark decay | **×0.97** per turn | `writer.ts` / `storage.ts` |
| Narrative boost | **×1.3**, final 20% | `NARRATIVE_POSITION_BOOST` (`sentiment/pipeline.ts`) |

## Invariants & gotchas

- **Every beat needs a companion ledger entry.** The loader builds the injected `<memory>` block from the **entry index, not the beats store** (`runSentimentPipeline`, `sentiment/pipeline.ts`). A beat with no companion entry is invisible to recall. Never encode a beat without `createEntryIfUnique`.
- **Never guess a subject into a permanent ledger.** Unknown subject → holding pool (beats) or chat-scope `[about: …]` (facts). Guessing pollutes a character's memory irreversibly.
- **Fire-and-forget must never block or throw into the response.** Each tier is wrapped in its own `try/catch` and `void`-ed. A failed tier logs a warning; the turn still returns its block.
- **Measure before you reason, and measure the measurement.** A rule that reads correct is not evidence; the first count is usually inflated by the system's own artifacts. See *House law* above.
- **Return the split, never a boolean.** Any detector deciding "is this chunk X?" must return which *lines* are X. Three separate incidents; see *House law* above.
- **A precision number is only valid for the scope it was measured in.** Widening a detector's scope requires re-measuring it.
- **Dedup is `kind`-aware** — `incident` (beats) vs `trait` (ambient facts) go through different bars in the dedup matrix (`dedup.ts`). Pass the right `kind` or dedup misfires.
- **The import path is windowed + resumable by design** — don't "optimize" it into one big call; that's the exact failure the Ledger Pattern exists to prevent.
