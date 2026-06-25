# The Ledger Pattern

> **This document has moved to its own repository:**
> **→ [github.com/TCLowe1982/ledger-pattern](https://github.com/TCLowe1982/ledger-pattern)**
>
> The Ledger Pattern is now maintained as a standalone, platform-agnostic
> project — full write-up, formal spec, a drop-in agent recipe, and a
> local-model implementation guide. Licensed CC BY 4.0.

## Why it lived here

The pattern was first discovered and formalized **in this project**. Marinara
Extender processes long conversations through context-limited local models to
build persistent character memory — exactly the workload that exposed the
failure the pattern fixes: a fact extracted cleanly from a focused window
vanishing when the same model was handed a larger one.

It was extracted into its own repo so it can be used without any knowledge of the
Extender. Marinara Extender remains its original **reference implementation** —
the incremental, resumable import pipeline; the windowed backfill/repair scripts;
and the context-sized fact extraction all embody it.

See the [standalone repo](https://github.com/TCLowe1982/ledger-pattern) for
everything.
