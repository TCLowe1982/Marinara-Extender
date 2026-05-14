// Digest a batch of chat messages into persistent memory entries.
// Calls the upstream LLM once with an extraction prompt, parses the JSON
// response, and writes the resulting entries to the character scope.

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

function buildPrompt(messages: DigestMessage[], characterName: string): string {
  const history = messages
    .slice(-MAX_MESSAGES)
    .map((m) => `${m.role === "user" ? "User" : characterName}: ${m.content}`)
    .join("\n\n");

  return `You are a memory archivist. Analyze the following chat history between a user and an AI character named "${characterName}". Extract a small set of entries worth remembering in future conversations.

Extract entries for three categories:
- open_threads: Ongoing tasks, unresolved issues, promises, or things needing follow-up.
- user_topics: Subjects the user mentioned repeatedly, cares about, or keeps returning to.
- character_topics: Things ${characterName} would want to remember — emotional moments, things to bring up, character development, established lore.

For each entry provide:
  lane: "open_threads" | "user_topics" | "character_topics"
  summary: one clear line, max 80 characters
  content: 1-3 sentences of context and detail
  status: (open_threads only) "open" | "in_progress" | "done" | "deferred"

Rules:
- Be selective. Only extract things that genuinely matter across future conversations.
- A typical digest produces 3-8 entries. Fewer is better than padding.
- Skip one-off exchanges, greetings, and ephemeral small talk.
- Respond with raw JSON only — no explanation, no markdown fences.

Format: {"entries":[{"lane":"...","summary":"...","content":"...","status":"..."}]}

Chat history:
${history}`;
}

// ── LLM call ──────────────────────────────────────────────────────────────────

async function callLlm(prompt: string, model: string): Promise<string> {
  const auth = getCachedAuth();
  if (!auth) {
    throw new Error(
      "No API key available. Set MARINARA_EXTENDER_API_KEY in memory-extender/.env to use imports.",
    );
  }

  // Read at call time so .env values (loaded after module init) are always used.
  const upstream = (process.env.MARINARA_EXTENDER_DIGEST_UPSTREAM ?? "https://api.openai.com")
    .replace(/\/$/, "");

  const headers = {
    "Content-Type": "application/json",
    "Authorization": auth,
  };
  console.log("[digest] request URL:", `${upstream}/v1/chat/completions`);
  console.log("[digest] request headers:", JSON.stringify(headers));
  const res = await fetch(`${upstream}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
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
  const raw = await callLlm(buildPrompt(messages, characterName), usedModel);

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
