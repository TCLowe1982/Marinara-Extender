// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// HOT INDEX SIZE AS A TRIPWIRE (TC, 2026-08-26).
//
// TC: "from a design perspective, and from a search perspective, we should
// probably limit the number of hot entries to 10,000, and if we ever exceed
// that, something is probably wrong. In this case, things have been wrong."
//
// TC, clarifying the intent afterwards: "The cap is more about retrieval speed,
// than anything else. I don't want the index to be too bloated for easy lookup."
//
// SPEED IS THE PRIMARY PURPOSE. Measured on the live store: loadContext takes
// ~1,279 ms against professor_mari, and 900 ms of that is YAML.parse on a 4 MB,
// 8,866-row index - per load, per scope. The cost is linear at 0.098 ms/entry, so
// 10,000 entries is almost exactly a one-second parse ceiling. That is what the
// number buys.
//
// It is ALSO a detector, and that is worth keeping as a secondary use: an ageing
// process that silently stops leaves the hot index growing with nothing else to
// show for it, which is a failure this codebase has now been bitten by twice.
//
// See hdq1 before tuning this number: the latency it guards is 149x more about
// the index FORMAT than the entry count (YAML.parse 900 ms vs JSON.parse 6 ms on
// identical data). If the index moves to JSON the cap stops being a speed limit
// and becomes purely a precision bound and a tripwire.
//
// The detector half is what caught the current problem. Tier promotion is gated on `turnNumber % 20`, and
// turnNumber was pinned at 0 in poller mode, so promotion never ran (7mb6).
// Nothing aged, nothing archived, and the hot index grew monotonically with no
// signal anywhere. 17,160 hot rows against 729 cold - 96% hot - is what "ageing
// has not run since May" looks like from the outside.
//
// WHY THIS WARNS AND DOES NOT ENFORCE. Silently discarding memory to satisfy a
// number would repeat the exact sin this file exists to catch: a process that
// quietly does something destructive and reports nothing. Promotion is the thing
// that should bound the hot set, and it now runs. If the cap keeps tripping with
// promotion working, THAT is the finding, and it should be read rather than
// automated away.
//
// TWO SIGNALS, BECAUSE THEY MEASURE DIFFERENT THINGS:
//   - THE CAP IS PER CHARACTER (TC ruled on the unit). Retrieval loads one
//     character index and ranks the whole thing to select ~10 rows, so that is
//     the size which degrades precision and latency, and the one that grows
//     without bound when ageing stops. Chat indexes are reported but never trip:
//     they are bounded by one conversation, so a cap there would fire on ordinary
//     long scenes and train everyone to ignore it.
//   - THE GLOBAL HOT:COLD RATIO is the health argument, and it is the sharper of
//     the two today. No character scope is over 10,000 yet - the largest is 8,862
//     - but 729 cold rows against 17,160 hot says ageing stopped months ago. The
//     cap would not have caught this on its own; the ratio does.

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { getDataDir } from "./storage.js";

/**
 * TC's number, and it is PER CHARACTER (his ruling, 2026-08-26).
 *
 * Not global, and not per chat. A chat index is bounded by the length of one
 * conversation and empties out with it, so capping there would fire on ordinary
 * long scenes and teach everyone to ignore the warning. A CHARACTER index is the
 * one that grows without limit if ageing stops, which is the failure this is
 * here to catch.
 */
export function hotEntryCap(): number {
  // Read at CALL time, not module load - the same convention the loader budgets
  // follow. A module-load read cannot be changed without a restart and, worse,
  // silently freezes at whatever the first import happened to see.
  const n = Number(process.env.MARINARA_EXTENDER_HOT_WARN);
  return Number.isFinite(n) && n > 0 ? n : 10000;
}

export interface ScopeSize {
  kind: "character" | "chat";
  id: string;
  hot: number;
  cold: number;
}

export interface IndexHealth {
  scopes: number;
  hot: number;
  cold: number;
  /** cold / (hot + cold). Low means nothing is ageing out. */
  coldShare: number;
  /** Largest CHARACTER scope — the one the cap is about. */
  largest: ScopeSize | null;
  /** Scopes at or above HOT_ENTRY_WARN. Empty is the healthy case. */
  overCap: ScopeSize[];
  warnings: string[];
}

function countEntries(p: string): number {
  if (!existsSync(p)) return 0;
  try {
    const y = YAML.parse(readFileSync(p, "utf8"));
    return Array.isArray(y?.entries) ? y.entries.length : 0;
  } catch {
    return 0; // unreadable is not "huge"; a parse failure is its own problem
  }
}

function scan(): IndexHealth {
  const base = getDataDir();
  const sizes: ScopeSize[] = [];
  for (const [dir, kind] of [["characters", "character"], ["chats", "chat"]] as const) {
    const root = join(base, dir);
    if (!existsSync(root)) continue;
    let ids: string[] = [];
    try { ids = readdirSync(root); } catch { continue; }
    for (const id of ids) {
      const hot = countEntries(join(root, id, "index.yaml"));
      if (hot === 0) continue;
      sizes.push({ kind, id, hot, cold: countEntries(join(root, id, "index.cold.yaml")) });
    }
  }
  sizes.sort((a, b) => b.hot - a.hot);

  const hot = sizes.reduce((n, s) => n + s.hot, 0);
  const cold = sizes.reduce((n, s) => n + s.cold, 0);
  // Character scopes only — see the note on HOT_ENTRY_WARN. Chat sizes are still
  // reported below, because they are useful context; they just never trip.
  const cap = hotEntryCap();
  const overCap = sizes.filter((s) => s.kind === "character" && s.hot >= cap);
  const coldShare = hot + cold === 0 ? 0 : cold / (hot + cold);

  const warnings: string[] = [];
  for (const s of overCap) {
    warnings.push(
      `${s.kind}:${s.id} has ${s.hot} hot entries (cap ${cap}). Retrieval ranks the whole index to pick ~10 rows, and promotion should be bounding this — check that it is running.`,
    );
  }
  const chars = sizes.filter((s) => s.kind === "character");
  return { scopes: sizes.length, hot, cold, coldShare, largest: chars[0] ?? null, overCap, warnings };
}

// The largest index is several megabytes of YAML and health is polled by the UI,
// so the scan is memoised. Short TTL: this is a tripwire, not a live gauge, and
// being a minute stale has never mattered for a number that moves over weeks.
let cached: { at: number; value: IndexHealth } | null = null;
const TTL_MS = 60_000;

export function indexHealth(now = Date.now()): IndexHealth {
  if (cached && now - cached.at < TTL_MS) return cached.value;
  const value = scan();
  cached = { at: now, value };
  return value;
}

export function _resetIndexHealthCache(): void {
  cached = null;
}

/**
 * Print the tripwire at startup.
 *
 * Deliberately loud and deliberately unconditional about the totals: the whole
 * lesson of 7mb6 and 771t is that a degraded path which prints nothing is
 * indistinguishable from a working one.
 */
export function logIndexHealth(): void {
  const h = indexHealth();
  const pct = (h.coldShare * 100).toFixed(1);
  console.info(
    `[ME:index] ${h.hot} hot / ${h.cold} cold across ${h.scopes} scope(s) — ${pct}% archived` +
      (h.largest ? `; largest ${h.largest.kind}:${h.largest.id} at ${h.largest.hot}` : ""),
  );
  for (const w of h.warnings) console.warn(`[ME:index] OVER CAP — ${w}`);
}
