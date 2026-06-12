// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Through-line arc renderer — the ceiling tier's ONE expensive call
// (MarinaraExtender-ajb). Given a candidate cluster of beats (plus the arc's
// prior recap when extending), a single LLM round-trip does three jobs:
//   1. CONFIRM membership (the causal/topical check from the binding-signal
//      stack — members it rejects don't join the arc);
//   2. LABEL the arc (re-renderable; the id is permanent);
//   3. RENDER the lane-aware recap (character_topics = trajectory/path —
//      lead is the current emotional state, body is the path that got there,
//      with dormancy gaps narrated as part of the arc).
//
// Local model first, external API fallback — same posture as the analyzer.

import { getCachedAuth } from "./auth-cache.js";
import { fetchWithBackoff } from "./http.js";
import { localUrl, localEnabled, localModel, externalUpstream, externalModel } from "./llm-config.js";

export interface RenderBeat {
  beatId: string;
  date: string;       // beat.created
  summary: string;    // "[emotion] motivation" line
}

export interface RenderInput {
  characterName: string;
  priorLabel?: string;     // existing arc label when extending
  priorRecap?: string;     // existing recap body when extending (accrete, don't restart)
  beats: RenderBeat[];     // ordered by seq — existing members first, then candidates
  candidateIds: string[];  // the beats the model must confirm or reject
  gaps?: Array<{ from: string; to: string }>; // dormancy gaps — renderer INPUT, not metadata
}

export interface RenderResult {
  label: string;
  lead: string;            // current state — the recap entry's summary line
  body: string;            // the trajectory — the recap entry's content
  members: Array<{ beatId: string; role: string; keep: boolean }>;
}

const SYSTEM_PROMPT = `You maintain a character's long-term narrative memory. You are given dated emotional beats that may form one THROUGH-LINE ARC — a named storyline spanning scenes (e.g. "Priya-as-co-experimenter").

Your three jobs, returned as one JSON object:
1. CONFIRM: for each CANDIDATE beat, decide keep=true only if it genuinely belongs to this arc (causally or thematically continuous with the others). Reject coincidental overlaps.
2. LABEL: a short possessive-style name for the arc (re-render freely; 2–6 words; name the through-line, not the cast).
3. RENDER the recap as a TRAJECTORY: "lead" = the current emotional state of the arc in 1–2 sentences; "body" = the path that got there, in order, 4–10 sentences, dated where it matters. If gaps are provided, narrate them ("went quiet for three weeks, reopened when…") — the silence is part of the arc. If a prior recap is provided, EXTEND its story with the new beats; do not restart it.
4. For each kept beat, assign a role: turning_point | escalation | threshold_crossing | recurrence | setup | minor.

Return raw JSON only:
{"label":"...","lead":"...","body":"...","members":[{"beatId":"...","role":"...","keep":true}]}`;

function buildUserPrompt(input: RenderInput): string {
  const gapLines = (input.gaps ?? [])
    .map((g) => `  quiet from ${g.from.slice(0, 10)} to ${g.to.slice(0, 10)}`)
    .join("\n");
  const beatLines = input.beats
    .map((b) => `  [${b.date}] (${input.candidateIds.includes(b.beatId) ? "CANDIDATE" : "member"}) ${b.beatId}: ${b.summary}`)
    .join("\n");
  return [
    `Character: ${input.characterName}`,
    input.priorLabel ? `Existing arc: "${input.priorLabel}"` : "New arc (no prior recap).",
    input.priorRecap ? `Prior recap:\n${input.priorRecap}` : "",
    gapLines ? `Dormancy gaps:\n${gapLines}` : "",
    `Beats (in order):\n${beatLines}`,
  ].filter(Boolean).join("\n\n");
}

async function callLocal(system: string, user: string): Promise<string | null> {
  if (!localEnabled()) return null;
  try {
    const res = await fetch(`${localUrl()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: localModel(),
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: 0.3,
        stream: false,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json?.choices?.[0]?.message?.content ?? null;
  } catch { return null; }
}

async function callExternal(system: string, user: string): Promise<string | null> {
  const auth = getCachedAuth();
  if (!auth) return null;
  try {
    const res = await fetchWithBackoff(`${externalUpstream()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        model: externalModel(),
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: 0.3,
        max_tokens: 1200,
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json?.choices?.[0]?.message?.content ?? null;
  } catch { return null; }
}

function parseRender(raw: string | null): RenderResult | null {
  if (!raw) return null;
  const attempts = [raw.trim(), raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? ""];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      const p = JSON.parse(attempt) as Record<string, unknown>;
      if (typeof p.label !== "string" || typeof p.body !== "string") continue;
      const members = Array.isArray(p.members)
        ? (p.members as Array<Record<string, unknown>>)
            .filter((m) => typeof m?.beatId === "string")
            .map((m) => ({
              beatId: String(m.beatId),
              role: typeof m.role === "string" && m.role.trim() ? m.role.trim() : "minor",
              keep: m.keep !== false,
            }))
        : [];
      return {
        label: p.label.trim().slice(0, 80),
        lead: typeof p.lead === "string" ? p.lead.trim() : p.body.slice(0, 140),
        body: p.body.trim(),
        members,
      };
    } catch { /* try next */ }
  }
  return null;
}

export type ArcRenderFn = (input: RenderInput) => Promise<RenderResult | null>;

export const renderArc: ArcRenderFn = async (input) => {
  const user = buildUserPrompt(input);
  const local = await callLocal(SYSTEM_PROMPT, user);
  const parsed = parseRender(local);
  if (parsed) return parsed;
  return parseRender(await callExternal(SYSTEM_PROMPT, user));
};
