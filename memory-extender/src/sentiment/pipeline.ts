// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Sentiment Analysis Pipeline — public entry point.
// Runs Stages 0–3 in sequence on a list of chat messages.

import type { DigestMessage } from "../digest.js";
import type { EmotionalBeat, ClassificationResult } from "./types.js";
import { chunkMessages } from "./chunker.js";
import { classifyChunks } from "./classifier.js";
import { recordOps, routeOps, type OpsRecord } from "./ops-lane.js";
import { analyzeChunk } from "./analyzer.js";
import { encodeBeat, beatIdForChunk, provenanceKeyForChunk, readBeatIndex, readBeat, companionEntryFromBeat } from "./encoder.js";
import { createEntryIfUnique } from "../dedup.js";
import { Progress, progressEnabled } from "../progress.js";
import { buildSubjectRoster, resolveNameToKey, matchesSessionName } from "../identity.js";
import { normalizeLabel } from "../aliases.js";
import { addPending } from "../holding-pool.js";
import { ingestSceneFacts } from "../facts.js";
import { getDataDir } from "../storage.js";

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

  // Stage -1: OPS ROUTING, BEFORE CHUNKING — and this ordering is the whole point.
  //
  // MEASURED 2026-08-06 (`node scripts/paste-scan-message.mjs`): the chunker joins
  // turns with a SPACE (`groupTexts.join(" ")`, chunker.ts:118/159). parseTurns has
  // already split the message on /\n+/, so by the time a chunk exists every newline
  // is gone and the chunk is one line. Every code-filter rule is line-anchored
  // (/^\s*.../) and partitionProse splits on /\r?\n/ — so routing at chunk level has
  // nothing left to work with on the live path.
  //
  // The numbers, same texts measured both ways: mean paste score 0.061 whole-message
  // against 0.003 at best chunk, a 20x collapse. That is not a weak signal, it is a
  // shredded one, and it is why the chunk-level scan concluded the size prior "is not
  // doing decisive work" — it was measuring after the evidence had been destroyed.
  //
  // So structure is routed here, where lines still exist, and the chunker receives
  // prose. The chunk-level gate in classifyChunk stays as defence in depth for paths
  // that reach it with newlines intact (story imports, re-analysis of stored text).
  const opsRecords: OpsRecord[] = [];
  const routedMessages = messages.map((m) => {
    const content = String(m.content ?? "");
    if (!content.includes("\n")) return m;
    const routed = routeOps(content);
    if (!routed.dropped.length) return m;
    for (const d of routed.dropped) {
      opsRecords.push({
        at: new Date().toISOString(),
        chatId: options.sourceChatId,
        speaker: m.role,
        rule: d.rule,
        line: d.line,
        pasteScore: routed.pasteScore,
      });
    }
    // MARK, DON'T DROP: the lines are in the sink before the message is reduced.
    return { ...m, content: routed.prose };
  }).filter((m) => String(m.content ?? "").trim().length > 0);

  if (opsRecords.length) {
    recordOps(getDataDir(), opsRecords);
    console.info(`[ME:pipeline] ops lane: routed ${opsRecords.length} line(s) from ${messages.length - routedMessages.length} dropped message(s) + reductions`);
  }

  // Stage 0: chunk
  let chunks = await chunkMessages(routedMessages, characterName);

  // Relabel "Narrator" to the POV character name for first-person prose.
  if (povCharacter) {
    chunks = chunks.map((c) =>
      c.speaker === "Narrator" ? { ...c, speaker: povCharacter } : c,
    );
  }

  // Stage 1: classify
  const classifications = classifyChunks(chunks, sourceType);

  // CHUNK-LEVEL SINK — defence in depth. The primary routing happened at Stage -1,
  // above, where newlines still exist. This catches anything that reaches classify
  // with structure intact, and writes it the same way. Kept separate rather than
  // merged because the two run at different granularities and conflating them is the
  // exact mistake this ticket is about.
  //
  // A SINK, NOT A FOURTH LANE. storage.ts's Lane type means a RECALL lane, read back
  // and injected into prompts; filing ops content there would classify it correctly
  // and then feed it to the model anyway, which is the problem restated.
  const chunkOpsRecords = classifications.flatMap((c) =>
    (c.opsLines ?? []).map((d) => ({
      at: new Date().toISOString(),
      chatId: options.sourceChatId,
      speaker: c.chunk.speaker,
      rule: d.rule,
      line: d.line,
      pasteScore: 0,
    })),
  );
  if (chunkOpsRecords.length) {
    recordOps(getDataDir(), chunkOpsRecords);
    console.info(`[ME:pipeline] ops lane (chunk-level): routed ${chunkOpsRecords.length} line(s) from ${classifications.filter((c) => c.opsLines?.length).length} chunk(s)`);
  }

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
  // skipped, so a re-run continues where it stopped instead of re-analyzing
  // everything.
  // (Beats subject-routed to a DIFFERENT character are not in this bucket's
  // index, so a re-run re-analyzes those chunks — idempotent on disk, just
  // re-spends the analyzer call.)
  //
  // MATCHED ON PROVENANCE FIRST (r0kc). beatIdForChunk hashes speaker and text,
  // which are readings of the chunk rather than facts about it — so improving
  // attribution (5dqr, 4ghy) or filtering (hjt9) renamed every affected beat and
  // the next import wrote it again under the new name. The duplicates then read
  // as independent corroborations of a single utterance, which is the failure
  // "count utterances, never hits" exists to prevent.
  //
  // The id fallback is not legacy debt to pay off later: pre-2pbi beats recorded
  // no message id and there is nothing to backfill one from, so it is their
  // permanent identity and stays here for good.
  const beatIndex = await readBeatIndex(characterId);
  const existingBeatIds = new Set(beatIndex?.entries.map((e) => e.id) ?? []);
  const idByProvenance = new Map<string, string>();
  for (const e of beatIndex?.entries ?? []) {
    if (e.provenanceKey) idByProvenance.set(e.provenanceKey, e.id);
  }
  /** The stored beat this chunk already produced, by provenance or by id. */
  const storedIdFor = (chunk: ClassificationResult["chunk"]): string | undefined => {
    const key = provenanceKeyForChunk(chunk);
    const byProvenance = key ? idByProvenance.get(key) : undefined;
    if (byProvenance) return byProvenance;
    const legacy = beatIdForChunk(chunk);
    return existingBeatIds.has(legacy) ? legacy : undefined;
  };

  // Known-identity roster for per-beat subject attribution — global, because
  // imports routinely involve the whole cast.
  const roster = await buildSubjectRoster(characterName);

  // Narrative position boost: the final 20% of a story carries climax and
  // resolution weight. Computed up front so it can be applied per chunk.
  const totalTurns = chunks.length > 0 ? chunks[chunks.length - 1].turnEnd + 1 : 0;
  const boostThresholdTurn = Math.floor(totalTurns * 0.8);

  const alreadyHave = filtered.filter((c) => storedIdFor(c.chunk)).length;
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
    const beatId = storedIdFor(result.chunk);
    if (!options.forceReanalyze && beatId) {
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

    // r0kc: a forced re-import re-analyses on purpose, but it must land ON the
    // beat this chunk already produced rather than beside it. Only safe when the
    // beat is staying in this bucket — `beatId` was looked up in THIS character's
    // index, and a subject-routed beat is going to a ledger that index cannot
    // speak for.
    const reuseId = beatId && targetKey === characterId ? beatId : undefined;
    const beat = await encodeBeat(targetKey, attributed, analysis, sourceType, options.sourceChatId, undefined, reuseId);
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

  // Durable-fact pass (1dn): identity/lore facts live BELOW the salience
  // threshold that gates beats, so they never become beats. Run over the FULL
  // chunk set (not just `filtered`/salient) so they're captured anyway. Guarded
  // — a fact-pass failure must never fail an import that already saved its beats.
  try {
    await ingestSceneFacts({ characterId, characterName, chunks, roster, sourceChatId: options.sourceChatId });
  } catch (err) {
    console.warn("[ME:pipeline] scene-fact pass failed:", err);
  }

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
