# Marinara Extender v1.1.3 — the sidecar heals itself

Patch release. v1.1.2 made recall *correct*; this one makes it *stay up*.

## The problem: a silent sidecar death took memory down until you noticed

If the memory server stopped — a closed window, an out-of-memory kill, a crash —
nothing said so. The engine kept injecting whatever was last written to the
lorebook, so characters ran on a **frozen snapshot** until a human happened to
notice and relaunch. Cross-character continuity is the first thing to break:
shared scenes and threads depend on the live server, so they quietly stop
updating while everything *looks* fine. One incident cost ~2 hours of stale
context before it was caught.

Two fixes, both of which should have been in the original launcher.

## Watchdog — a dead sidecar comes back on its own in ~10–15 seconds

`Extender_start.bat`'s console no longer just sits waiting for a keypress. It
now health-checks the sidecar every few seconds and, on two consecutive failed
probes, relaunches it and logs the event. The double-check (the probe has a 6s
timeout, so this is ~12–16s total) means a momentarily busy server is never
killed by mistake. Verified by hard-killing a running sidecar: it was back on
port 3001 in ~11 seconds with no human in the loop.

So **leave the launcher window open** — that console is now the supervisor.

## Crash breadcrumb — the next death names itself

The server now writes a final line to `logs/sidecar.log` on an uncaught
exception, an unhandled rejection, or a signal — synchronously, so it actually
lands before the process is gone. A code-level crash that used to vanish
without a trace now leaves `[breadcrumb] sidecar exiting — <cause>`. Hard kills
and a closed console window still can't self-log (nothing inside a dying
process can), but the watchdog records *those* from the outside as
`[watchdog] sidecar unreachable`. Between the two, no death is silent anymore.

## Also in this release

- **One launcher.** The repo root had accreted five start scripts, which is how
  two of them got launched at once and raced for the port (the "keeps closing"
  reports). Consolidated to `Extender_start.bat` (start), `start.ps1` (its
  engine, now with the watchdog and an `[L] View log` command), and
  `Marinara_Extender_Update.bat` (one-click update).
- **Persistent log on the normal launcher.** `Extender_start.bat` now tees the
  sidecar's output to `logs/sidecar.log` (UTF-8), and `[L]` in the console
  opens it — so there's always something to paste when something goes wrong.

## Upgrading

From v1.1.x: click **⬆ Update** in the ledger panel (or run
`Marinara_Extender_Update.bat`), then reload the Marinara tab. From v1.0: see
the [v1.1 release notes](RELEASE-v1.1.md) first. No data migration.
