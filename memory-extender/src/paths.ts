// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Install-relative paths.
//
// Resolve the sidecar's own locations relative to THIS module rather than
// process.cwd(), so it finds its .env, data dir, and bundled extension file no
// matter what directory it's launched from. (Launching from the wrong cwd would
// otherwise give an empty data dir — the user's memories appear gone — and a
// broken setup page.) This file sits at src/ when run via tsx and dist/ when
// built; the package root is one level up in both layouts. fileURLToPath handles
// Windows drive letters and spaces in the path correctly (manual import.meta.url
// munging does not — same reasoning as sentiment/config.ts).

import { fileURLToPath } from "url";
import { dirname, join } from "path";

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// memory-extender/.env — the user's stored config (API key, model, flags).
export function defaultEnvPath(): string {
  return join(PACKAGE_ROOT, ".env");
}

// memory-extender/data — the YAML memory store (overridable via
// MARINARA_EXTENDER_DATA).
export function defaultDataDir(): string {
  return join(PACKAGE_ROOT, "data");
}

// The bundled extension file lives at the repo root, one level above the
// memory-extender package; a sibling copy is accepted as a fallback.
export function extensionJsCandidates(): string[] {
  return [
    join(PACKAGE_ROOT, "..", "marinara-extender.js"),
    join(PACKAGE_ROOT, "marinara-extender.js"),
  ];
}
