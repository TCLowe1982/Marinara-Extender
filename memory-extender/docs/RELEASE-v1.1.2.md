# Marinara Extender v1.1.2 — recall actually reaches the model

Patch release, but a big one. It closes a stack of recall failures found by
chasing a single bug — "she doesn't remember the test drive" — through every
layer of the pipeline. Each fix below was real, and each one unmasked the
next. If your characters have ever denied something they should remember,
this release is why.

## The critical fix: the engine silently drops over-budget memory

Engine lorebooks have a per-turn injection budget (default **2,048 tokens**),
and entries that would exceed it are dropped with **no warning** — no log, no
UI hint. The Extender's memory block grows with your ledger, so once a
character accumulates enough memories the block crosses the budget and the
engine stops injecting it entirely. Long-running chats mask the failure
because the facts are still in visible history; brand-new chats expose it as
total amnesia.

v1.1.2 creates Extender lorebooks with a **16,384-token budget** and
automatically heals any existing Extender lorebook found below that. No
action needed — the heal runs on your first turn after updating.

## Pre-turn refresh — the one-turn recall lag is gone

Previously the memory block was rebuilt **after** each turn, so a question
about something not already in context was answered one turn stale ("what
porsche test drive?" — and then next turn she remembers). The extension now
intercepts generation, rebuilds the block against your **outgoing message**,
writes it to the lorebook, and only then lets the model reply. This covers
the first message of a brand-new chat too — previously the most amnesiac
moment in the system.

## Scene recaps could attach to the wrong scene

The engine's "returned from their scene" summary never names its scene, and
the old pairing-by-timestamp drifted: on the development install **36 of 56
scene recaps were attached to the wrong scene**. Characters weren't
forgetting — they were remembering the wrong event. Pairing is now done by
content overlap between the summary and the scene's actual transcript.

**Migration — if you used scene recaps on v1.1.x, audit your data:**

```bash
node scripts/repair-recap-pairing.mjs            # dry-run report, read-only
node scripts/repair-recap-pairing.mjs --apply    # fix (stop the sidecar first)
```

The script reads your local Marinara Engine tables, recomputes correct
pairings, and replaces any mispaired recap (entry, arc, and idempotency
marker) with the right one.

## Memory fidelity contract

The injected instructions now tell the model how to *use* memory honestly:
the memory block is canon for events that already happened; a character with
no memory of an event says so, in character, instead of inventing vivid
specifics; and leading questions that embed a false detail ("the 911",
"that night in Austin") get gently corrected rather than played along with.
Confabulation was the failure mode that masked everything above — fluent,
confident, and completely invented.

## Also in this release

- **Beat dedup tightened** — incident beats only collapse when provably the
  same moment (same chat, within 5 turns), and the analyzer prompts demand
  specifics ("name THIS fear, THIS admission"). Measured on live data:
  vulnerability-tag collapse fell from 37% to low single digits.
- **Embedding batching** — large imports no longer kill Ollama's embeddings
  endpoint (requests are chunked at 64 texts). Fixes
  `[chunker] embeddings unavailable` on big scene imports.
- **Build identity in the panel** — the version line now shows
  release + commit (`1.1.2+abc1234`) on its own readable row, and the
  stale-tab alarm compares the full string, so a tab running older extension
  code than the server is flagged even within the same release.
- **Import UI** — shared scenes are listed for every participant; ↻
  re-import a scene without restarting the browser; the list keeps your
  scroll position; the 🧠 last-turn activity line shows what each turn
  surfaced and saved.

## Upgrading

From v1.1.0 or v1.1.1: click **⬆ Update** in the ledger panel (or run
`Marinara_Extender_Update.bat`), then reload the Marinara tab. If you used
scene recaps, run the repair script above. From v1.0: see the
[v1.1 release notes](RELEASE-v1.1.md) first.
