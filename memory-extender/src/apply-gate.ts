// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Confidence + domain gate for automated reconciliation apply (MarinaraExtender-mjp).
//
// A TWO-STAGE gate, in this order (the second stage never overrides the first):
//   1. DOMAIN-SENSITIVE flags — a curator verdict touching a sensitive domain
//      (trauma first) ALWAYS holds for human review, regardless of confidence.
//      Rationale (the M13 case): a wrong merge on a trauma memory is asymmetric —
//      it can permanently erase a lead the system was trying to surface, while a
//      right merge saves only a near-dup row. When the downside is unrecoverable
//      and the upside ~0, never auto-apply, no matter how confident.
//   2. CONFIDENCE — for everything else, `high` auto-applies; `medium`/`low`/
//      unknown hold for review.
//
// "hold" never means "drop" — held items are recorded (with reasons) to the
// review lane for a human to confirm or discard. Auto only ever fires on a
// non-sensitive, high-confidence verdict.

// Trauma lexicon — deliberately TIGHT. It must catch genuinely sensitive content
// (the M13 PTSD/flashback pair) WITHOUT flooding the hold lane: broad military
// terms (war/combat/veteran/death) are pervasive in some ledgers and are NOT
// listed, or every Samara fact would hold. Extend per new domain, conservatively.
const TRAUMA_TERMS = [
  "ptsd", "trauma", "traumatic", "traumatized",
  "abuse", "abused", "abusive",
  "assault", "assaulted",
  "rape", "raped", "molest", "molested", "incest", "csa",
  "suicide", "suicidal", "self-harm", "self harm", "overdose",
  "flashback", "flashbacks", "grief", "grieving", "bereaved",
];
const TRAUMA_RE = new RegExp(`\\b(${TRAUMA_TERMS.join("|")})\\b`, "i");

// Domain-sensitivity flags for a blob of text (summaries + content of the items a
// verdict would act on). Returns the matched domains (currently just "trauma").
export function domainFlags(text: string): string[] {
  return TRAUMA_RE.test(text ?? "") ? ["trauma"] : [];
}

export type GateLane = "auto" | "hold";
export interface GateResult { lane: GateLane; reasons: string[] }

// The gate. `text` is everything the verdict touches (e.g. canonical + redundant
// summaries/content, or the candidate + colliding entry); `confidence` is the
// curator's self-reported certainty.
export function applyGate(input: { confidence?: string; text: string }): GateResult {
  const reasons: string[] = [];
  const flags = domainFlags(input.text);
  for (const f of flags) reasons.push(`domain:${f}`);
  if (input.confidence !== "high") reasons.push(`confidence:${input.confidence ?? "unknown"}`);

  // auto ONLY when no domain flag AND high confidence; otherwise hold.
  const lane: GateLane = flags.length === 0 && input.confidence === "high" ? "auto" : "hold";
  return { lane, reasons };
}
