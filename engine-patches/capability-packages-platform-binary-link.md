# Engine install state: the missing platform-binary link for capability packages

**Not a patch — a directory junction in the Engine install.** It survives no
reinstall and no `pnpm install`, and there is no file in the Engine repo that
records it, so it lives here with the patches for the same reason they do.

Created 2026-09-07 against Engine **v2.4.4** (`1a299369a`).

## Symptom

Any capability package that bundles the Agent SDK fails every call with:

    Native CLI binary for win32-x64 not found. Reinstall
    @anthropic-ai/claude-agent-sdk without --omit=optional, or set
    options.pathToClaudeCodeExecutable.

Observed from Noodle 1.2.14 (`[noodle] Timeline refresh failed`), whose stack
lands in its **own** bundle, not in Engine code:

    at AS.chat (…/data/capability-runtime-snapshots/noodle-1.2.14-…/server.mjs)

## Cause

The SDK resolves its optional per-platform package relative to its **own module
URL**. For a capability package that bundles the SDK, that URL is inside
`data/capability-runtime-snapshots/<pkg>/`, whose `node_modules` symlinks to
`packages/server/data/capability-packages/node_modules`.

That directory had the SDK but **not its platform sibling**:

    @anthropic-ai/claude-agent-sdk             -> .pnpm/…@0.3.235/…      present
    @anthropic-ai/sdk                          -> .pnpm/…@0.93.0/…       present
    @anthropic-ai/claude-agent-sdk-win32-x64                             MISSING

The Engine's own SDK tree *does* carry that sibling (pnpm placed it there), which
is why the chat provider worked while every bundling package failed.

**Nothing was missing from disk.** `claude-agent-sdk-win32-x64@0.3.235` has been
installed since 2026-09-01 11:39 at `MarinaraEngine\.pnpm\…`, 326,528,672 bytes.
Only the link into the capability-packages tree was absent. Do not "fix" this by
reinstalling — see `MarinaraExtender-8pwc`, where that misreading cost two
separate diagnoses.

## The fix

One directory junction, mirroring the link pnpm already made for the server.
A **junction**, not a symlink: `New-Item -ItemType SymbolicLink` requires
elevation on this machine, `mklink /J` does not, and Node's resolver follows both
identically.

```powershell
$link   = 'C:\Users\holyk\AppData\Local\MarinaraEngine\packages\server\data\capability-packages\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64'
$target = 'C:\Users\holyk\AppData\Local\MarinaraEngine\.pnpm\@anthropic-ai+claude-agent-sdk-win32-x64@0.3.235\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64'
cmd /c mklink /J "`"$link`"" "`"$target`""
```

**The version is in the target path.** After any Engine bump that moves the SDK,
re-point this at the new `@0.x.y` directory or it will dangle.

## Verifying it

Resolve the package the way the SDK does — from the package's own snapshot file,
not from the Engine root, or the test proves nothing:

```js
const { createRequire } = require("module");
const req = createRequire("C:/…/data/capability-runtime-snapshots/<pkg>/server.mjs");
req.resolve("@anthropic-ai/claude-agent-sdk-win32-x64/package.json");
```

Verified 2026-09-07: resolves to `@0.3.235` with `claude.exe` present.

## Scope

This fixes **every** capability package that bundles the SDK, not just Noodle,
and it needs no code change, no rebuild, and no restart — the SDK performs the
lookup per call, not at module load.

It is unrelated to the `pathToClaudeCodeExecutable` pins in
`claude-subscription-cli-path.v2.4.4.patch` and
`connections-route-cli-path.v2.4.4.patch`. Those cover **Engine** call sites,
which pass the option explicitly and never reach this lookup. A package's bundled
SDK cannot be reached by either patch, and honours no environment variable —
Noodle's bundle references `pathToClaudeCodeExecutable` three times and
`CLAUDE_CODE_EXECUTABLE_PATH` zero times.
