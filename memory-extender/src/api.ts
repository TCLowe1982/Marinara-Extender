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
  mutateBookmarks,
  listScopeIds,
  estimateTokens,
  type Scope,
  type Lane,
  type EntryStatus,
  type Entry,
  type Bookmark,
} from "./storage.js";
import { nanoid } from "./nanoid.js";
import { digestMessages, snapshotSession, type DigestMessage } from "./digest.js";
import { processResponse, extractRememberTags } from "./writer.js";
import { loadContext } from "./loader.js";
import { runPromotion, runPromotionAll, recordRecitation } from "./promotion.js";
import { runCleanup } from "./cleanup.js";
import { updateSoftClock, makeTimeContext } from "./soft-clock.js";
import { runSentimentPipeline } from "./sentiment/pipeline.js";
import { classifyChunks } from "./sentiment/classifier.js";
import { analyzeChunks } from "./sentiment/analyzer.js";
import { encodeBeat } from "./sentiment/encoder.js";
import { classifyAmbient } from "./ambient.js";
import { createEntryIfUnique, isDuplicate } from "./dedup.js";
import { Progress, progressEnabled } from "./progress.js";
import { computeJobKey, loadJob, saveJob, deleteJob, clearJobs } from "./story-jobs.js";
import type { Chunk } from "./sentiment/types.js";
import mammoth from "mammoth";
import { parseStoryToMessages } from "./story-parser.js";
import { readBeatIndex, readAllBeats, clearBeats } from "./sentiment/encoder.js";
import {
  resolveIdentity,
  getIdentityMap,
  relinkIdentity,
  renameIdentityKey,
  updateIdentityName,
  exportIdentity,
  importIdentity,
  type IdentityExportBundle,
} from "./identity.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

// Truncate a summary string at a word boundary ≤ maxLen characters.
function truncateSummary(s: string, maxLen = 120): string {
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
}

// Cap content at ~600 chars (~150 tokens) to prevent oversized entries.
function capContent(s: string, maxChars = 600): string {
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const lastSentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
  return lastSentence > 300 ? cut.slice(0, lastSentence + 1) : cut.trimEnd() + "…";
}

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

    let updated: Bookmark | null = null;
    await mutateBookmarks(scope, scopeId, (bookmarks) => {
      const i = bookmarks.findIndex((b) => b.id === id);
      if (i === -1) return bookmarks;
      updated = {
        ...bookmarks[i]!,
        ...(weight !== undefined && { weight: Math.min(1, Math.max(0, weight)) }),
        ...(why !== undefined && { why }),
        ...(summary !== undefined && { summary }),
      };
      bookmarks[i] = updated;
      return bookmarks;
    });
    if (!updated) return reply.code(404).send({ error: "bookmark not found" });

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

    let removed = false;
    await mutateBookmarks(scope, scopeId, (bookmarks) => {
      const filtered = bookmarks.filter((b) => b.id !== id);
      removed = filtered.length !== bookmarks.length;
      return filtered;
    });
    if (!removed) return reply.code(404).send({ error: "bookmark not found" });
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
    Body: { characterId: string; characterName?: string; chatId: string; turnNumber?: number; messageText?: string; userMessageText?: string };
  }>("/api/process-turn", async (req, reply) => {
    const { characterId, characterName, chatId, turnNumber = 0, messageText = "", userMessageText = "" } = req.body ?? {};
    if (!characterId || !chatId) {
      return reply.code(400).send({ error: "characterId and chatId are required" });
    }

    const identityKey = await resolveIdentity(characterId, characterName);

    // Update soft clock from the incoming message text (fire-and-forget).
    const clockState = await updateSoftClock(chatId, messageText, turnNumber).catch(() => null);
    const timeCtx = makeTimeContext(clockState);

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
      const isDupe = isDuplicate(summary, rem.content ?? "", existing);
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
        ...(timeCtx ? { timeContext: timeCtx } : {}),
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
    const { contextBlock, surfaced } = await loadContext({ characterId: identityKey, chatId, turnNumber });

    const saved = created + bookmarksExtracted;
    if (saved > 0) {
      const parts: string[] = [];
      if (created > 0) parts.push(`${created} ledger entr${created === 1 ? "y" : "ies"}`);
      if (bookmarksExtracted > 0) parts.push(`${bookmarksExtracted} bookmark${bookmarksExtracted === 1 ? "" : "s"}`);
      console.info(`[ME] memory saved — key:${identityKey} chat:${chatId} — ${parts.join(", ")}`);
    }

    // Run promotion pass every 20 turns — fire-and-forget, never blocks response.
    if (turnNumber > 0 && turnNumber % 20 === 0) {
      void Promise.all([
        runPromotion("character", identityKey),
        runPromotion("chat", chatId),
      ]).catch((err) => console.warn("[ME] promotion pass failed:", err));
    }

    // ── Tier 2: sentiment classification — fire-and-forget ────────────────────
    // Classifies the AI message and user message for emotional peaks.
    // Only fires the LLM analyzer when the fast keyword classifier passes threshold.
    if (messageText || userMessageText) {
      void (async () => {
        try {
          const chunks: Chunk[] = [];
          const charName = characterName ?? identityKey;
          if (userMessageText) chunks.push({ speaker: "user",    text: userMessageText, turnStart: turnNumber - 1, turnEnd: turnNumber - 1 });
          if (messageText)     chunks.push({ speaker: charName,  text: messageText,     turnStart: turnNumber,     turnEnd: turnNumber });

          const classified = classifyChunks(chunks, "chat");
          const passing = classified.filter(r => r.passesThreshold);
          if (passing.length === 0) return;

          console.info(`[ME:tier2] ${passing.length} chunk(s) passed sentiment threshold`);

          // Analyze with the full classified list as context so each beat sees
          // its true neighbor (e.g. the user line before the character's reply).
          for (const { result, analysis } of await analyzeChunks(passing, classified)) {
            const beat = await encodeBeat(identityKey, result, analysis, "chat");

            // Prefer the LLM's nuanced primary emotion for the human-facing tag;
            // fall back to the classifier's keyword lane when the model omits it.
            const primaryEmotion = analysis.emotions?.[0]?.emotion?.trim() || beat.emotion;

            // Companion ledger entry so the character can recall this moment.
            const summary = truncateSummary(
              `[${primaryEmotion}] ${analysis.motivation}`,
            );
            if (!summary.trim()) continue; // skip empty summaries

            const rawContent = [
              `Emotion: ${primaryEmotion}${beat.subpattern ? ` (${beat.subpattern})` : ""}`,
              `Motivation: ${analysis.motivation}`,
              `Relational dynamics: ${analysis.relationalDynamics}`,
              `Outcome: ${analysis.outcome}`,
              ...(analysis.subtext ? [`Subtext: ${analysis.subtext}`] : []),
            ].join("\n");

            const entry = await createEntryIfUnique("character", identityKey, {
              lane: "character_topics", summary, content: capContent(rawContent), timeContext: timeCtx,
            });
            if (entry) {
              console.info(`[ME:tier2] saved beat ${beat.id} + ledger entry for ${beat.emotion} (salience ${beat.salience.toFixed(2)})`);
            }
          }
        } catch (err) {
          console.warn("[ME:tier2] sentiment pass failed:", err);
        }
      })();
    }

    // ── Tier 3: ambient detail classifier — fire-and-forget ───────────────────
    // Extracts stable facts (preferences, history, identity) from throwaway lines.
    if (messageText || userMessageText) {
      void (async () => {
        try {
          const facts = await classifyAmbient({ userText: userMessageText, characterText: messageText });
          let saved = 0;
          for (const fact of facts) {
            const summary = truncateSummary(fact.fact);
            if (!summary.trim()) continue;
            const scope   = (fact.scope ?? "character") as "character" | "chat";
            const scopeId = scope === "character" ? identityKey : chatId;
            const entry = await createEntryIfUnique(scope, scopeId, {
              lane: fact.lane, summary, content: capContent(fact.text), timeContext: timeCtx,
            });
            if (entry) saved++;
          }
          if (saved > 0) {
            console.info(`[ME:tier3] saved ${saved} ambient fact(s) for ${identityKey}`);
          }
        } catch (err) {
          console.warn("[ME:tier3] ambient pass failed:", err);
        }
      })();
    }

    return reply.send({ memoryBlock: contextBlock, created, bookmarksExtracted, surfaced });
  });

  // ── POST /api/cleanup ────────────────────────────────────────────────────
  // One-time pool cleanup: ghost prune, dedup pass, transient detection.
  // Safe to run multiple times — idempotent.

  app.post("/api/cleanup", async (_req, reply) => {
    try {
      const result = await runCleanup();
      return reply.send(result);
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : "cleanup failed" });
    }
  });

  // ── POST /api/promote-all ────────────────────────────────────────────────
  // Backfills tier fields across every scope. Safe to run multiple times.
  // Returns { scopes, promoted, pruned }.

  app.post("/api/promote-all", async (_req, reply) => {
    try {
      const result = await runPromotionAll();
      return reply.send(result);
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : "backfill failed" });
    }
  });

  // ── POST /api/snapshot ───────────────────────────────────────────────────
  // Tier 1: called by the extension every 30 minutes of active chat.
  // Summarises the last N messages into character-scope memory entries.
  // Body: { characterId, characterName?, messages: DigestMessage[] }

  app.post<{
    Body: { characterId: string; characterName?: string; messages: DigestMessage[] };
  }>("/api/snapshot", async (req, reply) => {
    const { characterId, characterName, messages } = req.body ?? {};
    if (!characterId || !Array.isArray(messages) || messages.length === 0) {
      return reply.code(400).send({ error: "characterId and messages[] are required" });
    }
    const identityKey = await resolveIdentity(characterId, characterName);
    try {
      const result = await snapshotSession(messages.slice(-40), identityKey, characterName ?? identityKey);
      return reply.send({ created: result.created });
    } catch (err) {
      console.error("[ME:snapshot] failed:", err);
      return reply.code(500).send({ error: "snapshot failed" });
    }
  });

  // ── POST /api/entries/:id/recite ──────────────────────────────────────────
  // Called by the extension when it detects a surfaced memory was used in the
  // AI response (Jaccard similarity check). Increments recitationCount and
  // triggers immediate promotion if the new score crosses a threshold.
  // Body: { scope, scopeId }

  app.post<{
    Params: { id: string };
    Body: { scope: string; scopeId: string };
  }>("/api/entries/:id/recite", async (req, reply) => {
    const { id } = req.params;
    const { scope, scopeId } = req.body ?? {};
    if (!scope || !scopeId) {
      return reply.code(400).send({ error: "scope and scopeId are required" });
    }
    const validScopes = ["global", "character", "chat"] as const;
    if (!validScopes.includes(scope as (typeof validScopes)[number])) {
      return reply.code(400).send({ error: "invalid scope" });
    }
    await recordRecitation(scope as "global" | "character" | "chat", scopeId, id);
    return reply.send({ ok: true });
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
      const isDupe = isDuplicate(summary, cmd.content ?? "", existing);
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
      await mutateBookmarks("chat", chatId, (existing) => [...existing, ...newBookmarks]);
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
    Querystring: { characterId: string; chatId: string; characterName?: string };
  }>("/api/memory-block", async (req, reply) => {
    const { characterId, chatId, characterName } = req.query;
    if (!characterId || !chatId) {
      return reply.code(400).send({ error: "characterId and chatId are required" });
    }
    // Pass the name so a brand-new character (whose first call is this endpoint,
    // before any process-turn) gets a readable identity slug, not the card ID.
    const identityKey = await resolveIdentity(characterId, characterName);
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
      const result = await runSentimentPipeline(messages, identityKey, characterName, { sourceType, progressLabel: `${characterName} (chat history)` });
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

  // ── POST /api/extract-text ───────────────────────────────────────────────
  // Converts a .docx file (sent as base64) to plain text via mammoth.
  // .txt files are handled client-side and don't need this endpoint.
  // Body: { filename: string; data: string }  (data = base64-encoded file bytes)

  app.post<{
    Body: { filename: string; data: string };
  }>("/api/extract-text", async (req, reply) => {
    const { filename, data } = req.body ?? {};
    if (!filename || !data) {
      return reply.code(400).send({ error: "filename and data are required" });
    }
    const ext = filename.split(".").pop()?.toLowerCase();
    if (ext !== "docx") {
      return reply.code(400).send({ error: "only .docx is supported; read .txt client-side" });
    }
    try {
      const buffer = Buffer.from(data, "base64");
      const result = await mammoth.extractRawText({ buffer });
      return reply.send({ text: result.value });
    } catch (err) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : "Failed to extract text from .docx",
      });
    }
  });

  // ── POST /api/ingest-story ────────────────────────────────────────────────
  // Parses a prose story/narrative into emotional beats via the sentiment
  // pipeline. The LLM first adds "Name: " attribution prefixes so the chunker
  // can do per-speaker analysis; paragraph split is used as fallback.
  // Body: { characterId, characterName, text, characters?, povCharacter?, sourceType? }
  // characters: only beats for these speakers are saved; others are dropped.
  // povCharacter: "Narrator" chunks are relabeled to this name (use for first-person prose).

  app.post<{
    Body: {
      characterId: string;
      characterName: string;
      text: string;
      characters?: string[];
      povCharacter?: string;
      sourceType?: "chat" | "story";
      title?: string;       // label for console progress (e.g. the file name)
      progress?: boolean;   // override the MARINARA_EXTENDER_PROGRESS toggle
      useExternal?: boolean; // attribute via external API + larger windows
      // Multi-character: route beats to several characters from one import. Each
      // gets the chunks whose speaker matches its names. Falls back to a single
      // assignment built from characterId/characterName/characters when omitted.
      assignments?: Array<{ characterId: string; characterName?: string; names?: string[] }>;
    };
  }>("/api/ingest-story", async (req, reply) => {
    const {
      characterId,
      characterName,
      text,
      characters = [],
      povCharacter,
      sourceType = "story",
      title,
      progress,
      useExternal = false,
      assignments,
    } = req.body ?? {};

    if (!characterId || !characterName) {
      return reply.code(400).send({ error: "characterId and characterName are required" });
    }
    if (!text?.trim()) {
      return reply.code(400).send({ error: "text is required" });
    }

    // Normalize to a list of assignments. Single-character requests (no
    // assignments) become one assignment from the open character + names.
    const rawAssignments = (assignments && assignments.length)
      ? assignments
      : [{ characterId, characterName, names: characters }];

    // Resolve each to a stable identity key up front.
    const targets = [];
    for (const a of rawAssignments) {
      if (!a.characterId) continue;
      const name = a.characterName ?? characterId;
      const key = await resolveIdentity(a.characterId, a.characterName);
      const names = (a.names ?? []).map((n) => n.trim()).filter(Boolean);
      targets.push({ identityKey: key, characterName: name, names });
    }
    if (targets.length === 0) {
      return reply.code(400).send({ error: "no valid character assignments" });
    }

    const label = title?.trim() || characterName;
    const primaryKey = targets[0]!.identityKey;
    // Attribution hint + cache key cover every assigned speaker name.
    const unionNames = [...new Set(targets.flatMap((t) => t.names))];

    // Cancel the import when the client aborts the request (the Cancel button).
    const ac = new AbortController();
    req.raw.once("close", () => { if (!reply.raw.writableEnded) ac.abort(); });

    try {
      const progressReport = new Progress(label, progress ?? progressEnabled());

      // Resumable import job (shared across all target characters): cache
      // attributed windows keyed by text + options. Stored under the primary
      // character so a re-run with the same setup resumes attribution.
      const jobKey = computeJobKey(text, { povCharacter, characters: unionNames, useExternal });
      const job = (await loadJob(primaryKey, jobKey)) ?? {
        jobKey, title: label, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        attributedWindows: [],
      };
      const cachedCount = (job.attributedWindows ?? []).filter(Boolean).length;
      progressReport.stage(
        cachedCount > 0
          ? `resuming "${label}" — ${cachedCount} attributed window(s) cached`
          : `importing "${label}" — attributing text${useExternal ? " (external)" : ""}...`,
      );

      const { messages, method } = await parseStoryToMessages(text, {
        characters: unionNames,
        useExternal,
        signal: ac.signal,
        onWindow: (current, total) => progressReport.tick(current, total, "window"),
        cachedWindows: job.attributedWindows,
        onWindowDone: async (index, msgs) => {
          (job.attributedWindows ??= [])[index] = msgs;
          await saveJob(primaryKey, job);
        },
      });
      job.method = method;
      await saveJob(primaryKey, job);
      progressReport.stage(`attribution complete (${method}) — ${targets.length} character(s)`);

      // Analyze + encode per character. Chunks are disjoint by speaker, so each
      // chunk is analyzed once overall; resume skips done chunks per character.
      const perCharacter = [];
      let speakers: string[] = [];
      let chunksTotal = 0;
      for (const t of targets) {
        const r = await runSentimentPipeline(messages, t.identityKey, t.characterName, {
          sourceType,
          characters: t.names.length ? t.names : undefined,
          povCharacter,
          progressLabel: targets.length > 1 ? `${label} — ${t.characterName}` : label,
          progress,
          signal: ac.signal,
        });
        perCharacter.push({
          characterName: t.characterName,
          identityKey: t.identityKey,
          beats: r.beats.length,
          skipped: r.skipped,
          chunksFiltered: r.chunksFiltered,
          chunksFailed: r.chunksFailed,
        });
        if (!speakers.length) speakers = r.speakers;
        chunksTotal = r.chunksTotal;
      }

      // All characters done — drop the cached attribution job.
      await deleteJob(primaryKey, jobKey);
      const totalBeats = perCharacter.reduce((s, c) => s + c.beats, 0);
      const totalResumed = perCharacter.reduce((s, c) => s + c.skipped, 0);
      console.info(
        `[ME] story ingest — method:${method} — ${targets.length} char(s), ${totalBeats} new beats` +
        `${totalResumed ? `, ${totalResumed} resumed` : ""}`,
      );
      return reply.send({ parseMethod: method, speakers, chunksTotal, beats: totalBeats, perCharacter });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (ac.signal.aborted || msg === "cancelled") {
        console.info(`[ME] story ingest cancelled — primary:${primaryKey}`);
        if (!reply.raw.writableEnded) return reply.code(499).send({ cancelled: true });
        return; // client already gone
      }
      return reply.code(500).send({ error: msg || "Story ingest failed" });
    }
  });

  // ── DELETE /api/beats/:characterId ───────────────────────────────────────
  // Wipes all saved beats for a character (index + individual files).
  // Use before re-ingesting a story with corrected settings (e.g. POV char).

  app.delete<{
    Params: { characterId: string };
  }>("/api/beats/:characterId", async (req, reply) => {
    const { characterId } = req.params;
    if (!characterId) return reply.code(400).send({ error: "characterId is required" });
    const identityKey = await resolveIdentity(characterId);
    const deleted = await clearBeats(identityKey);
    const jobs = await clearJobs(identityKey); // also drop cached import progress
    console.info(`[ME] beats cleared — key:${identityKey} — ${deleted} beats removed, ${jobs} import job(s) cleared`);
    return reply.send({ ok: true, deleted });
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

  // ── PATCH /api/identity/name ─────────────────────────────────────────────
  // Update the display name stored for an identity key.
  // Body: { identityKey, name }

  app.patch<{
    Body: { identityKey: string; name: string };
  }>("/api/identity/name", async (req, reply) => {
    const { identityKey, name } = req.body ?? {};
    if (!identityKey?.trim() || !name?.trim()) {
      return reply.code(400).send({ error: "identityKey and name are required" });
    }
    try {
      await updateIdentityName(identityKey.trim(), name.trim());
      return reply.send({ ok: true, identityKey, name: name.trim() });
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
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
