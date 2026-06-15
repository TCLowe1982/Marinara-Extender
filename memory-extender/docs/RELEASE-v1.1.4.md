# Marinara Extender v1.1.4 — the watchdog stops false-alarming

Patch release, and a quick one: it fixes a regression introduced in v1.1.3.

## What was wrong

v1.1.3's watchdog decided the sidecar was dead from a slow `/api/health`
response (a 6-second timeout, twice). But the sidecar runs the local model for
memory analysis *while the chat is generating*, so a heavy turn makes the
machine compute-bound and the health probe legitimately slow for a few seconds.
The watchdog read "slow" as "dead" and relaunched a perfectly healthy server —
roughly once an hour. No data was lost (the relaunch is clean), but it was an
unnecessary, occasionally disruptive restart.

## The fix

Liveness is now the **port**, not the HTTP response. A bound port 3001 proves
the process is alive even when it's busy, so the watchdog only relaunches when
the port has **no listener** — the genuine crash case, recovered in ~10s as
before. A separate, deliberately patient guard still catches a truly wedged
server (port bound but hung) after a long unbroken failure streak (~75s+), far
beyond any normal heavy turn — so a busy sidecar is never killed by mistake.
The relaunch reason (process-gone vs wedged) is now written to the log.

## Upgrading

From v1.1.x: click **⬆ Update** in the ledger panel (or run
`Marinara_Extender_Update.bat`), then reload the Marinara tab. Updating relaunches
the launcher once — that's the only restart you'll see. No data migration.
