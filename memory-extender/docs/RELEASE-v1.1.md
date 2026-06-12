# Marinara Extender v1.1 — "The story, not just the facts"

v1.0 gave characters persistent memory. v1.1 gives them **narrative memory**:
who a moment was about, which storyline it belongs to, and how the storylines
add up — plus the durability and security hardening that a memory system owes
its users.

## Headline: the Recap Layer

Beat fragmentation was the disease: a character could recall ten high-signal
moments that didn't add up to a story. v1.1 introduces **arcs** as first-class
memory objects, in two tiers:

- **Scene recaps (free).** When you conclude a scene in Marinara, the engine's
  own prose summary is ingested as a retrievable memory — keyed to the scene,
  with the scene's beats cited as footnotes. Your existing concluded scenes
  backfill automatically on first load. No LLM cost.
- **Through-line arcs (the new capability).** A background pass clusters
  emotionally salient beats *across scenes* — by shared narrative thread,
  shared cast, and embedding similarity — and one local-LLM call per arc
  confirms membership, names the arc, and writes a dated trajectory recap
  ("each demonstration of competence is shadowed by a reminder of
  fragility…"). Arcs **accrete**: new beats extend an existing arc and its
  recap updates in place; arc identity is permanent, labels re-render freely;
  idle arcs go dormant and wake only on a real signal. Runs every 60 turns off
  the hot path, or on demand via `POST /api/arcs/promote`.

## Narrative threads

Beats are now born into **threads** ("Porsche test drive", not a pile of
moments). The analyzer picks or mints a thread label on the same LLM call it
already makes; recall is thread-aware — returning to an arc by name surfaces
its members even when their individual summaries don't match, and one
strongly-recalled beat pulls its siblings. Closed threads archive to cold
storage as units. Thread registry health (cast-list label lint, fragmentation
metrics) at `GET /api/threads`; relabel with `PATCH /api/threads/:id`.

## Subject attribution — multi-character scenes finally work

Previously, everything captured in a scene was filed under the session
character. Now every beat and ambient fact is attributed to **whoever it is
about**: the analyzer returns a `subject`, scoped to the characters actually
in the scene; known co-stars get the beat in *their own ledger*; the player's
persona maps to "user"; unknown names go to the holding pool — never guessed.
This applies to live play **and** imports: importing a shared scene from
either participant's list distributes beats correctly ("import once"), and
deliberate re-imports fully re-analyze so redistribution is real.

## Smarter dedup: incidents accumulate, facts supersede

- A specific emotional *moment* no longer collapses into a standing
  personality *trait* — the arc accumulates. Same-moment recaptures still dedup.
- A fact **correction** ("my sister is Lin", after "Mei") is no longer
  silently dropped: the new fact lands, the old one is marked superseded and
  moved to cold — replaced, never deleted, still reachable by a precise query,
  and never sharing a prompt with its replacement. Audit at
  `GET /api/supersessions`.

## Durability & security

- **Atomic, fsync'd writes** on every state mutation. A hard crash (BSOD,
  power cut) can no longer NUL-fill the memory store — the failure mode that
  destroyed real data and started this release. (The matching engine-side bug
  was reported upstream.)
- **CSRF protection** on all mutating API routes: browser requests need a
  per-process token (handled automatically by the extension); local tooling
  is unaffected.

## Observability & UX

- Panel: "🧠 last turn: N memories in context" with click-to-expand, plus
  per-entry retrieved/recited counters.
- Import tab: shared scenes appear in every participant's list (marked
  "(shared)"), completed rows get a ↻ re-import button.
- Console launcher (`Marinara_Extender_Start.bat`): visible window + a
  persistent UTF-8 log at `memory-extender/logs/sidecar.log`.
- Routing decisions are logged: `subject="…" → ledger`, `thread=nthr-…`,
  dedup-skip targets.

## Embeddings: on by default

Semantic features (chunk merging, the arc kNN generator) now default to
`nomic-embed-text` via Ollama. One-time setup: `ollama pull nomic-embed-text`
(274 MB). Everything degrades gracefully without it; disable entirely with
`MARINARA_EXTENDER_EMBED_MODEL=0`.

---

## Migrating from v1.0

No data migration. All storage changes are additive — v1.0 data loads as-is,
and new fields appear as you play.

1. **Update & build**
   ```
   git pull
   cd memory-extender && npm install && npm run build
   ```
2. **Pull the embedding model** (recommended):
   `ollama pull nomic-embed-text` — or set `MARINARA_EXTENDER_EMBED_MODEL=0`
   in `.env` to opt out.
3. **Start with the launcher**: `Marinara_Extender_Start.bat` (repo root).
4. **Reload your Marinara tab.** Required: the CSRF guard rejects the old
   in-page extension until the reload pulls the new one (you'll see
   `[ME:csrf] blocked` lines until you do). The loader stub you pasted into
   Marinara settings is unchanged — no re-pasting.
5. **Expect a one-time backfill** on first load: your concluded scenes ingest
   as recaps (`[ME:recap] scene "…" ingested` lines).
6. **Recommended:** give co-star characters short-name aliases (Pending tab,
   or `POST /api/aliases`) — subject routing resolves "Priya" to her ledger
   through the alias table.
7. **Optional:** re-import shared multi-character scenes once (↻ in the
   Import tab) so past scenes redistribute beats to the right ledgers.

Full import semantics and costs: `memory-extender/docs/importing.md`.
Arc data model: `memory-extender/docs/recap-ceiling-data-model.md`.
