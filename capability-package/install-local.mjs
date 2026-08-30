// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Dev-install this package into a local Marinara Engine.
//
// WHY BY HAND. package-manager.service.ts install() resolves the OFFICIAL CATALOG
// only and throws "Package is not present in the official catalog" for anything
// else; third-party trust is explicitly unbuilt ("A future third-party flow
// requires a separate explicit trust design"). The LOADER has no such
// restriction — capability-module-runtime imports any registered package's
// serverEntrypoint and calls activate(context) — so a dev-install is a registry
// entry plus files in the right place.
//
// This exists instead of hand-editing installed.json because that file governs
// what the Engine loads at boot: a malformed entry fails registry parsing hard
// enough to abort bootstrap, and doing it by hand twice is how you find that out.
//
// SAFETY. installed.json is backed up before it is touched, the manifest hashes
// are re-verified against the payload actually copied (not trusted from the
// build), and an existing entry for this package is replaced rather than
// duplicated. It never removes another package.
//
// Usage:
//   node capability-package/install-local.mjs --engine "C:/path/to/MarinaraEngine"
//   node capability-package/install-local.mjs --engine ... --dry-run

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

const arg = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : undefined; };
const DRY = process.argv.includes("--dry-run");
const ENGINE = arg("--engine") ?? "C:/Users/holyk/AppData/Local/MarinaraEngine";

const CP = join(ENGINE, "packages", "server", "data", "capability-packages");
const REGISTRY = join(CP, "installed.json");
const VERSIONS = join(CP, "versions");

if (!existsSync(dist)) { console.error("no dist/ — run: node capability-package/build.mjs"); process.exit(1); }
if (!existsSync(REGISTRY)) { console.error(`no registry at ${REGISTRY}\nIs --engine correct? (this must be the engine you RUN, not a dev checkout)`); process.exit(1); }

const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
const target = join(VERSIONS, manifest.id, manifest.version);

console.log(`package : ${manifest.id}@${manifest.version}`);
console.log(`engine  : ${ENGINE}`);
console.log(`target  : ${target}`);

// Verify the hashes describe the payload we are about to install. The Engine
// checks these at install time in the catalog path; nothing checks them here, so
// a stale dist/ would install silently and fail later as "corruption".
for (const f of manifest.files) {
  const bytes = readFileSync(join(dist, f.path));
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== f.sha256 || bytes.length !== f.bytes) {
    console.error(`INTEGRITY: ${f.path} does not match manifest — rebuild before installing.`);
    process.exit(1);
  }
}
console.log(`hashes  : ${manifest.files.length} file(s) verified against manifest`);

const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));
const packages = registry.packages ?? [];
const prior = packages.find((p) => p.id === manifest.id);
console.log(`registry: ${packages.length} installed${prior ? `, replacing existing ${manifest.id}@${prior.version}` : ""}`);

if (DRY) { console.log("\nDRY RUN — nothing written. Re-run without --dry-run."); process.exit(0); }

const backup = `${REGISTRY}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
copyFileSync(REGISTRY, backup);
console.log(`backup  : ${backup}`);

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const f of manifest.files) copyFileSync(join(dist, f.path), join(target, f.path));
copyFileSync(join(dist, "manifest.json"), join(target, "manifest.json"));

const entry = {
  id: manifest.id,
  version: manifest.version,
  manifest,
  installedAt: new Date().toISOString(),
  status: "active",
  error: null,
  readiness: "ready",
  readinessError: null,
  legacy: false,
};
registry.packages = [...packages.filter((p) => p.id !== manifest.id), entry];
writeFileSync(REGISTRY, JSON.stringify(registry, null, 2), "utf8");

console.log("");
console.log(`INSTALLED ${manifest.id}@${manifest.version}`);
console.log("");
console.log("NOT LIVE YET — two things remain, and both are easy to forget:");
console.log("  1. RESTART Marinara Engine. The registry is read at boot; a running");
console.log("     Engine has not seen this entry.");
console.log("  2. ENABLE THE AGENT PER CHAT: Chat Settings -> Agents -> Misc Agents.");
console.log("     agents.json declares enabledByDefault:false and the contributor");
console.log("     self-gates on chatMeta.activeAgentIds, so it stays inert everywhere");
console.log("     it was not switched on.");
console.log("");
console.log("Then watch the sidecar log for [ME:pre-turn] and the Engine log for");
console.log("\"prompt-context contributor INVOKED\". Silence in BOTH means the seam");
console.log("is not wired — that failure is otherwise completely silent.");
