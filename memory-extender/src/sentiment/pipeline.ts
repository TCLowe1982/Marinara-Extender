// Sentiment Analysis Pipeline — public entry point.
// Runs Stages 0–3 in sequence on a list of chat messages.

import type { DigestMessage } from "../digest.js";
import type { EmotionalBeat, ClassificationResult } from "./types.js";
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

const NARRATIVE_POSITION_BOOST = 1.3;

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

  // Speaker filter: each run saves beats only for ONE character so beats land in
  // the right character directory. In story mode the default is characterName —
  // run the ingest once per character from that character's chat to populate each.
  // Pass an explicit characters list to override (e.g. for alias matching).
  let filtered: ClassificationResult[];
  if (characters?.length) {
    const needles = characters.map((n) => n.trim().toLowerCase());
    filtered = passing.filter((c) => needles.includes(c.chunk.speaker.trim().toLowerCase()));
  } else if (sourceType === "story") {
    const nameLower = characterName.trim().toLowerCase();
    filtered = passing.filter((c) => c.chunk.speaker.trim().toLowerCase() === nameLower);
  } else {
    filtered = passing;
  }

  // Stage 2: deep analyze (only passing + allowed chunks)
  const analyzed = await analyzeChunks(filtered);

  // Narrative position boost: the final 20% of a story carries climax and
  // resolution weight. Boost stored salience so these beats surface first
  // during retrieval without changing which chunks passed the threshold.
  const totalTurns = chunks.length > 0 ? chunks[chunks.length - 1].turnEnd + 1 : 0;
  const boostThresholdTurn = Math.floor(totalTurns * 0.8);
  const boosted = analyzed.map(({ result, analysis }) =>
    result.chunk.turnStart >= boostThresholdTurn
      ? { result, analysis: { ...analysis, salience: Math.min(1.0, analysis.salience * NARRATIVE_POSITION_BOOST) } }
      : { result, analysis },
  );

  // Stage 3: encode to disk
  const beats = await encodeBeats(characterId, boosted, sourceType);

  return {
    beats,
    chunksTotal:    chunks.length,
    chunksAnalyzed: boosted.length,
    chunksFailed:   filtered.length - boosted.length,
    chunksFiltered: passing.length - filtered.length,
  };
}
