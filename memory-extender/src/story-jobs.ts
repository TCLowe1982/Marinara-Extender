// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Resumable story-import jobs.
//
// A job is keyed by a hash of the source text + the options that affect parsing
// (povCharacter, characters, useExternal). Re-running the same import finds the
// same job and resumes: attributed windows are cached here, and the analysis
// phase resumes off the beats already on disk (see pipeline + encoder).
//
// Stored at data/characters/<identityKey>/imports/<jobKey>.yaml

import { readFile, writeFile, mkdir, readdir, unlink, rename } from "fs/promises";
import { join, dirname } from "path";
import { createHash } from "crypto";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { getDataDir } from "./storage.js";
import type { DigestMessage } from "./digest.js";

export interface ImportJob {
  jobKey: string;
  title?: string;
  method?: string;
  windowsTotal?: number;
  // Per-window attributed output. Index i present => window i is done.
  attributedWindows?: DigestMessage[][];
  createdAt: string;
  updatedAt: string;
}

export function computeJobKey(
  text: string,
  opts: { povCharacter?: string; characters?: string[]; useExternal?: boolean },
): string {
  return createHash("sha1")
    .update(text)
    .update(`\0pov:${opts.povCharacter ?? ""}`)
    .update(`\0chars:${(opts.characters ?? []).join(",")}`)
    .update(`\0ext:${opts.useExternal ? "1" : "0"}`)
    .digest("hex")
    .slice(0, 16);
}

function jobsDir(characterId: string): string {
  return join(getDataDir(), "characters", characterId, "imports");
}

function jobPath(characterId: string, jobKey: string): string {
  return join(jobsDir(characterId), `${jobKey}.yaml`);
}

export async function loadJob(characterId: string, jobKey: string): Promise<ImportJob | null> {
  try {
    return parseYaml(await readFile(jobPath(characterId, jobKey), "utf8")) as ImportJob;
  } catch {
    return null; // missing or unreadable — treat as no prior progress
  }
}

export async function saveJob(characterId: string, job: ImportJob): Promise<void> {
  const p = jobPath(characterId, job.jobKey);
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, toYaml({ ...job, updatedAt: new Date().toISOString() }), "utf8");
  await rename(tmp, p);
}

export async function deleteJob(characterId: string, jobKey: string): Promise<void> {
  await unlink(jobPath(characterId, jobKey)).catch(() => {});
}

// Remove all cached import jobs for a character (used when clearing beats).
export async function clearJobs(characterId: string): Promise<number> {
  let n = 0;
  try {
    for (const f of await readdir(jobsDir(characterId))) {
      if (f.endsWith(".yaml")) { await unlink(join(jobsDir(characterId), f)).catch(() => {}); n++; }
    }
  } catch { /* no imports dir */ }
  return n;
}
