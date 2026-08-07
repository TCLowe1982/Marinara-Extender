// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Stage 0: Chunking
//
// Splits a list of chat messages into dialogue turns, then merges consecutive
// same-speaker turns that are semantically related (high cosine similarity)
// into coherent chunks for the classifier.
//
// Embedding calls go to Ollama (opt-in via MARINARA_EXTENDER_EMBED_MODEL). When
// no embed model is configured, turns are grouped by speaker only — no external
// Marinara Engine sidecar is involved.

import type { DigestMessage } from "../digest.js";
import type { Chunk, DialogueTurn } from "./types.js";
import { loadSentimentConfig } from "./config.js";
import { embedModel } from "../embeddings.js";

// ── Turn detection ────────────────────────────────────────────────────────────

// Matches lines like "Name: text" or "Name (context): text"
const SPEAKER_PREFIX_RE = /^([A-Za-z][A-Za-z0-9 _'-]{0,40})(?:\s*\([^)]*\))?\s*:\s*/;

/**
 * THE COLON MIGHT BELONG TO A CLOCK, NOT A SPEAKER (5dqr).
 *
 * The label charset above allows digits and spaces, so an exported line like
 *
 *     Thomas Today at 8:04 PM
 *
 * matches with label "Thomas Today at 8" — the regex split on the TIME's colon and
 * absorbed the timestamp into the name. Measured across the store: 157 beats under 20
 * mangled aliases, including Thomas01..12, NarratorNarrator05..12 and
 * "ThomasToday at 8". "Thomas" proper held 8 beats while his variants held ~40, so
 * the real character was more fragmented than intact.
 *
 * This is the inverse of 4ghy and worse. A minted fake speaker produces beats that
 * are visibly junk. A mangled real speaker produces beats that look entirely correct
 * and route to a person-shaped stranger, and subject attribution compounds it.
 *
 * The signature is unambiguous: the label ends in digits AND the text after the colon
 * begins with two more. No name does that; every clock does.
 */
const TIME_SPLIT_RE = /\d$/;
const MINUTES_RE = /^\d{2}\b/;

/**
 * Recover the speaker from a timestamp-mangled label.
 *
 * RE-ATTRIBUTE, DON'T DISCARD. Refusing the match would drop the line into the
 * previous speaker's buffer, which trades a stranger for a misattribution — the same
 * beat, still on the wrong person. "Thomas Today at 8" really is Thomas talking, so
 * the name is recovered and the clock is dropped.
 *
 * Handles the doubled form too: exports that repeat the name produce
 * "NarratorNarrator07", which is the single largest cluster in the census.
 */
export function unmangleSpeaker(label: string): string {
  let s = label.trim();
  s = s.replace(/\s*\d{1,2}$/, "");                 // trailing hour
  s = s.replace(/\s*(?:Today|Yesterday)?\s*at$/i, ""); // "... Today at"
  s = s.replace(/\s*(?:Today|Yesterday)$/i, "");
  s = s.trim();
  // "NarratorNarrator" -> "Narrator". Only an exact doubling, so "Anna Annabel" is safe.
  const doubled = /^(.+?)\1$/.exec(s);
  if (doubled) s = doubled[1]!;
  return s.trim();
}

// Narration blocks delimited by asterisks: *does something*
const NARRATION_RE = /^\*[^*]+\*$/;

/**
 * A SPEAKER LABEL IS A NOUN PHRASE (Mari's rule, 4ghy).
 *
 * A fragment ending in a copula, preposition or conjunction is a sentence being cut
 * in half — the chunker splitting ordinary prose on an ordinary colon. "so the plan
 * is:", "the question is:", "What she's hearing is:". None of those is a person, and
 * the shape says so without a blocklist.
 */
const FRAGMENT_TAIL = new Set([
  "is", "are", "was", "were", "be", "been", "am",
  "of", "in", "on", "at", "by", "for", "with", "from", "to", "into",
  "about", "over", "under", "than", "then", "as", "like",
  "and", "or", "but", "either", "so", "because", "if", "when", "while", "that", "which",
]);

/**
 * Could this label be a person?
 *
 * MEASURED against all 542 labels in the store before it was written, per house law.
 * 70 labels / 79 beats fail the fragment tail; a further 175 / 188 fail lowercase —
 * and every real speaker survives both, including the walk-on "Driver".
 *
 * NOT A JUNK DETECTOR, and that distinction is the whole scope of this fix. It cannot
 * see "BAD", "Format" or "Extract the emotional beat as JSON": those arrive inside
 * pasted prompt and report text, which is hjt9's ops lane and pe4o's self-prompt gate.
 * One rule, one job.
 */
export function isPlausibleSpeakerLabel(label: string): boolean {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  if (words.length >= 2) {
    // Names are capitalised; a lowercase multi-word label is a sentence fragment.
    if (label === label.toLowerCase() && /[a-z]/.test(label)) return false;
    const tail = words[words.length - 1]!.toLowerCase().replace(/[^a-z]/g, "");
    if (FRAGMENT_TAIL.has(tail)) return false;
  }
  return true;
}

/**
 * Labels with enough evidence to mint a speaker: seen at least twice IN THIS IMPORT.
 *
 * WITHIN-IMPORT, NOT STORE-WIDE, and the reason is determinism rather than recall.
 * Counting against the store would catch walk-ons who speak once per chat, but it
 * makes the result depend on what is already stored — the same chat imported on a
 * different day would chunk differently. Reproducible beats marginally better recall.
 *
 * TAIL HYGIENE ONLY. Recurrence does NOT separate people from junk: `status` occurs
 * 322 times, `summary` 17, `BAD` 8. Every structured junk label in this store is
 * high-frequency by construction, because reports get pasted into the live capture
 * channel. Ten of the twenty-five most frequent labels are not people. So this buys
 * the 463 one-off labels and nothing else, and must never be mistaken for the junk
 * filter — that is the ops lane's job.
 */
const MIN_LABEL_OCCURRENCES = 2;

function countCandidateLabels(messages: DigestMessage[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const msg of messages) {
    for (const line of String(msg.content ?? "").split(/\n+/)) {
      const m = SPEAKER_PREFIX_RE.exec(line.trim());
      if (!m) continue;
      let label = m[1]!.trim();
      const rest = line.trim().slice(m[0].length).trim();
      if (TIME_SPLIT_RE.test(label) && MINUTES_RE.test(rest)) label = unmangleSpeaker(label);
      if (!label || !isPlausibleSpeakerLabel(label)) continue;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return counts;
}

export function parseTurns(messages: DigestMessage[], characterName: string): DialogueTurn[] {
  const turns: DialogueTurn[] = [];
  // Pass 1: which labels have earned the right to mint a speaker.
  const labelCounts = countCandidateLabels(messages);
  let index = 0;

  for (const msg of messages) {
    // A per-message speaker (set by the client for group chats) labels the whole
    // message; otherwise assistant turns default to the primary character. Inline
    // "Name:" prefixes within the content still override this per line below.
    const rawSpeaker = msg.role === "user" ? "user" : (msg.speaker?.trim() || characterName);
    const content = msg.content.trim();
    if (!content) continue;

    // A single message can contain multiple speaker lines (common in roleplay).
    // Split on newlines and re-detect speaker prefixes within the content.
    const lines = content.split(/\n+/).map((l) => l.trim()).filter(Boolean);

    let currentSpeaker = rawSpeaker;
    let buffer: string[] = [];
    // 2pbi: position within THIS message, reset per message. turnIndex keeps its
    // own meaning (position across the array the caller passed in) — the two are
    // different numbers on purpose and neither replaces the other.
    let ordinal = 0;
    const provenance = {
      ...(msg.messageId ? { messageId: msg.messageId } : {}),
      ...(typeof msg.swipeIndex === "number" ? { swipeIndex: msg.swipeIndex } : {}),
    };

    const flush = () => {
      const text = buffer.join(" ").trim();
      if (text) {
        turns.push({ speaker: currentSpeaker, text, turnIndex: index++, ordinal: ordinal++, ...provenance });
      }
      buffer = [];
    };

    for (const line of lines) {
      const prefixMatch = SPEAKER_PREFIX_RE.exec(line);
      if (prefixMatch) {
        // Line starts a new speaker — flush what we have, then start fresh.
        flush();
        let label = prefixMatch[1]!.trim();
        let rest = line.slice(prefixMatch[0].length).trim();

        // 5dqr: the matched colon may belong to a clock. Recover the name and keep
        // the rest of the line as this speaker's text, minus the timestamp.
        if (TIME_SPLIT_RE.test(label) && MINUTES_RE.test(rest)) {
          const recovered = unmangleSpeaker(label);
          if (recovered) {
            label = recovered;
            // Drop the minutes and any am/pm that followed the clock.
            rest = rest.replace(/^\d{2}\s*(?:[AaPp]\.?[Mm]\.?)?\s*/, "").trim();
          }
        }

        // UNRECOGNISED LABEL DOES NOT OVERRIDE THE MESSAGE'S SPEAKER (4ghy).
        //
        // The failure costs are asymmetric, which is what decides this. A false
        // positive mints a permanent phantom entity — the Kristen class: invisible,
        // and it pollutes the entity index, which is the thing that actually opens
        // recall. A false negative attributes the line to whoever sent the message,
        // and the raw text still says "Driver:", so it stays re-derivable later.
        // One error is permanent and silent; the other is recoverable and visible.
        // Always take the recoverable one.
        //
        // So an unproven label leaves the line exactly where it was — attributed to
        // the sender — rather than inventing a person to hang it on.
        // Roster match is STRONGER evidence than recurrence, so it short-circuits it:
        // the session character speaking once is still the session character.
        const rosterKnown = !!characterName && label.toLowerCase() === characterName.trim().toLowerCase();
        if (isPlausibleSpeakerLabel(label)
            && (rosterKnown || (labelCounts.get(label) ?? 0) >= MIN_LABEL_OCCURRENCES)) {
          currentSpeaker = label;
          buffer.push(rest);
        } else {
          // Not a speaker line after all: keep the whole line as this speaker's text.
          buffer.push(line);
        }
      } else if (NARRATION_RE.test(line)) {
        flush();
        // "Narrator" (capital) is the single canonical label across the chunker
        // and story parser, so the pipeline's povCharacter relabel matches both.
        turns.push({ speaker: "Narrator", text: line, turnIndex: index++, ordinal: ordinal++, ...provenance });
      } else {
        buffer.push(line);
      }
    }
    flush();
  }

  return turns;
}

// ── Embeddings via Ollama ─────────────────────────────────────────────────────
// Semantic merging is opt-in: set MARINARA_EXTENDER_EMBED_MODEL to an Ollama
// embedding model (e.g. "nomic-embed-text", after `ollama pull nomic-embed-text").
// When unset, fetchEmbeddings returns null and chunkMessages falls back to
// speaker-turn grouping — no Marinara Engine sidecar involved.

// Delegates to the shared embeddings module (default-ON with kill switch — d6d).
import { fetchEmbeddings } from "../embeddings.js";

// ── Cosine similarity ─────────────────────────────────────────────────────────

export function cosine(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Merge turns into chunks ───────────────────────────────────────────────────

/**
 * Provenance for a chunk, taken from the turns it spans (2pbi).
 *
 * FROM THE FIRST TURN, deliberately. A same-speaker run merges across message
 * boundaries — two consecutive replies from one character become one chunk — so
 * a chunk does not belong to a single message and cannot pretend to. What it
 * does have is an unambiguous STARTING point, and no two chunks of one import
 * start at the same (messageId, ordinal).
 *
 * Emitted only when the source actually carried an id. Writing `messageId:
 * undefined` into every chunk would make "we don't know" indistinguishable from
 * "there is no message", which is the distinction the whole ticket rests on.
 */
function chunkProvenance(first: DialogueTurn, last: DialogueTurn) {
  return {
    ...(first.messageId ? { messageId: first.messageId } : {}),
    ...(typeof first.swipeIndex === "number" ? { swipeIndex: first.swipeIndex } : {}),
    ...(typeof first.ordinal === "number" ? { ordinalStart: first.ordinal } : {}),
    ...(typeof last.ordinal === "number" ? { ordinalEnd: last.ordinal } : {}),
  };
}

function mergeByEmbedding(
  turns: DialogueTurn[],
  embeddings: number[][],
  threshold: number,
  maxTurns: number,
): Chunk[] {
  if (turns.length === 0) return [];

  const chunks: Chunk[] = [];
  let groupStart = 0;
  let groupSpeaker = turns[0]!.speaker;
  let groupTexts = [turns[0]!.text];
  let groupCount = 1;

  const finalize = (endIndex: number) => {
    chunks.push({
      speaker: groupSpeaker,
      text: groupTexts.join(" "),
      turnStart: turns[groupStart]!.turnIndex,
      turnEnd: turns[endIndex]!.turnIndex,
      ...chunkProvenance(turns[groupStart]!, turns[endIndex]!),
    });
  };

  for (let i = 1; i < turns.length; i++) {
    const turn = turns[i]!;
    const prevEmbed = embeddings[i - 1]!;
    const currEmbed = embeddings[i]!;
    const sim = cosine(prevEmbed, currEmbed);

    const sameSpeaker = turn.speaker === groupSpeaker;
    const similar = sim >= threshold;
    const withinLimit = groupCount < maxTurns;

    if (sameSpeaker && similar && withinLimit) {
      groupTexts.push(turn.text);
      groupCount++;
    } else {
      finalize(i - 1);
      groupStart = i;
      groupSpeaker = turn.speaker;
      groupTexts = [turn.text];
      groupCount = 1;
    }
  }

  finalize(turns.length - 1);
  return chunks;
}

export function mergeByTurnOnly(turns: DialogueTurn[], maxTurns = 6): Chunk[] {
  if (turns.length === 0) return [];

  const chunks: Chunk[] = [];
  let groupStart = 0;
  let groupSpeaker = turns[0]!.speaker;
  let groupTexts = [turns[0]!.text];
  let groupCount = 1;

  const finalize = (endIndex: number) => {
    chunks.push({
      speaker: groupSpeaker,
      text: groupTexts.join(" "),
      turnStart: turns[groupStart]!.turnIndex,
      turnEnd: turns[endIndex]!.turnIndex,
      ...chunkProvenance(turns[groupStart]!, turns[endIndex]!),
    });
  };

  for (let i = 1; i < turns.length; i++) {
    const turn = turns[i]!;
    if (turn.speaker === groupSpeaker && groupCount < maxTurns) {
      groupTexts.push(turn.text);
      groupCount++;
    } else {
      finalize(i - 1);
      groupStart = i;
      groupSpeaker = turn.speaker;
      groupTexts = [turn.text];
      groupCount = 1;
    }
  }

  finalize(turns.length - 1);
  return chunks;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function chunkMessages(
  messages: DigestMessage[],
  characterName: string,
): Promise<Chunk[]> {
  const cfg = loadSentimentConfig().chunking;
  const turns = parseTurns(messages, characterName);

  if (turns.length === 0) return [];

  // Semantic merging via Ollama embeddings (opt-in via MARINARA_EXTENDER_EMBED_MODEL).
  const embeddings = await fetchEmbeddings(turns.map((t) => t.text));

  if (embeddings && embeddings.length === turns.length) {
    return mergeByEmbedding(turns, embeddings, cfg.merge_threshold, cfg.max_turns_per_chunk);
  }

  // Embeddings unavailable — honor the config flag for callers that require them.
  if (!cfg.fallback_on_sidecar_unavailable) {
    throw new Error(
      "Chunker: embeddings unavailable and fallback_on_sidecar_unavailable is false. Set MARINARA_EXTENDER_EMBED_MODEL or enable the fallback.",
    );
  }

  // Only warn when embeddings were actually attempted (a model is configured);
  // otherwise turn-only grouping is the intended default, silently.
  if (embedModel()) {
    console.warn("[chunker] embeddings unavailable (is the embed model pulled in Ollama?) — using speaker-turn grouping.");
  }
  return mergeByTurnOnly(turns, cfg.max_turns_per_chunk);
}
