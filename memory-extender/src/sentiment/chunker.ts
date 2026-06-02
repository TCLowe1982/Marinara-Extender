// Stage 0: Chunking
//
// Splits a list of chat messages into dialogue turns, then merges consecutive
// same-speaker turns that are semantically related (high cosine similarity)
// into coherent chunks for the classifier.
//
// Embedding calls go to the Marinara Engine sidecar. If the sidecar is
// unavailable and fallback is enabled, turns are grouped by speaker only.

import type { DigestMessage } from "../digest.js";
import type { Chunk, DialogueTurn } from "./types.js";
import { loadSentimentConfig } from "./config.js";

// ── Turn detection ────────────────────────────────────────────────────────────

// Matches lines like "Name: text" or "Name (context): text"
const SPEAKER_PREFIX_RE = /^([A-Za-z][A-Za-z0-9 _'-]{0,40})(?:\s*\([^)]*\))?\s*:\s*/;

// Narration blocks delimited by asterisks: *does something*
const NARRATION_RE = /^\*[^*]+\*$/;

export function parseTurns(messages: DigestMessage[], characterName: string): DialogueTurn[] {
  const turns: DialogueTurn[] = [];
  let index = 0;

  for (const msg of messages) {
    const rawSpeaker = msg.role === "user" ? "user" : characterName;
    const content = msg.content.trim();
    if (!content) continue;

    // A single message can contain multiple speaker lines (common in roleplay).
    // Split on newlines and re-detect speaker prefixes within the content.
    const lines = content.split(/\n+/).map((l) => l.trim()).filter(Boolean);

    let currentSpeaker = rawSpeaker;
    let buffer: string[] = [];

    const flush = () => {
      const text = buffer.join(" ").trim();
      if (text) {
        turns.push({ speaker: currentSpeaker, text, turnIndex: index++ });
      }
      buffer = [];
    };

    for (const line of lines) {
      const prefixMatch = SPEAKER_PREFIX_RE.exec(line);
      if (prefixMatch) {
        // Line starts a new speaker — flush what we have, then start fresh.
        flush();
        currentSpeaker = prefixMatch[1]!.trim();
        buffer.push(line.slice(prefixMatch[0].length).trim());
      } else if (NARRATION_RE.test(line)) {
        flush();
        // "Narrator" (capital) is the single canonical label across the chunker
        // and story parser, so the pipeline's povCharacter relabel matches both.
        turns.push({ speaker: "Narrator", text: line, turnIndex: index++ });
      } else {
        buffer.push(line);
      }
    }
    flush();
  }

  return turns;
}

// ── Embeddings via Marinara sidecar ──────────────────────────────────────────

type EmbeddingResponse = {
  data: Array<{ embedding: number[]; index: number }>;
};

async function fetchEmbeddings(texts: string[]): Promise<number[][] | null> {
  const engineUrl = (process.env.MARINARA_ENGINE_URL ?? "http://localhost:7860").replace(/\/$/, "");

  try {
    const res = await fetch(`${engineUrl}/api/sidecar/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: texts }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as EmbeddingResponse;
    if (!Array.isArray(json.data)) return null;

    // Return in original order.
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  } catch {
    return null;
  }
}

// ── Cosine similarity ─────────────────────────────────────────────────────────

export function cosine(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Merge turns into chunks ───────────────────────────────────────────────────

function mergeByEmbedding(
  turns: DialogueTurn[],
  embeddings: number[][],
  threshold: number,
  maxTurns: number,
): Chunk[] {
  if (turns.length === 0) return [];

  const chunks: Chunk[] = [];
  let groupStart = 0;
  let groupSpeaker = turns[0]!.speaker;
  let groupTexts = [turns[0]!.text];
  let groupCount = 1;

  const finalize = (endIndex: number) => {
    chunks.push({
      speaker: groupSpeaker,
      text: groupTexts.join(" "),
      turnStart: turns[groupStart]!.turnIndex,
      turnEnd: turns[endIndex]!.turnIndex,
    });
  };

  for (let i = 1; i < turns.length; i++) {
    const turn = turns[i]!;
    const prevEmbed = embeddings[i - 1]!;
    const currEmbed = embeddings[i]!;
    const sim = cosine(prevEmbed, currEmbed);

    const sameSpeaker = turn.speaker === groupSpeaker;
    const similar = sim >= threshold;
    const withinLimit = groupCount < maxTurns;

    if (sameSpeaker && similar && withinLimit) {
      groupTexts.push(turn.text);
      groupCount++;
    } else {
      finalize(i - 1);
      groupStart = i;
      groupSpeaker = turn.speaker;
      groupTexts = [turn.text];
      groupCount = 1;
    }
  }

  finalize(turns.length - 1);
  return chunks;
}

export function mergeByTurnOnly(turns: DialogueTurn[], maxTurns = 6): Chunk[] {
  if (turns.length === 0) return [];

  const chunks: Chunk[] = [];
  let groupStart = 0;
  let groupSpeaker = turns[0]!.speaker;
  let groupTexts = [turns[0]!.text];
  let groupCount = 1;

  const finalize = (endIndex: number) => {
    chunks.push({
      speaker: groupSpeaker,
      text: groupTexts.join(" "),
      turnStart: turns[groupStart]!.turnIndex,
      turnEnd: turns[endIndex]!.turnIndex,
    });
  };

  for (let i = 1; i < turns.length; i++) {
    const turn = turns[i]!;
    if (turn.speaker === groupSpeaker && groupCount < maxTurns) {
      groupTexts.push(turn.text);
      groupCount++;
    } else {
      finalize(i - 1);
      groupStart = i;
      groupSpeaker = turn.speaker;
      groupTexts = [turn.text];
      groupCount = 1;
    }
  }

  finalize(turns.length - 1);
  return chunks;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function chunkMessages(
  messages: DigestMessage[],
  characterName: string,
): Promise<Chunk[]> {
  const cfg = loadSentimentConfig().chunking;
  const turns = parseTurns(messages, characterName);

  if (turns.length === 0) return [];

  // Try semantic merging via embeddings.
  const embeddings = await fetchEmbeddings(turns.map((t) => t.text));

  if (embeddings && embeddings.length === turns.length) {
    return mergeByEmbedding(turns, embeddings, cfg.merge_threshold, cfg.max_turns_per_chunk);
  }

  // Sidecar unavailable.
  if (!cfg.fallback_on_sidecar_unavailable) {
    throw new Error(
      "Chunker: Marinara sidecar is unavailable and fallback_on_sidecar_unavailable is false.",
    );
  }

  console.warn("[chunker] Sidecar unavailable — falling back to speaker-turn grouping only.");
  return mergeByTurnOnly(turns, cfg.max_turns_per_chunk);
}
