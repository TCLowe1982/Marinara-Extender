// Marinara Extender — capability package build
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.
//
// Assembles dist/ as an installable capability package: copies the entrypoints
// and writes manifest.json with the sha256 + byte size the Engine's installer
// verifies before extraction. Hashes are COMPUTED, never hand-maintained — a
// manifest whose digests drift from its payload fails installation with an
// integrity error that reads like corruption rather than a stale build.

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, "src");
const dist = join(root, "dist");

const VERSION = "1.0.0";

// The prompt-context contributor seam does not exist in released Marinara yet;
// it ships with the Engine branch this package was developed against. Pin the
// floor to the first Engine version that carries it so an install on an older
// Engine fails with a compatibility message instead of registering a service
// nothing will ever call.
const ENGINE_MIN = "2.4.1";

const ENTRYPOINTS = [
  { from: "agents.json", to: "agents.json" },
  { from: "server-entry.mjs", to: "server.mjs" },
];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const files = ENTRYPOINTS.map(({ from, to }) => {
  copyFileSync(join(src, from), join(dist, to));
  const bytes = readFileSync(join(dist, to));
  return { path: to, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
});

// Required by manifest schemaVersion 2, and validated at Engine startup — a
// missing or malformed value fails registry parsing hard enough to abort
// bootstrap, so it is derived rather than typed by hand. Override via env when
// building against a different Engine checkout.
const BUILT_AGAINST = {
  engineVersion: process.env.MARINARA_ENGINE_VERSION ?? "2.4.1",
  engineCommit: process.env.MARINARA_ENGINE_COMMIT ?? "ac2c3c4dfb3d254895781a3e84c38146762ed4e2",
};

if (!/^[a-f0-9]{40}$/.test(BUILT_AGAINST.engineCommit)) {
  throw new Error(`builtAgainst.engineCommit must be a 40-character hex sha: got "${BUILT_AGAINST.engineCommit}"`);
}

const manifest = {
  schemaVersion: 2,
  capabilityApi: { major: 1, minor: 7 },
  builtAgainst: BUILT_AGAINST,
  id: "marinara-extender",
  name: "Marinara Extender",
  version: VERSION,
  description:
    "Scoped persistent memory for characters, injected while the prompt is assembled. Brokers to the Marinara Extender sidecar running locally; contributes nothing when it is not running.",
  engine: { min: ENGINE_MIN, maxExclusive: "4.0.0" },
  kind: ["agent"],
  entrypoints: { agents: "agents.json", server: "server.mjs" },
  // Declared honestly and kept minimal. `network` is required because the
  // package brokers to a local companion process; the destination is loopback
  // and comes from configuration only, never from chat content or model output.
  permissions: ["agent-runtime", "chat-read", "network", "prompt-context"],
  files,
  restartRequired: false,
};

writeFileSync(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`built marinara-extender ${VERSION} -> ${dist}`);
for (const file of files) console.log(`  ${file.path.padEnd(14)} ${file.bytes} bytes  ${file.sha256.slice(0, 16)}…`);
