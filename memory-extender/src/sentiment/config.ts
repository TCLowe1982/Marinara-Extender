// Reads sentiment-config.yaml and emotional_keywords.yaml at call time.
// No caching — edits to either file take effect on the next pipeline call.

import { readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import type { Emotion } from "./types.js";

const CONFIG_DIR = join(new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"), "..", "..", "config");

// ── Config shape ──────────────────────────────────────────────────────────────

export interface StructuralPatternConfig {
  pattern: string;
  flags?: string;   // regex flags, e.g. "i" for case-insensitive. Default: "" (case-sensitive)
  emotion: Emotion;
  subpattern?: string;
  score: number;
  description?: string;
}

export interface ChunkingConfig {
  merge_threshold: number;
  max_turns_per_chunk: number;
  fallback_on_sidecar_unavailable: boolean;
}

export interface SentimentConfig {
  chunking: ChunkingConfig;
  salience_threshold: number;
  emotion_weights: Record<Emotion, number>;
  match_score_per_hit: number;
  compound_boost: { two_matches: number; three_plus: number };
  short_message: { word_count_threshold: number; multiplier: number };
  dysregulation_contextual: { combined_boost: number };
  structural_patterns: Record<string, StructuralPatternConfig>;
}

// ── Keywords shape ────────────────────────────────────────────────────────────

export interface EmotionalKeywords {
  // Standard emotion lanes: flat word list
  fear: string[];
  shame: string[];
  hope: string[];
  desire: string[];
  relief: string[];
  vulnerability: string[];
  trust: string[];
  anger: string[];
  joy: string[];
  // Dysregulation has sub-lists
  dysregulation: {
    deflection: string[];
    attachment: string[];
    direct: string[];
  };
}

// ── Loaders ───────────────────────────────────────────────────────────────────

export function loadSentimentConfig(): SentimentConfig {
  const raw = readFileSync(join(CONFIG_DIR, "sentiment-config.yaml"), "utf8");
  return parseYaml(raw) as SentimentConfig;
}

export function loadEmotionalKeywords(): EmotionalKeywords {
  const raw = readFileSync(join(CONFIG_DIR, "emotional_keywords.yaml"), "utf8");
  return parseYaml(raw) as EmotionalKeywords;
}
