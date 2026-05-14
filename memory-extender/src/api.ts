// Management API — lets the ledger panel (and any other client) create, read,
// update, and delete entries and bookmarks across all three scopes.
//
// All routes are under /api/* and require scope + scopeId to locate data.
// Entries routes:   GET|POST /api/entries, GET|PATCH|DELETE /api/entries/:id
// Bookmarks routes: GET /api/bookmarks, PATCH|DELETE /api/bookmarks/:id
// Scopes route:     GET /api/scopes

import type { FastifyInstance } from "fastify";
import {
  readIndex,
  readEntry,
  writeEntry,
  deleteEntryFile,
  upsertIndexEntry,
  removeIndexEntry,
  readBookmarks,
  writeBookmarks,
  listScopeIds,
  estimateTokens,
  type Scope,
  type Lane,
  type EntryStatus,
  type Entry,
  type Bookmark,
} from "./storage.js";
import { nanoid } from "./nanoid.js";
import { digestMessages, type DigestMessage } from "./digest.js";
import { processResponse } from "./writer.js";
import { loadContext } from "./loader.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_SCOPES: Scope[] = ["global", "character", "chat"];
const VALID_LANES: Lane[] = ["open_threads", "user_topics", "character_topics"];
const VALID_STATUSES: EntryStatus[] = ["open", "in_progress", "done", "deferred"];

function idPrefix(lane: Lane): string {
  if (lane === "open_threads") return "thread";
  if (lane === "user_topics") return "utopic";
  return "ctopic";
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function scopeErr(reply: ReturnType<FastifyInstance["inject"]> | never) {
  void reply; // type narrowing guard — actual usage below
}
void scopeErr; // prevent unused warning

// ── Route registration ────────────────────────────────────────────────────────

export function registerApiRoutes(app: FastifyInstance): void {

  // ── GET /api/entries ──────────────────────────────────────────────────────
  // Returns index entries (summaries) for a scope. No file I/O beyond the index.
  // Query: scope, scopeId, lane? (filter), status? (filter, default excludes "done")

  app.get<{
    Querystring: { scope: Scope; scopeId: string; lane?: Lane; status?: string };
  }>("/api/entries", async (req, reply) => {
    const { scope, scopeId, lane, status } = req.query;
    if (!VALID_SCOPES.includes(scope) || !scopeId) {
      return reply.code(400).send({ error: "scope and scopeId are required" });
    }

    const index = await readIndex(scope, scopeId);
    let entries = index?.entries ?? [];

    if (lane) entries = entries.filter((e) => e.lane === lane);

    // Default: hide done entries; ?status=all overrides
    if (status !== "all") {
      const filter = status ? [status] : ["open", "in_progress", "deferred"];
      entries = entries.filter((e) => filter.includes(e.status ?? "open"));
    }

    return reply.send(entries);
  });

  // ── GET /api/entries/:id ──────────────────────────────────────────────────
  // Returns the full entry including content. Loads the YAML file.
  // Query: scope, scopeId

  app.get<{
    Params: { id: string };
    Querystring: { scope: Scope; scopeId: string };
  }>("/api/entries/:id", async (req, reply) => {
    const { id } = req.params;
    const { scope, scopeId } = req.query;
    if (!VALID_SCOPES.includes(scope) || !scopeId) {
      return reply.code(400).send({ error: "scope and scopeId are required" });
    }

    const index = await readIndex(scope, scopeId);
    const indexEntry = index?.entries.find((e) => e.id === id);
    if (!indexEntry) return reply.code(404).send({ error: "entry not found" });

    const entry = await readEntry(scope, scopeId, indexEntry.path);
    if (!entry) return reply.code(404).send({ error: "entry file missing" });

    return reply.send(entry);
  });

  // ── POST /api/entries ─────────────────────────────────────────────────────
  // Creates a new entry and adds it to the scope index.
  // Body: { scope, scopeId, lane, summary, content, status?, id? }

  app.post<{
    Body: {
      scope: Scope;
      scopeId: string;
      lane: Lane;
      summary: string;
      content: string;
      status?: EntryStatus;
      id?: string;
    };
  }>("/api/entries", async (req, reply) => {
    const { scope, scopeId, lane, summary, content, status = "open", id: reqId } = req.body;

    if (!VALID_SCOPES.includes(scope) || !scopeId) {
      return reply.code(400).send({ error: "scope and scopeId are required" });
    }
    if (!VALID_LANES.includes(lane)) {
      return reply.code(400).send({ error: `lane must be one of: ${VALID_LANES.join(", ")}` });
    }
    if (!summary?.trim()) return reply.code(400).send({ error: "summary is required" });
    if (!VALID_STATUSES.includes(status)) {
      return reply.code(400).send({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
    }

    const id = reqId ?? `${idPrefix(lane)}-${nanoid(8)}`;
    const now = today();

    const entry: Entry = {
      id,
      lane,
      summary: summary.trim(),
      status,
      created: now,
      lastAccessed: now,
      content: (content ?? "").trim(),
      tokens: estimateTokens(`${summary} ${content ?? ""}`),
    };

    const relativePath = await writeEntry(scope, scopeId, entry);

    await upsertIndexEntry(scope, scopeId, {
      id,
      path: relativePath,
      summary: entry.summary,
      tokens: entry.tokens,
      lane,
      status,
      lastAccessed: now,
    });

    return reply.code(201).send({ entry, path: relativePath });
  });

  // ── PATCH /api/entries/:id ────────────────────────────────────────────────
  // Updates an existing entry. Partial — only supplied fields are changed.
  // Body: { scope, scopeId, summary?, content?, status? }

  app.patch<{
    Params: { id: string };
    Body: {
      scope: Scope;
      scopeId: string;
      summary?: string;
      content?: string;
      status?: EntryStatus;
    };
  }>("/api/entries/:id", async (req, reply) => {
    const { id } = req.params;
    const { scope, scopeId, summary, content, status } = req.body;

    if (!VALID_SCOPES.includes(scope) || !scopeId) {
      return reply.code(400).send({ error: "scope and scopeId are required" });
    }
    if (status && !VALID_STATUSES.includes(status)) {
      return reply.code(400).send({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
    }

    const index = await readIndex(scope, scopeId);
    const indexEntry = index?.entries.find((e) => e.id === id);
    if (!indexEntry) return reply.code(404).send({ error: "entry not found" });

    const existing = await readEntry(scope, scopeId, indexEntry.path);
    if (!existing) return reply.code(404).send({ error: "entry file missing" });

    const updated: Entry = {
      ...existing,
      ...(summary !== undefined && { summary: summary.trim() }),
      ...(content !== undefined && { content: content.trim() }),
      ...(status !== undefined && { status }),
      lastAccessed: today(),
    };
    updated.tokens = estimateTokens(`${updated.summary} ${updated.content}`);

    await writeEntry(scope, scopeId, updated);
    await upsertIndexEntry(scope, scopeId, {
      ...indexEntry,
      summary: updated.summary,
      tokens: updated.tokens,
      status: updated.status,
      lastAccessed: updated.lastAccessed,
    });

    return reply.send({ entry: updated });
  });

  // ── DELETE /api/entries/:id ───────────────────────────────────────────────
  // Removes the entry file and its index row.
  // Query: scope, scopeId

  app.delete<{
    Params: { id: string };
    Querystring: { scope: Scope; scopeId: string };
  }>("/api/entries/:id", async (req, reply) => {
    const { id } = req.params;
    const { scope, scopeId } = req.query;

    if (!VALID_SCOPES.includes(scope) || !scopeId) {
      return reply.code(400).send({ error: "scope and scopeId are required" });
    }

    const index = await readIndex(scope, scopeId);
    const indexEntry = index?.entries.find((e) => e.id === id);
    if (!indexEntry) return reply.code(404).send({ error: "entry not found" });

    await deleteEntryFile(scope, scopeId, indexEntry.path);
    await removeIndexEntry(scope, scopeId, id);

    return reply.send({ ok: true });
  });

  // ── GET /api/bookmarks ────────────────────────────────────────────────────
  // Returns all bookmarks for a scope, sorted by weight descending.
  // Query: scope, scopeId

  app.get<{
    Querystring: { scope: Scope; scopeId: string };
  }>("/api/bookmarks", async (req, reply) => {
    const { scope, scopeId } = req.query;
    if (!VALID_SCOPES.includes(scope) || !scopeId) {
      return reply.code(400).send({ error: "scope and scopeId are required" });
    }

    const bookmarks = await readBookmarks(scope, scopeId);
    return reply.send(bookmarks.sort((a, b) => b.weight - a.weight));
  });

  // ── PATCH /api/bookmarks/:id ──────────────────────────────────────────────
  // Updates a bookmark's weight, why, or summary.
  // Body: { scope, scopeId, weight?, why?, summary? }

  app.patch<{
    Params: { id: string };
    Body: {
      scope: Scope;
      scopeId: string;
      weight?: number;
      why?: string;
      summary?: string;
    };
  }>("/api/bookmarks/:id", async (req, reply) => {
    const { id } = req.params;
    const { scope, scopeId, weight, why, summary } = req.body;

    if (!VALID_SCOPES.includes(scope) || !scopeId) {
      return reply.code(400).send({ error: "scope and scopeId are required" });
    }

    const bookmarks = await readBookmarks(scope, scopeId);
    const i = bookmarks.findIndex((b) => b.id === id);
    if (i === -1) return reply.code(404).send({ error: "bookmark not found" });

    const updated: Bookmark = {
      ...bookmarks[i]!,
      ...(weight !== undefined && { weight: Math.min(1, Math.max(0, weight)) }),
      ...(why !== undefined && { why }),
      ...(summary !== undefined && { summary }),
    };
    bookmarks[i] = updated;
    await writeBookmarks(scope, scopeId, bookmarks);

    return reply.send(updated);
  });

  // ── DELETE /api/bookmarks/:id ─────────────────────────────────────────────
  // Removes a bookmark permanently.
  // Query: scope, scopeId

  app.delete<{
    Params: { id: string };
    Querystring: { scope: Scope; scopeId: string };
  }>("/api/bookmarks/:id", async (req, reply) => {
    const { id } = req.params;
    const { scope, scopeId } = req.query;

    if (!VALID_SCOPES.includes(scope) || !scopeId) {
      return reply.code(400).send({ error: "scope and scopeId are required" });
    }

    const bookmarks = await readBookmarks(scope, scopeId);
    const filtered = bookmarks.filter((b) => b.id !== id);
    if (filtered.length === bookmarks.length) {
      return reply.code(404).send({ error: "bookmark not found" });
    }

    await writeBookmarks(scope, scopeId, filtered);
    return reply.send({ ok: true });
  });

  // ── POST /api/digest ──────────────────────────────────────────────────────
  // Digests a batch of chat messages with an LLM and creates memory entries
  // in the character scope. Requires MARINARA_EXTENDER_API_KEY in .env.
  // Body: { characterId, characterName?, model?, messages: [{role, content}] }

  app.post<{
    Body: {
      characterId: string;
      characterName?: string;
      model?: string;
      messages: DigestMessage[];
    };
  }>("/api/digest", async (req, reply) => {
    const { characterId, characterName = "the character", model, messages } = req.body;

    if (!characterId) {
      return reply.code(400).send({ error: "characterId is required" });
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.code(400).send({ error: "messages array is required and must not be empty" });
    }

    try {
      const result = await digestMessages(messages, characterId, characterName, model);
      return reply.send(result);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (detail.includes("No API key")) {
        return reply.code(503).send({ error: "no_api_key", detail });
      }
      return reply.code(500).send({ error: "digest_failed", detail });
    }
  });

  // ── POST /api/process-turn ────────────────────────────────────────────────
  // Called by the extension after each AI response is received.
  // Persists any <bookmark> tags in the message, decays old bookmarks,
  // then returns the updated memory block for the extension to write to the lorebook.
  // Body: { characterId, chatId, turnNumber, messageText }

  app.post<{
    Body: { characterId: string; chatId: string; turnNumber?: number; messageText?: string };
  }>("/api/process-turn", async (req, reply) => {
    const { characterId, chatId, turnNumber = 0, messageText = "" } = req.body ?? {};
    if (!characterId || !chatId) {
      return reply.code(400).send({ error: "characterId and chatId are required" });
    }
    await processResponse(chatId, turnNumber, messageText);
    const { contextBlock } = await loadContext({ characterId, chatId, turnNumber });
    return reply.send({ memoryBlock: contextBlock });
  });

  // ── GET /api/memory-block ─────────────────────────────────────────────────
  // Returns the current memory block without modifying any state.
  // Used by the extension on initial session load to populate the lorebook entry.
  // Query: characterId, chatId

  app.get<{
    Querystring: { characterId: string; chatId: string };
  }>("/api/memory-block", async (req, reply) => {
    const { characterId, chatId } = req.query;
    if (!characterId || !chatId) {
      return reply.code(400).send({ error: "characterId and chatId are required" });
    }
    const { contextBlock } = await loadContext({ characterId, chatId, turnNumber: 0 });
    return reply.send({ memoryBlock: contextBlock });
  });

  // ── GET /api/scopes ───────────────────────────────────────────────────────
  // Lists all scopes that have data, with entry and bookmark counts.

  app.get("/api/scopes", async (_req, reply) => {
    const results: Array<{
      scope: Scope;
      scopeId: string;
      entryCount: number;
      bookmarkCount: number;
    }> = [];

    for (const scope of VALID_SCOPES) {
      const ids = await listScopeIds(scope);
      for (const scopeId of ids) {
        const [index, bookmarks] = await Promise.all([
          readIndex(scope, scopeId),
          readBookmarks(scope, scopeId),
        ]);
        if (!index && bookmarks.length === 0) continue; // empty scope, skip
        results.push({
          scope,
          scopeId,
          entryCount: index?.entries.length ?? 0,
          bookmarkCount: bookmarks.length,
        });
      }
    }

    return reply.send(results);
  });
}
