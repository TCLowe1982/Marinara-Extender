# Recap Layer — Ceiling-Tier Data Model (sketch)

Tracking: `MarinaraExtender-ajb` (ceiling), parent `MarinaraExtender-cz3`.
Status: **design sketch**, not yet implemented. Grounded against the live types in
`src/sentiment/types.ts` (`EmotionalBeat`) and `src/storage.ts` (`Lane`, `Entry`,
`EntryStatus`, `MemoryTier`, `TIER_DAYS_COLD`).

## Where it sits

A **through-line arc** is an aggregate over `EmotionalBeat`s that span scenes. It is
**not** a replacement for the beats — it is a typed set of references plus its own
metadata. The beats stay at full fidelity and go cold via the existing
`TIER_DAYS_COLD` path; the arc cites them as footnotes. An arc **renders** into a
`RecapEntry` that lives in the same hot index the loader already scans, so the recap
becomes the canonical retrieval unit and displaces its member beats from the hot loader.

Two arc kinds share the model:
- `kind: "scene"` (**floor**, `MarinaraExtender-2cu`) — 1:1 with an engine scene; no
  clustering, no match-before-mint; ingested from the `/api/scene/conclude` prose summary.
- `kind: "through_line"` (**ceiling**, this ticket) — inferred across scenes by the
  assign-on-promotion pass.

## Core types

```ts
// Reuses Lane from storage.ts: "open_threads" | "user_topics" | "character_topics".
// Lane drives lane-aware rendering — see the render contract below.

export type ArcKind = "scene" | "through_line";
export type ArcOrigin = "engine" | "promotion";

// New state beyond EntryStatus. "dormant" is auto-quiesced (reopens on re-mention),
// distinct from "deferred" (manual). active ~ open/in_progress; resolved ~ done.
export type ArcStatus = "active" | "dormant" | "resolved";

// The per-arc meaning of a beat. Freeform string allowed (mirrors the freeform
// `emotion` convention in BeatAnalysis); the union is the suggested vocabulary.
export type BeatRole =
  | "turning_point"
  | "escalation"
  | "threshold_crossing"
  | "recurrence"
  | "setup"
  | "minor"
  | (string & {});

// The typed N:M edge. The SAME beat can carry different role/salience per arc.
export interface ArcMembership {
  arcId: string;
  beatId: string;             // -> EmotionalBeat.id
  role: BeatRole;             // what this beat MEANS in this arc
  salience: number;           // 0.0-1.0, salience of this beat WITHIN this arc
  addedAt: string;            // ISO; which promotion cycle bound it
}

// The matching signature for match-before-mint and dormant reactivation.
export interface ArcSignature {
  entities: string[];         // characters / locations / props
  threadIds: string[];        // open_threads references (most reliable signal)
  centroid: number[];         // mean embedding of member beats (kNN tier)
}

export interface Arc {
  id: string;                 // PERMANENT — never changes across re-promotion
  kind: ArcKind;
  origin: ArcOrigin;
  lane: Lane;                 // feeling=character_topics, fact=user_topics, thread=open_threads
  label: string;              // re-renderable LLM name (e.g. "Priya-as-co-experimenter")
  status: ArcStatus;
  scope: { characterId?: string; chatId?: string };

  signature: ArcSignature;    // also the dormant reverse-index key
  members: ArcMembership[];   // ordered by underlying beat.created when rendered

  // Watermark: the arc's recap is canonical for beats up to here; newer beats ride
  // hot until the next promotion advances it. resolved/dormant => pinned.
  watermark: { coveredThrough: string /* ISO of last covered beat */ ; version: number };

  // Periods of no activity, fed to the renderer as INPUT (not just metadata) so the
  // recap can say "went quiet for three weeks, reopened when...". Derivable from
  // member beat timestamps but materialized for the renderer.
  gaps?: Array<{ from: string; to: string }>;

  created: string;            // ISO
  lastPromotedAt: string;     // ISO; last time the assign-on-promotion pass touched it
}

// The rendered view the loader actually injects. Extends the existing Entry shape
// so it is a first-class hot-index citizen and the cold-tier machinery applies.
export interface RecapEntry extends Entry {
  kind: "recap";
  arcId: string;              // -> Arc.id
  // `content` (from Entry) holds the structured recap body; `summary` holds the lead.
  // footnoteBeatIds are the high-salience members rendered as citations.
  footnoteBeatIds: string[];
}
```

## Lane-aware render contract

The renderer is a pure-ish function `(Arc, orderedMembers, gaps) -> RecapEntry`,
branching on `arc.lane`:

- `character_topics` (**feeling**) -> **trajectory / path**. Preserve the ordered
  emotional progression (the arc IS the point). Lead = current emotional state;
  body = the path that got there, with gaps narrated.
- `user_topics` (**fact**) -> **point + footnotes**. Lead = current canonical value;
  body = superseded values as dated footnotes (never deleted).
- `open_threads` (**thread**) -> **state**. Lead = current open/in_progress/done status;
  body = what is settled vs still open.

## Identity & lifecycle (the load-bearing rules)

- **Match-before-mint:** the promotion pass matches candidate beats against existing
  `Arc.signature` (entities + threadIds + centroid) BEFORE creating an arc. Hit =>
  extend the matched arc + advance its watermark. Clean miss => mint a new `Arc.id`.
  `Arc.id` is permanent; `Arc.label` is re-renderable. This is what makes the system
  accrete instead of re-summarize.
- **Activation > candidacy:** a `dormant` arc flips to `active` only on a threadId hit
  or centroid match — NOT mere entity presence (the protagonist is in everything).
  `signature` doubles as the dormant reverse-index key.
- **Recap-aware recitation:** a cold beat cited by a recap does NOT auto-rehydrate on
  the recap's recall; only a precise query the recap does not cover cracks it open.

## Open type-level questions (for review)

1. **Watermark ordering key.** `coveredThrough` as ISO of last covered beat assumes
   beat timestamps are monotonic per arc. Beats have `created` + `turnStart`; is a
   per-character monotonic beat sequence number safer than ISO time for ordering?
2. **Edge home.** `ArcMembership` as a separate join collection (queryable both
   directions) vs embedded `Arc.members[]`. Sketch embeds for render-locality; a beat
   -> arcs reverse lookup (for "which arcs does this new beat extend?") may want the
   standalone collection.
3. **Salience source (v1.1).** Edge `salience` heuristic = `recency * entityProminence
   * beat.salience`, normalized. `beat.salience` and `created` exist; entityProminence
   needs a per-arc entity-frequency count. Confirm the three factors and weighting.
4. **Centroid storage cost.** Storing `centroid: number[]` per arc (nomic-embed-text =
   768-dim) across hundreds of arcs — acceptable inline, or store a beat-id list and
   recompute on demand?
