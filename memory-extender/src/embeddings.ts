// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Shared Ollama embeddings (MarinaraExtender-d6d packaging).
//
// DEFAULT-ON with an env kill switch, per the project's ergonomic posture:
// opt-in capability flags cause silent degradation — the median user gets
// restricted results that look fine because they have nothing to compare to.
// The model defaults to nomic-embed-text (a 274MB one-time `ollama pull`);
// set MARINARA_EXTENDER_EMBED_MODEL=0 (or "off") to disable embeddings
// entirely, or set it to any other Ollama embedding model to swap.
//
// Consumers: sentiment/chunker.ts (semantic chunk merging) and
// arc-promotion.ts (the kNN candidate generator for through-line arcs).
// All failures degrade gracefully to null — callers fall back to their
// non-embedding behavior.

import { localUrl } from "./llm-config.js";

export const DEFAULT_EMBED_MODEL = "nomic-embed-text";

export function embedModel(): string | null {
  const v = process.env.MARINARA_EXTENDER_EMBED_MODEL?.trim();
  if (v === "0" || v?.toLowerCase() === "off") return null; // kill switch
  return v || DEFAULT_EMBED_MODEL;                           // default ON
}

type EmbeddingResponse = {
  data: Array<{ embedding: number[]; index?: number }>;
};

// Ollama falls over on oversized embedding batches (measured live: 256 texts
// OK, 800 → 400 with its internal tokenize subprocess dying), so requests are
// chunked. All-or-null contract preserved: any failed sub-batch fails the lot,
// because callers align embeddings[i] with texts[i].
const EMBED_BATCH_SIZE = 64;

export async function fetchEmbeddings(texts: string[]): Promise<number[][] | null> {
  const base = localUrl();
  const model = embedModel();
  if (!base || !model || texts.length === 0) return null;

  const out: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
    try {
      const res = await fetch(`${base}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: batch }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return null;

      const json = (await res.json()) as EmbeddingResponse;
      if (!Array.isArray(json.data) || json.data.length !== batch.length) return null;

      const ordered = json.data.every((d) => typeof d.index === "number")
        ? [...json.data].sort((a, b) => a.index! - b.index!)
        : json.data;
      out.push(...ordered.map((d) => d.embedding));
    } catch {
      return null;
    }
  }
  return out;
}

// First-boot/diagnostic probe (TC review feedback): "semantic features feel
// different" is undiagnosable from the outside, so the sidecar says exactly
// why embeddings are off and what one command fixes it. Distinguishes the
// three states a user can actually act on.
export type EmbeddingsStatus = "ok" | "model_missing" | "ollama_down" | "disabled";

export async function embeddingsStatus(): Promise<EmbeddingsStatus> {
  const model = embedModel();
  if (!model) return "disabled";
  const root = localUrl().replace(/\/v1\/?$/, "");
  try {
    const res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) return "ollama_down";
    const json = (await res.json()) as { models?: Array<{ name?: string }> };
    const have = (json.models ?? []).some((m) => (m.name ?? "").split(":")[0] === model.split(":")[0]);
    return have ? "ok" : "model_missing";
  } catch {
    return "ollama_down";
  }
}

export function describeEmbeddingsStatus(status: EmbeddingsStatus): string {
  const model = embedModel() ?? DEFAULT_EMBED_MODEL;
  switch (status) {
    case "ok":            return `on (${model})`;
    case "disabled":      return "off (disabled via MARINARA_EXTENDER_EMBED_MODEL)";
    case "ollama_down":   return "UNAVAILABLE — Ollama is not running. Semantic features (arc clustering, chunk merging) are disabled until it starts.";
    case "model_missing": return `MODEL MISSING — semantic features disabled. Enable with:  ollama pull ${model}`;
  }
}

export function cosineSim(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export function meanVector(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dims = vectors[0]!.length;
  const out = new Array<number>(dims).fill(0);
  for (const v of vectors) for (let i = 0; i < dims; i++) out[i]! += v[i] ?? 0;
  for (let i = 0; i < dims; i++) out[i]! /= vectors.length;
  return out;
}
