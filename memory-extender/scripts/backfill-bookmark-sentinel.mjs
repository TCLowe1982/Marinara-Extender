// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// MIGRATE lastSeenTurn TO THE "NEVER SURFACED" SENTINEL (7mb6).
//
// Bookmarks were minted with `lastSeenTurn: turnNumber`, and turnNumber is
// permanently 0 in poller mode, so every one was born carrying the value the
// surfacing guard compares against and was suppressed forever. The code fix
// stops NEW bookmarks being born that way; this repairs the ones already stored.
//
// THE MIGRATION RULE IS SAFE BECAUSE NOTHING EVER WRITES THIS FIELD AFTER
// CREATION. Verified by grep: lastSeenTurn is assigned in exactly two places
// (api.ts and writer.ts, both at mint) and read in one (loader.ts). So a stored
// lastSeenTurn is ALWAYS still its birth value, and `lastSeenTurn ===
// createdTurn` identifies a bookmark that has never been surfaced - which is all
// of them. Rows where the two differ are left alone: that would mean something
// wrote the field, and this script's assumption would be wrong.
//
//   node scripts/backfill-bookmark-sentinel.mjs           report only
//   node scripts/backfill-bookmark-sentinel.mjs --write   apply

import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHATS = join(PKG, "data", "chats");
const WRITE = process.argv.includes("--write");
const NEVER_SURFACED = -1;

let files = 0, seen = 0, migrated = 0, already = 0, skipped = 0;

for (const chat of existsSync(CHATS) ? readdirSync(CHATS) : []) {
  const p = join(CHATS, chat, "bookmarks.yaml");
  if (!existsSync(p)) continue;
  let y;
  try { y = YAML.parse(readFileSync(p, "utf8")); } catch { continue; }
  const list = Array.isArray(y) ? y : y?.bookmarks;
  if (!Array.isArray(list) || !list.length) continue;
  files++;
  let touched = 0;
  for (const b of list) {
    if (!b || typeof b !== "object") continue;
    seen++;
    if (b.lastSeenTurn === NEVER_SURFACED) { already++; continue; }
    if (b.lastSeenTurn !== b.createdTurn) { skipped++; continue; }
    b.lastSeenTurn = NEVER_SURFACED;
    migrated++; touched++;
  }
  if (WRITE && touched) {
    copyFileSync(p, p + ".bak-7mb6");
    writeFileSync(p, YAML.stringify(y), "utf8");
  }
}

console.log(`bookmark files      : ${files}`);
console.log(`bookmarks seen      : ${seen}`);
console.log(`already sentinel    : ${already}`);
console.log(`MIGRATED to never   : ${migrated}`);
console.log(`left alone          : ${skipped}   (lastSeenTurn !== createdTurn - something wrote it, so the assumption does not hold)`);
console.log(WRITE ? "\nWRITTEN. A .bak-7mb6 sits beside every file touched." : "\nDRY RUN - pass --write to apply.");
console.log("\nNOTE: this does NOT restore the weights. They decayed on every turn while");
console.log("invisible, so a bookmark dropped at 0.9 may now sit at 0.10 and will still");
console.log("lose the roll it never got to take. Surfacing eligible is not surfacing.");
