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
import { processResponse, extractRememberTags } from "./writer.js";
import { loadContext } from "./loader.js";
import { runSentimentPipeline } from "./sentiment/pipeline.js";
import { parseStoryToMessages } from "./story-parser.js";
import { readBeatIndex, readAllBeats } from "./sentiment/encoder.js";
import {
  resolveIdentity,
  getIdentityMap,
  relinkIdentity,
  renameIdentityKey,
  exportIdentity,
  importIdentity,
  type IdentityExportBundle,
} from "./identity.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

// Jaccard similarity on word bags — used to detect duplicate <remember> entries.
function summarySimilarity(a: string, b: string): number {
  const words = (s: string) =>
    new Set(s.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean));
  const wa = words(a);
  const wb = words(b);
  const intersection = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union === 0 ? 0 : intersection / union;
}

// Truncate a summary string at a word boundary ≤ maxLen characters.
function truncateSummary(s: string, maxLen = 120): string {
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
}

const DEDUP_SIMILARITY_THRESHOLD = 0.45;

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

    const identityKey = await resolveIdentity(characterId, characterName);

    try {
      const result = await digestMessages(messages, identityKey, characterName, model);
      return reply.send(result);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[digest] failed:", detail);
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
    Body: { characterId: string; characterName?: string; chatId: string; turnNumber?: number; messageText?: string };
  }>("/api/process-turn", async (req, reply) => {
    const { characterId, characterName, chatId, turnNumber = 0, messageText = "" } = req.body ?? {};
    if (!characterId || !chatId) {
      return reply.code(400).send({ error: "characterId and chatId are required" });
    }

    const identityKey = await resolveIdentity(characterId, characterName);

    // Extract <remember> tags and create permanent entries before bookmark processing.
    const remembers = extractRememberTags(messageText);
    let created = 0;
    // Cache index entries per scope+lane so we only read once per target, even
    // when multiple <remember> tags in one message share the same scope.
    const indexCache = new Map<string, import("./storage.js").IndexEntry[]>();
    for (const rem of remembers) {
      const scopeId = rem.scope === "character" ? identityKey
                    : rem.scope === "global"    ? "global"
                    : chatId;
      const rawSummary = rem.content.replace(/\n+/g, " ").trim();
      if (rawSummary.length < 10) continue; // skip blank / near-blank entries
      const summary = truncateSummary(rawSummary);

      // Dedup: skip if a sufficiently similar entry already exists in this lane.
      const cacheKey = `${rem.scope}/${scopeId}/${rem.lane}`;
      if (!indexCache.has(cacheKey)) {
        const idx = await readIndex(rem.scope, scopeId);
        indexCache.set(
          cacheKey,
          (idx?.entries ?? []).filter((e) => e.lane === rem.lane),
        );
      }
      const existing = indexCache.get(cacheKey)!;
      const isDupe = existing.some(
        (e) => summarySimilarity(e.summary, summary) >= DEDUP_SIMILARITY_THRESHOLD,
      );
      if (isDupe) {
        console.info(`[ME] skipped duplicate entry: "${summary.slice(0, 60)}"`);
        continue;
      }

      const id  = `${idPrefix(rem.lane)}-${nanoid(8)}`;
      const now = today();
      const entry: Entry = {
        id, lane: rem.lane, summary, status: "open",
        created: now, lastAccessed: now,
        content: rem.content,
        tokens: estimateTokens(`${summary} ${rem.content}`),
      };
      const relativePath = await writeEntry(rem.scope, scopeId, entry);
      await upsertIndexEntry(rem.scope, scopeId, {
        id, path: relativePath, summary,
        tokens: entry.tokens, lane: rem.lane,
        status: "open", lastAccessed: now,
      });
      // Add to cache so later tags in the same message don't duplicate each other.
      existing.push({ id, path: relativePath, summary, tokens: entry.tokens, lane: rem.lane, status: "open", lastAccessed: now });
      created++;
    }

    const { bookmarksExtracted } = await processResponse(chatId, turnNumber, messageText);
    const { contextBlock } = await loadContext({ characterId: identityKey, chatId, turnNumber });

    const saved = created + bookmarksExtracted;
    if (saved > 0) {
      const parts: string[] = [];
      if (created > 0) parts.push(`${created} ledger entr${created === 1 ? "y" : "ies"}`);
      if (bookmarksExtracted > 0) parts.push(`${bookmarksExtracted} bookmark${bookmarksExtracted === 1 ? "" : "s"}`);
      console.info(`[ME] memory saved — key:${identityKey} chat:${chatId} — ${parts.join(", ")}`);
    }

    return reply.send({ memoryBlock: contextBlock, created, bookmarksExtracted });
  });

  // ── POST /api/ingest-commands ─────────────────────────────────────────────
  // Called by Marinara Engine after parsing [remember: ...] or [bookmark: ...]
  // native commands from an AI response. Creates ledger entries and bookmarks
  // without running bookmark decay (decay runs in /api/process-turn each turn).
  // Body: { characterId, chatId, turnNumber?, commands[] }

  app.post<{
    Body: {
      characterId: string;
      characterName?: string;
      chatId: string;
      turnNumber?: number;
      commands: Array<
        | { type: "remember"; lane: Lane; content: string; scope?: Scope }
        | { type: "bookmark"; topic: string; weight: number; why: string; summary: string }
      >;
    };
  }>("/api/ingest-commands", async (req, reply) => {
    const { characterId, characterName, chatId, turnNumber = 0, commands } = req.body ?? {};
    if (!characterId || !chatId) {
      return reply.code(400).send({ error: "characterId and chatId are required" });
    }
    if (!Array.isArray(commands) || commands.length === 0) {
      return reply.send({ created: 0, bookmarksAdded: 0 });
    }

    const identityKey = await resolveIdentity(characterId, characterName);

    let created = 0;
    let bookmarksAdded = 0;

    // Process [remember: ...] commands (dedup + create ledger entries)
    const indexCache = new Map<string, import("./storage.js").IndexEntry[]>();
    for (const cmd of commands) {
      if (cmd.type !== "remember") continue;
      const scope = (cmd.scope ?? "chat") as Scope;
      const scopeId =
        scope === "character" ? identityKey : scope === "global" ? "global" : chatId;
      const rawSummary = cmd.content.replace(/\n+/g, " ").trim();
      if (rawSummary.length < 10) continue;
      const summary = truncateSummary(rawSummary);

      const cacheKey = `${scope}/${scopeId}/${cmd.lane}`;
      if (!indexCache.has(cacheKey)) {
        const idx = await readIndex(scope, scopeId);
        indexCache.set(
          cacheKey,
          (idx?.entries ?? []).filter((e) => e.lane === cmd.lane),
        );
      }
      const existing = indexCache.get(cacheKey)!;
      const isDupe = existing.some(
        (e) => summarySimilarity(e.summary, summary) >= DEDUP_SIMILARITY_THRESHOLD,
      );
      if (isDupe) {
        console.info(`[ME] skipped duplicate entry: "${summary.slice(0, 60)}"`);
        continue;
      }

      const id = `${idPrefix(cmd.lane)}-${nanoid(8)}`;
      const now = today();
      const lane = cmd.lane as Lane;
      const entry: Entry = {
        id,
        lane,
        summary,
        status: "open",
        created: now,
        lastAccessed: now,
        content: cmd.content,
        tokens: estimateTokens(`${summary} ${cmd.content}`),
      };
      const relativePath = await writeEntry(scope, scopeId, entry);
      await upsertIndexEntry(scope, scopeId, {
        id,
        path: relativePath,
        summary,
        tokens: entry.tokens,
        lane,
        status: "open",
        lastAccessed: now,
      });
      existing.push({
        id,
        path: relativePath,
        summary,
        tokens: entry.tokens,
        lane,
        status: "open",
        lastAccessed: now,
      });
      created++;
    }

    // Process [bookmark: ...] commands (add without decay — decay runs in /process-turn)
    const newBookmarks: import("./storage.js").Bookmark[] = [];
    for (const cmd of commands) {
      if (cmd.type !== "bookmark") continue;
      newBookmarks.push({
        id: nanoid(8),
        topic: cmd.topic,
        summary: cmd.summary,
        weight: Math.max(0, Math.min(1, cmd.weight)),
        why: cmd.why,
        createdTurn: turnNumber,
        lastSeenTurn: turnNumber,
        decayRate: 0.97,
      });
      bookmarksAdded++;
    }

    if (newBookmarks.length > 0) {
      const existing = await readBookmarks("chat", chatId);
      await writeBookmarks("chat", chatId, [...existing, ...newBookmarks]);
    }

    if (created > 0 || bookmarksAdded > 0) {
      const parts: string[] = [];
      if (created > 0) parts.push(`${created} ledger entr${created === 1 ? "y" : "ies"}`);
      if (bookmarksAdded > 0) parts.push(`${bookmarksAdded} bookmark${bookmarksAdded === 1 ? "" : "s"}`);
      console.info(`[ME] memory saved — key:${identityKey} chat:${chatId} — ${parts.join(", ")}`);
    }

    return reply.send({ created, bookmarksAdded });
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
    const identityKey = await resolveIdentity(characterId);
    const { contextBlock } = await loadContext({ characterId: identityKey, chatId, turnNumber: 0 });
    if (contextBlock) {
      console.info(`[ME] memory loaded — key:${identityKey} chat:${chatId}`);
    }
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

  // ── POST /api/analyze-beats ───────────────────────────────────────────────
  // Runs the full sentiment pipeline (Stage 0–3) on a list of chat messages
  // and stores the resulting emotional beats under the character scope.
  // Body: { messages, characterId, characterName, sourceType? }

  app.post<{
    Body: {
      messages: DigestMessage[];
      characterId: string;
      characterName: string;
      sourceType?: "chat" | "story";
    };
  }>("/api/analyze-beats", async (req, reply) => {
    const { messages, characterId, characterName, sourceType = "chat" } = req.body ?? {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.code(400).send({ error: "messages array is required and must not be empty" });
    }
    if (!characterId || !characterName) {
      return reply.code(400).send({ error: "characterId and characterName are required" });
    }

    const identityKey = await resolveIdentity(characterId, characterName);

    try {
      const result = await runSentimentPipeline(messages, identityKey, characterName, sourceType);
      console.info(
        `[ME] sentiment pipeline — key:${identityKey} — ${result.beats.length} beats from ${result.chunksTotal} chunks`,
      );
      return reply.send(result);
    } catch (err) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : "Sentiment pipeline failed",
      });
    }
  });

  // ── GET /api/beats ────────────────────────────────────────────────────────
  // Returns the beat index (summaries) for a character.
  // Query: characterId, full? (if true, returns full beat objects)

  app.get<{
    Querystring: { characterId: string; full?: string };
  }>("/api/beats", async (req, reply) => {
    const { characterId, full } = req.query;
    if (!characterId) {
      return reply.code(400).send({ error: "characterId is required" });
    }

    const identityKey = await resolveIdentity(characterId);

    if (full === "true") {
      const beats = await readAllBeats(identityKey);
      return reply.send({ beats });
    }

    const index = await readBeatIndex(identityKey);
    return reply.send({ entries: index?.entries ?? [] });
  });

  // ── POST /api/ingest-story ────────────────────────────────────────────────
  // Parses a prose story/narrative into emotional beats via the sentiment
  // pipeline. The LLM first adds "Name: " attribution prefixes so the chunker
  // can do per-speaker analysis; paragraph split is used as fallback.
  // Body: { characterId, characterName, text, characters?, sourceType? }

  app.post<{
    Body: {
      characterId: string;
      characterName: string;
      text: string;
      characters?: string[];
      sourceType?: "chat" | "story";
    };
  }>("/api/ingest-story", async (req, reply) => {
    const {
      characterId,
      characterName,
      text,
      characters = [],
      sourceType = "story",
    } = req.body ?? {};

    if (!characterId || !characterName) {
      return reply.code(400).send({ error: "characterId and characterName are required" });
    }
    if (!text?.trim()) {
      return reply.code(400).send({ error: "text is required" });
    }

    const identityKey = await resolveIdentity(characterId, characterName);

    try {
      const { messages, method } = await parseStoryToMessages(text, { characters });
      const result = await runSentimentPipeline(messages, identityKey, characterName, sourceType);
      console.info(
        `[ME] story ingest — key:${identityKey} — method:${method} — ${result.beats.length} beats from ${result.chunksTotal} chunks`,
      );
      return reply.send({ ...result, parseMethod: method });
    } catch (err) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : "Story ingest failed",
      });
    }
  });

  // ── GET /api/identity ─────────────────────────────────────────────────────
  // Lists all known character identities with their card-ID mappings.

  app.get("/api/identity", async (_req, reply) => {
    const entries = await getIdentityMap();
    return reply.send({ entries });
  });

  // ── POST /api/identity/relink ─────────────────────────────────────────────
  // Points a (new) card ID at an existing identity key.
  // Use after recreating a card to preserve its memories.
  // Body: { characterId, identityKey }

  app.post<{
    Body: { characterId: string; identityKey: string };
  }>("/api/identity/relink", async (req, reply) => {
    const { characterId, identityKey } = req.body ?? {};
    if (!characterId || !identityKey) {
      return reply.code(400).send({ error: "characterId and identityKey are required" });
    }
    try {
      await relinkIdentity(characterId, identityKey);
      return reply.send({ ok: true, characterId, identityKey });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── PATCH /api/identity/:characterId ─────────────────────────────────────
  // Rename the identity key bound to a character ID.
  // Body: { newKey }

  app.patch<{
    Params: { characterId: string };
    Body: { newKey: string };
  }>("/api/identity/:characterId", async (req, reply) => {
    const { characterId } = req.params;
    const { newKey } = req.body ?? {};
    if (!newKey?.trim()) {
      return reply.code(400).send({ error: "newKey is required" });
    }

    // Find the current key for this characterId.
    const entries = await getIdentityMap();
    const current = entries.find((e) => e.characterId === characterId);
    if (!current) {
      return reply.code(404).send({ error: `No identity mapping found for characterId "${characterId}"` });
    }

    try {
      await renameIdentityKey(current.identityKey, newKey);
      return reply.send({ ok: true, oldKey: current.identityKey, newKey: newKey.trim() });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /api/identity/:key/export ─────────────────────────────────────────
  // Returns a portable JSON bundle of all memories for an identity key.
  // Use for backup or moving a character's memories to another installation.

  app.get<{
    Params: { key: string };
  }>("/api/identity/:key/export", async (req, reply) => {
    const { key } = req.params;
    try {
      const bundle = await exportIdentity(key);
      return reply
        .header("Content-Disposition", `attachment; filename="${key}-memories.json"`)
        .send(bundle);
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /api/identity/import ─────────────────────────────────────────────
  // Imports a previously exported memory bundle.
  // Body: the IdentityExportBundle JSON, optionally with targetKey to override the key.

  app.post<{
    Body: IdentityExportBundle & { targetKey?: string };
  }>("/api/identity/import", async (req, reply) => {
    const { targetKey, ...bundle } = req.body ?? {};
    if (!bundle.version || !bundle.identityKey) {
      return reply.code(400).send({ error: "invalid bundle: missing version or identityKey" });
    }
    try {
      const resolvedKey = await importIdentity(bundle as IdentityExportBundle, targetKey);
      return reply.code(201).send({
        ok: true,
        identityKey: resolvedKey,
        entriesImported: bundle.entries?.length ?? 0,
        beatsImported: bundle.beats?.length ?? 0,
      });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
