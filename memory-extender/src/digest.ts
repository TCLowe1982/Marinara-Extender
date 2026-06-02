// Digest a batch of chat messages into persistent memory entries.
// Tries the Marinara Engine's local Gemma sidecar first; falls back to an
// external OpenAI-compatible API if the sidecar is unavailable.

import { getCachedAuth } from "./auth-cache.js";
import {
  type Entry,
  type Lane,
  type EntryStatus,
} from "./storage.js";
import { createEntryIfUnique } from "./dedup.js";

// ── Config ────────────────────────────────────────────────────────────────────

const MAX_MESSAGES = 200;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DigestMessage {
  role: string;
  content: string;
}

interface ExtractedEntry {
  lane: Lane;
  summary: string;
  content: string;
  status?: EntryStatus;
}

export interface DigestResult {
  created: number;
  entries: Entry[];
}

// ── Extraction prompt ─────────────────────────────────────────────────────────

function buildSystemPrompt(characterName: string): string {
  return `You are a memory archivist. Extract insights from the chat log and respond ONLY with valid JSON matching the schema below. No commentary, no analysis, no markdown, no prose — JSON only.

SCHEMA:
{"entries":[{"lane":"<lane>","summary":"<summary>","content":"<content>","status":"<status>"}]}

FIELD RULES:
- lane: one of "open_threads" | "user_topics" | "character_topics"
  - open_threads: ongoing tasks, unresolved issues, promises, follow-ups
  - user_topics: subjects the user mentioned repeatedly or clearly cares about
  - character_topics: things ${characterName} would want to remember — emotional moments, lore, callbacks
- summary: ≤80 chars, plain text
- content: 1-3 sentences
- status: only for open_threads — "open" | "in_progress" | "done" | "deferred". Omit for other lanes.

EXAMPLE OUTPUT:
{"entries":[{"lane":"user_topics","summary":"TC is writing a research paper on attachment theory","content":"TC mentioned working on a paper about attachment theory. He is in the editing phase and finds it emotionally difficult."},{"lane":"open_threads","summary":"Follow up on paper submission deadline","content":"TC hasn't mentioned when the paper is due. Worth asking next session.","status":"open"}]}

RULES: Be selective. 3-8 entries typical. Fewer is better. Skip greetings and ephemeral small talk. Output ONLY the JSON object — nothing before or after it.`;
}

function buildUserPrompt(messages: DigestMessage[], characterName: string): string {
  const history = messages
    .slice(-MAX_MESSAGES)
    .map((m) => `${m.role === "user" ? "User" : characterName}: ${m.content}`)
    .join("\n\n");
  return `Analyze this chat history and extract memory entries worth keeping:\n\n${history}`;
}

// ── Local model call (Ollama or any OpenAI-compatible local server) ──────────

async function callLocalLlm(systemPrompt: string, userPrompt: string): Promise<string | null> {
  const base = (process.env.MARINARA_EXTENDER_LOCAL_URL ?? "").replace(/\/$/, "");
  if (!base) return null;
  const model = process.env.MARINARA_EXTENDER_LOCAL_MODEL ?? "phi3:mini";

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
        temperature: 0.3,
        stream: false,
        response_format: { type: "json_object" }, // force JSON; avoid prose fallback
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json?.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

// ── External API call (fallback) ──────────────────────────────────────────────

async function callExternalLlm(systemPrompt: string, userPrompt: string, model: string): Promise<string> {
  const auth = getCachedAuth();
  if (!auth) {
    throw new Error(
      "Local sidecar unavailable and no API key set. Either enable a local model in Marinara Engine → Settings → Local Model, or set MARINARA_EXTENDER_API_KEY in memory-extender/.env.",
    );
  }

  const upstream = (process.env.MARINARA_EXTENDER_DIGEST_UPSTREAM ?? "https://api.openai.com")
    .replace(/\/$/, "");

  const res = await fetch(`${upstream}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": auth,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    }),
  });

  if (!res.ok) {
    throw new Error(`LLM call failed (${res.status}): ${await res.text()}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  return json?.choices?.[0]?.message?.content ?? "";
}

// ── LLM call (local → external fallback) ─────────────────────────────────────

function looksLikeJson(s: string): boolean {
  const t = s.trim();
  return t.startsWith("{") || t.startsWith("[") || t.includes('"entries"');
}

async function callLlm(systemPrompt: string, userPrompt: string, model: string): Promise<string> {
  const local = await callLocalLlm(systemPrompt, userPrompt);
  if (local !== null) {
    if (looksLikeJson(local)) {
      console.log("[digest] local model ok");
      return local;
    }
    console.warn("[digest] local model returned prose instead of JSON — falling back to external API");
  } else if (process.env.MARINARA_EXTENDER_LOCAL_URL) {
    console.log("[digest] local model unavailable — falling back to external API");
  }
  return callExternalLlm(systemPrompt, userPrompt, model);
}

// ── JSON extraction (resilient against prose-wrapped responses) ───────────────

function parseEntriesJson(raw: string, label: string): ExtractedEntry[] {
  const attempts: string[] = [
    // 1. Strip markdown fences and parse whole response
    raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim(),
    // 2. Find first { … } block that contains "entries"
    (() => { const m = raw.match(/\{[\s\S]*?"entries"[\s\S]*\}/); return m?.[0] ?? ""; })(),
    // 3. Find outermost { … } block
    (() => { const s = raw.indexOf("{"); const e = raw.lastIndexOf("}"); return s !== -1 && e > s ? raw.slice(s, e + 1) : ""; })(),
  ];

  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      const parsed = JSON.parse(attempt) as { entries?: unknown[] };
      const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      if (entries.length > 0 || attempt === attempts[0]) return entries as ExtractedEntry[];
    } catch { /* try next */ }
  }

  console.warn(`[digest:${label}] could not parse LLM response as JSON — skipping. Preview: ${raw.slice(0, 120)}`);
  return [];
}

// ── Entry creation ────────────────────────────────────────────────────────────

const VALID_LANES: Lane[] = ["open_threads", "user_topics", "character_topics"];
const VALID_STATUSES: EntryStatus[] = ["open", "in_progress", "done", "deferred"];

// Returns the created Entry, or null if it was a duplicate of an existing one.
async function createEntry(
  characterId: string,
  e: ExtractedEntry,
): Promise<Entry | null> {
  const status: EntryStatus =
    e.lane === "open_threads" && VALID_STATUSES.includes(e.status as EntryStatus)
      ? (e.status as EntryStatus)
      : "open";

  return createEntryIfUnique("character", characterId, {
    lane: e.lane,
    summary: e.summary.trim().slice(0, 200),
    content: e.content ?? "",
    status,
  });
}

// ── Snapshot prompt (session summary — different framing from full import) ────

function buildSnapshotSystemPrompt(characterName: string): string {
  return `You are capturing a session memory snapshot. Focus ONLY on what was actively happening in these recent messages — not a full archive. Respond ONLY with valid JSON matching the schema below. No commentary, no analysis, no markdown, no prose — JSON only.

SCHEMA:
{"entries":[{"lane":"<lane>","summary":"<summary>","content":"<content>","status":"<status>"}]}

FIELD RULES:
- lane: one of "open_threads" | "user_topics" | "character_topics"
  - open_threads: work in progress right now, things promised or left unresolved
  - user_topics: facts or preferences the user revealed this session
  - character_topics: emotional moments, lore, things ${characterName} should carry forward
- summary: ≤80 chars, plain text
- content: 1-3 sentences
- status: only for open_threads — "open" | "in_progress" | "done" | "deferred". Omit for other lanes.

EXAMPLE OUTPUT:
{"entries":[{"lane":"character_topics","summary":"Shared a quiet moment after the conference talk","content":"TC and ${characterName} stepped outside after the panel. The conversation shifted from professional to personal — he admitted he was nervous about the reception."},{"lane":"open_threads","summary":"TC mentioned wanting to revisit the ethics section","content":"He flagged the ethics section as needing another pass but they moved on. Worth returning to.","status":"open"}]}

RULES: 2-6 entries. Only what genuinely matters from this window. Skip filler, greetings, routine exchanges. Output ONLY the JSON object — nothing before or after it.`;
}

function buildSnapshotUserPrompt(messages: DigestMessage[], characterName: string): string {
  const history = messages
    .map((m) => `${m.role === "user" ? "User" : characterName}: ${m.content}`)
    .join("\n\n");
  return `Capture a memory snapshot of this session window:\n\n${history}`;
}

export async function snapshotSession(
  messages: DigestMessage[],
  characterId: string,
  characterName: string,
): Promise<DigestResult> {
  const model = process.env.MARINARA_EXTENDER_DIGEST_MODEL ?? "gpt-4o-mini";
  const raw = await callLlm(
    buildSnapshotSystemPrompt(characterName),
    buildSnapshotUserPrompt(messages, characterName),
    model,
  );

  const extracted = parseEntriesJson(raw, "snapshot");

  const created: Entry[] = [];
  for (const e of extracted) {
    if (!VALID_LANES.includes(e.lane)) continue;
    if (!e.summary?.trim()) continue;
    const entry = await createEntry(characterId, e);
    if (entry) created.push(entry);
  }

  console.info(`[ME:snapshot] saved ${created.length} entries for ${characterId}`);
  return { created: created.length, entries: created };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function digestMessages(
  messages: DigestMessage[],
  characterId: string,
  characterName: string,
  model?: string,
): Promise<DigestResult> {
  const usedModel = model ?? process.env.MARINARA_EXTENDER_DIGEST_MODEL ?? "gpt-4o-mini";
  const raw = await callLlm(
    buildSystemPrompt(characterName),
    buildUserPrompt(messages, characterName),
    usedModel,
  );

  const extracted = parseEntriesJson(raw, "digest");

  const created: Entry[] = [];

  for (const e of extracted) {
    if (!VALID_LANES.includes(e.lane)) continue;
    if (!e.summary?.trim()) continue;
    const entry = await createEntry(characterId, e);
    if (entry) created.push(entry);
  }

  return { created: created.length, entries: created };
}
