// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Shared index reader for the analysis scripts (hdq1).
//
// The scripts used to open "index.yaml" by name. After the JSON migration that
// name resolves to nothing, and every one of them would have reported ZERO rows
// and looked like a clean audit — an audit tool that answers "no problems"
// because it cannot find the data is the worst failure mode available to it.
//
// So the lookup lives in one place and tries both names. `.superseded` is never
// read: a retired YAML is a backup, not an index.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

/**
 * Read one scope index in whichever format is on disk.
 * @param dir  scope directory
 * @param base "index" or "index.cold"
 * @returns the parsed index, or null if neither format is present
 */
export function readIndexAny(dir, base) {
  const jsonPath = join(dir, `${base}.json`);
  if (existsSync(jsonPath)) return JSON.parse(readFileSync(jsonPath, "utf8"));
  const yamlPath = join(dir, `${base}.yaml`);
  if (existsSync(yamlPath)) return YAML.parse(readFileSync(yamlPath, "utf8"));
  return null;
}

/** Rows from one scope index, or [] when absent. */
export function readIndexRows(dir, base) {
  const y = readIndexAny(dir, base);
  return Array.isArray(y?.entries) ? y.entries : [];
}
