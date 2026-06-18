# The Ledger Pattern

*A design pattern for reliably processing large text inputs through a
context-limited LLM. Named by TC; first formalized after the 1dn fact-capture
work, where a fact extracted cleanly from a focused window vanished when the
same model was handed a larger one.*

## Intent

Process a large text input through an LLM **without** degrading the result by
overstuffing the context. Window the input, process one slice at a time against
a durable per-input ledger, and assemble the slices at the end.

## Motivation

A single large prompt makes a model *triage*: it returns the few most salient
results and silently drops the quiet ones, mis-attributes details, or truncates.
This is not fixed by a better prompt — it's a property of asking a model to
attend to too much at once.

> Live example: the fact "Mari's D&D class is a Pact of the Tome Warlock" was
> dropped from a 10-chunk extraction window and recovered, by the *same model*,
> from a focused window. The model could always do it — it just couldn't do it
> while triaging ten chunks of dense prose.

## Structure

1. **Ledger** — a durable, per-input record (a temp file on disk) of slice →
   result. Makes the run resumable (a crash keeps completed slices) and
   inspectable (you can read what each slice produced before assembling).
2. **Window** — slice the input into chunks sized by the model's context budget
   (see the allocation rule), not a fixed count.
3. **Process** — send one slice at a time.
4. **Assemble** — merge and de-duplicate the per-slice results at the end.

## The context allocation rule (prompt integrity)

Partition the model's context window in thirds-ish, and keep the input slice
small:

| Portion | Share | Purpose |
| --- | --- | --- |
| Prompt / instructions | ~1/6 | system prompt, schema, examples |
| Input chunk | ~1/6 | the slice being processed |
| Headroom | ~2/3 | the model's room to reason + produce output |

The load-bearing constraint: **the input slice should be ≤ ~1/6 of the context
window, and prompt + chunk together ≤ ~1/3.** A model operating near its limit
degrades; leaving 2/3 free is what keeps extraction exhaustive instead of
triaged. The window therefore **scales with the model**: a 200k-context model
takes far larger slices than an 8k local model — sizing by a fixed chunk count
(as the first 1dn cut did) is the anti-pattern.

## Applicability

Use it whenever:
- a large text input gave a lossy/triaged/mis-attributed result, OR
- a single call would put more than ~1/3 of the model's context in the prompt.

Especially: extraction/classification over long transcripts (fact capture, beat
analysis, scene recap, digest, arc rendering).

## In this codebase

Already embodies parts of it:
- **Import pipeline** (`sentiment/pipeline.ts`) — persists beats incrementally;
  a cancel/crash keeps every completed beat (the ledger, as resumability).
- **Backfill / repair scripts** (`scripts/backfill-scene-facts.mjs`,
  `repair-recap-pairing.mjs`) — window the input, dry-run preview, assemble.
- **Fact extraction** (`facts.ts` `ingestSceneFacts`) — windows the scene; the
  10→5 chunk fix was an ad-hoc instance of the allocation rule.

Missing / to apply:
- **Context-budget windows.** Size the slice to a fraction (~1/6) of the *active
  model's* context window instead of a fixed chunk count, so a large remote
  model isn't throttled to a small local model's window. (See issue notes.)
- **An on-disk ledger for the fact pass**, so a long backfill is resumable and
  the per-slice extraction is inspectable before assembly.

## Consequences

- **+** Higher recall and accuracy on large inputs (no triage).
- **+** Resumable and inspectable (the ledger).
- **−** More LLM calls (bounded, and cheap relative to losing the data).
- **−** Assembly must de-duplicate across slices (a fact restated in two windows).
