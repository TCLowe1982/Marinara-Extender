# Review Synthesis — Four External Analysis Docs vs. the Marinara Extender

*One-page consolidation of the source-verified reviews of four AI-generated analysis docs (`Comparision_1_review`, `Comparision_2_review`, `Doc_3_NextGen_assessment`, `Doc_4_LedgerIntegration_review`). Every claim below was checked against `memory-extender/src/`, the live engine repo, and the Ledger Pattern repo.*

## The throughline

**Your reasoning held in all four.** Where a doc diverged from the real design, the **code matched your understanding, not the doc's.** The docs are accurate on *described* architecture but consistently **under-map the implementation** — so they repeatedly critique or "propose" subsystems you've already built (reconcile/FR2–FR3, embeddings/cosine retrieval, live group-chat routing, and the import pipeline that already *is* a Ledger-Pattern instance). The most ambitious doc (3) is partly a *different product*; the "wildest"-sounding doc (4) was actually the most accurate.

## Genuinely-new ideas → beads filed

| Bead | P | Idea | From |
|---|---|---|---|
| `1m9` | 1 | **State lane + epistemic injection** (who-knows-what / hiding) — *enriched with SPO-triple design note for precise contradiction* | prior + doc 3/4 |
| `w4l` | 2 | Relationship history (subject→target emotion) — *rides the `1m9` lane* | prior |
| `19o` | 3 | **`entities.yaml` multi-hop** relationship topology for retrieval expansion | doc 1 |
| `fr0` | 3 | Story-time decay — *enriched: consider the **bitemporal Valid/System-time** model* | doc 1 + doc 3/4 |
| `ybe` | 3 | Importance-weighted adaptive decay | doc 3 |
| `i4s` | 3 | YMYL / sensitive-domain protected category (extends `apply-gate`) | doc 3 |
| `w4x` | 3 | Decision: promote **FR3 reconcile** from opt-in → default/live | doc 1 |
| `7at` | 3 | `recall_memory` tool (model-initiated retrieval via function calling) | engine review |
| `fhd` | 3 | **Party Scope** — shared scene memory for group chats | doc 2 |
| `9l6` | 3 | Per-model prompt adapters / structured output | doc 2 |
| `x0y` | 3 | Opt-in **multi-pass consensus** for the import pipeline | doc 4 |
| `bos` | 2 | Import from lorebooks | prior |
| `d06` | 3 | Import from Smart-Memory (*blocked by `1m9`+`w4l`*) | prior |
| `bg6` | 4 | In-memory index **read**-cache (read-only) | doc 2/3/4 |

## Already built (the docs re-proposed these)

- **Conflict resolution** ("TOKI operators," "gatekeeper," "Audit-Row Defense") = your **FR1→FR2→FR3 + apply-gate + supersession→Retired**.
- **Tagless extraction** = automatic **Tier-2 (beats) + Tier-3 (ambient facts)**, fire-and-forget.
- **Vector search / "tensor math"** = `embeddings.ts` (`cosineSim` over cached `beat-embeddings.yaml`).
- **Live group/multi-agent routing** = `participantIds` + `buildSubjectRoster` + `resolveNameToKey`.
- **Memory consolidation** = `recordRecitation`; **hysteresis** = tier thresholds + `secondary_core`.
- **Ledger-Pattern integration** = the import pipeline (`runSentimentPipeline`) already windows + ledgers + resumes async. (Only **multi-pass consensus**, `x0y`, is net-new.)

## Recurring errors to fix at the source

- ❌ **Tailscale/Docker "auto-trusted, bypass auth"** — appears in docs **1, 2, and 4**; verifiably **backwards** (`security.ts`: `100.64.0.0/10` + `172.16.0.0/12` are *blocked/reserved*; only loopback is trusted, behind `ADMIN_SECRET`). Kill this at whatever source keeps generating it.
- 🟡 **Bookmark weight "[0.1, 0.9]"** — code clamps **[0, 1]**, default 0.5.
- 🟡 **"Operates at the post-generation stage"** — it's an external sidecar + extension firing *post-turn*, not an in-engine post-proc agent.
- ⚪ **Fabricated precision** — doc 3/4's `β=0.8/1.2`, "half-lives 11.25/5.02 days," `θ=0.75/0.30` are invented, not derived.
- 🔧 **Reference fix already applied:** `/api/identities` → `/api/identity` in the extender-expert skill.

## Out of scope / not worth building

- 🟣 **DAG plot blueprint + 5 authoring agents** (doc 3) — an AI *story-architect*; a separate product that would *consume* the Extender, not live in it.
- 🔴 **Audio speaker diarization** (doc 3/4) — wrong modality (input is text); at most a standalone voice-import preprocessor.
- ⚪ **SHA-256 hash-chain "immutable ledger"** (doc 4) — tamper-evidence security theater for a loopback, single-user, local tool.
- ⚠️ **Deferred-write queue** (docs 2/3/4) — breaks the atomic-write crash-safety design. (Read-cache only: `bg6`.)
- ⚪ **ROXY predictive/HyDE indexing** (doc 3) — wrong economics for local-first; semantic recall already covers part of it.

## Suggested build order

1. **`1m9`** (state lane + epistemic + SPO) — foundation; unblocks `w4l`.
2. **Time/decay cluster** — `fr0` (story-time / bitemporal) + `ybe` (importance decay), designed together.
3. **Reconcile cluster** — `w4x` (FR3 default decision) + `i4s` (YMYL extends apply-gate).
4. **Import cluster** — `bos`, then `x0y` (multi-pass consensus), then `d06` (after `1m9`+`w4l`).
5. **Retrieval/structure** — `19o` (entities multi-hop), `7at` (recall tool), `fhd` (party scope).
6. **Infra (low priority)** — `bg6` (read-cache), `9l6` (prompt adapters).

**Bottom line:** the four docs surfaced ~6 genuinely-useful upgrades (epistemic/SPO, bitemporal time, importance decay, YMYL, party scope, multi-pass import) and confirmed the existing architecture is sound. Their value was the *new ideas*; their failure mode was not reading deep enough into the code.
