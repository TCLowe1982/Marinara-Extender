// Sentiment Analysis Pipeline — public entry point.
// Runs Stages 0–3 in sequence on a list of chat messages.

import type { DigestMessage } from "../digest.js";
import type { EmotionalBeat, ClassificationResult } from "./types.js";
import { chunkMessages } from "./chunker.js";
import { classifyChunks } from "./classifier.js";
import { analyzeChunk } from "./analyzer.js";
import { encodeBeat, beatIdForChunk, readBeatIndex, companionEntryFromBeat } from "./encoder.js";
import { createEntryIfUnique } from "../dedup.js";
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
  skipped: number;      // chunks skipped because their beat already existed (resume)
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

  // Resume support: beats already on disk (from a prior interrupted run) are
  // skipped. Beat ids are deterministic per chunk, so a re-run of the same
  // import continues where it stopped instead of re-analyzing everything.
  const existingBeatIds = new Set((await readBeatIndex(characterId))?.entries.map((e) => e.id) ?? []);

  // Narrative position boost: the final 20% of a story carries climax and
  // resolution weight. Computed up front so it can be applied per chunk.
  const totalTurns = chunks.length > 0 ? chunks[chunks.length - 1].turnEnd + 1 : 0;
  const boostThresholdTurn = Math.floor(totalTurns * 0.8);

  const alreadyHave = filtered.filter((c) => existingBeatIds.has(beatIdForChunk(c.chunk))).length;
  report.stage(
    `parsing complete, analyzing sentiment — ${filtered.length} of ${chunks.length} chunks` +
    (alreadyHave ? ` (resuming — ${alreadyHave} already done)` : ""),
  );

  // Stage 2+3: analyze and encode each beat incrementally, so progress is
  // persisted as it happens (a cancel/crash keeps every completed beat).
  const beats: EmotionalBeat[] = [];
  let skipped = 0;
  let failed = 0;
  const total = filtered.length;
  for (let i = 0; i < filtered.length; i++) {
    if (options.signal?.aborted) {
      report.done(`cancelled — ${beats.length} new beats saved, resumable`);
      throw new Error("cancelled");
    }
    const result = filtered[i]!;
    const current = i + 1;

    // Skip if this chunk's beat already exists (resume).
    if (existingBeatIds.has(beatIdForChunk(result.chunk))) {
      skipped++;
      report.tick(current, total);
      continue;
    }

    // Analyze with the full classification list as context (true neighbors).
    const idx = classifications.indexOf(result);
    let analysis;
    try {
      analysis = await analyzeChunk(result, idx === -1 ? undefined : {
        before: classifications[idx - 1],
        after:  classifications[idx + 1],
      });
    } catch (err) {
      failed++;
      report.error(current, err instanceof Error ? err.message : String(err));
      report.tick(current, total);
      continue;
    }
    if (!analysis) {
      failed++;
      report.error(current, "model returned no parseable analysis");
      report.tick(current, total);
      continue;
    }

    if (result.chunk.turnStart >= boostThresholdTurn) {
      analysis = { ...analysis, salience: Math.min(1.0, analysis.salience * NARRATIVE_POSITION_BOOST) };
    }

    const beat = await encodeBeat(characterId, result, analysis, sourceType);
    beats.push(beat);

    // Also write a retrievable ledger entry. The loader builds the injected
    // <memory> block from the entry index, NOT the beats store — so without this
    // companion entry the character could never recall an imported beat.
    const { summary, content } = companionEntryFromBeat(beat);
    if (summary) await createEntryIfUnique("character", characterId, { lane: "character_topics", summary, content });

    report.tick(current, total);
  }

  report.done(
    `done — ${beats.length} new beats from ${chunks.length} chunks` +
    (skipped ? `, ${skipped} resumed` : "") +
    (failed ? `, ${failed} failed` : "") +
    `, ${passing.length - filtered.length} off-speaker`,
  );

  return {
    beats,
    chunksTotal:    chunks.length,
    chunksAnalyzed: beats.length,
    chunksFailed:   failed,
    chunksFiltered: passing.length - filtered.length,
    skipped,
    speakers,
  };
}
