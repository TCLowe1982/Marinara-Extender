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
    };
  }

  const text = chunk.text.toLowerCase();
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
    chunk,
    scores,
    primaryEmotion,
    salience,
    structuralMatches,
    passesThreshold: salience >= threshold,
  };
}

// ── Batch helper ──────────────────────────────────────────────────────────────

export function classifyChunks(
  chunks: Chunk[],
  sourceType: "chat" | "story" = "chat",
): ClassificationResult[] {
  return chunks.map((c) => classifyChunk(c, sourceType));
}
