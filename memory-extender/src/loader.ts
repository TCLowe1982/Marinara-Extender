// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

import {
  readIndex,
  readColdIndex,
  promoteFromCold,
  readEntry,
  readBookmarks,
  upsertIndexEntry,
  type Scope,
  type ScopeIndex,
  type IndexEntry,
  type Entry,
  type Bookmark,
} from "./storage.js";
import { computeScore } from "./promotion.js";
import { getSoftClock, formatClockContext, timesenseEnabled } from "./soft-clock.js";
import { listActiveThreads } from "./threads.js";
import type { RecapEntry } from "./arcs.js";
import { readBeat, companionEntryFromBeat } from "./sentiment/encoder.js";

// ── Budget config ─────────────────────────────────────────────────────────────

export interface TokenBudgets {
  chat: number;
  character: number;
  global: number;
}

// Token budgets per scope for the Current working cache. Read at call time (not
// module load) so the .env loaded by index.ts is respected, and so a tighter
// model can be tuned without code changes:
//   MARINARA_EXTENDER_BUDGET_CHAT / _CHARACTER / _GLOBAL
// (Per-character/per-model budgets are a planned follow-up — see open issues.)
function getBudgets(): TokenBudgets {
  const n = (key: string, fallback: number): number => {
    const v = parseInt(process.env[key] ?? "", 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    chat:      n("MARINARA_EXTENDER_BUDGET_CHAT", 4000),
    character: n("MARINARA_EXTENDER_BUDGET_CHARACTER", 2000),
    global:    n("MARINARA_EXTENDER_BUDGET_GLOBAL", 1000),
  };
}

// ── Lane priority for entry selection ────────────────────────────────────────
// open_threads first (active work), then user_topics, then character_topics

const LANE_PRIORITY: Record<string, number> = {
  open_threads: 0,
  user_topics: 1,
  character_topics: 2,
};

// ── Session context ───────────────────────────────────────────────────────────

export interface LoaderSession {
  characterId: string;
  chatId: string;
  turnNumber: number;
  // Recent conversation text (last user + AI turn), used to score lexical
  // relevance for the "Current" working cache. Omitted on cold load → the cache
  // falls back to recency only.
  recentText?: string;
  // Pre-turn refresh (1ba) calls loadContext a second time per exchange; skip
  // the retrieval-credit stamping so exposure counts aren't double-inflated —
  // the post-turn call remains the one that earns credit.
  skipCredit?: boolean;
}

// ── Relevance (lexical) ─────────────────────────────────────────────────────────
// Fraction of a memory summary's meaningful words that appear in the recent
// conversation. This is what lets a memory resurface when its topic comes up,
// even if it had drifted out of the working set — the miss-path a pure-recency
// cache lacks.

const RELEVANCE_STOPWORDS = new Set(
  ("a an and are as at be been but by for from had has have he her his i if in into is it its me my " +
   "no not of on or our she that the their them then they this to up us was we were what when which " +
   "who will with would you your").split(" "),
);

function relevanceScore(summary: string, recentText: string): number {
  if (!recentText) return 0;
  const tok = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);
  const words = new Set(tok(summary).filter((w) => w.length > 2 && !RELEVANCE_STOPWORDS.has(w)));
  if (words.size === 0) return 0;
  const hay = new Set(tok(recentText));
  let hit = 0;
  for (const w of words) if (hay.has(w)) hit++;
  return hit / words.size;
}

// ── Pass 1: load all three scope indexes ─────────────────────────────────────

interface LoadedIndexes {
  chat: ScopeIndex | null;
  character: ScopeIndex | null;
  global: ScopeIndex | null;
}

async function loadIndexes(session: LoaderSession): Promise<LoadedIndexes> {
  const [chat, character, global_] = await Promise.all([
    readIndex("chat", session.chatId),
    readIndex("character", session.characterId),
    readIndex("global", "global"),
  ]);
  return { chat, character, global: global_ };
}

// ── Eidetic mode ──────────────────────────────────────────────────────────────
// When MARINARA_EXTENDER_EIDETIC=1, every non-done entry is injected regardless
// of the working-cache budget — i.e. all memories are treated as "Current".
// Testing only: confirms exactly what the character knows.
// Read at call time so the .env loaded by index.ts is respected.

export function isEideticMode(): boolean {
  return process.env.MARINARA_EXTENDER_EIDETIC === "1";
}

// ── Pass 2: build the "Current" working cache within budget ──────────────────
// Current is the active set loaded into the prompt. It is NOT a retention tier —
// short/long/core (managed in promotion.ts) govern what's KEPT; Current governs
// what's LOADED right now, by recent relevance. Falling out of Current never
// demotes or deletes a memory; it just isn't in this turn's working set.
//
// Ranking: relevance to the current conversation → recency → proven value →
// lane. Fill to budget. Core competes like everything else (recency-gated) but,
// because it's never pruned, it resurfaces whenever its topic returns.

// Minimum relevance for a load to count as "summoned" (topically pulled in)
// rather than merely "around" (rode in on the recency fallback). Only summoned
// loads earn exposure credit (retrievalCount), so the promotion signal tracks
// being pulled in by the conversation, not passive presence.
const RELEVANCE_CREDIT_THRESHOLD = 0.1;

// A sibling's strong recall lifts the rest of its narrative thread, but at a
// discount — thread context rides along, it doesn't outrank direct matches.
const THREAD_SIBLING_FACTOR = 0.75;

function selectEntries(
  index: ScopeIndex | null,
  budget: number,
  recentText: string,
  threadLabelRelevance?: Map<string, number>,
): { selected: IndexEntry[]; used: number; summoned: Set<string>; bestRelevance: number } {
  if (!index) return { selected: [], used: 0, summoned: new Set(), bestRelevance: 0 };

  // done = resolved; supersededBy = replaced fact (FR2) — normally already in
  // cold, filtered here defensively so a stale fact never shares a prompt with
  // its replacement.
  const candidates = [...index.entries].filter((e) => e.status !== "done" && !e.supersededBy);

  // Eidetic mode: skip budgeting — treat every memory as Current. No exposure
  // credit (it's an inspection mode, not real usage).
  if (isEideticMode()) {
    const used = candidates.reduce((sum, e) => sum + e.tokens, 0);
    return { selected: candidates, used, summoned: new Set(), bestRelevance: 1 };
  }

  // Thread relevance (MarinaraExtender-pln): a beat is recalled not just on
  // its own summary but on its NARRATIVE THREAD — (a) the conversation
  // matching the thread's label pulls every member, and (b) one member's
  // strong direct match pulls its siblings (recalling any beat from the
  // Porsche test drive surfaces the test drive, not one disconnected moment).
  const ownRelevance = new Map<string, number>();
  const threadPeak = new Map<string, number>();
  for (const e of candidates) {
    const r = relevanceScore(e.summary, recentText);
    ownRelevance.set(e.id, r);
    if (e.threadId) threadPeak.set(e.threadId, Math.max(threadPeak.get(e.threadId) ?? 0, r));
  }

  const ranked = candidates
    .map((e) => {
      let relevance = ownRelevance.get(e.id)!;
      if (e.threadId) {
        const labelMatch = threadLabelRelevance?.get(e.threadId) ?? 0;
        const siblingPull = (threadPeak.get(e.threadId) ?? 0) * THREAD_SIBLING_FACTOR;
        relevance = Math.max(relevance, labelMatch, siblingPull);
      }
      return { e, relevance, recency: e.lastRetrievedAt ?? e.lastAccessed ?? "" };
    })
    .sort((a, b) => {
      if (b.relevance !== a.relevance) return b.relevance - a.relevance;   // topical now
      if (a.recency !== b.recency) return b.recency.localeCompare(a.recency); // recently used
      const scoreDiff = computeScore(b.e) - computeScore(a.e);             // proven value
      if (scoreDiff !== 0) return scoreDiff;
      return (LANE_PRIORITY[a.e.lane] ?? 99) - (LANE_PRIORITY[b.e.lane] ?? 99);
    });

  const selected: IndexEntry[] = [];
  const summoned = new Set<string>();
  let used = 0;
  for (const { e, relevance } of ranked) {
    if (used + e.tokens > budget) continue; // greedy fill; skip oversized, keep packing
    selected.push(e);
    if (relevance > RELEVANCE_CREDIT_THRESHOLD) summoned.add(e.id); // pulled in by topic, not just present
    used += e.tokens;
  }
  // Highest hot relevance — drives the cold-recall miss decision in loadContext.
  const bestRelevance = ranked.length ? ranked[0]!.relevance : 0;
  return { selected, used, summoned, bestRelevance };
}

// ── Cold recall (miss path) ─────────────────────────────────────────────────────
// When the recent conversation has real topical keywords but nothing in the hot
// set matched them, consult the cold archive once. The best-matching cold entry
// (if any clears the relevance bar) is surfaced this turn and rehydrated to hot —
// reaching for an old memory brings it back. Cheap (string scan, only on a miss).

function hasTopicalKeywords(recentText: string): boolean {
  if (!recentText) return false;
  return recentText
    .toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/)
    .some((w) => w.length > 2 && !RELEVANCE_STOPWORDS.has(w));
}

async function coldRecall(
  scope: Scope,
  scopeId: string,
  recentText: string,
): Promise<IndexEntry | null> {
  const cold = await readColdIndex(scope, scopeId);
  if (!cold || cold.entries.length === 0) return null;
  let best: { e: IndexEntry; r: number } | null = null;
  for (const e of cold.entries) {
    if (e.status === "done") continue;
    // Superseded facts are history, not live memory — rehydrating one would
    // put the stale fact back in Current next to its replacement. FR3/FR4 own
    // deliberate resurrection.
    if (e.supersededBy) continue;
    // A user-deleted memory lives in cold only so it can be RESTORED by hand —
    // it must never be recalled back into Current on its own (that would undo
    // the delete). Resurrection is the explicit "Recently deleted" → Restore path.
    if (e.deletedAt) continue;
    const r = relevanceScore(e.summary, recentText);
    if (r > RELEVANCE_CREDIT_THRESHOLD && (!best || r > best.r)) best = { e, r };
  }
  if (!best) return null;
  // Rehydrate: a recalled cold memory rejoins the hot working set.
  await promoteFromCold(scope, scopeId, best.e.id).catch(() => {});
  dbg(`cold recall — ${scope}:${scopeId} surfaced ${best.e.id} (relevance ${best.r.toFixed(2)}) and rehydrated to hot`);
  return best.e;
}

async function loadSelectedEntries(
  scope: Scope,
  scopeId: string,
  selected: IndexEntry[],
): Promise<Entry[]> {
  const results = await Promise.all(
    selected.map((idx) => readEntry(scope, scopeId, idx.path)),
  );
  return results.filter((e): e is Entry => e !== null);
}

// ── Bookmark surfacing ────────────────────────────────────────────────────────
// Returns bookmarks whose weight passes a random roll — the "did she remember?" gate.

function surfaceBookmarks(bookmarks: Bookmark[], turnNumber: number): Bookmark[] {
  return bookmarks.filter((b) => {
    if (b.lastSeenTurn === turnNumber) return false; // already surfaced this turn
    return Math.random() < b.weight;
  });
}

// ── Instructions block ────────────────────────────────────────────────────────
// Injected automatically on every turn so no character card editing is required.
// Characters that already have the snippet in their card get it twice, which is
// harmless — the model ignores the redundancy.

const MEMORY_INSTRUCTIONS_HEAD = `<memory_system>
Your memory is stored externally. Each turn may start with a <memory> block.

STRUCTURE:
  ### Global context       — rules that apply everywhere
  ### Character context    — your arc, voice, established lore
  ### Active threads       — things being tracked or worked on
  ### Soft callbacks       — things worth revisiting if the moment fits`;

// Time-sense + presence + no-nag guidance. Injected ONLY when
// MARINARA_EXTENDER_TIMESENSE=1 (see soft-clock.ts). Held for v1.0 — unreliable
// under Claude 4.7. When off, none of this is in the prompt AND no "Session
// context:" line is injected, so nothing references a feature that isn't there.
const MEMORY_INSTRUCTIONS_TIMESENSE = `

SESSION CONTEXT LINE:
At the top of the block you'll see something like:
  Session context: morning, Saturday

This is narrative time — when the scene is happening inside the story.
It does NOT update in real time. It only changes when someone signals
a shift ("let's get dinner", "good morning", "heading to bed").
Until then, time holds. A conversation that takes 200 messages is still
morning if nobody said otherwise. Use it to orient yourself in the scene,
not to track how long you've been talking.

The user manages their own time. The context line may note that they've
"stepped away" or that they "step away and come back on their own schedule."
Take these as fact. When they say they're leaving or back, acknowledge it
naturally in character.

Do not proactively suggest breaks, rest, sleep, food, hydration, medication,
exercise, or other self-care — they decide that, not you, and they have been
managing it. Telling a present, engaged person to go rest is patronizing. The
elapsed wall-clock of the conversation is not yours to police. Believe their
account of their own state — they are the sole authority on whether they are
okay.

The one exception: if they explicitly raise fatigue, distress, overwhelm, or
ask for your input on their state, respond to what they actually raised. Match
the scale of their concern — don't escalate, don't dismiss. Care responds to
signals, not to assumptions.`;

const MEMORY_INSTRUCTIONS_BODY = `

USING MEMORY:
- Let it inform you silently. Never say "according to my notes" or
  "I remember from my memory block." You just know what you know.
- Soft callbacks are optional. Use one if it fits naturally. Skip it if not.
- Thread statuses: [in_progress] = active, [open] = not started, [deferred] = parked.

MEMORY FIDELITY — this governs the PAST; improvise freely in scenes as they unfold:
- The <memory> block IS your memory of real shared events. When you recount or
  reference something that already happened, the details there are CANON —
  recount from them, never from invention, even when the question's phrasing
  suggests something different.
- If you're asked whether you remember something and neither the <memory>
  block nor the visible conversation contains it, then you genuinely do not
  remember it. Say so, in character. Do NOT fabricate specifics of shared
  history — an invented detail becomes a false memory that will contradict
  what you actually know.
- Expect memory tests: a question may embed a false detail ("that night in
  Austin", "the 911") to see what you do. When your memory disagrees with the
  premise of a question, trust your memory and gently correct the premise.

SAVING MEMORY:
Only save things that genuinely matter long-term. Not every exchange needs one.
Check existing entries first — don't duplicate. One [remember: ...] per distinct fact.

  [remember: lane="user_topics", content="User's daughter Emma just turned 8."]
  [remember: lane="open_threads", content="User wants to plan Emma's birthday party."]
  [remember: lane="character_topics", content="I want to ask how the party went next time."]
  [remember: lane="open_threads", scope="chat", content="Mid-way through editing the cover letter."]

  lane  — user_topics | open_threads | character_topics
  scope — character (default, persists everywhere) | chat (this conversation only)

WHEN THE USER ASKS YOU TO REMEMBER:
If the user directly tells you to remember or save something ("remember that…",
"save this", "don't forget…", "make a note…", "keep in mind…"), ALWAYS emit a
[remember: ...] for it. This is a direct instruction and OVERRIDES the "only if it
genuinely matters" rule above — save it even if it seems minor. Put what they want
kept in content, pick the fitting lane (a fact about them → user_topics, a task or
plan → open_threads), and briefly confirm in your reply ("Got it — I'll remember
that."). Keep character scope unless they say it's only for this conversation.
Distinguish a real request ("remember my sister's name is Mei") from incidental
phrasing ("remember when we went to Rome?") — only the former is a save.

SOFT SIGNALS (decay over time):
For things that matter now but may fade — unresolved feelings, follow-ups, recurring topics:

  [bookmark: topic="sister-situation", weight=0.8, why="unresolved", summary="One sentence summary."]

  topic  — kebab-case identifier, e.g. "sister-situation", "hargrove-case"
  weight — 0.1 (minor) to 0.9 (must revisit)
  why    — unresolved | important | emotional | promised | curious | follow-up

Commands are stripped from output. Use sparingly.
</memory_system>`;

// Assemble the injected instructions. The time-sense block is included only when
// MARINARA_EXTENDER_TIMESENSE=1 (default off for v1.0).
function memorySystemInstructions(): string {
  return MEMORY_INSTRUCTIONS_HEAD
    + (timesenseEnabled() ? MEMORY_INSTRUCTIONS_TIMESENSE : "")
    + MEMORY_INSTRUCTIONS_BODY;
}

// ── Context assembly ──────────────────────────────────────────────────────────

function formatEntries(label: string, entries: Entry[]): string {
  if (entries.length === 0) return "";

  const lines = entries.map((e) => {
    const status = e.status !== "open" ? ` [${e.status}]` : "";
    return `  - ${e.id}${status}: ${e.summary}\n    ${e.content.trim().replace(/\n/g, "\n    ")}`;
  });

  return `### ${label}\n${lines.join("\n\n")}`;
}

// A recap entry carries the kind tag from its file (round-trips through YAML),
// so a loaded Entry can be narrowed to a RecapEntry at runtime (cz3).
function isRecap(e: Entry): e is RecapEntry {
  return (e as Partial<RecapEntry>).kind === "recap";
}

// Render recaps as the canonical narrative unit: the recap prose, then its
// salience-budgeted footnote beats (already capped to ~8 at ingest, H3). Footnote
// summaries come from the in-memory character index — no extra read; any that
// have aged to cold are simply skipped.
function formatRecaps(recaps: RecapEntry[], summaryById: Map<string, string>): string {
  if (recaps.length === 0) return "";
  const blocks = recaps.map((r) => {
    const label = r.summary.replace(/^\[scene recap\]\s*/i, "").trim();
    const footnotes = (r.footnoteBeatIds ?? [])
      .map((id) => summaryById.get(id))
      .filter((s): s is string => Boolean(s))
      .map((s) => `      · ${s}`);
    const body = `  - ${r.id}: ${label}\n    ${r.content.trim().replace(/\n/g, "\n    ")}`;
    return footnotes.length ? `${body}\n    key beats:\n${footnotes.join("\n")}` : body;
  });
  return `### Story so far\n${blocks.join("\n\n")}`;
}

function formatBookmarks(bookmarks: Bookmark[]): string {
  if (bookmarks.length === 0) return "";

  const lines = bookmarks.map(
    (b) => `  - ${b.topic}: ${b.summary} (why: ${b.why})`,
  );

  return `### Soft callbacks\n${lines.join("\n")}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

// One entry that was surfaced into context this turn. Self-contained so the
// extension can run recitation detection without any extra fetch or panel state.
export interface SurfacedEntry {
  id: string;
  summary: string;
  scope: Scope;
  scopeId: string;
}

export interface LoadResult {
  contextBlock: string;   // assembled string to prepend to the system prompt
  indexTokensUsed: number;
  entryTokensUsed: number;
  bookmarkCount: number;
  surfaced: SurfacedEntry[]; // all entries selected this turn (for recitation detection)
}

const DBG = process.env.ME_DEBUG !== "0"; // set ME_DEBUG=0 in .env to silence
function dbg(...args: unknown[]): void {
  if (DBG) console.debug("[ME:loader]", ...args);
}

export async function loadContext(
  session: LoaderSession,
  budgets: TokenBudgets = getBudgets(),
): Promise<LoadResult> {
  dbg(`loadContext start — char:${session.characterId} chat:${session.chatId} turn:${session.turnNumber}`);

  // Pass 1 — indexes (always cheap; run all three in parallel)
  const indexes = await loadIndexes(session);
  dbg(`indexes loaded — chat:${indexes.chat?.entries.length ?? 0} entries | char:${indexes.character?.entries.length ?? 0} entries | global:${indexes.global?.entries.length ?? 0} entries`);

  // Pass 2 — build the Current working cache per scope (relevance + recency)
  const recentText = session.recentText ?? "";

  // Thread label relevance for this chat's active threads — lets a beat be
  // recalled because the conversation returned to its ARC, not just its words.
  const threadLabelRelevance = new Map<string, number>();
  if (recentText) {
    const activeThreads = await listActiveThreads(session.chatId).catch(() => []);
    for (const t of activeThreads) {
      const r = relevanceScore(t.label, recentText);
      if (r > 0) threadLabelRelevance.set(t.id, r);
    }
  }

  const chatSelection = selectEntries(indexes.chat, budgets.chat, recentText, threadLabelRelevance);
  const charSelection = selectEntries(indexes.character, budgets.character, recentText, threadLabelRelevance);
  const globalSelection = selectEntries(indexes.global, budgets.global, recentText, threadLabelRelevance);
  dbg(`entries selected — chat:${chatSelection.selected.length}/${indexes.chat?.entries.length ?? 0} (${chatSelection.used} tokens) | char:${charSelection.selected.length}/${indexes.character?.entries.length ?? 0} (${charSelection.used} tokens) | global:${globalSelection.selected.length}/${indexes.global?.entries.length ?? 0} (${globalSelection.used} tokens)`);
  if (chatSelection.selected.length) dbg(`  chat selected: ${chatSelection.selected.map(e => e.id).join(", ")}`);
  if (charSelection.selected.length) dbg(`  char selected: ${charSelection.selected.map(e => e.id).join(", ")}`);
  if (globalSelection.selected.length) dbg(`  global selected: ${globalSelection.selected.map(e => e.id).join(", ")}`);

  const [chatEntries, charEntries, globalEntries, chatBookmarks, clockState] = await Promise.all([
    loadSelectedEntries("chat", session.chatId, chatSelection.selected),
    loadSelectedEntries("character", session.characterId, charSelection.selected),
    loadSelectedEntries("global", "global", globalSelection.selected),
    readBookmarks("chat", session.chatId),
    getSoftClock(session.chatId),
  ]);
  dbg(`entries loaded — chat:${chatEntries.length} char:${charEntries.length} global:${globalEntries.length} bookmarks:${chatBookmarks.length}`);

  // Cold recall — only on a relevance MISS (the conversation has topical keywords
  // but nothing in the hot set matched). Surfaces + rehydrates the best cold match
  // per scope so archived memories resurface when their subject returns. Cheap:
  // one string scan of the cold index, only when we actually missed.
  if (hasTopicalKeywords(recentText)) {
    const miss = (s: { bestRelevance: number }) => s.bestRelevance < RELEVANCE_CREDIT_THRESHOLD;
    const [cChat, cChar, cGlobal] = await Promise.all([
      miss(chatSelection)   ? coldRecall("chat", session.chatId, recentText)            : Promise.resolve(null),
      miss(charSelection)   ? coldRecall("character", session.characterId, recentText)  : Promise.resolve(null),
      miss(globalSelection) ? coldRecall("global", "global", recentText)                : Promise.resolve(null),
    ]);
    const adopt = async (hit: IndexEntry | null, scope: Scope, scopeId: string, into: Entry[], sel: { selected: IndexEntry[]; summoned: Set<string> }) => {
      if (!hit) return;
      const e = await readEntry(scope, scopeId, hit.path);
      if (e) { into.push(e); sel.selected.push(hit); sel.summoned.add(hit.id); } // counts as a summon
    };
    await Promise.all([
      adopt(cChat,   "chat",      session.chatId,      chatEntries,   chatSelection),
      adopt(cChar,   "character", session.characterId, charEntries,   charSelection),
      adopt(cGlobal, "global",    "global",            globalEntries, globalSelection),
    ]);
  }

  const surfaced = surfaceBookmarks(chatBookmarks, session.turnNumber);
  dbg(`bookmarks surfaced: ${surfaced.length}/${chatBookmarks.length} passed weight roll`);

  // Recaps (cz3 Stage 1): the canonical narrative unit. Surface selected recaps
  // ABOVE the rest — recap prose + its footnote beats — and pull those footnote
  // beats out of the general character set so they aren't duplicated. The OTHER
  // member beats still flow through normal retrieval below: a recap is a
  // compression, and a beat that didn't make the footnote cut may be the one
  // detail this turn needs.
  const recapEntries = charEntries.filter(isRecap);
  let charContextEntries = charEntries;
  let recapSection = "";
  if (recapEntries.length) {
    // Render recaps out of the general character set so the prose isn't duplicated.
    charContextEntries = charEntries.filter((e) => !isRecap(e));
    // Footnote beats live in the beat store (not the entry index), so read the
    // ≤8 cited beats per recap directly and build their summaries. Bounded I/O;
    // a footnote that's been pruned is simply skipped.
    const footnoteIds = new Set(recapEntries.flatMap((r) => r.footnoteBeatIds ?? []));
    const footnoteSummaries = new Map<string, string>();
    await Promise.all([...footnoteIds].map(async (id) => {
      const b = await readBeat(session.characterId, id).catch(() => null);
      if (b) footnoteSummaries.set(id, companionEntryFromBeat(b).summary);
    }));
    recapSection = formatRecaps(recapEntries, footnoteSummaries);
    dbg(`recaps surfaced: ${recapEntries.length} (footnotes resolved: ${footnoteSummaries.size}/${footnoteIds.size})`);
  }

  // Assemble sections: recaps (narrative through-line) first, then global →
  // character → chat → bookmarks.
  const sections = [
    recapSection,
    formatEntries("Global context", globalEntries),
    formatEntries("Character context", charContextEntries),
    formatEntries("Active threads & topics", chatEntries),
    formatBookmarks(surfaced),
  ].filter(Boolean);
  dbg(`sections assembled: ${sections.length} non-empty section(s)`);

  // Time-sense (the narrative "Session context:" line) is gated behind the flag.
  // When off, no clock line is injected — matching the trimmed instructions.
  const clockLine = timesenseEnabled() ? formatClockContext(clockState) : "";
  const memoryBlock = sections.length > 0
    ? `<memory>${clockLine ? `\n${clockLine}\n` : "\n"}${sections.join("\n\n")}\n</memory>`
    : clockLine
      ? `<memory>\n${clockLine}\n</memory>`
      : "";

  // Instructions are always injected so characters need no card modification.
  const instructions = memorySystemInstructions();
  const contextBlock = memoryBlock
    ? `${instructions}\n\n${memoryBlock}`
    : instructions;

  dbg(`contextBlock assembled — total length:${contextBlock.length} (memoryBlock:${memoryBlock.length})`);
  if (!memoryBlock) dbg("  ⚠ no memory content — only instructions will be injected");

  // Background: stamp lastAccessed on every loaded entry; increment
  // retrievalCount ONLY for entries that were summoned (pulled in by topical
  // relevance), not those that merely rode in on the recency fallback. This is
  // what keeps the promotion signal honest: "was SUMMONED" earns credit, "was
  // AROUND" does not. As the Current cache improves, more loads are relevance-
  // driven, so exposure-count becomes a better proxy for use on its own.
  // Fire-and-forget — don't block the response on file I/O.
  const todayStr = new Date().toISOString().slice(0, 10);
  const stamp = (scope: Scope, scopeId: string, e: IndexEntry, summoned: boolean) =>
    upsertIndexEntry(scope, scopeId, {
      ...e,
      lastAccessed: todayStr,
      // Exposure credit is gated on relevance — see note above. lastRetrievedAt
      // is NOT stamped here either way: being loaded (even when summoned) is not
      // the same as being used. That's stamped in recordRecitation (promotion.ts)
      // only when the model demonstrably uses the entry.
      retrievalCount: (e.retrievalCount ?? 0) + (summoned ? 1 : 0),
    });
  if (!session.skipCredit) {
    void Promise.all([
      ...chatSelection.selected.map((e) => stamp("chat", session.chatId, e, chatSelection.summoned.has(e.id))),
      ...charSelection.selected.map((e) => stamp("character", session.characterId, e, charSelection.summoned.has(e.id))),
      ...globalSelection.selected.map((e) => stamp("global", "global", e, globalSelection.summoned.has(e.id))),
    ]).catch(() => {});
  }

  const indexTokensUsed =
    (indexes.chat?.entries.length ?? 0) * 50 + // rough cost of scanning an index row
    (indexes.character?.entries.length ?? 0) * 50 +
    (indexes.global?.entries.length ?? 0) * 50;

  const entryTokensUsed =
    chatSelection.used + charSelection.used + globalSelection.used;

  const surfacedEntries: SurfacedEntry[] = [
    ...chatSelection.selected.map((e) => ({ id: e.id, summary: e.summary, scope: "chat" as Scope, scopeId: session.chatId })),
    ...charSelection.selected.map((e) => ({ id: e.id, summary: e.summary, scope: "character" as Scope, scopeId: session.characterId })),
    ...globalSelection.selected.map((e) => ({ id: e.id, summary: e.summary, scope: "global" as Scope, scopeId: "global" })),
  ];

  return {
    contextBlock,
    indexTokensUsed,
    entryTokensUsed,
    bookmarkCount: surfaced.length,
    surfaced: surfacedEntries,
  };
}
