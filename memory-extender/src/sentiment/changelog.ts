// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// IS THIS TEXT THIRD-PARTY RELEASE NOTES? (MarinaraExtender-mln9)
//
// WHY THIS EXISTS. Marinara ENGINE release notes, pasted into a chat for discussion,
// were chunked, scored for emotion, and filed as Mari's emotional beats — six of them
// store-wide, two on the current build. They become companion ledger entries and are
// retrievable, so the character can later "remember feeling ashamed" about an Engine
// bug she has no relationship to. Same family as the invented-partner problem (epf4):
// a record that reads as lived experience and cannot be distinguished from one
// downstream, because by then the source is gone.
//
// WHY THE EXISTING GATES MISS IT. pe4o gates on OUR OWN PROMPT, by coverage against
// ownPromptSignatures — release notes are not our prompt, so nothing matches. hjt9's
// routeOps is built for code and structured payloads: fences, shell transcripts,
// tables, JSON. Changelog prose is PROSE — full sentences, ordinary vocabulary, no
// fences. It looks like writing because it is writing. Neither gate was built for
// "third-party product documentation", and that is a real third category.
//
// ── WHAT THE MEASUREMENT FALSIFIED, kept because the wrong rule is the obvious one ──
//
// mln9 predicted release notes would show NO first/second person, NO dialogue, and
// dense proper nouns. Scored exactly that way across 9,433 beats, the fourteen
// top-ranked chunks contained ZERO changelogs — they were code, logs and CLI
// transcripts (the hjt9/4ghy populations) — while a plain release-notes paste ranked
// 1666th. User-facing release notes ADDRESS THE READER ("customize your experience",
// "so the scene art behind it is visible"), so their person-rate runs HIGHER than
// ordinary chat. The predicted signal is not weak, it is INVERTED. Do not reinstate
// it; scripts/changelog-scan.mjs still prints those features so the falsification
// stays visible rather than becoming folklore.
//
// ── WHY COUNTING "Added" IS NOT THE BLOCKLIST mln9 FORBIDS ────────────────────
//
// The ban is on PRESENCE. A sentence that opens with "Added" is a sentence, and a
// rule that fires on one would eat real writing — release notes have no fixed
// vocabulary and neither does anyone describing their day's work.
//
// What convicts here is DENSITY: many sentence-initial enumeration verbs in ONE
// chunk. That is not vocabulary matching, it is enumerated LIST STRUCTURE — the same
// kind of structural evidence code-filter reads off braces, carried by a word instead
// of a brace. Measured on the store: 33 chunks contain at least one opener and would
// trip a presence rule; only 6 carry three or more, and the other 27 are real RP
// dialogue and genuine work notes. That gap is the entire argument.
//
// ABSOLUTE COUNT, NOT A RATE, and for the same reason the person-rate failed. A
// per-100-word density penalises the clearest positives: a 3,544-word release-notes
// dump carries 20 openers and scores 0.56/100w, BELOW a 224-word work note with a
// single "Added" at 0.45. Length dilutes the signal it is supposed to confirm.
//
// ── THE THIRD GENUS IS THE THING MOST AT RISK ────────────────────────────────
//
// self-ingest-triage.mjs names three genera, and the dangerous one here is ABOUT-WORK:
// a character REACTING to a changelog in her own voice. "BABE. 'Gallery routes now
// serve valid raster images...' — that's MINE. that's my bug report, shipped" is a
// real utterance about a real event, and suppressing it is the fqnl error with the
// sign flipped — destroying true records to be rid of false ones.
//
// The topic is identical in both, so topic cannot separate them. DIALOGUE RATE can,
// and by a wide margin: measured on the eight real candidates, pastes run 0.003-0.016
// and in-character reactions 0.063-0.076 — a 4x gap with nothing in between. So a
// chunk that is talking, however many release-note sentences it quotes, is spared.
//
// ── HOUSE LAW: RETURN THE SPLIT, NEVER A BOOLEAN ─────────────────────────────
//
// The verdict carries its evidence — the opener count, which verbs, the issue refs,
// the dialogue rate, and which test spared or convicted it — so a wrong call can be
// read rather than guessed at, and so the ledger has something to record.

/**
 * Sentence-initial enumeration verbs.
 *
 * DELIBERATELY SHORT AND BORING. This list is not trying to recognise release notes
 * by their vocabulary — it is trying to count list items. Adding synonyms ("Support",
 * "Enable", "Bump") buys nothing at the density floor and starts matching ordinary
 * narration, which is the failure mode the whole design is avoiding.
 */
const ENUMERATION_VERBS = [
  "Added", "Fixed", "Changed", "Removed", "Improved",
  "Updated", "Refactored", "Renamed", "Deprecated", "Introduced",
];

/**
 * Sentence-initial, case-sensitive: start of text, after terminal punctuation, or
 * after a newline (release notes pasted with their line breaks intact).
 *
 * CASE MATTERS. Lowercase "added" mid-narration ("i added a note") is not a list
 * item, and matching it would drag in exactly the conversational prose this must
 * never touch.
 */
const OPENER_RE = new RegExp(
  String.raw`(?:^|[.!?]\s+|\n\s*)(` + ENUMERATION_VERBS.join("|") + String.raw`)\b`,
  "g",
);

/** Issue/PR references — release-note grammar, and almost nothing else in this store. */
const ISSUE_REF_RE = /#\d{3,6}\b/g;

/**
 * Dialogue evidence. Quotes, contractions, question marks, ellipses, speech verbs.
 * Used ONLY to spare — never to convict — so a generous list is the safe direction.
 */
const DIALOGUE_RE =
  /(["“”])|(\?\s)|(\b(?:don'?t|can'?t|won'?t|i'?m|it'?s|that'?s|you'?re|didn'?t|isn'?t|let'?s|we'?re|they'?re)\b)|(\.\.\.)|(\b(?:said|asked|whispered|laughed|sighed|replied|murmured)\b)/gi;

/**
 * At least this many sentence-initial enumeration verbs before a chunk can convict.
 *
 * THREE, from the calibration set: the six true positives carry 4, 6, 20, 26, 36 and
 * 53; every negative carries 0 or 1. Three sits in the gap with a margin on both
 * sides and is not fitted to any single example.
 */
export const OPENER_FLOOR = 3;

/**
 * Above this dialogue rate a chunk is somebody TALKING and is spared regardless.
 *
 * 0.03, from the same eight: pastes 0.003-0.016, in-character reactions 0.063-0.076.
 * It sits in an empty band roughly 2x from either side. Lowering it starts eating
 * ABOUT-WORK beats, which is the one outcome this detector must never produce.
 */
export const DIALOGUE_CEILING = 0.03;

export type ChangelogReason =
  | "release-notes"      // convicted: enumerated structure, not speech
  | "below-floor"        // too few enumeration verbs to be a list
  | "dialogue"           // enumerated, but somebody is talking — ABOUT-WORK, spared
  | "empty";

export interface ChangelogVerdict {
  /** True only for `release-notes`. Never trust this without reading `reason`. */
  isChangelog: boolean;
  reason: ChangelogReason;
  /** Count of sentence-initial enumeration verbs — the convicting signal. */
  openers: number;
  /** Which verbs, in order of appearance. Evidence for explaining a call. */
  openerVerbs: string[];
  /** Issue/PR references. Corroborating only; never sufficient on its own. */
  issueRefs: number;
  /** Dialogue markers per word. The genus test that spares ABOUT-WORK. */
  dialogueRate: number;
  words: number;
}

function countWords(s: string): number {
  return (s.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []).length;
}

/**
 * Classify a chunk of text as third-party release notes or not.
 *
 * RUN THIS AT MESSAGE LEVEL, not chunk level. The chunker splits messages on /\n+/,
 * so by the time a chunk exists the line structure is gone — the same shredding that
 * made the paste prior look weak until it was measured whole-message (a 20x collapse;
 * see pipeline.ts). Enumeration survives chunking better than fences do, because
 * sentence-terminal punctuation still marks the items, but a long changelog SPLIT
 * across chunks divides its openers among them and can fall under the floor.
 * Message level is where the evidence is intact.
 */
export function classifyChangelog(text: string): ChangelogVerdict {
  const s = String(text ?? "");
  const words = countWords(s);
  if (!s.trim() || words === 0) {
    return { isChangelog: false, reason: "empty", openers: 0, openerVerbs: [], issueRefs: 0, dialogueRate: 0, words: 0 };
  }

  const openerVerbs = [...s.matchAll(OPENER_RE)].map((m) => m[1]);
  const openers = openerVerbs.length;
  const issueRefs = (s.match(ISSUE_REF_RE) ?? []).length;
  const dialogueRate = (s.match(DIALOGUE_RE) ?? []).length / words;

  const base = { openers, openerVerbs, issueRefs, dialogueRate, words };

  // ORDER MATTERS. The floor is checked first so that `reason` distinguishes "not a
  // list" from "a list, but someone is speaking" — the second is the ABOUT-WORK save
  // and is the case worth being able to count separately in the ledger.
  if (openers < OPENER_FLOOR) return { isChangelog: false, reason: "below-floor", ...base };
  if (dialogueRate >= DIALOGUE_CEILING) return { isChangelog: false, reason: "dialogue", ...base };
  return { isChangelog: true, reason: "release-notes", ...base };
}

/** Convenience for call sites that only need the boolean. Prefer the verdict. */
export function isChangelog(text: string): boolean {
  return classifyChangelog(text).isChangelog;
}

// ── The lane ─────────────────────────────────────────────────────────────────
//
// ROUTE AND MARK, NEVER DROP (hjt9). A suppressed release-notes paste is still
// evidence of what was discussed, so it goes to an append-only sink: greppable
// forever, never deleted, and never read back by recall. Same contract as
// ops-lane.jsonl — it is a SINK, not a fourth recall lane. Routing this into
// open_threads or character_topics would file it correctly and then feed it to the
// model anyway, which is the problem restated.
//
// ITS OWN FILE, NOT ops-lane.jsonl, for the reason self-ingest-triage.mjs gives about
// folding populations together: asking one ledger to answer two questions is how a
// number stops meaning anything. The ops lane counts LINES of structure; this counts
// WHOLE MESSAGES of third-party prose. Two questions, two denominators.
//
// AND IT RECORDS THE SAVES, NOT ONLY THE CATCHES. `spared-dialogue` is written when a
// message carried enough enumeration to convict but was talking — the ABOUT-WORK case
// this detector exists to protect. Without those lines the ledger could only show
// what was suppressed, and "did it ever eat a real utterance" would be unanswerable
// by division. That is exactly the hole 5x5y spent three months in: subtext sat at
// 0.7% and read as working because nothing recorded how many chunks WARRANTED one.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type ChangelogOutcome =
  /** Convicted: routed to the sink, does not become a beat. */
  | "suppressed"
  /** Enumerated like release notes, but someone was talking. Spared on purpose. */
  | "spared-dialogue";

export interface ChangelogRecord {
  at: string;
  outcome: ChangelogOutcome;
  chatId?: string;
  speaker?: string;
  openers: number;
  issueRefs: number;
  dialogueRate: number;
  words: number;
  /**
   * THE FULL TEXT, not an excerpt. The sink's promise is that nothing is destroyed —
   * a suppressed paste has to remain readable, or "route and mark" is just a drop
   * with better manners. These are rare (six in three months) so the cost is nil.
   */
  text: string;
}

/** Append-only, never read by recall. */
export function changelogLanePath(dataDir: string): string {
  return join(dataDir, "changelog-lane.jsonl");
}

/**
 * Write routed messages to the sink.
 *
 * NEVER THROWS. This runs inside ingestion, and a sink failure that broke an import
 * would be a worse bug than the noise it collects. A lost record is a miss; a thrown
 * error is a lost import.
 */
export function recordChangelog(dataDir: string, records: ChangelogRecord[]): void {
  if (!records.length) return;
  try {
    const p = changelogLanePath(dataDir);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  } catch {
    // Swallowed on purpose — see above.
  }
}
