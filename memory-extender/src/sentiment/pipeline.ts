// Sentiment Analysis Pipeline — public entry point.
// Runs Stages 0–3 in sequence on a list of chat messages.

import type { DigestMessage } from "../digest.js";
import type { EmotionalBeat, ClassificationResult } from "./types.js";
import { chunkMessages } from "./chunker.js";
import { classifyChunks } from "./classifier.js";
import { analyzeChunks } from "./analyzer.js";
import { encodeBeats } from "./encoder.js";
import { Progress, progressEnabled } from "../progress.js";

export interface PipelineOptions {
  sourceType?: "chat" | "story";
  // Only analyze chunks attributed to these speakers. Unrecognized speakers
  // (e.g. walk-on characters) are dropped before the deep-analysis LLM call.
  characters?: string[];
  // If provided, chunks with speaker "Narrator" are relabeled to this name
  // before filtering. Use for first-person prose where the narrator IS a
  // named character (e.g. povCharacter: "Mark").
  povCharacter?: string;
  // Label for console progress output (e.g. the story title). Defaults to the
  // character name.
  progressLabel?: string;
  // Override the MARINARA_EXTENDER_PROGRESS env toggle for this run.
  progress?: boolean;
  // Aborts the analysis loop (cancelled import); no beats are encoded.
  signal?: AbortSignal;
}

export interface PipelineResult {
  beats: EmotionalBeat[];
  chunksTotal: number;
  chunksAnalyzed: number;
  chunksFailed: number;
  chunksFiltered: number;
  speakers: string[];   // unique speaker labels found in the text
}

const NARRATIVE_POSITION_BOOST = 1.3;

export async function runSentimentPipeline(
  messages: DigestMessage[],
  characterId: string,
  characterName: string,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const { sourceType = "chat", characters, povCharacter, progressLabel } = options;
  const report = new Progress(progressLabel ?? characterName, options.progress ?? progressEnabled());

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

  // Collect unique speakers for diagnostics.
  const speakers = [...new Set(chunks.map((c) => c.speaker))].sort();

  // Speaker filter: keep only chunks for the target character.
  // Uses partial/contains matching so "Mari" matches "Dr. Mari Zielinska",
  // "Professor Mari", etc. Pass an explicit characters list to pin exact names.
  function speakerMatches(speaker: string, needle: string): boolean {
    const s = speaker.trim().toLowerCase();
    const n = needle.trim().toLowerCase();
    return s === n || s.includes(n) || n.includes(s);
  }

  let filtered: ClassificationResult[];
  if (characters?.length) {
    filtered = passing.filter((c) =>
      characters.some((name) => speakerMatches(c.chunk.speaker, name)),
    );
  } else if (sourceType === "story") {
    filtered = passing.filter((c) => speakerMatches(c.chunk.speaker, characterName));
  } else {
    filtered = passing;
  }

  console.info(`[ME:pipeline] speakers found: ${speakers.join(", ")}`);
  console.info(`[ME:pipeline] matching against: "${characterName}" — ${filtered.length}/${passing.length} chunks kept`);

  report.stage(`parsing complete, analyzing sentiment — ${filtered.length} of ${chunks.length} chunks`);

  // Stage 2: deep analyze (only passing + allowed chunks). Pass the full ordered
  // classification list as context so each beat sees its TRUE neighbors, not the
  // nearest other passing beat. Report per-chunk progress and errors to the console.
  const analyzed = await analyzeChunks(filtered, classifications, (current, total, reason) => {
    if (reason) report.error(current, reason);
    report.tick(current, total);
  }, options.signal);

  // If cancelled mid-analysis, stop before writing any beats so a restart
  // starts clean.
  if (options.signal?.aborted) {
    report.done("cancelled");
    throw new Error("cancelled");
  }

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

  report.done(
    `done — ${beats.length} beats from ${chunks.length} chunks ` +
    `(${filtered.length - boosted.length} failed, ${passing.length - filtered.length} off-speaker)`,
  );

  return {
    beats,
    chunksTotal:    chunks.length,
    chunksAnalyzed: boosted.length,
    chunksFailed:   filtered.length - boosted.length,
    chunksFiltered: passing.length - filtered.length,
    speakers,
  };
}
