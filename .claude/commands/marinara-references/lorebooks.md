# Lorebooks

**Lorebooks** are keyword-triggered knowledge injection systems. Entries activate when their trigger keywords appear in recent chat messages, injecting content into the prompt at that turn. They're designed for "large, structured, but stable" reference material that would waste tokens if always active.

**Source of truth:** `packages/shared/src/schemas/lorebook.schema.ts`

## Core Structure

A lorebook is a container with metadata and multiple entries.

### Lorebook fields
- `name` — identifier
- `description` — what the lorebook covers
- `category` — organizational tag
- `tokenBudget` — max tokens injected per turn (default: 2048)
- `scanDepth` — how many recent messages are scanned for keywords (default: 2)
- `recursiveScan` — whether activated entries' content can trigger more entries
- `recursionDepth` — how many recursive passes to allow (default: 2)

### Entry fields
```typescript
{
  keys: string[],               // primary trigger keywords
  secondaryKeys: string[],      // secondary keys (used in selective logic)
  content: string,              // text injected when triggered
  constant: boolean,            // always inject, regardless of keyword
  enabled: boolean,
  position: "before_char" | "after_char",
  order: number,                // priority when multiple entries trigger
  depth: number,                // inject at N messages from the end
  probability: number,          // 0-100; random chance of firing even when triggered
  caseSensitive: boolean,
  matchWholeWord: boolean,
  useRegex: boolean,
  selective: boolean,           // require both primary AND secondary keys
  group: string,                // group name for weighted lottery selection
  groupWeight: number,          // relative weight within group
  sticky: number,               // turns to stay active after triggering
  cooldown: number,             // min messages between activations
  delay: number,                // wait N turns before first activation
  ephemeral: number,            // max total activations in this chat (0 = unlimited)
  condition: string,            // game-state expression (advanced)
}
```

## Activation Logic

1. The engine scans the last `scanDepth` messages for keyword matches.
2. If a `constant` entry exists, it always injects (subject to sticky/cooldown/ephemeral).
3. For keyword entries: `keys` are checked; if `selective`, `secondaryKeys` must also match.
4. Probability fires (if < 100).
5. Grouped entries: only one entry per group is selected, weighted by `groupWeight`.
6. All triggered entries are sorted by `order` and injected, up to `tokenBudget`.
7. If `recursiveScan` is on, the injected content is itself scanned for more triggers (up to `recursionDepth`).

## Scope Levels

Lorebooks can be scoped at three levels:
- **Global** — applies to all chats across all characters
- **Character-scoped** — applies only when a specific character is active (linked via `character.extensions.world`)
- **Chat-scoped** — applies only within a specific chat

Characters can also have an **embedded lorebook** in `character_book` — same entry schema, travels with the character card on export/import.

## Advanced Features

### Weighted Group Lottery
Entries in the same `group` compete; only one is selected per turn. Higher `groupWeight` = more likely to win. Use this for random variation ("roll for weather," "pick a mood for the NPC").

### Sticky Entries
A sticky entry with `sticky: 3` stays active for 3 turns after its keywords stop appearing. Useful for persistent context that shouldn't drop out mid-scene.

### Cooldown
Prevents an entry from firing too often. Good for event-driven entries that should trigger once and then pause.

### Ephemeral Entries
A cap on total lifetime activations per chat. Use for one-time lore reveals or limited-use mechanics.

### Semantic Matching (Knowledge-Retrieval Agent)
If the built-in `knowledge-retrieval` agent is enabled, it uses embedding similarity (MiniLM-L6-v2) to find relevant lorebook entries even when exact keywords don't match. This supplements, not replaces, keyword scanning.

### AI Lorebook Generation
`POST /api/lorebook-maker/generate` — SSE endpoint that bootstraps lorebook entries from a topic description using the configured LLM.

## When to Use Lorebooks vs. Other Surfaces

| Scenario | Use |
|---|---|
| Knowledge fits in < 2000 tokens and never changes | Character card (`description` or `system_prompt`) |
| Large reference, discrete lookup ("tell me about X") | **Lorebook** |
| Data changes weekly or faster | Webhook custom tool |
| Every-turn context injection | Lorebook (constant entry) or pre-generation agent |
| Knowledge varies by keyword in conversation | **Lorebook** — this is the ideal use case |

## Common Mistakes

- **Setting `scanDepth` too low** — if you set it to 1, keywords in older messages don't trigger. Increase to 4–8 for richer triggering.
- **Too many constant entries** — they all inject every turn; you'll eat the token budget fast.
- **Not setting `order`** — entries are injected in arbitrary order. Set `order` to control what comes first when multiple entries trigger.
- **Groups without `groupWeight`** — all entries default to equal weight; that's usually fine but set it explicitly if you need skewed probability.
- **Using lorebooks for live data** — if the content changes more than quarterly, use a webhook tool instead.
- **Forgetting the token budget** — a lorebook with 50 entries each injecting 500 tokens will only inject the highest-priority ones. Keep entries concise.

## API Endpoints

- `GET /api/lorebooks` — list all lorebooks
- `GET /api/lorebooks/:id` — get one
- `POST /api/lorebooks` — create
- `PATCH /api/lorebooks/:id` — update metadata
- `DELETE /api/lorebooks/:id` — delete
- `GET /api/lorebooks/:id/entries` — list entries
- `POST /api/lorebooks/:id/entries` — create entry
- `PATCH /api/lorebooks/:id/entries/:entryId` — update entry
- `DELETE /api/lorebooks/:id/entries/:entryId` — delete entry
- `GET /api/lorebooks/:id/export` — export as JSON
- `POST /api/lorebook-maker/generate` — AI-generate lorebook entries (SSE)
