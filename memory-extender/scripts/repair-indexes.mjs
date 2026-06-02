// Rebuild corrupt scope index.yaml files from their (intact) entry files.
//
// A torn/interleaved write can leave index.yaml unparseable; the server then
// treats that scope as empty and its memories stop surfacing. The individual
// entry .yaml files under threads/ user-topics/ char-topics/ are untouched and
// carry every field the index mirrors, so we can regenerate the index from them.
//
// Usage (from the memory-extender directory):
//   node scripts/repair-indexes.mjs          # repair only corrupt indexes
//   node scripts/repair-indexes.mjs --force  # rebuild every index
//   node scripts/repair-indexes.mjs --dry    # report only, write nothing

import { readFile, writeFile, readdir, rename, stat } from "fs/promises";
import { join } from "path";
import { parse, stringify } from "yaml";

const DATA_DIR = process.env.MARINARA_EXTENDER_DATA ?? "./data";
const FORCE = process.argv.includes("--force");
const DRY = process.argv.includes("--dry");

const LANE_DIRS = [
  ["threads", "open_threads"],
  ["user-topics", "user_topics"],
  ["char-topics", "character_topics"],
];

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function isParseable(file) {
  try { parse(await readFile(file, "utf8")); return true; } catch { return false; }
}

async function writeYamlAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, stringify(data), "utf8");
  await rename(tmp, file);
}

// Collect every entry file for a scope and turn each into an index row.
async function rebuildEntries(scopeDir) {
  const entries = [];
  for (const [dirName, lane] of LANE_DIRS) {
    const laneDir = join(scopeDir, dirName);
    if (!(await exists(laneDir))) continue;
    const files = (await readdir(laneDir)).filter((f) => f.endsWith(".yaml"));
    for (const file of files) {
      const full = join(laneDir, file);
      let entry;
      try { entry = parse(await readFile(full, "utf8")); }
      catch { console.warn(`    ! skipping unreadable entry ${dirName}/${file}`); continue; }
      if (!entry || !entry.id) { console.warn(`    ! skipping malformed entry ${dirName}/${file}`); continue; }
      const row = {
        id: entry.id,
        path: `${dirName}/${file}`,
        summary: entry.summary ?? "",
        tokens: entry.tokens ?? 0,
        lane: entry.lane ?? lane,
        status: entry.status ?? "open",
        lastAccessed: entry.lastAccessed ?? new Date().toISOString().slice(0, 10),
      };
      // Preserve tier metadata when present so promotion state survives.
      for (const k of ["tier", "retrievalCount", "recitationCount", "cycleCount", "lastRetrievedAt"]) {
        if (entry[k] !== undefined) row[k] = entry[k];
      }
      entries.push(row);
    }
  }
  return entries;
}

async function repairScope(scope, scopeId, scopeDir) {
  const indexPath = join(scopeDir, "index.yaml");
  const hasIndex = await exists(indexPath);
  if (!hasIndex && !FORCE) return;

  const ok = hasIndex ? await isParseable(indexPath) : false;
  if (ok && !FORCE) return; // valid — leave it alone

  const entries = await rebuildEntries(scopeDir);
  const label = `${scope}:${scopeId}`;
  if (ok) console.log(`  ${label} — valid, rebuilding anyway (--force): ${entries.length} entries`);
  else    console.log(`  ${label} — CORRUPT, rebuilding from ${entries.length} entry files`);

  if (DRY) return;
  await writeYamlAtomic(indexPath, {
    scope, scopeId, lastUpdated: new Date().toISOString(), entries,
  });
  console.log(`    -> wrote ${indexPath}`);
}

async function listDirs(parent) {
  if (!(await exists(parent))) return [];
  const ents = await readdir(parent, { withFileTypes: true });
  return ents.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function main() {
  console.log(`Repairing indexes under ${DATA_DIR}${DRY ? " (dry run)" : ""}${FORCE ? " (force)" : ""}\n`);

  // global
  const globalDir = join(DATA_DIR, "global");
  if (await exists(globalDir)) await repairScope("global", "global", globalDir);

  // characters
  for (const id of await listDirs(join(DATA_DIR, "characters"))) {
    await repairScope("character", id, join(DATA_DIR, "characters", id));
  }
  // chats
  for (const id of await listDirs(join(DATA_DIR, "chats"))) {
    await repairScope("chat", id, join(DATA_DIR, "chats", id));
  }

  console.log("\nDone.");
}

main().catch((err) => { console.error(err); process.exit(1); });
