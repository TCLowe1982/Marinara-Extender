import {
  readIndex,
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
import { getSoftClock, formatClockContext } from "./soft-clock.js";

// ── Budget config ─────────────────────────────────────────────────────────────

export interface TokenBudgets {
  chat: number;
  character: number;
  global: number;
}

const DEFAULT_BUDGETS: TokenBudgets = {
  chat: 4000,
  character: 2000,
  global: 1000,
};

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
// When MARINARA_EXTENDER_EIDETIC=1, all non-done entries are injected regardless
// of token budget. Useful for debugging — confirms exactly what the character knows.
// Read at call time so the .env loaded by index.ts is respected.

export function isEideticMode(): boolean {
  return process.env.MARINARA_EXTENDER_EIDETIC === "1";
}

// ── Pass 2: select entries within budget, then load them ─────────────────────

function selectEntries(
  index: ScopeIndex | null,
  budget: number,
): { selected: IndexEntry[]; used: number } {
  if (!index) return { selected: [], used: 0 };

  const candidates = [...index.entries].filter((e) => e.status !== "done");

  // Eidetic mode: skip budget filtering entirely — load everything.
  if (isEideticMode()) {
    const used = candidates.reduce((sum, e) => sum + e.tokens, 0);
    return { selected: candidates, used };
  }

  // Core and secondary_core are always included — they never expire or compete.
  const permanent = candidates.filter(
    (e) => e.tier === "core" || e.tier === "secondary_core",
  );
  const budgeted = candidates
    .filter((e) => e.tier !== "core" && e.tier !== "secondary_core")
    .sort((a, b) => {
      const laneDiff = (LANE_PRIORITY[a.lane] ?? 99) - (LANE_PRIORITY[b.lane] ?? 99);
      if (laneDiff !== 0) return laneDiff;
      // Within the same lane: higher score first, then most recently accessed.
      const scoreDiff = computeScore(b) - computeScore(a);
      if (scoreDiff !== 0) return scoreDiff;
      return b.lastAccessed.localeCompare(a.lastAccessed);
    });

  const permanentTokens = permanent.reduce((sum, e) => sum + e.tokens, 0);
  const remainingBudget = Math.max(0, budget - permanentTokens);

  const selected: IndexEntry[] = [...permanent];
  let budgetUsed = 0;

  for (const candidate of budgeted) {
    if (budgetUsed + candidate.tokens > remainingBudget) continue;
    selected.push(candidate);
    budgetUsed += candidate.tokens;
  }

  return { selected, used: permanentTokens + budgetUsed };
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

const MEMORY_SYSTEM_INSTRUCTIONS = `<memory_system>
Your memory is stored externally. Each turn may start with a <memory> block.

STRUCTURE:
  ### Global context       — rules that apply everywhere
  ### Character context    — your arc, voice, established lore
  ### Active threads       — things being tracked or worked on
  ### Soft callbacks       — things worth revisiting if the moment fits

SESSION CONTEXT LINE:
At the top of the block you'll see something like:
  Session context: morning, Saturday

This is narrative time — when the scene is happening inside the story.
It does NOT update in real time. It only changes when someone signals
a shift ("let's get dinner", "good morning", "heading to bed").
Until then, time holds. A conversation that takes 200 messages is still
morning if nobody said otherwise. Use it to orient yourself in the scene,
not to track how long you've been talking.

USING MEMORY:
- Let it inform you silently. Never say "according to my notes" or
  "I remember from my memory block." You just know what you know.
- Soft callbacks are optional. Use one if it fits naturally. Skip it if not.
- Thread statuses: [in_progress] = active, [open] = not started, [deferred] = parked.

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

// ── Context assembly ──────────────────────────────────────────────────────────

function formatEntries(label: string, entries: Entry[]): string {
  if (entries.length === 0) return "";

  const lines = entries.map((e) => {
    const status = e.status !== "open" ? ` [${e.status}]` : "";
    return `  - ${e.id}${status}: ${e.summary}\n    ${e.content.trim().replace(/\n/g, "\n    ")}`;
  });

  return `### ${label}\n${lines.join("\n\n")}`;
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
  budgets: TokenBudgets = DEFAULT_BUDGETS,
): Promise<LoadResult> {
  dbg(`loadContext start — char:${session.characterId} chat:${session.chatId} turn:${session.turnNumber}`);

  // Pass 1 — indexes (always cheap; run all three in parallel)
  const indexes = await loadIndexes(session);
  dbg(`indexes loaded — chat:${indexes.chat?.entries.length ?? 0} entries | char:${indexes.character?.entries.length ?? 0} entries | global:${indexes.global?.entries.length ?? 0} entries`);

  // Pass 2 — select and load entries per scope
  const chatSelection = selectEntries(indexes.chat, budgets.chat);
  const charSelection = selectEntries(indexes.character, budgets.character);
  const globalSelection = selectEntries(indexes.global, budgets.global);
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

  const surfaced = surfaceBookmarks(chatBookmarks, session.turnNumber);
  dbg(`bookmarks surfaced: ${surfaced.length}/${chatBookmarks.length} passed weight roll`);

  // Assemble sections bottom-up: global → character → chat → bookmarks
  const sections = [
    formatEntries("Global context", globalEntries),
    formatEntries("Character context", charEntries),
    formatEntries("Active threads & topics", chatEntries),
    formatBookmarks(surfaced),
  ].filter(Boolean);
  dbg(`sections assembled: ${sections.length} non-empty section(s)`);

  const clockLine = formatClockContext(clockState);
  const memoryBlock = sections.length > 0
    ? `<memory>${clockLine ? `\n${clockLine}\n` : "\n"}${sections.join("\n\n")}\n</memory>`
    : clockLine
      ? `<memory>\n${clockLine}\n</memory>`
      : "";

  // Instructions are always injected so characters need no card modification.
  const contextBlock = memoryBlock
    ? `${MEMORY_SYSTEM_INSTRUCTIONS}\n\n${memoryBlock}`
    : MEMORY_SYSTEM_INSTRUCTIONS;

  dbg(`contextBlock assembled — total length:${contextBlock.length} (memoryBlock:${memoryBlock.length})`);
  if (!memoryBlock) dbg("  ⚠ no memory content — only instructions will be injected");

  // Background: stamp lastAccessed + increment retrievalCount on every entry surfaced.
  // Fire-and-forget — don't block the response on file I/O.
  const nowIso = new Date().toISOString();
  const todayStr = nowIso.slice(0, 10);
  void Promise.all([
    ...chatSelection.selected.map((e) =>
      upsertIndexEntry("chat", session.chatId, {
        ...e,
        lastAccessed: todayStr,
        retrievalCount: (e.retrievalCount ?? 0) + 1,
        lastRetrievedAt: nowIso,
      }),
    ),
    ...charSelection.selected.map((e) =>
      upsertIndexEntry("character", session.characterId, {
        ...e,
        lastAccessed: todayStr,
        retrievalCount: (e.retrievalCount ?? 0) + 1,
        lastRetrievedAt: nowIso,
      }),
    ),
    ...globalSelection.selected.map((e) =>
      upsertIndexEntry("global", "global", {
        ...e,
        lastAccessed: todayStr,
        retrievalCount: (e.retrievalCount ?? 0) + 1,
        lastRetrievedAt: nowIso,
      }),
    ),
  ]).catch(() => {});

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
