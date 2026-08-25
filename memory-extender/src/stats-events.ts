// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Store-wide statistics events — an append-only record of deliberate, bulk,
// machine-driven changes to the corpus.
//
// WHY THIS EXISTS (s8qe, TC's condition). A retirement that removes 517 beats
// concentrated in one stratum does not just change the store, it changes every
// curve ever measured over the store — and it does so INVISIBLY. Someone
// re-running chunk-floor-scan.mjs after the fact sees a clean distribution and
// concludes the 89%-echo spike never happened, or worse, that echo declined on
// its own. Both readings are false, and neither is recoverable from the data
// once the rows are gone from the working set.
//
// So a bulk change files its own footnote. The rule: any script that mutates the
// corpus at population scale records what it did, how it selected, and what it
// deliberately spared. Analysis tools read this back and say so.
//
// APPEND-ONLY, and events are never edited or removed. An event that turned out
// to be a mistake gets a LATER event describing the correction — because the
// whole point is that the historical record survives the thing it records.

import { join } from "path";
import { readFile } from "fs/promises";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { getDataDir, atomicWriteFile_UNLOCKED_takeSerializedWriteYourself } from "./storage.js";
import { nanoid } from "./nanoid.js";

export interface StatsEvent {
  id: string;
  at: string;                       // ISO datetime
  kind: string;                     // e.g. "retirement"
  issue?: string;                   // the beads id that authorised it
  reason: string;                   // human sentence: why this happened
  /** How rows were chosen. Must be reproducible by a reader, not a vibe. */
  selector?: string;
  /** What was touched, by category — free-form so callers aren't boxed in. */
  counts?: Record<string, number>;
  /** What was deliberately NOT touched, and why. Carve-outs are the interesting part. */
  spared?: string;
  /** The backup taken before the change, if any. */
  backup?: string;
  /** Affects statistics measured before this date — the warning a curve needs. */
  affectsHistoricalCurves?: boolean;
}

interface StatsEventFile {
  events: StatsEvent[];
}

function eventsPath(): string {
  return join(getDataDir(), "stats-events.yaml");
}

export async function readStatsEvents(): Promise<StatsEvent[]> {
  try {
    const raw = await readFile(eventsPath(), "utf8");
    return (parseYaml(raw) as StatsEventFile)?.events ?? [];
  } catch {
    return [];   // absent means nothing has ever been recorded, not an error
  }
}

/**
 * Append one event. Read-modify-write through the atomic writer, which is the
 * same discipline every other YAML path in this codebase uses — never a bare
 * write, or a crash mid-append truncates the whole history.
 */
export async function recordStatsEvent(
  event: Omit<StatsEvent, "id" | "at"> & { at?: string },
): Promise<StatsEvent> {
  const full: StatsEvent = {
    id: `stev-${nanoid(10)}`,
    at: event.at ?? new Date().toISOString(),
    ...event,
  };
  const events = await readStatsEvents();
  events.push(full);
  await atomicWriteFile_UNLOCKED_takeSerializedWriteYourself(eventsPath(), toYaml({ events } satisfies StatsEventFile));
  return full;
}
