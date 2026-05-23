// Sentiment Analysis Pipeline — public entry point.
// Runs Stages 0–3 in sequence on a list of chat messages.

import type { DigestMessage } from "../digest.js";
import type { EmotionalBeat } from "./types.js";
import { chunkMessages } from "./chunker.js";
import { classifyChunks } from "./classifier.js";
import { analyzeChunks } from "./analyzer.js";
import { encodeBeats } from "./encoder.js";

export interface PipelineResult {
  beats: EmotionalBeat[];
  chunksTotal: number;
  chunksAnalyzed: number;
  chunksFailed: number;
}

export async function runSentimentPipeline(
  messages: DigestMessage[],
  characterId: string,
  characterName: string,
  sourceType: "chat" | "story" = "chat",
): Promise<PipelineResult> {
  // Stage 0: chunk
  const chunks = await chunkMessages(messages, characterName);

  // Stage 1: classify
  const classifications = classifyChunks(chunks, sourceType);
  const passing = classifications.filter((c) => c.passesThreshold);

  // Stage 2: deep analyze (only passing chunks)
  const analyzed = await analyzeChunks(passing);

  // Stage 3: encode to disk
  const beats = await encodeBeats(characterId, analyzed, sourceType);

  return {
    beats,
    chunksTotal:    chunks.length,
    chunksAnalyzed: analyzed.length,
    chunksFailed:   passing.length - analyzed.length,
  };
}
