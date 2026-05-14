// Post-processes a completed LLM response:
//   1. Strips <bookmark> tags from visible output
//   2. Persists new bookmarks to the chat's bookmarks.yaml
//   3. Runs per-turn weight decay on existing bookmarks
//
// Called by proxy.ts after the full response has streamed through.

import { nanoid } from "./nanoid.js";
import { readBookmarks, writeBookmarks, type Bookmark } from "./storage.js";

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
  const re = /<bookmark\b([^>]*)>([\s\S]*?)<\/bookmark>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
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
  return found;
}

export function stripBookmarkTags(text: string): string {
  return text
    .replace(/<bookmark\b[^>]*>[\s\S]*?<\/bookmark>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Decay ─────────────────────────────────────────────────────────────────────

const PRUNE_THRESHOLD = 0.1;

function decayBookmarks(bookmarks: Bookmark[]): Bookmark[] {
  return bookmarks
    .map((b) => ({ ...b, weight: b.weight * b.decayRate }))
    .filter((b) => b.weight >= PRUNE_THRESHOLD);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function processResponse(
  chatId: string,
  turnNumber: number,
  rawText: string,
): Promise<string> {
  const extracted = extractBookmarks(rawText);
  const clean = stripBookmarkTags(rawText);

  // Decay runs every turn regardless of whether new bookmarks were found.
  let bookmarks = await readBookmarks("chat", chatId);
  bookmarks = decayBookmarks(bookmarks);

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

  await writeBookmarks("chat", chatId, bookmarks);
  return clean;
}
