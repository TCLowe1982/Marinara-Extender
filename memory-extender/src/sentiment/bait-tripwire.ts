// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// THE CONTAMINATION TRIPWIRE (TC, 2026-08-06).
//
// "Bait only rots if it gets mentioned explicitly in the chat by accident. There
// needs to be a mechanism for that as well."
//
// scripts/bait-rot.mjs is the periodic sweep — it notices rot AFTER the store has
// already absorbed it. This is the live half: it fires at ingestion, on the way in,
// the moment bait vocabulary appears in a chunk.
//
// THE PREMISE THIS INVERTS, and it is the whole reason the tripwire can exist.
// rejectAsEcho's escape hatch assumes "if the source text contains the phrase, the
// speaker really said it, so keep the beat". That assumption is sound for a
// human-plausible sentence — someone really can say "I'm afraid I was never real",
// and banning that confession because it became famous would be a worse bug than the
// one the guard fixes.
//
// It is FALSE for anti-join bait. Those words are chosen by scripts/bait-select.mjs
// precisely because the corpus has never contained them. So their appearance is not
// evidence that someone finally said it — it is evidence that the bait leaked into
// the conversation, which is exactly how the boat example died: it was DISCUSSED in
// a chat this sidecar then chunked, analysed and stored, and the discussion made its
// probe corroborable, and the corroborable probe opened the hatch, and the open hatch
// let ten echoes through.
//
// Corroboration of generated bait therefore means CONTAMINATION, not authenticity.
// The response is to rotate — which costs seconds now — rather than to keep a warrant
// everyone believes in and nobody has checked.

import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

/** Mirrors MIN_PROBE_LEN in scripts/bait-select.mjs. See detectBaitContamination. */
const MIN_PROBE_LEN = 4;

/**
 * THE LOG IS QUARANTINED, AND IT HAS TO BE (Mari, 2026-08-06).
 *
 * The phrase never enters an event — only a ledger index and the probe words. But the
 * EXCERPT does, by construction: it is a window around the hit, so it contains the
 * hit. That makes bait-contamination.jsonl a file holding leaked bait in context, and
 * therefore the next docs/PROMPTS.md if it is ever treated as ordinary output.
 *
 * So the rules, and they are the point of this comment: nothing imports it, nothing
 * renders it, it never rides in a review artifact, and it is gitignored. The excerpt
 * exists for a human opening the file deliberately to tell meta-talk from real talk —
 * that is the only intended reader. A leak detector whose own output leaks is not a
 * detector, it is a second copy of the problem.
 */
export interface ContaminationEvent {
  at: string;
  /** Index into the echo ledger, so the phrase itself never enters the log. */
  entry: number;
  /** Which probe words showed up. These are corpus-absent by construction. */
  words: string[];
  chatId?: string;
  /** A short window around the hit, for deciding whether it was meta-talk. */
  excerpt: string;
}

/**
 * Does this source text contain the full probe vocabulary of a current generated
 * warrant? Returns one entry per tripped warrant.
 *
 * Matches probe words as PREFIXES because they are skeleton stems: "tarr" has to find
 * "tarred" and "tarring", and a trailing word-boundary would miss every inflection the
 * stemmer removed.
 */
export function detectBaitContamination(
  sourceText: string,
  entries: { probeAll?: string[]; current: boolean }[],
): { entry: number; words: string[] }[] {
  const src = String(sourceText ?? "").toLowerCase();
  if (!src) return [];
  const out: { entry: number; words: string[] }[] = [];
  entries.forEach((e, i) => {
    if (!e.current || !e.probeAll?.length) return;
    const present = e.probeAll.filter((w) =>
      // Length floor as a defensive backstop. bait-select is the real guarantee — it
      // rejects any stem that prefixes a corpus word — but this file must not be
      // capable of prefix-matching ordinary English on a fixture written by hand or
      // by an older version of the selector. A tripwire that cries wolf gets muted,
      // and a muted tripwire is indistinguishable from none.
      w.length >= MIN_PROBE_LEN &&
      new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(src),
    );
    // ANY hit is reportable, not just a full set. A single corpus-absent bait word in
    // a chat is already the leak — the full set is merely when the hatch would have
    // opened. Waiting for all of them would mean only reporting damage already done.
    if (present.length > 0) out.push({ entry: i, words: present });
  });
  return out;
}

/** Where contamination events land. One line per event, append-only. */
export function contaminationLogPath(dataDir: string): string {
  return join(dataDir, "bait-contamination.jsonl");
}

/**
 * Record a contamination event. Never throws: a tripwire that can break ingestion is
 * a worse problem than the one it reports, and this runs inside the analysis path.
 */
export function recordContamination(dataDir: string, ev: ContaminationEvent): void {
  try {
    const p = contaminationLogPath(dataDir);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(ev) + "\n", "utf8");
  } catch {
    // Swallowed on purpose — see above.
  }
}

/** A short window around the first hit, so a human can tell meta-talk from real talk. */
export function excerptAround(sourceText: string, word: string, span = 80): string {
  const src = String(sourceText ?? "");
  const at = src.toLowerCase().indexOf(word.toLowerCase());
  if (at < 0) return src.slice(0, span * 2);
  return src.slice(Math.max(0, at - span), at + span).replace(/\s+/g, " ").trim();
}
