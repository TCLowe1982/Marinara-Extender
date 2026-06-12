// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Sentiment Analysis Pipeline — public entry point.
// Runs Stages 0–3 in sequence on a list of chat messages.

import type { DigestMessage } from "../digest.js";
import type { EmotionalBeat, ClassificationResult } from "./types.js";
import { chunkMessages } from "./chunker.js";
import { classifyChunks } from "./classifier.js";
import { analyzeChunk } from "./analyzer.js";
import { encodeBeat, beatIdForChunk, readBeatIndex, readBeat, companionEntryFromBeat } from "./encoder.js";
import { createEntryIfUnique } from "../dedup.js";
import { Progress, progressEnabled } from "../progress.js";
import { buildSubjectRoster, resolveNameToKey, matchesSessionName } from "../identity.js";
import { normalizeLabel } from "../aliases.js";
import { addPending } from "../holding-pool.js";

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
  // Tag companion ledger entries with the chat they came from, so a re-import
  // of that chat can cleanly replace them.
  sourceChatId?: string;
  // Deliberate re-import: skip the existing-beat resume shortcut and re-analyze
  // every chunk. The resume skip bypasses subject routing (it recreates
  // companions under the bucket without analysis), which silently defeats a
  // re-import whose purpose is redistributing a shared scene across ledgers.
  forceReanalyze?: boolean;
  // Per-chunk progress sink (in addition to the console reporter) — used to
  // stream within-chat progress to the browser.
  onProgress?: (current: number, total: number) => void;
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

// Partial/contains matching so "Mari" matches "Dr. Mari Zielinska", "Professor
// Mari", etc. Exported so the orchestrator can identify which passing chunks
// matched no assigned character (the true orphans that route to the holding pool).
export function speakerMatches(speaker: string, needle: string): boolean {
  const s = speaker.trim().toLowerCase();
  const n = needle.trim().toLowerCase();
  return !!s && !!n && (s === n || s.includes(n) || n.includes(s));
}

// Run only Stages 0–1 (chunk + classify + threshold) — no LLM deep analysis.
// The orchestrator uses this to find passing chunks whose speaker matched none
// of the assigned characters, so they can be held instead of dropped.
export async function collectPassingClassifications(
  messages: DigestMessage[],
  characterName: string,
  options: { sourceType?: "chat" | "story"; povCharacter?: string } = {},
): Promise<{ speakers: string[]; passing: ClassificationResult[] }> {
  const { sourceType = "chat", povCharacter } = options;
  let chunks = await chunkMessages(messages, characterName);
  if (povCharacter) {
    chunks = chunks.map((c) => (c.speaker === "Narrator" ? { ...c, speaker: povCharacter } : c));
  }
  const passing = classifyChunks(chunks, sourceType).filter((c) => c.passesThreshold);
  const speakers = [...new Set(chunks.map((c) => c.speaker))].sort();
  return { speakers, passing };
}

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

  // CHAT imports analyze EVERYTHING: assistant messages carry the session
  // character's id, so the chunker labels every narration chunk with one
  // speaker — a shared scene cannot be split by speaker, only by analyzed
  // subject. "Import once, from either side." STORY imports keep the speaker
  // pre-filter (big casts; explicit name assignments matter).
  const analyzeAll = sourceType === "chat";
  let filtered: ClassificationResult[];
  if (analyzeAll) {
    filtered = passing;
  } else if (characters?.length) {
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
  // (Beats subject-routed to a DIFFERENT character are not in this bucket's
  // index, so a re-run re-analyzes those chunks — idempotent on disk, just
  // re-spends the analyzer call.)
  const existingBeatIds = new Set((await readBeatIndex(characterId))?.entries.map((e) => e.id) ?? []);

  // Known-identity roster for per-beat subject attribution — global, because
  // imports routinely involve the whole cast.
  const roster = await buildSubjectRoster(characterName);

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
  const tick = (current: number) => { report.tick(current, total); options.onProgress?.(current, total); };
  for (let i = 0; i < filtered.length; i++) {
    if (options.signal?.aborted) {
      report.done(`cancelled — ${beats.length} new beats saved, resumable`);
      throw new Error("cancelled");
    }
    const result = filtered[i]!;
    const current = i + 1;

    // Skip analysis if this chunk's beat already exists (resume) — but still
    // make sure its companion ledger entry is present. A clean re-import clears
    // companions by sourceChatId; without this, skipped chunks would lose their
    // retrievable entry. Re-derive it from the stored beat (no re-analysis).
    // forceReanalyze (deliberate re-import) bypasses this: the skip would also
    // bypass subject routing and silently undo a redistribution.
    const beatId = beatIdForChunk(result.chunk);
    if (!options.forceReanalyze && existingBeatIds.has(beatId)) {
      skipped++;
      const existing = await readBeat(characterId, beatId);
      if (existing) {
        const { summary, content } = companionEntryFromBeat(existing);
        if (summary) await createEntryIfUnique("character", characterId, { lane: "character_topics", summary, content, sourceChatId: options.sourceChatId, kind: "incident", turnStart: existing.turnStart });
      }
      tick(current);
      continue;
    }

    // Analyze with the full classification list as context (true neighbors).
    const idx = classifications.indexOf(result);
    let analysis;
    try {
      analysis = await analyzeChunk(result, idx === -1 ? undefined : {
        before: classifications[idx - 1],
        after:  classifications[idx + 1],
      }, { roster });
    } catch (err) {
      failed++;
      report.error(current, err instanceof Error ? err.message : String(err));
      tick(current);
      continue;
    }
    if (!analysis) {
      failed++;
      report.error(current, "model returned no parseable analysis");
      tick(current);
      continue;
    }

    if (result.chunk.turnStart >= boostThresholdTurn) {
      analysis = { ...analysis, salience: Math.min(1.0, analysis.salience * NARRATIVE_POSITION_BOOST) };
    }

    // Subject routing (MarinaraExtender-cx4): like the live path, a beat lands
    // in the ledger of whoever it is ABOUT, not the import bucket. RP prose is
    // narration — the speaker label can't attribute it; the analysis can.
    // UNRESOLVED subjects: chunks whose speaker the user explicitly assigned
    // (keep list / bucket character / user) fall back to the bucket — stated
    // intent. A stranger's chunk with an unresolvable subject goes to the
    // holding pool instead: never guessed into a permanent ledger.
    let targetKey = characterId;
    let attributed = result;
    const subject = analysis.subject?.trim();
    const isUserish = !subject || normalizeLabel(subject) === "user" || matchesSessionName(subject, characterName);
    if (!isUserish) {
      const key = await resolveNameToKey(subject);
      if (key && key !== characterId) {
        targetKey = key;
        attributed = { ...result, chunk: { ...result.chunk, speaker: subject } };
        console.info(`[ME:pipeline] subject="${subject}" → ${targetKey} (routed off the ${characterId} bucket)`);
      } else if (!key && analyzeAll) {
        const assignedNames = [characterName, "user", "Narrator", ...(characters ?? [])];
        const speakerAssigned = assignedNames.some((n) => speakerMatches(result.chunk.speaker, n));
        if (!speakerAssigned) {
          await addPending({
            speaker: subject,
            sourceType,
            sourceChatId: options.sourceChatId,
            classification: { ...result, chunk: { ...result.chunk, speaker: subject } },
          }).catch(() => {});
          console.info(`[ME:pipeline] unknown subject "${subject}" on unassigned speaker — parked in holding pool`);
          tick(current);
          continue;
        }
      }
    }

    const beat = await encodeBeat(targetKey, attributed, analysis, sourceType, options.sourceChatId);
    beats.push(beat);

    // Also write a retrievable ledger entry. The loader builds the injected
    // <memory> block from the entry index, NOT the beats store — so without this
    // companion entry the character could never recall an imported beat.
    const { summary, content } = companionEntryFromBeat(beat);
    if (summary) await createEntryIfUnique("character", targetKey, { lane: "character_topics", summary, content, sourceChatId: options.sourceChatId, kind: "incident", turnStart: beat.turnStart });

    tick(current);
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
