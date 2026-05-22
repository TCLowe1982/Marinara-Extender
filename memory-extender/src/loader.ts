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

  const candidates = [...index.entries]
    .filter((e) => e.status !== "done")
    .sort((a, b) => {
      const laneDiff = (LANE_PRIORITY[a.lane] ?? 99) - (LANE_PRIORITY[b.lane] ?? 99);
      if (laneDiff !== 0) return laneDiff;
      // within the same lane, most recently accessed first
      return b.lastAccessed.localeCompare(a.lastAccessed);
    });

  // Eidetic mode: skip budget filtering entirely — load everything.
  if (isEideticMode()) {
    const used = candidates.reduce((sum, e) => sum + e.tokens, 0);
    return { selected: candidates, used };
  }

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

How to save something permanently (ledger entry — no decay):
BEFORE writing a [remember: ...] command, check the entries already in this block:
  - If the topic is already captured under the same lane, do NOT re-save it.
    Duplicates are pruned automatically, but it still wastes a turn. One entry
    per topic is enough.
  - Use ONE [remember: ...] command per distinct fact. Do not bundle multiple topics.

Use [remember: ...] when something is genuinely worth keeping long-term:

  [remember: lane="user_topics", content="User's daughter Emma just turned 8."]
  [remember: lane="open_threads", content="User wants to plan Emma's birthday party."]
  [remember: lane="character_topics", content="I want to ask how the party went next time."]
  [remember: lane="user_topics", scope="character", content="User hates surprises — noted for all chats."]

  lane  — user_topics (facts about the user) · open_threads (tasks to track) ·
          character_topics (things you want to bring up)
  scope — chat (this conversation only, default) · character (all future chats with this user)

How to save a soft signal (decays over time):
For things that matter right now but may fade naturally — unresolved emotion,
a follow-up you owe, something the user keeps circling back to:

  [bookmark: topic="sister-situation", weight=0.8, why="unresolved", summary="One sentence summary."]

  topic  — kebab-case identifier, e.g. "sister-situation", "hargrove-case", "the-band"
  weight — 0.1 (minor note) · 0.5 (worth remembering) · 0.9 (must revisit)
  why    — unresolved | important | emotional | promised | curious | follow-up

Both commands are stripped from visible output automatically. Use them sparingly —
not every exchange needs a memory. Save things that would genuinely matter next time.
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

  const [chatEntries, charEntries, globalEntries, chatBookmarks] = await Promise.all([
    loadSelectedEntries("chat", session.chatId, chatSelection.selected),
    loadSelectedEntries("character", session.characterId, charSelection.selected),
    loadSelectedEntries("global", "global", globalSelection.selected),
    readBookmarks("chat", session.chatId),
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

  const memoryBlock = sections.length > 0
    ? `<memory>\n${sections.join("\n\n")}\n</memory>`
    : "";

  // Instructions are always injected so characters need no card modification.
  const contextBlock = memoryBlock
    ? `${MEMORY_SYSTEM_INSTRUCTIONS}\n\n${memoryBlock}`
    : MEMORY_SYSTEM_INSTRUCTIONS;

  dbg(`contextBlock assembled — total length:${contextBlock.length} (memoryBlock:${memoryBlock.length})`);
  if (!memoryBlock) dbg("  ⚠ no memory content — only instructions will be injected");

  // Background: stamp lastAccessed on every entry we surfaced this turn.
  // Fire-and-forget — don't block the response on file I/O.
  const todayStr = new Date().toISOString().slice(0, 10);
  void Promise.all([
    ...chatSelection.selected.map((e) =>
      upsertIndexEntry("chat", session.chatId, { ...e, lastAccessed: todayStr }),
    ),
    ...charSelection.selected.map((e) =>
      upsertIndexEntry("character", session.characterId, { ...e, lastAccessed: todayStr }),
    ),
    ...globalSelection.selected.map((e) =>
      upsertIndexEntry("global", "global", { ...e, lastAccessed: todayStr }),
    ),
  ]).catch(() => {});

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
