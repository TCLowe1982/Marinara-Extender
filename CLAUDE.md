# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->

## Session Completion — Project Addendum

**These amend the mandatory workflow above.** (Kept here, *outside* the beads-managed block, so a `bd` regen can't drop them.)

- **SKIP `bd dolt push`.** This project does not use Dolt and never has — `bd dolt remote list` reports "No remotes configured", so the command in step 4 always fails. It is boilerplate from the beads-managed block, not a step anyone dropped. Beads data travels in `.beads/issues.jsonl` via git, so a plain `git push` is the whole job. Do not "fix" this by adding a remote.

- **Restart the sidecar whenever you need to** (TC, 2026-08-04, standing). Do not ask, and do not leave work sitting behind a stale process. Kill the listener on 3001; `start.ps1`'s watchdog relaunches it within ~10s onto the current `dist`. Verify by process start time vs `dist/index.js` mtime — **the version string is not proof**. Corrected 2026-08-25: `buildVersion()` does NOT re-read git at runtime, and does not capture at startup either. `_build` is memoized (`update.ts:38`) and the function is only ever called from REQUEST HANDLERS, so the sha freezes at **whatever HEAD was when the process was first asked**. That is worse than either alternative, because whether it lies depends on when you happened to query it: ask early and a stale process looks honest; ask only after a commit and it reports a HEAD it never ran. Observed live — a process started 13:40 reported `d37ca06` even after HEAD moved to `1e4af86`, purely because it had been queried in between. Process start time vs `dist` mtime is the only check that cannot be fooled this way.

- **Show prompt text before shipping a prompt change.** TC reviews prompts; models are unreliable at prompting models. The assembled text is at `/prompts` on the running sidecar and in `memory-extender/docs/PROMPTS.md`. **Regenerate that file (`node scripts/dump-prompts.mjs`) in the same commit as any prompt edit**, so the review diff shows readable prose rather than template-literal fragments.

- **Update the expert skill.** If code or behavior changed this session, update the corresponding expert skill so it never drifts from the code:
  - Marinara **Extender** changes → `marinara-extender-expert` (`.claude/skills/marinara-extender-expert/` — `SKILL.md` + the affected `references/*`).
  - Marinara **Engine** changes → `marinara-engine-expert`.

  The repo copy under `.claude/skills/` is **canonical**; re-sync the global `~/.claude/skills/` copy so they don't drift. A stale skill is worse than none. (Also recorded in beads: `bd memories session-close`.)


## Build & Test

_Add your build and test commands here_

```bash
# Example:
# npm install
# npm test
```

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

_Add your project-specific conventions here_
