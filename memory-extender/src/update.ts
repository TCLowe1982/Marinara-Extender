// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// One-click update plumbing (MarinaraExtender-uo4, child of szf).
//
// The sidecar knows its own version (package.json) and checks GitHub's latest
// PUBLISHED release (drafts are excluded by the API) at most once per hour,
// failing silently offline. When a newer release exists the panel shows an
// Update button; POST /api/update spawns the visible updater console
// (scripts/update-sidecar.ps1), which stops this process, pulls, builds, and
// relaunches — the user never opens a terminal.

import { readFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn, execSync } from "child_process";
import { extensionJsCandidates } from "./paths.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function currentVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Release version + short commit, e.g. "1.1.1+cba43f8". The release number
// only bumps when a GitHub release is cut, so between releases every build
// looked identical in the panel — undiagnosable when master is ahead of the
// tag. The commit suffix makes each code change visibly change the version
// string (and the tab/server match check compares the FULL string, so a tab
// served by an older build alarms even within the same release).
let _build: string | null = null;
let _builtAt: string | null = null;

/** When the RUNNING code was built, from the build stamp. null if unstamped. */
export function builtAt(): string | null {
  buildVersion(); // populates _builtAt as a side effect of the same read
  return _builtAt;
}

/**
 * When the build stamp ON DISK says dist was last built. Read FRESH every call.
 *
 * THIS IS NOT builtAt(), AND THE DIFFERENCE IS THE WHOLE POINT. builtAt() rides
 * on the memoized buildVersion(), so it answers "what did the stamp say the
 * first time anybody asked" — which is correct for reporting the running
 * version and USELESS for detecting staleness, because a rebuild after that
 * first read can never move it.
 *
 * That reintroduced the exact observer-dependence the comment in buildVersion()
 * describes retiring: "query early and a stale process looked honest". Measured
 * 2026-08-30 — a health check at 02:03 froze the value, dist was rebuilt at
 * 02:45, and /api/health kept reporting stale:false while the process was
 * running four-hours-old code. The detector built to catch a stale process
 * certified one as current.
 *
 * So staleness compares PROCESS START against the stamp as it is NOW. One tiny
 * JSON read per health check, and it is the only way the answer can change when
 * the thing it describes changes.
 */
export function distBuiltAt(): string | null {
  try {
    const stamp = JSON.parse(readFileSync(join(PKG_ROOT, "dist", "build-info.json"), "utf8")) as {
      builtAt?: string;
    };
    return typeof stamp.builtAt === "string" ? stamp.builtAt : null;
  } catch {
    return null; // unstamped or unreadable — the caller reports unknown, not fresh
  }
}

export function buildVersion(): string {
  if (_build) return _build;
  let code = "";

  // 0. THE BUILD STAMP — authoritative, because it describes THIS CODE.
  //
  // Everything below answers "what does the repo say right now?", which is a
  // different question from "which build am I running?" and diverges the moment
  // HEAD moves without a rebuild. Worse, this function is memoized and is only
  // called from REQUEST HANDLERS, so the git answer froze at whatever HEAD was
  // when somebody first asked: query early and a stale process looked honest,
  // query only after a commit and it reported a HEAD IT NEVER RAN. The observer
  // changed the answer. A stamp written by the build cannot do that.
  //
  // "-dirty" is not decoration: a build from a modified tree is not the commit
  // it names, and saying so beats letting it impersonate a clean checkout.
  try {
    const stamp = JSON.parse(readFileSync(join(PKG_ROOT, "dist", "build-info.json"), "utf8")) as
      { sha?: string; dirty?: boolean; builtAt?: string };
    if (stamp.builtAt) _builtAt = stamp.builtAt;
    if (stamp.sha) {
      _build = `${currentVersion()}+${stamp.sha}${stamp.dirty ? "-dirty" : ""}`;
      return _build;
    }
  } catch {
    // No stamp: running from src (tsx/vitest) or a pre-stamp build. Fall through
    // to the git answer, which is the best available and now clearly labelled as
    // second choice rather than as the truth.
  }

  // 1. Git checkout — short HEAD sha. The .git lives at the REPO ROOT, but this
  // package is memory-extender/ (PKG_ROOT), so .git is PKG_ROOT/.. — checking
  // only PKG_ROOT silently missed every normal checkout, leaving the panel on a
  // bare version with no build code (MarinaraExtender-4b2). Check both. The
  // existsSync guard still avoids the spawn (and the "fatal: not a git
  // repository" stderr) on real release installs; stdio ignoring stderr is the
  // backstop (e.g. git missing from PATH).
  const repoRoot = [PKG_ROOT, join(PKG_ROOT, "..")].find((d) => existsSync(join(d, ".git")));
  if (repoRoot) {
    try {
      code = execSync("git rev-parse --short HEAD", {
        cwd: repoRoot,
        timeout: 3_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString().trim();
    } catch {
      // not resolvable — fall through to the content hash
    }
  }
  // 2. No .git (ZIP/release install) — there is no commit to name, but the build
  // must still be identifiable, so hash the extension file the panel actually
  // runs. A short content hash changes whenever the shipped code changes, which
  // is exactly what "which build am I on?" needs. The 'c' prefix keeps a content
  // hash from being misread as a git sha.
  if (!code) {
    for (const p of extensionJsCandidates()) {
      try {
        code = "c" + createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 8);
        break;
      } catch {
        // try next candidate
      }
    }
  }
  _build = code ? `${currentVersion()}+${code}` : currentVersion();
  return _build;
}

// Plain numeric dotted compare: 1 if a > b, -1 if a < b, 0 if equal.
// Build-metadata suffixes ("1.1.1+cba43f8") are ignored.
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, "").replace(/\+.*$/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/i, "").replace(/\+.*$/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

const RELEASES_URL = "https://api.github.com/repos/TCLowe1982/Marinara-Extender/releases/latest";
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

let _lastCheck = 0;
let _latest: string | null = null;

export async function latestVersion(): Promise<string | null> {
  if (Date.now() - _lastCheck < CHECK_INTERVAL_MS) return _latest;
  _lastCheck = Date.now();
  try {
    const res = await fetch(RELEASES_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return _latest;
    const json = (await res.json()) as { tag_name?: string };
    _latest = json.tag_name?.replace(/^v/i, "") ?? null;
  } catch {
    // offline / rate-limited — keep whatever we knew
  }
  return _latest;
}

export async function updateStatus(): Promise<{ version: string; latest: string | null; updateAvailable: boolean }> {
  const latest = await latestVersion();
  return {
    // The panel displays (and the tab/server match check compares) the full
    // build string; release comparison ignores the +sha suffix.
    version: buildVersion(),
    latest,
    updateAvailable: !!latest && compareVersions(latest, currentVersion()) > 0,
  };
}

// Launch the updater in its own visible console window and let it take over
// (it stops this process as its first step). Returns false when the script
// is missing — never throws into the request path.
export function spawnUpdater(): boolean {
  const script = join(PKG_ROOT, "scripts", "update-sidecar.ps1");
  if (!existsSync(script)) return false;
  try {
    const child = spawn(
      "cmd.exe",
      ["/c", "start", "Marinara Extender Update", "powershell", "-NoLogo", "-ExecutionPolicy", "Bypass", "-File", script],
      { detached: true, stdio: "ignore", windowsHide: false },
    );
    child.unref();
    console.info("[ME:update] updater launched — this process will be stopped and relaunched by it");
    return true;
  } catch (err) {
    console.error("[ME:update] failed to launch updater:", err);
    return false;
  }
}
