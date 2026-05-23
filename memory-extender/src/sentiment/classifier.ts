// Stage 1: Emotional Classification
//
// Scores a text chunk against emotion keyword dictionaries and structural
// patterns. No LLM calls — pure regex + scoring, designed to be fast enough
// to run on every chunk before deciding which ones warrant a Gemma call.
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

// ── Core scoring ──────────────────────────────────────────────────────────────

export function classifyChunk(chunk: Chunk): ClassificationResult {
  const cfg = loadSentimentConfig();
  const kw = loadEmotionalKeywords();

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
    passesThreshold: salience >= cfg.salience_threshold,
  };
}

// ── Batch helper ──────────────────────────────────────────────────────────────

export function classifyChunks(chunks: Chunk[]): ClassificationResult[] {
  return chunks.map(classifyChunk);
}
