# Assessment: `Doc_3_NextGen` — "Next-Generation … Comprehensive Upgrade" (feasibility / triage)

*This is the **third** doc — a vision/upgrade proposal, not an analysis of the existing system. So this is an **ideation assessment**, not a correctness review: each proposal is triaged for feasibility, novelty vs. what's already built, and scope. Grounded against the real Extender (`memory-extender/src/`) and the existing beads roadmap. Built slice-by-slice per the Ledger Pattern.*

**Triage buckets:**

- 🟢 **Worth doing** — feasible, valuable upgrade that fits a memory sidecar
- 🔵 **Already built / partial** — the proposal re-invents existing code or an existing bead
- 🟣 **Different product** — sound idea, but out of scope for a memory sidecar (belongs in a separate project)
- 🔴 **Misunderstanding** — misreads the system or misapplies a technique
- ⚪ **Academic dressing** — formalism that adds little practical value

---

## Slice 1 — Framing & "Current Limitations" (L1–15)

**Accurate description of the current Extender; familiar limitations (a couple overstated); thesis = a major re-architecture.**

- ✅ **Current-system description is correct** — sidecar + port 3001, thin loader, YAML storage, 4k/2k/1k budgets, the `W(t)=W(t-1)×0.97` decay. Matches code.
- 🟡 **Limitations are the familiar trio, partly overstated:**
  - *Static budget → "total loss of long-term consistency on overflow"* — dramatized. The budget + **hot/cold split + promotion** exist precisely to manage this; degradation is graceful, not "total loss."
  - *Fixed-coefficient decay, no narrative-timeline awareness* — fair, and already a bead (`fr0` story-time decay).
  - *Over-reliance on `[bookmark:]`/`[remember:]`* — overstated (same as doc 2): automatic Tier-2/3 extraction runs regardless of tags.
- 🧭 **Thesis:** "comprehensive restructuring into a hybrid storage paradigm." This frames everything downstream as a **re-architecture**, not an incremental upgrade — consistent with your "new project" description.

**Section take:** The premise is sound and the current-system read is accurate. Watch for the recurring pattern (proposals that re-invent existing subsystems), and for genuine scope-creep into a *different product* (the doc's title already signals "ultra-long chronicle writing," which is an authoring engine, not just memory).

---

## Slice 2 — DAG Plot Blueprint + 5 Authoring Agents (L17–37)  🟣 different product

**A multi-agent story-authoring engine, not a memory-sidecar feature. Cool as a separate project; mostly out of scope here.**

- 🟣 **This is an AI narrative-architect, not memory.** A plot **DAG as the single source of truth for event progression** (nodes = events + metadata, edges = causal prerequisites), driven by **5 authoring agents** — Architect (plot framework), World Builder (enrich nodes), Drama Coach (insert conflict), Dependency Manager (topological-sort consistency validation), Narrator (traverse + generate prose). That's a **story-generation/plotting system**. The Extender *stores and retrieves* memory; it doesn't author plots or generate prose. This is a **different, large product** that would *consume* the Extender's memory, not extend it.
- ✅ **Each piece is individually feasible** — multi-agent orchestration, topological sort for prerequisite validation, "Projectional Decoding" (constrained generation maintaining a partial graph) are all real techniques. Assembled, they're an authoring engine.
- 🔵 **One piece touches memory** — the **event-DAG as a causal/prerequisite graph** is adjacent to the `entities.yaml` multi-hop bead (`19o`) and the arcs/threads system. A *lightweight* event/causal graph could be a memory feature; the 5-agent stack around it is the separate product.

**Section take:** 🟣 Genuinely interesting as a **separate project** (an "AI story architect" reading the Extender's memory). As an Extender upgrade, only the event-graph idea is in scope, and it overlaps `19o`. Don't fold the authoring engine into the memory sidecar.

## Slice 3 — Bi-Temporal Time Model (Graphiti-inspired) (L39–53)  🟢 worth doing

**The principled version of the time-sense gap — and a cleaner answer to stale facts than hard supersession. Feasible in YAML.**

- 🟢 **Valid Time + System Time is a real, valuable upgrade.** Tag each fact with **Valid Time `Tv`** (true *in-story*) and **System Time `Ts`** (recorded), query `asof(tv, ts)` for the world-state at a plot moment. This is the Zep/Graphiti model. For narrative consistency it's useful: "lives in NYC" `Tv=[ch1,ch7)`, then "lives in LA" `Tv=[ch7,…)` — both retained, correctly scoped.
- 🔵 **Overlaps + extends roadmap.** Subsumes the **`fr0` story-time-decay** bead (time-leap detection → adjust plot-time → accelerate old-scene decay *is* `fr0`, plus a validity model), and offers a **cleaner answer to belief-contradiction than FR2 supersession**: instead of superseding a corrected fact, close its validity window (`Tv.to = now`). Time-bound facts stop being "wrong," they become "no longer valid."
- ✅ **Feasible** — two interval pairs per entry in YAML + an `asof` filter in the loader. Heavier than `soft-clock` but tractable and incremental (start with Valid-Time on facts).

**Section take:** 🟢 The strongest idea so far. Treat it as the **ambitious version of `fr0`** — weigh bitemporal (more work, more correct, doubles as a better contradiction model) vs. the simpler story-time decay. Candidate to fold into `fr0`'s design.

---

## Slice 4 — TOKI Operator Algebra (conflict resolution) (L55–73)  🔵 already built + 🟢 one enhancement

**A formalized re-description of your existing FR1/FR2/FR3 + apply-gate system. One genuinely-new piece: structured SPO facts for precise contradiction detection.**

- 🔵 **The four "operators" are already your reconcile system:**
  - *Last-Writer-Wins* ≈ **FR2 supersession** (newest replaces old).
  - *Evidence-Weighted Merge* ≈ **FR3 curator EXPAND/merge** (confidence-weighted).
  - *Await-Confirmation* ≈ **apply-gate HOLD lane** (hold for human review).
  - *Per-Rule Policy* ≈ **apply-gate domain-sensitivity** (trauma always holds).
- 🔵 **"Audit-Row Defense" is already built** — "superseded fact → audit row, never deleted, queryable as history" is exactly `supersedeEntry` (`supersededBy`/`supersededAt` → cold/**Retired**, never deleted; `/api/retired`). The detective-queries-history case already works via cold recall.
- 🟢 **The one real enhancement: SPO-triple structured facts.** The contradiction predicate (`same subject ∧ same predicate ∧ different object ∧ overlapping valid-time`) needs facts stored as **subject–predicate–object triples**. Today detection is **lexical** (`dedup.ts` Jaccard correction-signature), which misses semantic contradictions with low word overlap (the belief-contradiction gap). Structured SPO facts make it **precise** — and this connects directly to the **`1m9` epistemic state-lane**. *This* is worth pulling out.
- ⚪ **"TOKI operator algebra"** is academic dressing over the existing verdicts.

**Section take:** 🔵 You already have the conflict-resolution machinery (FR2/FR3 + apply-gate + supersession-audit). The valuable extraction is **SPO-triple fact representation** (→ precise contradiction detection), which slots into `1m9`. Everything else is your system, formalized.

## Slice 5 — ROXY Predictive Question Indexing (L75–79)  ⚪ speculative

**A HyDE-style retrieval optimization for a real problem — but the LLM cost fights local-first, and semantic recall already covers part of it.**

- 🟢 **Real problem:** "retrieval mismatch" — the current prompt lacks keywords matching archived content. Genuine RAG issue.
- 🔵 **Partially handled** — the Extender's **semantic recall** (embedding cosine, not keyword) already bridges wording gaps; ROXY is a more aggressive version.
- ⚪ **Cost conflicts with local-first.** "Generate hypothetical questions per memory segment via the LLM, index them" (HyDE / generative indexing) = an **extra LLM pass per stored memory** — expensive on a local model, exactly the economy the Extender protects. The "Conflict-Aware Reranker" adds another pass and overlaps the reconcile system.
- **Verdict:** defer / experiment, not a priority. The payoff is partly already delivered by semantic recall; the marginal gain likely isn't worth doubling extraction-time LLM cost for local users.

**Section take:** ⚪ Sound technique, wrong economics here. If recall-mismatch is ever measured as a real problem, tune the existing embedding recall before adding a generative-indexing layer.

---

## Slice 6 — Speaker Diarization (L81–101)  🔴 / 🟣 out of scope

**Audio-domain ML applied to a text system. Out of scope for the memory core; at best a separate upstream preprocessor for a niche voice-import use case.**

- 🔴 **Modality mismatch.** Diarization (acoustic segmentation 0.5–10s, voice-biometric embeddings, speaker clustering, WDER) is for **audio**. The Extender ingests **text** chat turns — there is no audio stream. Voice-biometric embeddings of a text log is a category error.
- 🟣 **The intent (L101) is an upstream preprocessor** — "once labeled, send the text to `/api/ingest-story`." So really: "if you have historical *voice* logs, diarize them to text, then ingest." A **standalone audio→text tool**, not a memory-layer feature, for a niche (voice-chat history import).
- ✅ **Correctly describes the EXISTING text speaker-resolution** — `/api/ingest-story` + `aliases.yaml` + `/api/pending-speakers` (map/create/ignore). For text (the actual input), that already solves "who said what." No diarization needed.
- "55.5% WDER reduction" is a cited audio-diarization benchmark, not the Extender's.

**Section take:** 🔴 Skip for the memory core — the input is text and text speaker-resolution already exists. If *voice-log import* ever becomes a goal, it's a separate preprocessor feeding `/api/ingest-story`.

## Slice 7 — FadeMem Hierarchical Decay + YMYL (L103–119)  🟢 two real upgrades, rest already built

- 🟢 **Importance-weighted adaptive decay** (`λ` varies by importance score) — **genuine upgrade.** Today decay is uniform (bookmark ×0.97; tier demotion by fixed staleness). Importance-adaptive decay = trivia fades fast, pivotal facts persist. Natural enhancement to the tier engine.
- 🔵 **Hysteresis (separate promote/demote thresholds)** — partially exists (`TIER_SCORE_LONG=5`/`CORE=25` + staleness demotion + `secondary_core`-after-3-cycles). Explicit dual thresholds would formalize it; minor.
- 🔵 **"Memory consolidation: re-access resets to peak"** — **already built** = `recordRecitation` (re-access bumps + restamps + can promote). Biological-recall strengthening = your recitation mechanism.
- 🟢 **YMYL protected-domain classifier** (regex + local-LLM detect health/finance/legal → importance floor, decay exemption, mandatory reconcile) — **reasonable extension** of the existing `apply-gate` domain-sensitivity (currently a trauma lexicon → always-hold) + the never-pruned `core` tier.

**Section take:** 🟢 Two worth extracting: **importance-weighted adaptive decay** and the **YMYL/sensitive-domain protected category**. Hysteresis + consolidation already in your tier/recitation system.

## Slice 8 — RAM Cache + Deferred Write Queue (L121–129)  🔵 = bead `bg6` + ⚠️ conflict

- 🔵 **Read-cache** (load `index.yaml` into a RAM `Map` at boot, serve reads from RAM) — already filed as **`bg6`**.
- ⚠️ **Deferred write queue, flush every 30s** — **conflicts with atomic-write durability** (`storage.ts` temp→`fsync`→`rename` per write). Batching loses up to 30s on a crash. Keep write-through. (Same as Comparision_2 Slice 3.)

**Section take:** Nothing new vs. doc 2 — read-cache yes (`bg6`), deferred-write no (durability).

---

## Overall Verdict — `Doc_3_NextGen` (assembled)

**An ambitious vision conflating three things: real memory upgrades, a re-description of subsystems you already have, and a separate AI-authoring product. Your "new project" read is exactly right.**

**🟢 Genuinely worth doing (in-scope upgrades):**

1. **Bi-temporal Valid-Time model** (Slice 3) — the standout; principled time-sense + a cleaner contradiction model than supersession. **Extends/supersedes `fr0`.**
2. **SPO-triple structured facts** (Slice 4) — precise (not lexical) contradiction detection. **Slots into `1m9`.**
3. **Importance-weighted adaptive decay** (Slice 7).
4. **YMYL / sensitive-domain protected category** (Slice 7) — extends `apply-gate`.

**🔵 Already built / partial (the doc re-invents):** TOKI operators + "Audit-Row Defense" = FR2/FR3 + apply-gate + supersession; "memory consolidation" = recitation; hysteresis = tier thresholds + `secondary_core`; RAM read-cache = `bg6`; semantic recall partly covers ROXY.

**🟣 Different product (out of scope):** the **DAG plot blueprint + 5 authoring agents** (an AI story-architect — a real, separate project that would *consume* the Extender), and **audio diarization** (a separate voice-import preprocessor; the input is text).

**⚪ Speculative / academic dressing:** ROXY (wrong economics for local-first); the formal algebra (TOKI/`asof`/FadeMem notation) is mostly framing over existing or simple ideas.

**⚠️ Conflicts:** the deferred-write queue breaks crash-safety (recurs from doc 2).

**On your reasoning:** intact, emphatically. Doc 3 mostly shows your existing reconcile/tier/supersession systems are *already* what an academic write-up reaches for — it just doesn't realize they exist and dresses them in notation. The genuinely-new memory ideas are four (bitemporal, SPO facts, importance-decay, YMYL), two of which enrich existing beads (`fr0`, `1m9`). The **DAG-authoring engine is the actual "new project"** — worth pursuing *separately*, on top of the Extender, not inside it.

**Candidate beads:** importance-weighted decay; YMYL protected-domain. **Design-note enrichments:** bitemporal → `fr0`; SPO facts → `1m9`. **Separate-project note:** DAG narrative-architect.
