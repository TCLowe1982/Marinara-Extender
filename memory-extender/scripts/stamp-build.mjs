// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Stamp the build. Runs as part of `npm run build`, after tsc.
//
// WHY THIS EXISTS. buildVersion() answered "what is git HEAD right now?" when the
// question it is asked — and the question its own comment says it exists to
// answer — is "which build am I running?". Those are different the moment HEAD
// moves without a rebuild, which is every commit.
//
// Worse, it was memoized (update.ts _build) and only ever called from REQUEST
// HANDLERS, so the sha froze at whatever HEAD was when someone first asked. Ask
// early and a stale process looked honest; ask only after a commit and it
// reported a HEAD IT NEVER RAN. Observed live 2026-08-25: a process started on
// d37ca06 kept reporting d37ca06 after HEAD moved — purely because it had been
// queried in between. The observer changed the answer.
//
// A build stamp cannot lie about this: it is written by the build, from the tree
// that was built, and a running process reads a file that describes its own code.

import { execSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(PKG, "dist", "build-info.json");

let sha = "";
let dirty = false;
const repoRoot = [PKG, join(PKG, "..")].find((d) => existsSync(join(d, ".git")));
if (repoRoot) {
  const git = (args) => execSync(`git ${args}`, { cwd: repoRoot, timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  try { sha = git("rev-parse --short HEAD"); } catch { /* not resolvable */ }
  // A build from a dirty tree is NOT the commit it names. Say so in the string
  // rather than letting it impersonate a clean checkout.
  try { dirty = git("status --porcelain").length > 0; } catch { /* ignore */ }
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ sha, dirty, builtAt: new Date().toISOString() }, null, 2) + "\n", "utf8");
console.log(`build stamp: ${sha || "(no git)"}${dirty ? "-dirty" : ""} @ ${new Date().toISOString()}`);
