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
  watermark: { coveredThroughSeq: number /* per-character beat seq, NOT ISO — see Resolved #1 */ ; version: number };

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

## Resolved decisions (review complete — TC, 2026-06-05)

1. **Watermark ordering = per-character monotonic sequence, not ISO time.** There is
   NO sequence today; beat ids are content hashes (`beat-<sha1>`, encoder.ts:26), not
   ordinal. ISO is unusable: `EmotionalBeat.created` is `new Date().toISOString().slice(0,10)`
   (encoder.ts:207) — date only, no time-of-day, so all beats in a session share one
   value and cannot be ordered intra-day. `turnStart` is monotonic only WITHIN a source
   chat (resets per import), so not a global per-character order either.

   Implementation: add `nextSeq: number` to `BeatIndex` and `seq: number` to
   `BeatIndexEntry`. Assign inside `upsertBeatIndex` under the EXISTING per-character
   `serializeBeatWrite` lock (encoder.ts:115), which already makes the index
   read-modify-write atomic; the counter persists durably in `beats/index.yaml`. Assign
   ONCE on first insert (the `i < 0` branch, encoder.ts:132) and NEVER reassign on
   re-encode — beat ids are idempotent, so a resumed import must not renumber history;
   `seq` is write-once, immutable. Caveat: the lock is in-memory / single-process — fine
   for today's single-process sidecar, not a cross-process guarantee.

2. **Edges = standalone `ArcMembership` collection** with bidirectional indexes built
   at load. Both directions are needed: beat to arcs at promotion time ("what arcs does
   this new beat extend?") and arc to beats at render time. Embedded edges force a full
   arc scan for the first query — dies past ~100 arcs.

3. **Edge salience = recency x entityProminence x beat.salience, normalized, WITH a
   high-salience floor.** Raw recency-as-multiplier crushes founding / turning-point
   beats to zero over time, so recaps lose their own origin stories. Floor: a beat with
   intrinsic `beat.salience > 0.8` loses no more than X% of its arc-edge salience to
   recency decay (X is a tuning knob). Keeps turning points visible regardless of age.

4. **Centroid = inline + cached, recomputed ONCE per promotion pass (batched), not per
   added beat.** Per-beat recompute makes a pass O(N^2); end-of-pass recompute is O(N).
   768-dim x hundreds of arcs is sub-MB inline.

## EntryStatus consumer audit (why ArcStatus stays separate)

`dormant` lives on `ArcStatus`, NOT `EntryStatus` — by decision, with evidence. Adding
it to `EntryStatus` was audited against every consumer:

- **No exhaustive switch / `assertNever` exists.** All matches are `status === "done"`
  skip-guards (cleanup.ts:131/134/162, loader.ts:195, promotion.ts:112/175), which treat
  an unknown value gracefully as "not done." So there is no catastrophic fall-through.
- **Allow-lists would drop it silently.** `VALID_STATUSES` (api.ts:102, digest.ts:197)
  rejects a new value via the API and coerces it to "open" via the LLM digest (digest.ts:207).
- **Default list filter excludes it.** api.ts:137 is `["open","in_progress","deferred"]`;
  a new value vanishes from default listings.
- **Prompt leak.** loader.ts:332 renders a `[status]` tag (space-prefixed) into the injected context verbatim.
- **Storage does not validate.** Load is `parse(raw) as T` (storage.ts:152) — unknown
  values round-trip silently.

Resolution: keep `dormant` off `EntryStatus`. `RecapEntry.status` stays `"open"`; the
loader gates recap injection on the linked `Arc.status === "dormant"` (the arc link, not
the entry status). This converts a fan-out across every consumer into ONE deliberate new
consumer in the loader's recap path. Do NOT later "simplify" `dormant` onto `EntryStatus`
— this is a decision with evidence, not a preference.
