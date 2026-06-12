# Importing chats and stories — behavior, routing, and costs

How past content becomes memory: the import paths, what subject routing does
to them, when analysis is skipped vs re-run, and what each operation costs.
Current as of 2026-06-12 (post-cx4 subject routing + forced re-analysis).

## The three capture paths

| Path | Trigger | Attribution |
|---|---|---|
| **Live capture** | every turn (`/api/process-turn`) | analyzer `subject`, roster scoped to scene participants |
| **Chat import** | Import tab / ↻ re-import (`/api/analyze-beats`, `sourceType: "chat"`) | analyzer `subject` per chunk — **no speaker pre-filter** |
| **Story import** | story ingest UI (`sourceType: "story"`) | speaker pre-filter by assignment, then `subject` routing within kept chunks; off-speaker chunks go through the orphan/alias pass |

## Why chat imports analyze everything

Marinara stores each assistant message with the **session character's id**, so
the chunker labels every narration chunk with one speaker — a shared scene
(Mari-led, Priya co-starring) *cannot* be split by speaker labels. Only the
analyzer's per-beat `subject` ("whose inner state is this?") can attribute it.

Consequences, by design:

- **Import once, from either side.** Importing a shared scene from Priya's
  list or Mari's list produces the same distribution: each beat lands in the
  ledger of whoever it is about. Do **not** import the same scene from both
  sides — the bucket-fallback beats would duplicate across ledgers.
- Shared scenes appear in **every participant's** import list, marked
  `(shared)`. The list includes any chat whose `characterIds` contain the
  character, not just chats they lead.
- **Routing rules per beat** (same as the live path):
  - subject = `user` / the player's persona / the session character → the
    import bucket (the character you imported from);
  - subject = a known identity (alias table / identity map, exact match) →
    that character's ledger, beat speaker corrected to the subject;
  - subject unresolved + chunk speaker explicitly assigned (bucket character,
    `user`, `Narrator`) → bucket — the assignment is stated intent;
  - subject unresolved + unassigned speaker → **holding pool** (never guessed
    into a permanent ledger; resolve from the Pending tab).

## Resume vs deliberate re-import

Beat ids are deterministic (hash of speaker + text + turn span), which powers
two different behaviors:

- **First import / crash-resume** (`purged 0` in the log): chunks whose beat
  already exists on disk skip the analyzer call; only the companion ledger
  entry is re-derived. Cancelling a long import and re-running it continues
  where it stopped.
- **Deliberate re-import** (`re-import — cleared N prior entries … full
  re-analysis for routing`): when prior entries for the chat existed and were
  cleared, the resume shortcut is **bypassed** and every chunk re-analyzes.
  This is what makes re-import a *redistribution*: the resume path recreates
  companions under the bucket without analysis, which would silently undo
  subject routing (observed live on the first Test Drive re-import:
  35/35 kept, 34 resumed, only 1 routed).

Re-import hygiene: prior companion entries are cleared by `sourceChatId`
(bucket scope only; a snapshot is taken first), beats overwrite idempotently
by id, and re-derived companions dedup against near-identical survivors at the
incident threshold. Re-running is always safe; it only costs compute.

The Import tab keeps a **↻ re-import button** on completed rows — no page
reload needed.

## Costs

One analyzer LLM call per **passing** chunk (the keyword classifier gates
which chunks pass — typically a fraction of the total). With the local model
(`MARINARA_EXTENDER_LOCAL_MODEL`, e.g. `dolphin3:8b`) this is fast and free;
a ~35-chunk scene re-imports in well under a minute on local inference.
The external API fallback (`MARINARA_EXTENDER_API_KEY`) spends real tokens —
mind it before bulk re-imports.

| Operation | Analyzer calls |
|---|---|
| First import of a scene | one per passing chunk |
| Crash-resume of that import | only the chunks not yet done |
| Deliberate re-import (↻) | one per passing chunk, again — full redistribution |
| Story import | one per passing chunk **kept by the speaker filter** |

## Log lines worth knowing

```
[ME:pipeline] matching against: "X" — 35/35 chunks kept     ← chat imports keep everything
[ME] re-import — cleared 58 prior entries … full re-analysis ← deliberate re-import detected
[ME:pipeline] subject="Dr. Priya Chandrasekaran" → k6cq…     ← a beat routed off the bucket
[ME:pipeline] unknown subject "James" on unassigned speaker  ← parked in holding pool
(resuming — 34 already done)                                  ← crash-resume path (first imports only)
```

## Known limitations

- Routed-away beats are not in the bucket's index, so crash-resume of a
  partially-imported shared scene re-spends analyzer calls on chunks that
  routed elsewhere (idempotent on disk).
- Subject quality is the local model's judgment; diacritic near-misses on the
  session/persona name are absorbed (Jaro-Winkler ≥ 0.9), unknown names never
  auto-route.
- One chunk per live message still applies to live capture (MarinaraExtender-7h9);
  imports chunk at speaker-turn granularity and don't share that limit.
