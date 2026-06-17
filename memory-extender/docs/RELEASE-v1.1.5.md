# Marinara Extender v1.1.5 — no more git errors on ZIP installs

Patch release. Fixes a confusing (but harmless) error on installs that aren't a
git checkout, plus two pieces of extension hardening.

## `fatal: not a git repository` — fixed

If you installed by downloading a ZIP/release (no `.git` folder), the extender
printed `fatal: not a git repository` on startup. It was cosmetic — the server
ran fine and just couldn't stamp the `+commit` onto its version — but it looked
like something was broken.

- The version stamp now skips git entirely unless the install is actually a
  checkout (and silences git's stderr as a backstop).
- The one-click updater now detects a non-git install **before** stopping the
  server and explains how to update manually, instead of failing with a
  misleading "commit or stash your changes" message and leaving the server down.

**If you're on a ZIP/download install:** the one-click updater needs git, so it
can't update you in place. To get this fix and future auto-updates, reinstall
with `git clone`, or download this release and copy the files over your install
— your `memory-extender/data` folder and `.env` are not in the release, so your
memory and API key are preserved.

## Extension hardening

- The page hook that refreshes memory before each turn now installs **once** per
  page, even if the extension script is evaluated more than once — preventing a
  rare race that could blank memory mid-generation.
- The extension's API calls tolerate a non-JSON/empty response (a stray error
  page) instead of throwing.

## Upgrading

From a **git install**: click **⬆ Update** in the ledger panel (or run
`Marinara_Extender_Update.bat`), then reload the Marinara tab. From a **ZIP
install**: see the note above. No data migration.
