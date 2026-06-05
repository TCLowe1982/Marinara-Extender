// Stage 2: Deep Sentiment Analysis
//
// For each ClassificationResult that passes the salience threshold, calls the
// local Ollama model with an emotion-specific system prompt to extract
// structured BeatAnalysis JSON. Falls back to the external API if Ollama is
// unavailable.
//
// Each emotion has its own system prompt tuned to ask the right questions.
// Dysregulation is the most complex: it identifies which sub-pattern is
// driving the behavior and focuses on what's underneath the surface behavior.
//
// Context window: each chunk is analyzed with the preceding and following
// chunks visible so the model understands tone-vs-intent and conversational
// register rather than reading lines in isolation.

import { getCachedAuth } from "../auth-cache.js";
import { fetchWithBackoff } from "../http.js";
import { localUrl, localEnabled, localModel, externalUpstream, externalModel } from "../llm-config.js";
import type { BeatAnalysis, ClassificationResult, Emotion, EmotionWeight } from "./types.js";

// ── JSON extraction (handles markdown-fenced responses) ────────────────────

function parseEmotions(raw: unknown): EmotionWeight[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const result: EmotionWeight[] = [];
  for (const item of raw) {
    if (typeof item === "object" && item !== null &&
        typeof (item as Record<string, unknown>).emotion === "string" &&
        typeof (item as Record<string, unknown>).weight === "number") {
      result.push({
        emotion: (item as { emotion: Emotion; weight: number }).emotion,
        weight:  (item as { emotion: Emotion; weight: number }).weight,
      });
    }
  }
  return result.length > 0 ? result : undefined;
}

function parseAnalysisJson(raw: string): BeatAnalysis | null {
  const attempts = [
    raw.trim(),
    raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? "",
  ];

  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      const parsed = JSON.parse(attempt) as Record<string, unknown>;
      if (typeof parsed.motivation !== "string") continue;
      if (typeof parsed.relational_dynamics !== "string") continue;
      if (typeof parsed.outcome !== "string") continue;
      return {
        motivation:        parsed.motivation.trim(),
        relationalDynamics: parsed.relational_dynamics.trim(),
        outcome:           parsed.outcome.trim(),
        subpattern:        typeof parsed.subpattern === "string" ? parsed.subpattern : undefined,
        emotions:          parseEmotions(parsed.emotions),
        subtext:           typeof parsed.subtext === "string" && parsed.subtext.trim()
                             ? parsed.subtext.trim() : undefined,
        salience:          typeof parsed.salience === "number"
                             ? Math.min(1, Math.max(0, parsed.salience))
                             : 0.5,
      };
    } catch {
      // try next
    }
  }
  return null;
}

// ── Local model (Ollama or any OpenAI-compatible local server) ────────────

async function callLocal(systemPrompt: string, userPrompt: string): Promise<string | null> {
  if (!localEnabled()) return null;  // explicitly disabled — skip
  const base = localUrl();
  const model = localModel();

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt },
        ],
        temperature: 0.2,
        stream: false,
        response_format: { type: "json_object" }, // force JSON; avoid prose fallback
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json?.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

// ── External API fallback ─────────────────────────────────────────────────

async function callExternal(systemPrompt: string, userPrompt: string): Promise<string> {
  const auth = getCachedAuth();
  if (!auth) {
    throw new Error(
      "Analyzer: local Ollama model unavailable and no API key set. Run Ollama (MARINARA_EXTENDER_LOCAL_URL/LOCAL_MODEL) or set MARINARA_EXTENDER_API_KEY.",
    );
  }
  const upstream = externalUpstream();
  const model = externalModel();

  const res = await fetchWithBackoff(`${upstream}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 600,
    }),
  });
  if (!res.ok) throw new Error(`Analyzer external API failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json?.choices?.[0]?.message?.content ?? "";
}

async function callLlm(systemPrompt: string, userPrompt: string): Promise<string> {
  const local = await callLocal(systemPrompt, userPrompt);
  if (local !== null) return local;
  // No per-chunk warn here — it would break the progress bar; the pipeline's
  // progress reporter surfaces per-chunk status instead.
  return callExternal(systemPrompt, userPrompt);
}

// ── System prompts ─────────────────────────────────────────────────────────
// Each prompt is tuned to extract the most meaningful signal for that emotion.
// All prompts request a compound emotions array and an optional subtext field.

const EMOTIONS_FORMAT = `[{"emotion":"<primary>","weight":0.0},{"emotion":"<secondary>","weight":0.0}]`;

const SUBTEXT_INSTRUCTION = `
- subtext: If this chunk contains sexual or physically intimate content, analyze the EMOTIONAL FUNCTION of that content — what is it doing beyond arousal? Consider: trust-building, vulnerability, power exchange, marking/claiming, first-time significance, comfort-seeking, validation, grief, or avoidance. If no sexual/intimate content is present, omit this field or set it to null.`.trim();

const SHARED_RULES = `
Rules:
- Analyze the chunk marked "ANALYZE THIS" only. Context blocks are provided so you understand conversational register and tone-vs-intent — a line that looks aggressive in isolation may be flirtatious in context, a line that sounds dismissive may be empathetic. Use context to correctly read intent.
- Be specific to the text provided — do not generalize.
- 1–3 sentences per field.
- salience: 0.0 = barely present, 1.0 = defining or pivotal moment.
- emotions: list the 1–3 emotions present, weighted by intensity (weights sum to ~1.0). First entry is the primary emotion.
- Respond with raw JSON only — no explanation, no markdown.`.trim();

const JSON_FORMAT_STANDARD = `{"motivation":"...","relational_dynamics":"...","outcome":"...","emotions":${EMOTIONS_FORMAT},"subtext":null,"salience":0.0}`;
const JSON_FORMAT_WITH_SUBPATTERN = `{"motivation":"...","relational_dynamics":"...","outcome":"...","subpattern":"...","emotions":${EMOTIONS_FORMAT},"subtext":null,"salience":0.0}`;

function fearPrompt(): string {
  return `You are analyzing a moment of fear in a conversation.

Extract the emotional beat as JSON:
- motivation: What is this person actually afraid of? What threat — real or perceived — is activating the fear response? What does this fear protect or preserve?
- relational_dynamics: How is the fear affecting or being shaped by the relationship in this moment? Does it push them toward clinging, fleeing, or freezing?
- outcome: What does this moment of fear signal about what could happen next — in this relationship or within this person?
${SUBTEXT_INSTRUCTION}

${SHARED_RULES}

Format: ${JSON_FORMAT_STANDARD}`;
}

function shamePrompt(): string {
  return `You are analyzing a moment of shame in a conversation.

Extract the emotional beat as JSON:
- motivation: What core belief about the self is being activated? What did this person do, feel, or reveal that triggered shame — and what does that say about their self-image?
- relational_dynamics: How is shame functioning relationally here? Is it causing hiding, withdrawal, self-attack, or a bid for reassurance?
- outcome: What does this shame moment suggest about how this person will behave next — toward themselves or toward others?
${SUBTEXT_INSTRUCTION}

${SHARED_RULES}

Format: ${JSON_FORMAT_STANDARD}`;
}

function hopePrompt(): string {
  return `You are analyzing a moment of hope in a conversation.

Extract the emotional beat as JSON:
- motivation: What is this person hoping for? What does this hope reveal about what they want or need most right now?
- relational_dynamics: How is hope functioning in the relationship — is it building trust, creating vulnerability, or setting up the risk of disappointment?
- outcome: What does this moment of hope suggest about where this person or relationship is heading?
${SUBTEXT_INSTRUCTION}

${SHARED_RULES}

Format: ${JSON_FORMAT_STANDARD}`;
}

function desirePrompt(): string {
  return `You are analyzing a moment of desire or longing in a conversation.

Extract the emotional beat as JSON:
- motivation: What does this person want — and what does that want reveal about what they feel is missing or possible? Is this desire for connection, safety, pleasure, or something else?
- relational_dynamics: How is desire functioning between these people — is it drawing them closer, creating tension, or exposing vulnerability?
- outcome: What does this desire moment suggest about what this person will do or feel next?
${SUBTEXT_INSTRUCTION}

${SHARED_RULES}

Format: ${JSON_FORMAT_STANDARD}`;
}

function reliefPrompt(): string {
  return `You are analyzing a moment of relief in a conversation.

Extract the emotional beat as JSON:
- motivation: What tension, fear, or dread has just released? What had this person been carrying that they can now put down?
- relational_dynamics: How does this relief affect the relationship dynamic — does it create closeness, lower defenses, or reveal how much pressure the person was under?
- outcome: What does this moment of relief open up — for this person or for this relationship?
${SUBTEXT_INSTRUCTION}

${SHARED_RULES}

Format: ${JSON_FORMAT_STANDARD}`;
}

function vulnerabilityPrompt(): string {
  return `You are analyzing a moment of vulnerability in a conversation.

Extract the emotional beat as JSON:
- motivation: What is this person exposing, admitting, or allowing to be seen? What makes this moment an act of courage or risk for them?
- relational_dynamics: How does this vulnerability land in the relationship? Does it invite reciprocity, create intimacy, or risk rejection?
- outcome: What does this moment of openness suggest about where this person or relationship could go from here?
${SUBTEXT_INSTRUCTION}

${SHARED_RULES}

Format: ${JSON_FORMAT_STANDARD}`;
}

function trustPrompt(): string {
  return `You are analyzing a moment involving trust or the breakdown of trust in a conversation.

Extract the emotional beat as JSON:
- motivation: Is trust being offered, tested, confirmed, or broken here? What does this person's relationship with trust reveal about their history or current state?
- relational_dynamics: How is trust functioning between these people — is it deepening the bond, revealing a wound, or exposing a pattern?
- outcome: What does this trust moment predict about what will happen next in this relationship?
${SUBTEXT_INSTRUCTION}

${SHARED_RULES}

Format: ${JSON_FORMAT_STANDARD}`;
}

function angerPrompt(): string {
  return `You are analyzing a moment of anger in a conversation.

Extract the emotional beat as JSON:
- motivation: What is underneath the anger? Anger is usually a secondary emotion — what hurt, fear, or violated need is it protecting? What does this person feel has been taken from them or disrespected?
- relational_dynamics: How is anger functioning between these people — is it creating distance, demanding to be seen, testing limits, or protecting something tender?
- outcome: What does this anger signal about what this person needs, and what might happen if they don't get it?
${SUBTEXT_INSTRUCTION}

${SHARED_RULES}

Format: ${JSON_FORMAT_STANDARD}`;
}

function joyPrompt(): string {
  return `You are analyzing a moment of joy, warmth, or happiness in a conversation.

Extract the emotional beat as JSON:
- motivation: What is generating this joy? What does it reveal about what this person values or has been missing?
- relational_dynamics: How is joy affecting the connection between these people — is it creating intimacy, softening tension, or marking a turning point?
- outcome: What does this moment of joy suggest about the relationship's potential or direction?
${SUBTEXT_INSTRUCTION}

${SHARED_RULES}

Format: ${JSON_FORMAT_STANDARD}`;
}

function dysregulationPrompt(structuralSubpatterns: string[]): string {
  const structuralHint = structuralSubpatterns.length > 0
    ? `\nThe classifier also detected these structural signals in the text: ${structuralSubpatterns.join(", ")}. Weight these in your subpattern assessment.\n`
    : "";

  return `You are analyzing a moment of emotional dysregulation — behavior driven by an unregulated emotional state rather than conscious choice. This applies to anyone in the conversation; dysregulation is not a character flaw, it is a signal of an unmet need.
${structuralHint}
Subpatterns to consider:
- bpd_testing: pushing someone away to test whether they will stay; creating conflict to check if the relationship is safe
- anxious_protest: escalating or intensifying behavior driven by fear of abandonment; reaching for connection through conflict
- avoidant_withdrawal: going cold, shutting down, creating distance when closeness feels dangerous or overwhelming
- dissociation: emotional flatness, one-word responses, grounding language ("ok.", "stay.", "here."), not being fully present
- catastrophizing: spiraling worst-case thinking; small events becoming proof of total disaster or permanent loss
- idealization: seeing someone as all-good, perfect, incapable of disappointing; unable to hold complexity
- devaluation: a sudden shift to seeing someone as all-bad, often following idealization
- emotional_flooding: overwhelm so intense that regulation is impossible; raw, unfiltered expression
- shutdown: complete withdrawal from the interaction; numbness, inability to continue engaging

Extract the emotional beat as JSON:
- motivation: What unmet need, fear, or wound is actually driving this behavior? Look beneath the surface action to what the person is really expressing or asking for.
- relational_dynamics: How is this dysregulation affecting the relationship dynamic right now? What is it asking of the other person?
- outcome: If this pattern continues unaddressed, what happens? What does this person actually need in this moment?
- subpattern: The single best-matching subpattern from the list above (exact key name), or null if none fits clearly.
${SUBTEXT_INSTRUCTION}

${SHARED_RULES}

Format: ${JSON_FORMAT_WITH_SUBPATTERN}`;
}

// ── Prompt dispatcher ──────────────────────────────────────────────────────

function buildSystemPrompt(emotion: Emotion, structuralSubpatterns: string[]): string {
  switch (emotion) {
    case "fear":          return fearPrompt();
    case "shame":         return shamePrompt();
    case "hope":          return hopePrompt();
    case "desire":        return desirePrompt();
    case "relief":        return reliefPrompt();
    case "vulnerability": return vulnerabilityPrompt();
    case "trust":         return trustPrompt();
    case "anger":         return angerPrompt();
    case "joy":           return joyPrompt();
    case "dysregulation": return dysregulationPrompt(structuralSubpatterns);
  }
}

// ── Context window ─────────────────────────────────────────────────────────

export interface AnalysisContext {
  before?: ClassificationResult;
  after?: ClassificationResult;
}

function buildUserPrompt(result: ClassificationResult, context?: AnalysisContext): string {
  const { chunk, scores, primaryEmotion, salience, structuralMatches } = result;

  const scoreLines = Object.entries(scores)
    .sort(([, a], [, b]) => b - a)
    .map(([e, s]) => `  ${e}: ${s.toFixed(2)}`)
    .join("\n");

  const structuralLines = structuralMatches.length > 0
    ? `\nStructural signals detected: ${structuralMatches.map(m => m.patternId).join(", ")}`
    : "";

  const beforeBlock = context?.before
    ? `Preceding context (${context.before.chunk.speaker} — for tone/intent reference only):
"""
${context.before.chunk.text.slice(0, 400)}${context.before.chunk.text.length > 400 ? "…" : ""}
"""

`
    : "";

  const afterBlock = context?.after
    ? `
Following context (${context.after.chunk.speaker} — for tone/intent reference only):
"""
${context.after.chunk.text.slice(0, 400)}${context.after.chunk.text.length > 400 ? "…" : ""}
"""`
    : "";

  return `${beforeBlock}ANALYZE THIS — Speaker: ${chunk.speaker}
Primary emotion detected: ${primaryEmotion ?? "unknown"} (salience ${salience.toFixed(2)})
All emotion scores:
${scoreLines}${structuralLines}

Dialogue chunk:
"""
${chunk.text}
"""
${afterBlock}

Analyze the emotional beat in the chunk marked "ANALYZE THIS".`;
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function analyzeChunk(
  result: ClassificationResult,
  context?: AnalysisContext,
): Promise<BeatAnalysis | null> {
  if (!result.passesThreshold || !result.primaryEmotion) return null;

  const structuralSubpatterns = result.structuralMatches
    .map((m) => m.subpattern)
    .filter((s): s is string => Boolean(s));

  const systemPrompt = buildSystemPrompt(result.primaryEmotion, structuralSubpatterns);
  const userPrompt   = buildUserPrompt(result, context);

  const raw = await callLlm(systemPrompt, userPrompt);
  return parseAnalysisJson(raw);
}

export interface AnalyzedBeat {
  result:   ClassificationResult;
  analysis: BeatAnalysis;
}

// `targets` are the chunks to analyze (passing + speaker-filtered). `allChunks`
// is the full ordered classification list used purely for context — so the
// "preceding/following" blocks shown to the model are the TRUE adjacent chunks
// in the conversation, not the nearest other high-salience beat (which could be
// many turns away). Defaults to `targets` if not supplied.
// `onItem` (optional) is called after each chunk is processed — current is the
// 1-based index, total the count being analyzed, and reason is set only when the
// chunk failed (used by the story-import progress reporter).
export async function analyzeChunks(
  targets: ClassificationResult[],
  allChunks?: ClassificationResult[],
  onItem?: (current: number, total: number, reason?: string) => void,
  signal?: AbortSignal,
): Promise<AnalyzedBeat[]> {
  const context = allChunks ?? targets;
  const passing = targets.filter((r) => r.passesThreshold && r.primaryEmotion);
  const total = passing.length;
  const output: AnalyzedBeat[] = [];

  let i = 0;
  for (const result of passing) {
    if (signal?.aborted) break; // cancelled — stop analyzing, keep what we have
    i++;
    const idx = context.indexOf(result);
    try {
      const analysis = await analyzeChunk(result, idx === -1 ? undefined : {
        before: context[idx - 1],
        after:  context[idx + 1],
      });
      if (analysis) {
        output.push({ result, analysis });
        onItem?.(i, total);
      } else {
        onItem?.(i, total, "model returned no parseable analysis");
      }
    } catch (err) {
      onItem?.(i, total, err instanceof Error ? err.message : String(err));
    }
  }

  return output;
}
