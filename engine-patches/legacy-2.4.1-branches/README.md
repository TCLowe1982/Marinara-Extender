# Legacy Engine branches rescued from the old D: working copy

Exported 2026-09-07 from `d:\Entertainment\Wip\Projects\Marinara-Engine`, a
**2.4.1-era clone that is NOT the running Engine**. See `_STALE_READ_ME_FIRST.md`
at that copy's root.

That clone held four commits that existed nowhere else — two local branches, both
unpushed, neither reachable from `origin/staging`. They are preserved here as
`git format-patch` output so the clone can be deleted without losing them.

## What is here

Base for all four: `origin/staging` in that clone (`1031013b1`, 368 behind at
time of export).

| Patch | Branch | Commit |
|---|---|---|
| 0001 | `feat/memory-injection-consumer` | `4740d09e9` feat(generation): generic prompt-context contributions for capability packages |
| 0002 | `feat/memory-injection-consumer` | `ac2c3c4df` feat(generation): wire prompt-context contributions into the generation route |
| 0003 | `feat/turn-complete-notification` | `370a960cd` feat(server): optional turn-complete notification for companion tools |
| 0004 | `feat/turn-complete-notification` | `fa31471ad` docs(turn-notify): record verified regeneration semantics |

## Status of the work — read before reapplying anything

**0001 + 0002 are almost certainly SUPERSEDED.** This is the injection-surface
work `MarinaraExtender-7zro` credits TC with on 2026-08-03. The capability now
exists upstream at v2.4.4 — `packages/server/src/services/capability-packages/
capability-prompt-context.service.ts` is present in the real install — so the
generic prompt-context contract a package needs is already there without these.
Kept for provenance and for diffing our intent against what upstream shipped,
NOT as something to reapply.

**0003 + 0004 are UNVERIFIED.** Nobody has checked whether a turn-complete
notification path exists at 2.4.4 or whether this is still wanted. Do not assume
it is dead just because 0001/0002 are.

## What is deliberately NOT here

The clone also carries an uncommitted diff to
`packages/server/src/services/llm/providers/claude-subscription.provider.ts`.
That is the same `CLAUDE_CODE_EXECUTABLE_PATH` pin already tracked by
`MarinaraExtender-8pwc` and already saved one directory up, anchored to the
versions that matter:

    engine-patches/claude-subscription-cli-path.v2.4.3.patch
    engine-patches/claude-subscription-cli-path.v2.4.4.patch

The copy in the D: clone is the 2.4.1-era anchor of the identical change. It adds
nothing, so it was not exported.
