// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// THE MIRROR (i83s, retargeted) — the store's own output, pasted into chat and
// ingested as dialogue.
//
// Found while reconciling a count: 12 beats contained the literal text
// "[about: Thomas]" because Mari had pasted a store audit back into the
// conversation — "- ctopic-tmbg7dpu: [about: Thomas] Thomas has been mourning…".
// Those 12 were then counted as if they were entries. The store described
// itself, the description became a memory, and the memory inflated the next
// measurement of the thing it described.
//
// That is a MIRROR, not a race: one utterance ends up carrying several weights
// because the system keeps re-reading its own reflection.
//
// ── WHY THIS IS NOT A KEYWORD BLOCKLIST ──────────────────────────────────────
// It matches SELF-MINTED IDENTIFIERS and its own log framing — strings only this
// system produces. Nobody types "ctopic-8f3k2a1b" to mean something. That is a
// different thing from banning vocabulary: a human can say "about" or "remember"
// all day and never trip this.
//
// ── AND WHY IT IS LINE-LEVEL ─────────────────────────────────────────────────
// Measured on the live store: 126 beats carry a mirror signal and nothing else,
// but 21 carry one INSIDE ordinary conversation ("the [remember:] tag writes
// character-scope because…"). A chunk-level verdict would misfile every word
// wrapped around the thing it detected — the pe4o failure, where the self-prompt
// gate killed 2,242 characters of real prose for quoting one schema line. Return
// the split, never a boolean; decide on COVERAGE, never on a hit.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// ── Signals ──────────────────────────────────────────────────────────────────

export interface MirrorSignal {
  name: string;
  re: RegExp;
}

// Self-minted identifiers and self-authored framing. Each is a string this
// system generates and a human would only ever have copied.
export const MIRROR_SIGNALS: MirrorSignal[] = [
  // Entry ids: ctopic-/utopic-/nthr-/recap-/otopic- + nanoid.
  { name: "entry-id", re: /\b(?:ctopic|utopic|nthr|recap|otopic)-[a-z0-9]{6,}\b/i },
  // Deterministic beat ids.
  { name: "beat-id", re: /\bbeat-[0-9a-f]{12}\b/i },
  // The aboutness prefix this system writes into summaries.
  { name: "about-tag", re: /\[about:\s*[^\]]{0,80}\]/ },
  // Our own console framing.
  { name: "me-log", re: /\[ME:[a-z0-9-]+\]/i },
  // Beads ticket ids — the store discussing its own backlog.
  { name: "ticket-id", re: /\bMarinaraExtender-[a-z0-9]{3,4}\b/i },
];

// DELIBERATE CAPTURE SYNTAX IS A FEATURE AND MUST NEVER BE REFUSED. 840 beats on
// the live store carry a [remember:] or [bookmark:] tag and nothing else: that is
// TC and Mari saving something ON PURPOSE, and it is the primary manual-capture
// path. A line carrying one is never a mirror line, whatever else is on it.
const DELIBERATE_RE = /\[(?:remember|bookmark)\s*:/i;

export interface MirrorHit {
  /** Which signals fired, for the refusal reason. */
  signals: string[];
  /** How many lines of the chunk were the store's own output. */
  matches: number;
  /** Fraction of the chunk, BY CHARACTERS, that is self-output. */
  coverage: number;
  /** Shortest matching line, so a human can judge whether the gate was right. */
  sample: string;
}

/**
 * Above this, the chunk IS a paste of our output. Below it, the chunk is
 * conversation that MENTIONS our output — ordinary shop talk, and a real memory.
 *
 * Calibrated on the live store rather than chosen: see scripts/mirror-bench.mjs.
 * Same shape and the same default as SELF_PROMPT_COVERAGE, which was moved to
 * coverage for exactly this failure.
 */
export const MIRROR_COVERAGE = 0.4;

/** Split a chunk into lines and decide which of them are the store talking. */
export function detectMirror(text: string): MirrorHit | null {
  const hay = text ?? "";
  if (!hay.trim()) return null;

  const lines = hay.split(/\r?\n/);
  const signals = new Set<string>();
  const matched: string[] = [];
  let covered = 0;

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    // A deliberate capture tag makes this line the user's, not the store's.
    if (DELIBERATE_RE.test(t)) continue;
    const fired = MIRROR_SIGNALS.filter((s) => s.re.test(t));
    if (!fired.length) continue;
    for (const s of fired) signals.add(s.name);
    matched.push(t);
    covered += line.length + 1; // +1 for the newline the split removed
  }

  if (!matched.length) return null;
  matched.sort((a, b) => a.length - b.length);
  return {
    signals: [...signals].sort(),
    matches: matched.length,
    coverage: Math.min(1, covered / Math.max(1, hay.length)),
    sample: matched[0]!.slice(0, 120),
  };
}

/** The gate the pipeline asks: is this chunk a paste of ourselves? */
export function isMirror(hit: MirrorHit | null): boolean {
  return !!hit && hit.coverage >= MIRROR_COVERAGE;
}

// ── The lane ─────────────────────────────────────────────────────────────────
// ROUTE AND MARK, never drop. A refused chunk is written here in full BEFORE the
// message is emptied, so nothing is destroyed — it just stops being memory. And
// the SAVES are recorded too: a chunk that carried the store's own ids but was
// somebody talking is the case this gate exists to protect, and it is only
// countable if it is written down. Without that the ledger could show what was
// refused and never whether a real utterance was eaten.

export type MirrorOutcome = "suppressed" | "spared-conversation";

export interface MirrorRecord {
  at: string;
  outcome: MirrorOutcome;
  chatId?: string;
  speaker?: string;
  signals: string[];
  matches: number;
  coverage: number;
  /** THE FULL TEXT, not an excerpt — see the note above. */
  text: string;
}

export function mirrorLanePath(dataDir: string): string {
  return join(dataDir, "mirror-lane.jsonl");
}

/** Never throws: a sink failure must not fail an ingest. */
export function recordMirror(dataDir: string, records: MirrorRecord[]): void {
  if (!records.length) return;
  try {
    const p = mirrorLanePath(dataDir);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  } catch {
    // Swallowed on purpose — see above.
  }
}

// ── Counters ─────────────────────────────────────────────────────────────────
// Counted BY REASON and surfaced live, not discoverable by grepping in October.

const refusals = new Map<string, number>();

export function noteMirrorRefusal(signals: string[]): void {
  for (const s of signals) refusals.set(s, (refusals.get(s) ?? 0) + 1);
}

export function mirrorRefusalCounts(): Record<string, number> {
  return Object.fromEntries(refusals);
}

export function resetMirrorRefusalCounts(): void {
  refusals.clear();
}
