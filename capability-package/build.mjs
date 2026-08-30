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

// 1.1.0 — ported from the branch convention to the SHIPPED contributor API.
// 1.0.0 registered under api.registerService("marinara-extender:prompt-context"),
// which released Marinara accepts and never consults for prompt context, so that
// build reports active/ready and does nothing. This is not a compatible change:
// 1.0.0 cannot work on a released Engine and 1.1.0 cannot work on the branch.
const VERSION = "1.1.0";

// CORRECTED 2026-08-30. The previous note here said "the prompt-context
// contributor seam does not exist in released Marinara yet; it ships with the
// Engine branch this package was developed against". That was true of the seam
// the branch built (registerService keyed on "<agentId>:prompt-context"). It is
// false of the SHIPPED Engine, which has its own first-class seam —
// api.registerPromptContext(fn), gated on the "prompt-context" permission and
// collected in generate.routes.ts during prompt assembly. Verified against the
// installed 2.4.3 build, which is the artifact users actually run.
//
// Pinned to 2.4.3 because that is the version the API was VERIFIED on, not the
// earliest that might carry it. Guessing a lower floor to widen compatibility
// would trade a clean install-time failure for the silent one this whole port
// exists to eliminate.
const ENGINE_MIN = "2.4.3";

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
  engineVersion: process.env.MARINARA_ENGINE_VERSION ?? "2.4.3",
  // The RELEASED 2.4.3 build this was verified against, read from the installed
  // Engine checkout. The old value named ac2c3c4df on feat/memory-injection-consumer,
  // which is in no release and is now only the reference implementation for the
  // upstream ask — recording it here claimed provenance we never had.
  engineCommit: process.env.MARINARA_ENGINE_COMMIT ?? "34442e26da577ff0d95ee890a87024e35831bfa9",
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
