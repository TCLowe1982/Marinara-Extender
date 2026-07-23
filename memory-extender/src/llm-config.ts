// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// LLM provider configuration — single source of truth for endpoint/model
// defaults, so a fresh install works with no .env in the common case.
//
// Local inference is the primary path and talks the OpenAI protocol against an
// OpenAI-compatible base URL (Ollama by default; any compatible server works —
// see the v1.1 multi-provider issue). The external API is an optional fallback.
//
// Resolution: an UNSET local URL falls back to the Ollama default (so local
// works out of the box); an explicitly EMPTY MARINARA_EXTENDER_LOCAL_URL= turns
// local off (external only). Read at call time so the loaded .env is respected.

export const DEFAULT_LOCAL_URL = "http://127.0.0.1:11434/v1"; // Ollama's OpenAI-compatible endpoint
// dolphin3:8b is the validated default: the sentiment analyzer classifies adult
// roleplay content, and an alignment-tuned small model (e.g. phi3) refuses or
// moralizes, breaking the pipeline. An uncensored local model is a functional
// requirement for the domain, not a preference.
export const DEFAULT_LOCAL_MODEL = "dolphin3:8b";
export const DEFAULT_EXTERNAL_UPSTREAM = "https://api.openai.com";
export const DEFAULT_EXTERNAL_MODEL = "gpt-4o-mini";

// Local base URL (no trailing slash). Unset → Ollama default; empty → disabled.
export function localUrl(): string {
  const v = process.env.MARINARA_EXTENDER_LOCAL_URL;
  return (v ?? DEFAULT_LOCAL_URL).replace(/\/+$/, "");
}

// Is local inference enabled? (False only when explicitly set empty.)
export function localEnabled(): boolean {
  return localUrl().length > 0;
}

export function localModel(): string {
  return process.env.MARINARA_EXTENDER_LOCAL_MODEL || DEFAULT_LOCAL_MODEL;
}

// External fallback base URL (no trailing slash) + model.
export function externalUpstream(): string {
  return (process.env.MARINARA_EXTENDER_DIGEST_UPSTREAM || DEFAULT_EXTERNAL_UPSTREAM).replace(/\/+$/, "");
}

export function externalModel(): string {
  return process.env.MARINARA_EXTENDER_DIGEST_MODEL || DEFAULT_EXTERNAL_MODEL;
}

// ── Engine-facing inference proxy ─────────────────────────────────────────────
// Where the proxy (proxy.ts) forwards Marinara's chat generations. Distinct
// from the analysis-model config above: that is the sidecar's OWN model for
// memory work, this is the user's real chat provider, and they are usually
// different (a small uncensored local model vs. whatever they roleplay on).
export const DEFAULT_PROXY_UPSTREAM = "https://api.openai.com";

// Base URL with no trailing slash and no trailing /v1 — callers append the full
// /v1/... path. Both "https://host" and "https://host/v1" are accepted because
// users paste whichever form their provider's docs show.
export function proxyUpstream(): string {
  const v = process.env.MARINARA_EXTENDER_PROXY_UPSTREAM || DEFAULT_PROXY_UPSTREAM;
  return v.replace(/\/+$/, "").replace(/\/v1$/, "");
}
