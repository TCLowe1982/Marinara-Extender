// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// THE OPS/META LANE (hjt9). Where pasted structure goes so it stops being memory.
//
// Two detectors already exist and are measured; this is the destination they were
// waiting for. code-filter.ts scores structure per line; paste-prior.ts weighs
// broad-and-shallow shape against narrow-and-deep prose. Neither was wired, because
// "the lane itself" was the missing half and the ticket is explicit that DESTINATION
// MATTERS MORE THAN THE DETECTOR.
//
// IT IS A SINK, NOT A FOURTH LANE, and that is the load-bearing decision here.
// `Lane` in storage.ts means a RECALL lane — open_threads, user_topics,
// character_topics are all read back and injected into prompts. Routing ops content
// there would file it correctly and then feed it to the model anyway, which is the
// whole problem restated. So it goes to an append-only sink that recall never reads:
// greppable forever, never deleted, never injected.
//
// THE ROUTABLE UNIT IS THE PARTITION, NEVER A CHUNK-LEVEL BOOLEAN. Both halves of
// this ticket reached that independently and both reached it by making the mistake
// first:
//   - the structural scan found a chunk at 0.64 ops-shaped whose prose was "god yeah
//     dotenv loading is sonnet's KRYPTONITE..." wrapped around a fenced block;
//   - the paste prior's first fence override scored six of Mari's own messages at
//     0.90 — "TC. LOOK AT IT. look at your progress bar" around one pasted log;
//   - and the self-prompt gate (pe4o) shipped the same bug a third time this week,
//     killing 2kB of someone thinking out loud for quoting one schema line.
// Three convictions at the same address. So this module never returns "this chunk is
// ops". It returns the split.
//
// HOUSE LAW — A NET THAT DEPENDS ON REMEMBERING TO TAG IS ADHD-HOSTILE. Fences are
// an override that raises confidence, never the dependency. Everything here works on
// unmarked text, and a miss is a re-file rather than a wound because nothing is
// deleted.

import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { partitionProse, type NonProseHit } from "./code-filter.js";
import { pasteEvidence } from "./paste-prior.js";

export interface OpsRouting {
  /** The lines that stay memory, rejoined. May be empty when the chunk was all paste. */
  prose: string;
  /** The lines that go to the sink. */
  dropped: NonProseHit[];
  /** Nothing survived as prose — the whole chunk was structure. */
  wholesale: boolean;
  /** Paste posterior for the ORIGINAL text, recorded for audit, never used as a verdict. */
  pasteScore: number;
  signals: string[];
}

/**
 * Split a chunk into what is memory and what is machine noise.
 *
 * The prose half is returned rejoined and is what everything downstream should see:
 * salience scoring, the analyzer, and — critically — the echo guard's corroboration
 * check. hjt9: "rejectAsEcho's escape hatch must not accept a paste of the phrase as
 * the speaker having said it". Feeding it prose-only is how that is enforced, rather
 * than by another special case inside the guard.
 */
export function routeOps(text: string): OpsRouting {
  const src = String(text ?? "");
  const { prose, dropped } = partitionProse(src);
  const ev = pasteEvidence(src);
  const proseText = prose.join("\n").trim();
  return {
    prose: proseText,
    dropped,
    wholesale: dropped.length > 0 && proseText.length === 0,
    pasteScore: ev.score,
    signals: ev.signals,
  };
}

export interface OpsRecord {
  at: string;
  chatId?: string;
  speaker?: string;
  /** Which rule caught this line — the lane's own record of why it is here. */
  rule: string;
  line: string;
  /** Paste posterior of the chunk this line came from. Context, not verdict. */
  pasteScore: number;
}

/** Append-only, never read by recall. */
export function opsLanePath(dataDir: string): string {
  return join(dataDir, "ops-lane.jsonl");
}

/**
 * Write routed lines to the sink.
 *
 * NEVER THROWS. This runs inside ingestion, and a sink failure that breaks an import
 * would be a worse bug than the noise it collects. A lost line is a miss; a thrown
 * error is a lost import.
 */
export function recordOps(dataDir: string, records: OpsRecord[]): void {
  if (!records.length) return;
  try {
    const p = opsLanePath(dataDir);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  } catch {
    // Swallowed on purpose — see above.
  }
}
