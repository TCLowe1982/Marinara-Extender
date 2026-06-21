# Marinara Extender v1.2 — "The story stays, and you can take it back"

v1.1 made characters remember the *story*; v1.2 makes that story actually reach
the model, makes memory **recoverable**, and makes the whole thing **installable
by a stranger** — including with a non-Ollama backend.

## Headline: the recap layer, end to end

v1.1 *generated* recaps (scene arcs, through-line arcs). v1.2 *uses* them. The
loader now injects a **"Story so far"** — the relevant recaps — **above** the raw
beats, so a character is grounded in the narrative arc before the individual
moments. Recaps are surfaced two ways:

- **By relevance** (lexical), and
- **By meaning** (embedding similarity), so the right arc appears even when the
  conversation shares no keywords with its label.

Both tiers surface: scene-arc recaps (the chronological floor) and through-line
recaps (the cross-scene ceiling), ceiling first. The underlying beats stay
underneath — a recap is a compression, and the detail that didn't make the
footnote cut is still one retrieval away.

## Memory you can take back

Deleting a memory no longer destroys it. **Delete tiers it to cold**, and a
**Recently deleted** panel restores it with one click; permanently erasing is a
separate, deliberate second step. Facts the reconciliation curator superseded
are likewise restorable from the **Retired** section. Nothing the system (or a
stray click) removes is gone for good unless you dig for it.

## A memory tab that shows everything

The Memory tab gained a **Chat | Character** scope toggle — so a character's
durable, cross-chat memory is finally visible and manageable, not just the active
conversation. Groups are collapsible, and a **sort** selector orders by newest,
most-used, or oldest.

## Guests keep their voice

In a multi-character scene, every participant's own ledger and recaps are now
refreshed each turn (**dual-retrieval**), so a guest character answers from their
own canon at home fidelity instead of degrading toward the visible scene.

## A told story lands in one telling

Tell a character a long, multi-page memory and it's routed through **windowed
granular ingestion** — the same machinery a chat re-import uses — so it becomes
rich beats instead of a single one. No more re-importing the chat to make it
stick.

## Install: guided, quiet, and not Ollama-only

- **First-run onboarding** pulls the chat and embedding models, opens the
  extension setup page, and guides you if Ollama isn't installed — then goes
  **quiet on every launch after**.
- **Bring your own backend.** Point `MARINARA_EXTENDER_LOCAL_URL` at any
  OpenAI-compatible server (KoboldCpp, LM Studio, llama.cpp) and the launcher
  detects it and skips the Ollama steps. The sidecar always spoke OpenAI; now the
  launcher does too.
- **Build code in the version string** so a stale tab in the panel is obvious.

## Notes

- The launcher is now **`Marinara_Extender_Start.bat`**.
- **Getting it:** clone (recommended — keeps the one-click updater working) or
  download the ZIP (no git; manual updates for now). See the README.
- Clone installs update in place via the panel's Update button; a ZIP/no-git
  updater is tracked for a follow-up.
