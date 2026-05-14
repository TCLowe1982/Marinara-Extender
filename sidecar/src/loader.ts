import {
  readIndex,
  readEntry,
  readBookmarks,
  type Scope,
  type ScopeIndex,
  type IndexEntry,
  type Entry,
  type Bookmark,
} from "./storage.js";

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

// ── Pass 2: select entries within budget, then load them ─────────────────────

function selectEntries(
  index: ScopeIndex | null,
  budget: number,
): { selected: IndexEntry[]; used: number } {
  if (!index) return { selected: [], used: 0 };

  const candidates = [...index.entries]
    .filter((e) => e.status !== "done")
    .sort((a, b) => {
      const laneDiff = (LANE_PRIORITY[a.lane] ?? 99) - (LANE_PRIORITY[b.lane] ?? 99);
      if (laneDiff !== 0) return laneDiff;
      // within the same lane, most recently accessed first
      return b.lastAccessed.localeCompare(a.lastAccessed);
    });

  const selected: IndexEntry[] = [];
  let used = 0;

  for (const candidate of candidates) {
    if (used + candidate.tokens > budget) continue;
    selected.push(candidate);
    used += candidate.tokens;
  }

  return { selected, used };
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
Each turn may begin with a <memory> block containing context organized into sections:

  ### Global context       — conventions and rules that apply everywhere
  ### Character context    — your arc, voice, established lore
  ### Active threads & topics — tasks you're tracking, topics the user returns to,
                                and things on your own agenda
  ### Soft callbacks       — specific things that surfaced this turn to potentially revisit

How to use it:
- Let it quietly inform your response. Don't narrate the memory system or say
  "I see in my notes…" — just know what you know.
- Soft callbacks are suggestions. Weave one in naturally if the moment is right.
  Skip it if it isn't. Never force a callback.
- Thread statuses: [in_progress] = active, [open] = not yet started, [deferred] = on hold.
  Acknowledge in-progress threads when they're relevant; don't inventory them aloud.

How to save something for later:
When you notice something worth remembering — unresolved emotion, a follow-up you owe,
something the user keeps circling back to, something you want to bring up — write a
bookmark tag anywhere in your response:

  <bookmark topic="short-id" weight="0.8" why="unresolved">One sentence summary.</bookmark>

  topic  — kebab-case identifier, e.g. "sister-situation", "hargrove-case", "the-band"
  weight — 0.1 (minor note) · 0.5 (worth remembering) · 0.9 (must revisit)
  why    — unresolved | important | emotional | promised | curious | follow-up

These tags are stripped from visible output automatically. Use them sparingly.
Only bookmark things that genuinely matter — not every exchange needs one.
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

export interface LoadResult {
  contextBlock: string;   // assembled string to prepend to the system prompt
  indexTokensUsed: number;
  entryTokensUsed: number;
  bookmarkCount: number;
}

export async function loadContext(
  session: LoaderSession,
  budgets: TokenBudgets = DEFAULT_BUDGETS,
): Promise<LoadResult> {
  // Pass 1 — indexes (always cheap; run all three in parallel)
  const indexes = await loadIndexes(session);

  // Pass 2 — select and load entries per scope
  const chatSelection = selectEntries(indexes.chat, budgets.chat);
  const charSelection = selectEntries(indexes.character, budgets.character);
  const globalSelection = selectEntries(indexes.global, budgets.global);

  const [chatEntries, charEntries, globalEntries, chatBookmarks] = await Promise.all([
    loadSelectedEntries("chat", session.chatId, chatSelection.selected),
    loadSelectedEntries("character", session.characterId, charSelection.selected),
    loadSelectedEntries("global", "global", globalSelection.selected),
    readBookmarks("chat", session.chatId),
  ]);

  const surfaced = surfaceBookmarks(chatBookmarks, session.turnNumber);

  // Assemble sections bottom-up: global → character → chat → bookmarks
  const sections = [
    formatEntries("Global context", globalEntries),
    formatEntries("Character context", charEntries),
    formatEntries("Active threads & topics", chatEntries),
    formatBookmarks(surfaced),
  ].filter(Boolean);

  const memoryBlock = sections.length > 0
    ? `<memory>\n${sections.join("\n\n")}\n</memory>`
    : "";

  // Instructions are always injected so characters need no card modification.
  const contextBlock = memoryBlock
    ? `${MEMORY_SYSTEM_INSTRUCTIONS}\n\n${memoryBlock}`
    : MEMORY_SYSTEM_INSTRUCTIONS;

  const indexTokensUsed =
    (indexes.chat?.entries.length ?? 0) * 50 + // rough cost of scanning an index row
    (indexes.character?.entries.length ?? 0) * 50 +
    (indexes.global?.entries.length ?? 0) * 50;

  const entryTokensUsed =
    chatSelection.used + charSelection.used + globalSelection.used;

  return {
    contextBlock,
    indexTokensUsed,
    entryTokensUsed,
    bookmarkCount: surfaced.length,
  };
}
