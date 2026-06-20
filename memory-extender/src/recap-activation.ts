// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Recap activation (cz3 Stage 2). Stage 1 surfaced recaps by LEXICAL relevance on
// their terse "[scene recap] <label>" summary, so an arc only appeared when the
// conversation happened to share label words. Stage 2 activates by MEANING: embed
// each recap's prose once — cached lazily, self-healing, so only recaps actually
// encountered ever pay the cost — and surface those closest to the recent
// conversation by cosine. Returns nothing when embeddings are disabled, so the
// loader's lexical pass (Stage 1) still governs.

import { join } from "node:path";
import { getDataDir, assertSafeId, readYamlFile, mutateYamlFile, readEntry } from "./storage.js";
import { fetchEmbeddings, cosineSim } from "./embeddings.js";

// Cosine floor for "this recap is about the current moment". A short query vs a
// prose recap sits lower than two like-sized texts, so this is permissive — the
// real cap on context bloat is MAX_ACTIVATED. Env-overridable for tuning.
const ACTIVATION_TAU = (() => {
  const v = parseFloat(process.env.MARINARA_EXTENDER_RECAP_TAU ?? "");
  return Number.isFinite(v) ? v : 0.5;
})();
const MAX_ACTIVATED = 3; // most recaps surfaced by activation per turn

interface RecapEmbedCache { vectors: Record<string, number[]> }

function cachePath(identityKey: string): string {
  assertSafeId(identityKey);
  return join(getDataDir(), "characters", identityKey, "recap-embeddings.yaml");
}

// Returns the ids of recaps whose prose is semantically closest to recentText
// (beyond lexical label overlap). `recaps` are the candidate rows the caller
// wants considered (typically the recaps the lexical pass did NOT already pick).
export async function activateRecaps(
  identityKey: string,
  recaps: Array<{ id: string; path: string }>,
  recentText: string,
): Promise<Set<string>> {
  if (!recentText.trim() || recaps.length === 0) return new Set();

  const cache = (await readYamlFile<RecapEmbedCache>(cachePath(identityKey))) ?? { vectors: {} };

  // Lazy backfill: embed (one batch) only the recaps not yet cached.
  const missing = recaps.filter((r) => !cache.vectors[r.id]);
  if (missing.length > 0) {
    const contents = await Promise.all(missing.map(async (r) => {
      const e = await readEntry("character", identityKey, r.path).catch(() => null);
      return (e?.content?.trim() || e?.summary || "").slice(0, 2000);
    }));
    const vecs = await fetchEmbeddings(contents);
    if (!vecs) return new Set(); // embeddings off/unavailable → lexical fallback
    await mutateYamlFile<RecapEmbedCache>(cachePath(identityKey), () => ({ vectors: {} }), (c) => {
      missing.forEach((r, i) => { if (vecs[i]) c.vectors[r.id] = vecs[i]!; });
    });
    missing.forEach((r, i) => { if (vecs[i]) cache.vectors[r.id] = vecs[i]!; });
  }

  const queryVec = (await fetchEmbeddings([recentText]))?.[0];
  if (!queryVec) return new Set();

  const activated = recaps
    .map((r) => ({ id: r.id, score: cache.vectors[r.id] ? cosineSim(queryVec, cache.vectors[r.id]!) : 0 }))
    .filter((s) => s.score >= ACTIVATION_TAU)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ACTIVATED);

  return new Set(activated.map((s) => s.id));
}
