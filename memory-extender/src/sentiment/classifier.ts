// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Stage 1: Emotional Classification
//
// Scores a text chunk against emotion keyword dictionaries and structural
// patterns. No LLM calls — pure regex + scoring, designed to be fast enough
// to run on every chunk before deciding which ones warrant an LLM call.
//
// Architecture mirrors AutoTroll's ToxicityDetector:
//   keyword match counts → per-category scores → weighted sum → compound boost
// Extended with:
//   - dysregulation contextual rule (deflection + attachment = strong signal)
//   - structural pattern detection (format-based signals keyword lists miss)

import type { Chunk, ClassificationResult, StructuralPatternMatch } from "./types.js";
import { detectSelfPrompt, SELF_PROMPT_COVERAGE } from "./self-prompt.js";
import { routeOps } from "./ops-lane.js";
import { classifyChangelog } from "./changelog.js";
import type { Emotion } from "./types.js";
import { loadSentimentConfig, loadEmotionalKeywords } from "./config.js";

// ── Regex helpers ─────────────────────────────────────────────────────────────

function wordBoundaryRegex(phrase: string): RegExp {
  // Multi-word phrases need spaces escaped, single words use \b.
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/\s/.test(phrase)) {
    return new RegExp(escaped, "i");
  }
  return new RegExp(`\\b${escaped}\\b`, "i");
}

function countMatches(text: string, keywords: string[]): number {
  return keywords.filter((kw) => wordBoundaryRegex(kw).test(text)).length;
}

// ── Content floor ─────────────────────────────────────────────────────────────

const DEFAULT_MIN_CHUNK_TOKENS = 2;

/**
 * Raw word tokens — every word, function words KEPT.
 *
 * Deliberately NOT the analyzer's skeletonTokens. That strips pronouns and
 * copulas, which is right for detecting a copied sentence and wrong for
 * measuring whether a short line is a sentence at all: "I love you," has one
 * content word, exactly like the junk token "open". Three raw tokens against
 * one is the distinction that survives.
 */
export function rawTokenCount(text: string): number {
  return (String(text ?? "").match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

/**
 * Is there enough here to be specific about?
 *
 * THE GATE THIS BACKS UP IS EMOTION-KEYED, NOT CONTENT-KEYED. `salience_threshold`
 * asks "does this look emotional?", and a single word can answer yes: the bare
 * token "open" matches a vulnerability keyword, scores 0.59, and passes. 513 such
 * chunks reached the analyzer, and 89.1% of them came back carrying the prompt's
 * own example as their motivation — because a model asked to name what happened
 * in a moment containing nothing reaches for the nearest concrete sentence it has
 * been shown.
 *
 * So this is not a salience refinement, it is a different question asked first,
 * and it removes the echo mechanism's precondition instead of blocklisting its
 * output. rejectAsEcho() in the analyzer catches the sentences we have already
 * seen; this catches the next one, which no blocklist can know.
 *
 * Calibration and the two rejected axes are in config/sentiment-config.yaml;
 * re-run `node scripts/chunk-floor-scan.mjs` to reproduce the numbers.
 */
export function meetsContentFloor(text: string, minTokens: number): boolean {
  return rawTokenCount(text) >= minTokens;
}

// ── Core scoring ──────────────────────────────────────────────────────────────

export function classifyChunk(
  chunk: Chunk,
  sourceType: "chat" | "story" = "chat",
): ClassificationResult {
  const cfg = loadSentimentConfig();
  const kw = loadEmotionalKeywords();
  const threshold = sourceType === "story"
    ? (cfg.story_salience_threshold ?? 0.25)
    : cfg.salience_threshold;

  // Content floor first — cheaper than scoring, and a chunk with nothing in it
  // is not a low-salience beat, it is not a beat. Returning zeroed scores rather
  // than a suppressed-but-scored result keeps the "no beat" answer unambiguous
  // for every caller that reads primaryEmotion.
  const minTokens = cfg.min_chunk_tokens ?? DEFAULT_MIN_CHUNK_TOKENS;
  if (!meetsContentFloor(chunk.text, minTokens)) {
    return {
      chunk,
      scores: {},
      primaryEmotion: null,
      salience: 0,
      structuralMatches: [],
      passesThreshold: false,
      suppressedReason: "content-floor",
    };
  }

  // SELF-INGESTION GATE (pe4o). Our own system prompt is not conversation.
  //
  // Prompt text gets pasted into a chat for review — this project's own required
  // workflow — and without this the sidecar chunks it, scores it for emotion, asks a
  // model what the speaker was feeling, and files the answer under a character. 65
  // live records were built that way, 47 of them in one day, 62 of them on a single
  // character whose ledger now contains beats analysing OUR SCAFFOLDING as her
  // feelings. It is also the root of the bait rot: the boat example's probe became
  // corroborable because the prompt containing it was ingested, not because anyone
  // discussed a boat.
  //
  // Gated HERE, before scoring, for the same reason as the content floor: a chunk of
  // machine scaffolding is not a low-salience beat, it is not a beat. Scoring it first
  // and suppressing later would still spend an LLM call and still let a structural
  // match through.
  //
  // Measured before wiring, over all 23,343 stored chunks: 34 gated, every one dated
  // to the prompt-rewrite session, ZERO hits on the other 23,309. The false-positive
  // cost here is a real memory that is never recorded — worse than the bug — so the
  // matcher demands a whole normalised line of our own prompt, not a phrase.
  // GATED ON COVERAGE, NOT ON A HIT. The first version suppressed on a single
  // matching line, which killed 2,242 characters of someone thinking out loud
  // because it quoted one schema line — hjt9's "a chunk-level route would misfile
  // all of it", reproduced exactly. A chunk that QUOTES the prompt is shop talk and
  // a real memory; a chunk that IS the prompt is not.
  const selfPrompt = detectSelfPrompt(chunk.text);
  if (selfPrompt && selfPrompt.coverage >= SELF_PROMPT_COVERAGE) {
    return {
      chunk,
      scores: {},
      primaryEmotion: null,
      salience: 0,
      structuralMatches: [],
      passesThreshold: false,
      suppressedReason: "self-prompt",
    };
  }

  // THIRD-PARTY RELEASE NOTES (mln9) — DEFENCE IN DEPTH, not the primary gate.
  //
  // The real gate is at message level in pipeline.ts, where the line structure still
  // exists. This one catches paths that reach a chunk without passing through there:
  // story imports and re-analysis of stored text. It is worth having because
  // enumeration survives chunking better than fences do — sentence-terminal
  // punctuation still marks the items — which is exactly why all six stored positives
  // are detectable in their flattened form.
  //
  // A CHUNK-LEVEL MISS IS EXPECTED AND ACCEPTED. A long changelog split across several
  // chunks divides its openers among them, and each piece can fall under the floor.
  // That is not a bug to fix here by lowering the floor: the message-level gate is the
  // one that sees the whole document, and loosening this one would trade a real
  // suppression risk for a duplicate catch.
  const cl = classifyChangelog(chunk.text);
  if (cl.isChangelog) {
    return {
      chunk,
      scores: {},
      primaryEmotion: null,
      salience: 0,
      structuralMatches: [],
      passesThreshold: false,
      suppressedReason: "changelog",
    };
  }

  // OPS/META ROUTING (hjt9). The routable unit is the PARTITION, never a chunk-level
  // boolean — three separate detectors in this codebase made the chunk-level mistake
  // before this landed, so the lane only ever consumes the split.
  //
  // Structure goes to the sink; the prose around it stays memory and is what gets
  // scored, analysed, and — critically — handed to the echo guard as corroboration
  // evidence. hjt9: "rejectAsEcho's escape hatch must not accept a paste of the
  // phrase as the speaker having said it." Feeding it prose-only enforces that here
  // rather than with another special case inside the guard.
  //
  // Measured over 8,300 live beats before wiring: 1.7% of chunks lose a line, 37 are
  // wholly structural. That number is only trustworthy because two rules were fixed
  // first — `shell-command` was matching markdown blockquotes of character-card
  // prose, and `bare-literal` was matching lines of dialogue like
  // "Zielińska. Party of three. Five-thirty." Unfixed, this dropped 310 chunks.
  const ops = routeOps(chunk.text);
  if (ops.wholesale) {
    return {
      chunk,
      scores: {},
      primaryEmotion: null,
      salience: 0,
      structuralMatches: [],
      passesThreshold: false,
      suppressedReason: "ops-lane",
      opsLines: ops.dropped,
    };
  }
  // Score the prose half only. The chunk carried downstream is the reduced one, so
  // the stored beat's evidence is what a person actually said.
  const scored: Chunk = ops.dropped.length ? { ...chunk, text: ops.prose } : chunk;
  const opsLines = ops.dropped.length ? ops.dropped : undefined;

  const text = scored.text.toLowerCase();
  const scores: Partial<Record<Emotion, number>> = {};
  let totalMatches = 0;

  // ── Standard emotion lanes ─────────────────────────────────────────────────
  const standardLanes: Array<[Emotion, string[]]> = [
    ["fear",          kw.fear],
    ["shame",         kw.shame],
    ["hope",          kw.hope],
    ["desire",        kw.desire],
    ["relief",        kw.relief],
    ["vulnerability", kw.vulnerability],
    ["trust",         kw.trust],
    ["anger",         kw.anger],
    ["joy",           kw.joy],
  ];

  for (const [emotion, keywords] of standardLanes) {
    const matches = countMatches(text, keywords);
    if (matches === 0) continue;
    totalMatches += matches;
    const weight = cfg.emotion_weights[emotion] ?? 0.7;
    scores[emotion] = Math.min(1.0, matches * cfg.match_score_per_hit * weight);
  }

  // ── Dysregulation lane (three sub-lists + contextual rule) ─────────────────
  const directMatches   = countMatches(text, kw.dysregulation.direct);
  const deflectMatches  = countMatches(text, kw.dysregulation.deflection);
  const attachMatches   = countMatches(text, kw.dysregulation.attachment);

  totalMatches += directMatches + deflectMatches + attachMatches;

  const dysregWeight = cfg.emotion_weights.dysregulation ?? 0.9;
  let dysregScore = Math.min(1.0, directMatches * cfg.match_score_per_hit * dysregWeight);

  // Deflection alone is a weak signal — add a small contribution.
  if (deflectMatches > 0) {
    dysregScore = Math.min(1.0, dysregScore + deflectMatches * 0.15);
  }

  // Deflection + attachment together is a strong dysregulation indicator.
  if (deflectMatches > 0 && attachMatches > 0) {
    dysregScore = Math.min(1.0, dysregScore * cfg.dysregulation_contextual.combined_boost);
  }

  if (dysregScore > 0) {
    scores.dysregulation = dysregScore;
  }

  // ── Compound amplification ─────────────────────────────────────────────────
  if (totalMatches >= 3) {
    for (const emotion of Object.keys(scores) as Emotion[]) {
      scores[emotion] = Math.min(1.0, scores[emotion]! * cfg.compound_boost.three_plus);
    }
  } else if (totalMatches >= 2) {
    for (const emotion of Object.keys(scores) as Emotion[]) {
      scores[emotion] = Math.min(1.0, scores[emotion]! * cfg.compound_boost.two_matches);
    }
  }

  // ── Short-message boost ────────────────────────────────────────────────────
  const wordCount = chunk.text.trim().split(/\s+/).length;
  if (wordCount <= cfg.short_message.word_count_threshold && Object.keys(scores).length > 0) {
    for (const emotion of Object.keys(scores) as Emotion[]) {
      scores[emotion] = Math.min(1.0, scores[emotion]! * cfg.short_message.multiplier);
    }
  }

  // ── Structural patterns ────────────────────────────────────────────────────
  const structuralMatches: StructuralPatternMatch[] = [];

  for (const [patternId, patternCfg] of Object.entries(cfg.structural_patterns)) {
    const re = new RegExp(patternCfg.pattern, patternCfg.flags ?? "");
    if (!re.test(chunk.text)) continue;

    structuralMatches.push({
      patternId,
      emotion: patternCfg.emotion,
      subpattern: patternCfg.subpattern,
      score: patternCfg.score,
    });

    // Merge structural score into the emotion scores.
    const existing = scores[patternCfg.emotion] ?? 0;
    scores[patternCfg.emotion] = Math.min(1.0, Math.max(existing, patternCfg.score));
  }

  // ── Derive salience and primary emotion ───────────────────────────────────
  let salience = 0;
  let primaryEmotion: Emotion | null = null;

  for (const [emotion, score] of Object.entries(scores) as [Emotion, number][]) {
    if (score > salience) {
      salience = score;
      primaryEmotion = emotion;
    }
  }

  return {
    // The REDUCED chunk, so everything downstream — the analyzer's prompt, the
    // stored beat's text, and the echo guard's corroboration evidence — sees what a
    // person said and not what they pasted.
    chunk: scored,
    scores,
    primaryEmotion,
    salience,
    structuralMatches,
    passesThreshold: salience >= threshold,
    opsLines,
  };
}

// ── Batch helper ──────────────────────────────────────────────────────────────

export function classifyChunks(
  chunks: Chunk[],
  sourceType: "chat" | "story" = "chat",
): ClassificationResult[] {
  return chunks.map((c) => classifyChunk(c, sourceType));
}
