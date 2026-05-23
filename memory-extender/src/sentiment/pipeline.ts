// Sentiment Analysis Pipeline — public entry point.
// Runs Stages 0–3 in sequence on a list of chat messages.

import type { DigestMessage } from "../digest.js";
import type { EmotionalBeat } from "./types.js";
import { chunkMessages } from "./chunker.js";
import { classifyChunks } from "./classifier.js";
import { analyzeChunks } from "./analyzer.js";
import { encodeBeats } from "./encoder.js";

export interface PipelineOptions {
  sourceType?: "chat" | "story";
  // Only analyze chunks attributed to these speakers. Unrecognized speakers
  // (e.g. walk-on characters) are dropped before the Gemma call.
  characters?: string[];
  // If provided, chunks with speaker "Narrator" are relabeled to this name
  // before filtering. Use for first-person prose where the narrator IS a
  // named character (e.g. povCharacter: "Mark").
  povCharacter?: string;
}

export interface PipelineResult {
  beats: EmotionalBeat[];
  chunksTotal: number;
  chunksAnalyzed: number;
  chunksFailed: number;
  chunksFiltered: number;
}

export async function runSentimentPipeline(
  messages: DigestMessage[],
  characterId: string,
  characterName: string,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const { sourceType = "chat", characters, povCharacter } = options;

  // Stage 0: chunk
  let chunks = await chunkMessages(messages, characterName);

  // Relabel "Narrator" to the POV character name for first-person prose.
  if (povCharacter) {
    chunks = chunks.map((c) =>
      c.speaker === "Narrator" ? { ...c, speaker: povCharacter } : c,
    );
  }

  // Stage 1: classify
  const classifications = classifyChunks(chunks, sourceType);
  const passing = classifications.filter((c) => c.passesThreshold);

  // Drop chunks from characters not in the allow-list (e.g. walk-on NPCs).
  const filtered = characters?.length
    ? passing.filter((c) => characters.includes(c.chunk.speaker))
    : passing;

  // Stage 2: deep analyze (only passing + allowed chunks)
  const analyzed = await analyzeChunks(filtered);

  // Stage 3: encode to disk
  const beats = await encodeBeats(characterId, analyzed, sourceType);

  return {
    beats,
    chunksTotal:    chunks.length,
    chunksAnalyzed: analyzed.length,
    chunksFailed:   filtered.length - analyzed.length,
    chunksFiltered: passing.length - filtered.length,
  };
}
