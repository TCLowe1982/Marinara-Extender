// Digest a batch of chat messages into persistent memory entries.
// Tries the Marinara Engine's local Gemma sidecar first; falls back to an
// external OpenAI-compatible API if the sidecar is unavailable.

import { getCachedAuth } from "./auth-cache.js";
import {
  writeEntry,
  upsertIndexEntry,
  estimateTokens,
  type Entry,
  type Lane,
  type EntryStatus,
} from "./storage.js";
import { nanoid } from "./nanoid.js";

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
  return `You are a memory archivist extracting insights from a chat log involving "${characterName}". Return raw JSON only — no explanation, no markdown fences.

Format: {"entries":[{"lane":"...","summary":"...","content":"...","status":"..."}]}

Lanes:
- open_threads: Ongoing tasks, unresolved issues, promises, or follow-ups.
- user_topics: Subjects the user mentioned repeatedly or cares about.
- character_topics: Things ${characterName} would want to remember — emotional moments, lore, things to bring up.

Each entry: lane, summary (≤80 chars), content (1-3 sentences), status (open_threads only: open|in_progress|done|deferred).
Rules: Be selective. 3-8 entries typical. Fewer is better. Skip greetings and ephemeral small talk.`;
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

async function callLlm(systemPrompt: string, userPrompt: string, model: string): Promise<string> {
  const local = await callLocalLlm(systemPrompt, userPrompt);
  if (local !== null) {
    console.log("[digest] local model ok");
    return local;
  }
  if (process.env.MARINARA_EXTENDER_LOCAL_URL) {
    console.log("[digest] local model unavailable, falling back to external API");
  }
  return callExternalLlm(systemPrompt, userPrompt, model);
}

// ── Entry creation ────────────────────────────────────────────────────────────

const VALID_LANES: Lane[] = ["open_threads", "user_topics", "character_topics"];
const VALID_STATUSES: EntryStatus[] = ["open", "in_progress", "done", "deferred"];

function idPrefix(lane: Lane): string {
  if (lane === "open_threads") return "thread";
  if (lane === "user_topics") return "utopic";
  return "ctopic";
}

async function createEntry(
  characterId: string,
  e: ExtractedEntry,
): Promise<Entry> {
  const now = new Date().toISOString().slice(0, 10);
  const id = `${idPrefix(e.lane)}-${nanoid(8)}`;

  const status: EntryStatus =
    e.lane === "open_threads" && VALID_STATUSES.includes(e.status as EntryStatus)
      ? (e.status as EntryStatus)
      : "open";

  const entry: Entry = {
    id,
    lane: e.lane,
    summary: e.summary.trim().slice(0, 200),
    status,
    created: now,
    lastAccessed: now,
    content: (e.content ?? "").trim(),
    tokens: estimateTokens(`${e.summary} ${e.content ?? ""}`),
  };

  const relativePath = await writeEntry("character", characterId, entry);
  await upsertIndexEntry("character", characterId, {
    id,
    path: relativePath,
    summary: entry.summary,
    tokens: entry.tokens,
    lane: e.lane,
    status,
    lastAccessed: now,
  });

  return entry;
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

  let extracted: ExtractedEntry[];
  try {
    const cleaned = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(cleaned) as { entries?: unknown[] };
    extracted = (Array.isArray(parsed.entries) ? parsed.entries : []) as ExtractedEntry[];
  } catch {
    throw new Error(`Could not parse LLM response as JSON: ${raw.slice(0, 300)}`);
  }

  const created: Entry[] = [];

  for (const e of extracted) {
    if (!VALID_LANES.includes(e.lane)) continue;
    if (!e.summary?.trim()) continue;
    created.push(await createEntry(characterId, e));
  }

  return { created: created.length, entries: created };
}
