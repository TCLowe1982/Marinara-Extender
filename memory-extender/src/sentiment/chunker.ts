// Stage 0: Chunking
//
// Splits a list of chat messages into dialogue turns, then merges consecutive
// same-speaker turns that are semantically related (high cosine similarity)
// into coherent chunks for the classifier.
//
// Embedding calls go to Ollama (opt-in via MARINARA_EXTENDER_EMBED_MODEL). When
// no embed model is configured, turns are grouped by speaker only — no external
// Marinara Engine sidecar is involved.

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
    // A per-message speaker (set by the client for group chats) labels the whole
    // message; otherwise assistant turns default to the primary character. Inline
    // "Name:" prefixes within the content still override this per line below.
    const rawSpeaker = msg.role === "user" ? "user" : (msg.speaker?.trim() || characterName);
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

// ── Embeddings via Ollama ─────────────────────────────────────────────────────
// Semantic merging is opt-in: set MARINARA_EXTENDER_EMBED_MODEL to an Ollama
// embedding model (e.g. "nomic-embed-text", after `ollama pull nomic-embed-text").
// When unset, fetchEmbeddings returns null and chunkMessages falls back to
// speaker-turn grouping — no Marinara Engine sidecar involved.

type EmbeddingResponse = {
  data: Array<{ embedding: number[]; index?: number }>;
};

async function fetchEmbeddings(texts: string[]): Promise<number[][] | null> {
  const base = (process.env.MARINARA_EXTENDER_LOCAL_URL ?? "").replace(/\/$/, "");
  const model = process.env.MARINARA_EXTENDER_EMBED_MODEL;
  if (!base || !model) return null; // embeddings opt-in; otherwise turn-only grouping

  try {
    const res = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as EmbeddingResponse;
    if (!Array.isArray(json.data) || json.data.length !== texts.length) return null;

    // Ollama returns items in input order; sort by index only when present.
    const ordered = json.data.every((d) => typeof d.index === "number")
      ? [...json.data].sort((a, b) => a.index! - b.index!)
      : json.data;
    return ordered.map((d) => d.embedding);
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

  // Semantic merging via Ollama embeddings (opt-in via MARINARA_EXTENDER_EMBED_MODEL).
  const embeddings = await fetchEmbeddings(turns.map((t) => t.text));

  if (embeddings && embeddings.length === turns.length) {
    return mergeByEmbedding(turns, embeddings, cfg.merge_threshold, cfg.max_turns_per_chunk);
  }

  // Embeddings unavailable — honor the config flag for callers that require them.
  if (!cfg.fallback_on_sidecar_unavailable) {
    throw new Error(
      "Chunker: embeddings unavailable and fallback_on_sidecar_unavailable is false. Set MARINARA_EXTENDER_EMBED_MODEL or enable the fallback.",
    );
  }

  // Only warn when embeddings were actually attempted (a model is configured);
  // otherwise turn-only grouping is the intended default, silently.
  if (process.env.MARINARA_EXTENDER_EMBED_MODEL) {
    console.warn("[chunker] embeddings unavailable (is the embed model pulled in Ollama?) — using speaker-turn grouping.");
  }
  return mergeByTurnOnly(turns, cfg.max_turns_per_chunk);
}
