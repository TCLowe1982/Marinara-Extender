// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Post-processes a completed LLM response:
//   1. Extracts <remember> tags → persistent ledger entries (returned to caller)
//   2. Extracts <bookmark> tags → decaying bookmark signals
//   3. Strips both tags from visible output
//   4. Runs per-turn weight decay on existing bookmarks

import { nanoid } from "./nanoid.js";
import { mutateBookmarks, type Bookmark, type Lane, type Scope } from "./storage.js";

// ── Bookmark parsing ──────────────────────────────────────────────────────────
// Attribute order is intentionally NOT enforced — models vary.
// Each function uses its own regex instance to avoid shared lastIndex state.

export interface ExtractedBookmark {
  topic: string;
  weight: number;
  why: string;
  summary: string;
}

function extractAttr(attrStr: string, name: string): string | undefined {
  const prefix = `${name}="`;
  const start = attrStr.indexOf(prefix);
  if (start === -1) return undefined;
  const valueStart = start + prefix.length;
  const end = attrStr.indexOf('"', valueStart);
  return end === -1 ? undefined : attrStr.slice(valueStart, end);
}

export function extractBookmarks(text: string): ExtractedBookmark[] {
  const found: ExtractedBookmark[] = [];

  // XML format: <bookmark topic="..." weight="0.8" why="...">summary</bookmark>
  const xmlRe = /<bookmark\b([^>]*)>([\s\S]*?)<\/bookmark>/gi;
  let match: RegExpExecArray | null;
  while ((match = xmlRe.exec(text)) !== null) {
    const attrStr = match[1]!;
    const topic = extractAttr(attrStr, "topic");
    if (!topic) continue;
    const weightRaw = extractAttr(attrStr, "weight");
    found.push({
      topic,
      weight: Math.min(1, Math.max(0, parseFloat(weightRaw ?? "0.5"))),
      why: extractAttr(attrStr, "why") ?? "unspecified",
      summary: match[2]!.trim(),
    });
  }

  // Bracket format: [bookmark: topic="...", weight=0.8, why="...", summary="..."]
  const bracketRe = /\[bookmark:\s*([^\]]*)\]/gi;
  while ((match = bracketRe.exec(text)) !== null) {
    const params = match[1]!;
    const topic = parseBracketParam(params, "topic");
    if (!topic) continue;
    const weightRaw = parseBracketParam(params, "weight");
    const summary = parseBracketParam(params, "summary") ?? "";
    found.push({
      topic,
      weight: Math.min(1, Math.max(0, parseFloat(weightRaw ?? "0.5"))),
      why: parseBracketParam(params, "why") ?? "unspecified",
      summary: summary.trim(),
    });
  }

  return found;
}

export function stripBookmarkTags(text: string): string {
  return text
    .replace(/<bookmark\b[^>]*>[\s\S]*?<\/bookmark>/gi, "")
    .replace(/\[bookmark:\s*[^\]]*\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Remember tag / command parsing ───────────────────────────────────────────
// Supports both:
//   XML format (legacy):    <remember lane="user_topics" scope="chat">content</remember>
//   Bracket format (Phase 0): [remember: lane="user_topics", content="...", scope="chat"]

const VALID_LANES_SET = new Set<string>(["open_threads", "user_topics", "character_topics"]);
const VALID_SCOPES_SET = new Set<string>(["chat", "character", "global"]);

/** The scope a tag gets when it names none — and, now, when it names one we don't know. */
const DEFAULT_SCOPE: Scope = "character";

export interface ExtractedRemember {
  lane: Lane;
  scope: Scope;
  content: string;
}

// Bad scope values are logged once each, not once per turn. A persistently
// typo-ing emitter should be visible without drowning the log in a duplicate
// line every message.
const warnedScopes = new Set<string>();

/**
 * Resolve the scope named by a tag.
 *
 * The value comes from a MODEL, so it arrives with model-shaped defects: stray
 * casing, surrounding whitespace, a near-miss synonym. Case and whitespace are
 * unambiguous in intent and are simply normalised away.
 *
 * A value we still don't recognise falls back to the SAME default as an omitted
 * one. It used to fall to "chat", which made invalid and omitted disagree — and
 * disagree in the damaging direction, because "chat" is the narrowest scope
 * there is. A typo'd `scope="charcter"` therefore didn't degrade to the default,
 * it quietly buried the memory in the conversation that produced it, where it
 * died with that chat. That presents much later as "she forgot something I told
 * her to remember forever", and triages as a capture gap or a retrieval miss
 * when it is neither: the memory was captured correctly and filed one scope too
 * narrow. Widening the failure to the default is the safe direction — the
 * default is what the author of the tag would have got by saying nothing.
 */
function resolveScope(raw: string | undefined): Scope {
  if (raw === undefined) return DEFAULT_SCOPE;
  const normalized = raw.trim().toLowerCase();
  if (VALID_SCOPES_SET.has(normalized)) return normalized as Scope;
  if (!warnedScopes.has(normalized)) {
    warnedScopes.add(normalized);
    console.warn(
      `[ME] unknown scope ${JSON.stringify(raw)} on a remember tag — filed as "${DEFAULT_SCOPE}". ` +
        `Valid: ${[...VALID_SCOPES_SET].join(" | ")}.`,
    );
  }
  return DEFAULT_SCOPE;
}

// Accept both quoted (content="…") and unquoted (weight=0.8) values. The model
// is told to emit weight unquoted, so a quote-only match silently dropped every
// weight to its 0.5 default. Quoted values may contain commas; unquoted values
// run to the next comma or closing bracket.
function parseBracketParam(params: string, key: string): string | undefined {
  const re = new RegExp(`${key}\\s*=\\s*(?:"([^"]*)"|([^,\\]]+))`, "i");
  const m = params.match(re);
  if (!m) return undefined;
  return (m[1] ?? m[2])?.trim();
}

export function extractRememberTags(text: string): ExtractedRemember[] {
  const found: ExtractedRemember[] = [];

  // XML format: <remember lane="..." scope="...">content</remember>
  const xmlRe = /<remember\b([^>]*)>([\s\S]*?)<\/remember>/gi;
  let match: RegExpExecArray | null;
  while ((match = xmlRe.exec(text)) !== null) {
    const attrStr = match[1]!;
    const content = match[2]!.trim();
    if (!content) continue;
    const laneRaw = extractAttr(attrStr, "lane") ?? "user_topics";
    found.push({
      lane: (VALID_LANES_SET.has(laneRaw) ? laneRaw : "user_topics") as Lane,
      scope: resolveScope(extractAttr(attrStr, "scope")),
      content,
    });
  }

  // Bracket format: [remember: lane="...", content="...", scope="..."]
  const bracketRe = /\[remember:\s*([^\]]*)\]/gi;
  while ((match = bracketRe.exec(text)) !== null) {
    const params = match[1]!;
    const content = parseBracketParam(params, "content");
    if (!content || content.trim().length === 0) continue;
    const laneRaw = parseBracketParam(params, "lane") ?? "user_topics";
    found.push({
      lane: (VALID_LANES_SET.has(laneRaw) ? laneRaw : "user_topics") as Lane,
      scope: resolveScope(parseBracketParam(params, "scope")),
      content: content.trim(),
    });
  }

  return found;
}

export function stripRememberTags(text: string): string {
  return text
    .replace(/<remember\b[^>]*>[\s\S]*?<\/remember>/gi, "")
    .replace(/\[remember:\s*[^\]]*\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Decay ─────────────────────────────────────────────────────────────────────

export const PRUNE_THRESHOLD = 0.1;

export function decayBookmarks(bookmarks: Bookmark[]): Bookmark[] {
  return bookmarks
    .map((b) => ({ ...b, weight: b.weight * b.decayRate }))
    .filter((b) => b.weight >= PRUNE_THRESHOLD);
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ProcessResult {
  clean: string;
  bookmarksExtracted: number;
}

export async function processResponse(
  chatId: string,
  turnNumber: number,
  rawText: string,
): Promise<ProcessResult> {
  const extracted = extractBookmarks(rawText);
  const clean = stripRememberTags(stripBookmarkTags(rawText));

  // Decay runs every turn regardless of whether new bookmarks were found.
  // Serialized so the read-decay-write can't race with panel edits or ingest.
  await mutateBookmarks("chat", chatId, (current) => {
    const bookmarks = decayBookmarks(current);
    for (const b of extracted) {
      bookmarks.push({
        id: nanoid(),
        topic: b.topic,
        summary: b.summary,
        weight: b.weight,
        why: b.why,
        createdTurn: turnNumber,
        lastSeenTurn: turnNumber,
        decayRate: 0.97,
      });
    }
    return bookmarks;
  });
  return { clean, bookmarksExtracted: extracted.length };
}
