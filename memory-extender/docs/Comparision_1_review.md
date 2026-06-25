# Review: `Comparision_1` — Gemini's Technical Study vs. the actual Extender

*Slice-by-slice comparison of the Gemini "Comprehensive Technical Study" against the real Marinara Extender architecture (grounded in `memory-extender/src/` and the `marinara-extender-expert` references). Built per the Ledger Pattern — one section at a time, written before moving on.*

**Verdicts:** ✅ accurate · 🟡 partial / imprecise · ❌ wrong · ❓ unverified (can't confirm from code/references — flag to check)

---

## Slice 1 — Intro + Ecosystem History (L1–7)

**Mostly accurate framing, two things to flag.**

- ✅ **Problem framing** — "static pruning queues degrade long-term consistency at million-token scale," solved by "persistent external memory organized by scopes and data lanes." Correct: scopes (`global`/`character`/`chat`) + lanes (`open_threads`/`user_topics`/`character_topics`) are exactly the model.
- ✅ **Pasta-Devs + TypeScript** — Marinara Engine is by Pasta-Devs and is a TypeScript codebase (client/server/shared workspaces). Correct.
- ✅ **Three agent phases** — "system agents running on three pipelines: pre-generation, parallel, and post-generation." Correct; those are the real engine agent phases.
- ✅ **Naming-collision disambiguation** — Chris Schmich's "Marinara" (MIT, JS/Vue/Ruby Pomodoro Chrome extension) is unrelated. Correct and a good clarification.
- ✅ **"currently undergoing a major refactor to the Tauri framework"** — **Verified TRUE against git.** `Pasta-Devs/Marinara-Engine-Refactor` is described verbatim as *"A refactor of Marinara Engine to move to Tauri for multi-platform support"* (TypeScript 86.7% / Rust 10.8% / CSS). The *current released* engine (`main`) is still the Node/TS pnpm monorepo with no Tauri, so Gemini's *"currently undergoing"* tense is exactly right. *(My initial skepticism was wrong — concrete proof of why source/git verification matters: from memory I'd have flagged a correct claim.)*
- 🟡 **"Marinara Extender acts as an add-on operating at the post-generation stage"** — **Imprecise, could mislead.** True that it acts *after* the turn generates. But architecturally it is **not** an in-engine post-processing *agent* in the pipeline — it's a **separate sidecar server + a thin client extension** that fires *post-turn* (after the response renders) and POSTs to `localhost:3001`. Calling it a "post-generation stage add-on" blurs it with the engine's own post-proc agents. Correct framing: *external extension + sidecar, triggered post-turn.*
- 🟡 **RPG Companion authorship/feature history** — Plausible (SpicyMarinara ↔ Marinara; RPG Companion is a real ST extension that tracked state/info-boxes/inner-thoughts), but the specific attribution chain isn't something I can verify from code. Treat as plausible background, not load-bearing fact.

**Section take:** Solid intro, and it holds up under git — the Tauri refactor checks out (verified). The only thing I'd *sharpen* is the "post-generation add-on" phrasing → "external sidecar + extension, triggered post-turn," so nobody reads the Extender as an in-engine post-proc agent. Your reasoning about what the Extender *is* holds.

---

## Slice 2 — Sidecar Model + Boot + Post-Turn Flow (L8–32)

**Fully accurate — the cleanest section so far, verified against source.**

- ✅ **Sidecar model** — "local Node.js server + thin extension loader in the browser; heavy logic/storage isolated from rendering." Correct (Fastify server + loader-fetched extension).
- ✅ **The ASCII pipeline diagram** — extract `[remember:]`/`[bookmark:]`, analyze beats via the internal model, promote/demote + archive, construct **`<memory_system>` + `<memory>`** blocks, load **2 fixed per-character Lorebook entries**, injected each turn. Every box checks out. The tag pair is **confirmed in source**: `loader.ts:277/375` wraps the Instructions entry in `<memory_system>…</memory_system>`; `loader.ts:592` wraps the live block in `<memory>…</memory>`.
- ✅ **Boot/install** — clone from GitHub; the Windows start script installs deps, launches Ollama, pulls models, and runs a crash-recovery watchdog; macOS/Linux launched manually on Node 20+. Matches the launcher + README.
- ✅ **Loader install** — download the small loader from the setup page, upload to Marinara; it registers JS via the engine's declarative extension format. Correct (the install-once loader that then fetches the live extension).
- ✅ **Post-turn flow** — extension intercepts the finished response → POSTs the whole turn to the sidecar (REST) → regex-extracts `[remember:]`/`[bookmark:]` and strips them from visible text → forwards to the local model for fact/emotion analysis → regenerates the two always-on Lorebook entries for the next turn. Accurate end-to-end.

**Section take:** Nothing to correct. The diagram and the post-turn loop match the code exactly, down to the `<memory_system>`/`<memory>` tag detail.

---

## Slice 3 — Environment Variables (L33–51)

**Defaults all correct; one mechanism claim is imprecise; table is a representative subset.**

- ✅ **Every default value matches source** — PORT 3001, LOCAL_URL `127.0.0.1:11434/v1`, LOCAL_MODEL `dolphin3:8b`, EMBED_MODEL none, API_KEY none, DIGEST_UPSTREAM `api.openai.com`, DIGEST_MODEL `gpt-4o-mini`, RWA_PATH none, TIMESENSE 0, EIDETIC 0, BUDGET_CHAT/CHARACTER/GLOBAL 4000/2000/1000. Verified against `llm-config.ts` + `loader.ts:44–46`.
- ✅ **Lorebook-limit reasoning** — "16,384-token Lorebook limit; engine silently discards over-budget entries; the ~7,000 default total (4k+2k+1k) is sized to stay safely under it." Correct and well-reasoned: `ME_LOREBOOK_TOKEN_BUDGET = 16384` in the extension, and the engine does drop over-budget entries (the exact silent-failure the extension guards against by forcing the budget up).
- 🟡 **"token budget values are reread directly from the disk … after each chat turn"** — **Mechanism is wrong, conclusion is right.** `getBudgets()` (`loader.ts:33,38–47`) reads from **`process.env` at call time** — its own comment says *"Read at call time (not module load) so the .env loaded by index.ts is respected."* It does **not** re-read the `.env` *file from disk* each turn. The "change on the fly without a restart" payoff is **true**, but it works because the `/api/config` form updates `process.env` (and rewrites `.env`), not because the system re-reads the disk file per turn. Small but real distinction.
- ℹ️ **Completeness** — the table is a representative subset, not exhaustive. It omits `MARINARA_EXTENDER_PROGRESS`, `MARINARA_EXTENDER_ALLOWED_ORIGIN`, `MARINARA_EXTENDER_RECONCILE` / `_RECONCILE_MODEL`, and `ME_HTTP_LOG`. Not an error — just note it isn't the full set if this doc is meant as a config reference.

**Section take:** Accurate where it counts (defaults + the budget-vs-Lorebook-limit logic). The only fix: it's `process.env`-at-call-time, not a per-turn disk re-read. Your "tune budgets live" design holds — Gemini just mis-described the plumbing.

---

## Slice 4 — Scopes, Lanes & Bookmark Decay (L52–76)

**Core model + decay math correct; three imprecisions to fix.**

- ✅ **Scopes & 2-D grid** — Global (1k) / Character (2k) / Chat (4k) × three lanes, "scopes × lanes" framing, decreasing lane priority. Correct; lane priority `open_threads → user_topics → character_topics` is `LANE_PRIORITY` in `loader.ts:53`.
- ✅ **Decay algorithm** — `W_t = W_{t-1} × 0.97`, default weight **0.5**, surfaced by a **stochastic roll** (weight vs. random [0,1]) as a subtle hint, pruned when it falls below the floor. All confirmed: `writer.ts:156` (`weight * decayRate`), `:47/:63` (default 0.5), `:188` (decayRate 0.97), `:157` (prune-below-threshold); the weighted random surfacing is the loader's bookmark roll.
- 🟡 **"W_start ∈ [0.1, 0.9]"** — **Range not enforced in code.** The model-supplied weight is clamped to **[0, 1]** (`writer.ts:47,63`: `Math.min(1, Math.max(0, …))`), not [0.1, 0.9]. The **default 0.5** is right; the [0.1, 0.9] band may be a prompt-suggested convention but the code accepts 0–1. State it as guidance, not a hard range.
- 🟡 **"decays after each chat turn that does not directly interact with the bookmark's topic"** — **The topic-interaction qualifier isn't in the decay code.** `writer.ts:156` decays **every** bookmark each turn, unconditionally (then prunes). I see no "refresh/skip-decay when the topic recurs" branch in the decay path. Either the qualifier is an over-statement (decay is unconditional) or there's refresh logic elsewhere worth pointing to — flagging for your confirmation, but as written it reads as conditional when the code is not.
- 🟡 **"Open Threads is the only lane that supports a lifecycle closure status (done)"** — **`status` is a universal field.** `EntryStatus` (`open/in_progress/done/deferred`) lives on **every** `Entry` (`storage.ts`) regardless of lane, and the loader filters `done` out of Current for all lanes. `open_threads` is where closure is *actually exercised* (tasks/threads that complete), but it isn't the only lane that *supports* status. Reword to "the lane where status closure is primarily used."

**Section take:** The decay engine and scope/lane grid are right. Fixes: weight clamps to [0,1] (not [0.1,0.9]); per-turn decay is unconditional (confirm if there's topic-refresh); and `status` is a universal field, just mostly used on `open_threads`. None of these break your design — they're precision corrections to Gemini's description.

---

## Slice 5 — Narrative Arcs / Clustering Layer (L77–81)

**Accurate — verified against source.**

- ✅ **Scene Recaps** — local model compiles a concluded scene into a prose summary, keeping the most prominent beats as footnotes. Correct (scene-recap ingestion; recap entries carry `footnoteBeatIds`).
- ✅ **Through-line Arcs via embedding cosine** — confirmed: `arc-promotion.ts:36` imports `cosineSim`/`fetchEmbeddings`; `:45` `EMBED_EDGE_TAU = 0.62` (kNN pair-edge), beat vectors cached at `beat-embeddings.yaml`. **Enrichment:** clustering is actually a **union-find over three signals** (`:10,:109`) — entity-name overlap (2+), embedding-kNN cosine, and thread/centroid match — not cosine alone. The embedding-cosine claim is right; it's one of three generators.
- ✅ **Semantic Retrieval** — through-line recaps surface by **vector similarity**, not keyword match, so "story so far" appears even when current wording differs. Correct (`recap-activation` semantic activation).

**Section take:** Accurate. Worth adding that arc clustering blends embedding-cosine with entity-overlap and thread/centroid matching (three signals, union-find) — the reality is a bit richer than the "cosine distance" single-mechanism description, not wrong.

---

## Slice 6 — REST API (L82–120)

**Every listed endpoint is REAL and correctly named — zero inventions. The list is a curated subset, and it out-corrected my own skill reference.**

- ✅ **All listed routes verified against source** (`api.ts` + `index.ts`): entries/bookmarks CRUD; estimate/analyze-beats; ingest-story; beats; **beats-to-entries** (`api.ts:1443`); pending-speakers; resolve-speaker; aliases GET/POST/DELETE; **ignored-speakers** (`:1711`); **restore-speaker** (`:1717`); **orphan-character** (`:1726`); scopes; health; memory-block; process-turn; cleanup; backup; and **`/api/identity`** (`:1738`). Not one fabricated endpoint.
- 🔎 **Caught an error in my own `architecture.md` reference.** Gemini correctly lists **`GET /api/identity`** (singular); my skill's `architecture.md` wrote `/api/identities` (plural). **Source says `/api/identity`** (`api.ts:1738`) — Gemini right, my reference wrong. Fixing the reference (code-wins + session-close skill rule).
- ℹ️ **Curated subset, not exhaustive** — omits a sizable real surface: the **conflict-resolution endpoints** `/api/supersessions` (`:1492`), `/api/retired` (`:1502`), `/api/rollback` (`:1509`); `/api/threads(/:id/close)`, `/api/arcs(/promote)`, `/api/scene-recap`, `/api/pre-turn`; identity sub-routes (`/relink`, `/name`, `/:key/export`, `/import`); the `/v1/chat/completions` inference proxy; and `/api/digest|snapshot|recite|ingest-commands|extract-text|deleted|promote-all`. **Worth flagging:** the omitted `supersessions`/`retired`/`rollback` trio *is* the conflict-resolution surface — directly relevant to the doc's later "Conflict resolution: Manual" claim.
- ✅ **`?status=all` / default `done`-filter** — consistent with the confirmed "filter `done` out of Current by default" behavior.

**Section take:** The strongest accuracy signal in the doc — real endpoints, correct names, zero hallucinations, and it even out-corrected my own reference on `/api/identity`. The only gap is breadth: user-facing core, missing the reconcile/arc/identity-admin surface.

---

## Slice 7 — YAML Storage & Indexing (L121–127)

**Fully accurate — the `index.yaml` field list matches `IndexEntry` exactly.**

- ✅ **Flat YAML over SQLite/vector DB**, with transparency / git-diff-ability / per-file corruption isolation. Correct.
- ✅ **`index.yaml` as a "hot lookup table"** mapping id → physical path, summary, token size, lane, **tier**, and status. This matches `IndexEntry` (`storage.ts:30`) field-for-field — and "hot" is exactly right: there's a parallel `index.cold.yaml` for archived rows (the hot/cold split the doc implicitly nods to).
- ✅ **Auto-updated on init/modification; don't hand-edit** — correct (`upsertIndexEntry`/`mutateIndex`), and the code even guards it: `upsertIndexEntry` refuses to overwrite an *unreadable* index and points to `scripts/repair-indexes.mjs`, so "avoid state desync" is enforced, not just advised.
- ➕ **Reality is stronger than stated** on corruption: it's not only "individual files" — writes are **atomic + durable** (temp → `fsync` → `rename`, per-path serialized; `storage.ts:184`), specifically for power-loss/BSOD safety. Gemini under-sold this.

**Section take:** Accurate and precise; the index-field list is spot-on. If anything, the durability story is *better* than described (atomic+fsync writes, hot/cold index split).

---

## Slice 8 — Security & Network (L128–131)  ⚠️ contains the review's biggest error

**The Extender's own security (L130) is accurate. L131 describes the *Engine's* auth — and its headline Tailscale/Docker claim is WRONG.**

- ✅ **CORS / CSRF (L130)** — the Extender's real inbound security: binds loopback `127.0.0.1`, `MARINARA_EXTENDER_ALLOWED_ORIGIN` registers extra safe origins, per-process CSRF token blocks malicious-site forgery. Correct (`cors.ts`/`csrf.ts`/`index.ts`).
- 🟡 **L131 is mis-scoped** — "Integration of the Marinara Engine Authentication Mechanism" sits in the *Extender's* security section, but **the Extender implements none of it.** A grep of `memory-extender/src` shows no `ADMIN_SECRET`, no `100.64`/`172.16` ranges, no inbound Basic Auth (the only `Authorization` headers are the Extender's *outbound* LLM-provider calls). This is the **Engine's** auth model, which the Extender coexists with but does not build into its own code.
- ✅ **Engine loopback-trust + `ADMIN_SECRET`** — verified in the engine's `privileged-gate.ts`: loopback bypasses the secret unless `isAdminSecretRequiredOnLoopback()`; privileged access otherwise needs the `x-admin-secret` value. The "loopback unrestricted + admin-secret for sensitive tasks" model is real and recent (staging — matches "latest updates").
- 🟡 **"Basic Auth"** — imprecise. The engine gates privileged access via an **`x-admin-secret` header**, not classic HTTP Basic Auth.
- ❌ **"automatically trusts and bypasses authentication for Tailscale (100.64.0.0/10) and Docker bridge (172.16.0.0/12)" — WRONG, and backwards.** Verified against the engine's `security.ts`: both ranges are treated as **RESERVED/BLOCKED** (`isReservedIp`/`isPrivateNetworkIp`), not trusted. There is **no** Tailscale/Docker-specific auth bypass anywhere (neither `security.ts` nor `privileged-gate.ts`) — **only loopback is trusted**, and that's gated by `ADMIN_SECRET`. A reader would believe these networks get a free pass; the code does the opposite.

**Section take:** The review's most important correction. The Extender's own CORS/CSRF story is right, but L131 (a) mis-attributes the Engine's auth as an Extender feature, and (b) makes a confident, specific, **false** claim that Tailscale/Docker ranges are auto-trusted — they're blocked. If any of your reasoning leaned on "Tailscale/Docker get a free pass," drop it: only loopback is trusted, behind the admin secret.

---

## Slice 9 — SOTA Comparison: Mem0 / Zep / Letta (L132–145)

**Fair and conceptually accurate on the external systems; one row understates the Extender.**

- ✅ **External SOTA descriptions are accurate at the mechanism level** — Mem0's `ADD/UPDATE/DELETE/NOOP` fact classification + User/Session/Agent scopes; Zep/Graphiti's bi-temporal model (event vs. transaction time, validity windows, never-delete); Letta/MemGPT's context-as-RAM / DB-as-disk with `core_memory_append`/`core_memory_replace` self-editing tools. All real designs — not strawmen.
- ❓ **Specific benchmark numbers are unverifiable** (cited sources, beyond my cutoff): Mem0 "$24M Series A 2026" + "~1.7k tokens / ~200ms p95"; Zep "up to 600k tokens". Plausible, but treat as sourced claims, not verified facts.
- ✅ **Extender-side rows mostly correct** — flat YAML, `[remember:]` + beat extraction, ~7k budget, extremely-low local-YAML latency, "folder cabinet + decaying bookmarks" philosophy. Match.
- 🟡 **"Conflict resolution: Manual" — understates the Extender.** Not purely manual. **FR2 supersession is automatic, on by default:** `dedup.ts` detects a correction signature ("sister is Mei" → "sister is Lin") and auto-`supersedeEntry`s the old fact → cold/**Retired** (`/api/retired`, restorable via `/api/rollback`). On top sits an **opt-in LLM reconciliation curator (FR3, `reconcile.ts` + `apply-gate.ts`)** deciding UPDATE/NEGATE/EXPAND/DISTINCT. The accurate row: *"auto structural supersession (default) + opt-in semantic curator, with a Retired/rollback review lane."* The "pushes old facts to Retired" half is right.

**Section take:** Fair comparison, legit SOTA write-ups. The one correction: the Extender's conflict resolution is **more capable than "Manual"** — FR2 auto-supersession runs by default, FR3 adds an LLM curator. Hold this — it directly undercuts the doc's own "belief contradiction" limitation in the next slice.

---

## Slice 10 — Advantages & Disadvantages (L147–158)

**Advantages all accurate. Of four "limitations," two are spot-on; two are overstated because they ignore systems the Extender already has.**

**Advantages:**

- ✅ **Local-first + Dolphin 3.0 uncensored** — fully local pipeline; uncensored model is a functional requirement for the domain. Correct.
- ✅ **Behavioral-psychology decay** (W×0.97 + stochastic roll ≈ gradual fade + occasional resurfacing). Fair characterization.
- ✅ **YAML transparency / no whole-DB corruption** — correct (per-file + atomic writes; "never corrupts" is strong but the design does avoid it).
- ✅ **Single-proxy / shared VRAM** — `/v1/chat/completions` lets the Rewrite Assistant + Extender share one Dolphin instance. Verified (inference proxy + `MARINARA_RWA_PATH`).

**Limitations:**

- 🟡 **Tag Dependency** — real, but **"immediately disrupted" overstates it.** The explicit `[remember:]`/`[bookmark:]` path depends on model compliance — but the **automatic Tier-2 (sentiment beats) and Tier-3 (ambient facts) extraction run regardless of tags**, so a non-compliant model *degrades* capture, it doesn't halt it. The doc's "relies *partly*" hedge is right; the "immediately disrupted" conclusion isn't.
- 🟡 **Belief Contradiction** — **overstated; ignores FR2.** "Loads by static priority and only pushes old info to cold when the budget runs out" is **wrong**: `dedup.ts` **auto-supersedes** a corrected fact (correction signature → `supersedeEntry` → Retired), on by default. The *real* gap is narrower — FR2 detection is **structural/lexical**, so semantic-only contradictions with low word overlap (the doc's "moved cities / changed jobs") *can* slip through in the default config, which is exactly what the **opt-in FR3 semantic curator** (`reconcile.ts`) addresses. Partially valid (semantic, default config), but mis-stated.
- ✅ **No Multi-hop Reasoning** — accurate. The Extender resolves identity/aliases but has **no relationship graph**; it can't bridge user→brother→brother's-friend. Legit gap.
- ✅ **Lack of Time Sense** — accurate. `TIMESENSE` off in v1.0; decay is turn-count, not story-time; a "3 years later" jump doesn't age bookmarks. Legit (the `soft-clock` exists but is disabled).

**Section take:** Advantages fair. Of the four limitations, **multi-hop and time-sense are accurate**; **tag-dependency and belief-contradiction are overstated** — they describe a simpler system than the code, ignoring automatic Tier-2/3 extraction and the FR2/FR3 reconcile system. This matters for the next slice: **two of Gemini's "future proposals" are already partially built.**

---

## Slice 11 — Proposed Improvements vs. Your Roadmap (L159–175)  ⭐ the payoff

**Two of four proposals are ALREADY BUILT. One is genuinely new and worth filing. One is partially built.** The proposals are sound — but because the doc under-mapped the reconcile (FR2/FR3) and automatic-extraction subsystems, half of them re-propose features that exist.

- ✅ **#1 Tagless Fact Extraction — ALREADY BUILT.** "Async background worker; after each turn send the message pair to the local model; extract facts/habits/twists; without diluting the main generation flow" is a near-verbatim description of **Tier-3 ambient (`ambient.ts`) + Tier-2 sentiment**, both fire-and-forget after each turn (`api.ts` process-turn). Tagless extraction already runs *alongside* the bracket path. The only real "transition" is de-emphasizing brackets — not building extraction.
- ✅ **#2 Conflict Resolution Gatekeeper — ALREADY BUILT (opt-in).** "Detect new fact → scan for a semantically similar existing key → move the old to `index.cold.yaml` / mark retired → record the new" is **exactly the FR1→FR2→FR3 pipeline** — it even names the real artifacts (`index.cold.yaml`, "retired"). `dedup.ts` detects the collision, `supersedeEntry` moves the old fact to cold/Retired, and the **FR3 curator (`reconcile.ts` + `apply-gate.ts`)** makes the semantic UPDATE/NEGATE call. The only gap: the semantic layer (FR3) is **opt-in/offline** (`MARINARA_EXTENDER_RECONCILE`, shadow-by-default). Actionable item = **"promote FR3 to default/live,"** not "build it."
- ✅ **#3 `entities.yaml` Multi-hop Entity Index — GENUINELY NEW, sound, file it.** Not built. The Extender does entity *resolution* (identity/aliases) but has **no relationship topology** for multi-hop retrieval (user→brother→brother's-friend). A flat `entities.yaml` relationship map (`character_A: relationship: {character_B: older_brother}` + `topics_of_interest`) that **expands a query on one entity to pull related entities' memories** is the right lightweight fit (no Neo4j), addresses the real multi-hop gap, and is **distinct from `w4l`** — `w4l` is a flat subject→target *emotion* ledger (explicitly not a graph); this is a relationship *topology for retrieval expansion*. Complementary. **Worth a new bead.**
- 🟡 **#4 Dynamic Narrative TimeSense — PARTIALLY BUILT.** `soft-clock.ts` already exists (narrative time-of-day + presence) but is **off** (`TIMESENSE=0`). Genuinely-new parts: (a) detect time-*leap* phrases ("months passed"), and (b) **modulate the bookmark decay rate by elapsed story-time** (so "3 years later" ages bookmarks). Current soft-clock does context-tagging, not decay modulation. Foundation exists; the story-time *decay* is new. **Worth a bead to activate + extend `soft-clock`.**

**Section take:** The most useful slice, and a clean illustration of the whole review. Gemini's architecture description is accurate, but it under-mapped the **reconcile (FR2/FR3)** and **automatic-extraction (Tier-2/3)** subsystems, so it re-proposes two features that already exist. The two genuinely-actionable ideas are **#3 `entities.yaml` multi-hop** (new) and **#4 story-time decay** (extends `soft-clock`), plus a config decision on **promoting FR3 to default**. None contradict your design — they extend it.

---

## Overall Verdict (assembled)

**A high-quality, largely accurate overview — trustworthy on the Extender's own architecture, weaker when it reaches into engine internals or under-maps the reconcile/extraction subsystems.**

- **Extender architecture (slices 1–7):** essentially correct, verified against source. Corrections were precision-level only — budget reread is `process.env` (not disk); weight clamps [0,1] (not [0.1,0.9]); `status` is universal; decay is unconditional; `<memory_system>`/`<memory>` tags and every REST endpoint confirmed real (zero hallucinations).
- **Engine-side claims:** mixed. Tauri refactor ✅ verified. But the **Tailscale/Docker "auto-trusted" security claim is FALSE** (slice 8) — those ranges are *blocked*. The one hard error to fix in the source doc.
- **Evaluation (slices 9–11):** fair comparison, legit SOTA write-ups — but it **understates conflict-resolution (FR2/FR3)** and **automatic extraction (Tier-2/3)**, overstating two limitations and re-proposing two already-built features.

**Candidate beads surfaced:**

1. **`entities.yaml` multi-hop entity index** — genuinely new; real multi-hop gap; distinct from `w4l`. (Proposal #3)
2. **Story-time bookmark decay** — activate + extend `soft-clock` to modulate decay by narrative time-leaps. (Proposal #4)
3. **Promote FR3 reconcile to default/live** — the "gatekeeper" exists opt-in; a config/UX decision, not new code. (Proposal #2)

**Reference fix already applied:** `/api/identities` → `/api/identity` in `architecture.md` (both skill copies), caught by slice 6.

**On your reasoning:** it holds throughout. Where the doc diverges from the real design, the *code* matches your reasoning, not Gemini's compression. The doc's main blind spots are the two subsystems (reconcile, auto-extraction) that make the Extender more capable than its "limitations" section admits.
