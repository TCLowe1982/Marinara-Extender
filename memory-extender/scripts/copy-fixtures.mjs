// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Copy non-TS runtime fixtures into dist/.
//
// tsc only emits what it compiles, so a .json the code reads at runtime never
// reaches dist/. analyzer.ts falls back to the src/ copy when dist/ lacks one, which
// keeps dev and tests working — but a dist-only deploy would hit the throw. Since
// that throw is deliberately fatal (an empty echo ledger is worse than a crash,
// because it looks like a clean run), this copy is part of the build, not an extra
// step someone has to remember.

import { copyFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const FIXTURES = [
  ["src/sentiment/bait.json", "dist/sentiment/bait.json"],
];

for (const [from, to] of FIXTURES) {
  await mkdir(dirname(join(ROOT, to)), { recursive: true });
  await copyFile(join(ROOT, from), join(ROOT, to));
  console.log(`fixture: ${from} -> ${to}`);
}
