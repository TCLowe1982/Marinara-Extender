// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Shared types for the sentiment analysis pipeline (Stages 0-3).

export type Emotion =
  | "fear"
  | "shame"
  | "hope"
  | "desire"
  | "relief"
  | "vulnerability"
  | "trust"
  | "anger"
  | "joy"
  | "dysregulation";

// Sub-patterns identified by the deep analyzer (Stage 2).
// Not exhaustive — the analyzer can surface patterns not in this list.
export type DysregulationPattern =
  | "bpd_testing"
  | "anxious_protest"
  | "avoidant_withdrawal"
  | "dissociation"
  | "catastrophizing"
  | "idealization"
  | "devaluation"
  | "emotional_flooding"
  | "shutdown";

// ── Stage 0: Chunking ─────────────────────────────────────────────────────────

export interface DialogueTurn {
  speaker: string;     // "user" | character name | "Narrator"
  text: string;
  turnIndex: number;   // position in the original message list
}

export interface Chunk {
  speaker: string;
  text: string;
  turnStart: number;   // first turn index merged into this chunk
  turnEnd: number;     // last turn index merged into this chunk
}

// ── Stage 1: Classification ───────────────────────────────────────────────────

export interface StructuralPatternMatch {
  patternId: string;
  emotion: Emotion;
  subpattern?: string;
  score: number;
}

export interface ClassificationResult {
  chunk: Chunk;
  scores: Partial<Record<Emotion, number>>;
  primaryEmotion: Emotion | null;
  salience: number;              // highest individual emotion score
  structuralMatches: StructuralPatternMatch[];
  passesThreshold: boolean;      // salience >= config.salience_threshold
}

// ── Stage 2: Deep Analysis ────────────────────────────────────────────────────

// Compound emotion: a named emotion paired with its relative weight (0–1).
// Weights across a beat's emotion array should sum to ~1.0 but are not enforced.
// The emotion label is freeform — richer vocabulary than the Emotion enum is intentional.
export interface EmotionWeight {
  emotion: string;
  weight: number;
}

export interface BeatAnalysis {
  motivation: string;            // what is driving this person right now
  relationalDynamics: string;    // how this affects/is affected by the relationship
  outcome: string;               // what this moment implies for the future
  subpattern?: string;           // specific dysregulation pattern if applicable
  // Compound emotion breakdown. The first entry is the primary emotion.
  emotions?: EmotionWeight[];
  // Emotional function of sexual/intimate content when present.
  subtext?: string;
  salience: number;              // 0.0–1.0, model's own salience estimate
}

// ── Stage 3: Encoded Beat ─────────────────────────────────────────────────────

export interface EmotionalBeat {
  id: string;
  speaker: string;
  emotion: Emotion;              // primary emotion (highest weight)
  subpattern?: string;
  // Compound breakdown — present when the beat carries mixed emotions.
  emotions?: EmotionWeight[];
  // Emotional subtext of sexual/intimate content when detected.
  subtext?: string;
  text: string;                  // the chunk text
  motivation: string;
  relationalDynamics: string;
  outcome: string;
  salience: number;
  turnStart: number;
  turnEnd: number;
  created: string;               // ISO date
  sourceType: "chat" | "story";  // came from live chat or story import
  sourceChatId?: string;         // provenance: the chat this beat was imported from
}
