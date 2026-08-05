// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Regenerate docs/PROMPTS.md from the live prompt builders (pifl).
// Run after ANY prompt change, so the review diff shows the assembled text.

import { writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const { promptsAsMarkdown } = await import("../dist/prompt-catalog.js");
const { buildVersion } = await import("../dist/update.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs", "PROMPTS.md");
await mkdir(dirname(out), { recursive: true });
await writeFile(out, await promptsAsMarkdown(buildVersion()), "utf8");
console.log(`wrote ${out}`);
