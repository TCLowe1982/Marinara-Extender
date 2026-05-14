# Character Cards

Characters in Marinara Engine follow the **V2 Character Card spec** (`chara_card_v2`), with Marinara-specific extensions. A character is a JSON object stored in SQLite and rendered through the Characters Panel UI.

**Source of truth:** `packages/shared/src/schemas/character.schema.ts` and `packages/server/src/db/seed-mari.ts` (the built-in Professor Mari assistant is the canonical example of a complex card).

## The V2 Card Schema

```typescript
{
  name: string,                     // required
  description: string,              // the main character description
  personality: string,              // traits, speech style, quirks
  scenario: string,                 // the setting / framing
  first_mes: string,                // the character's opening message
  mes_example: string,              // example dialogue (teaches the model voice)
  creator_notes: string,            // not sent to model; for other users
  system_prompt: string,            // overrides the user's global system prompt
  post_history_instructions: string, // instructions inserted after message history
  tags: string[],
  creator: string,
  character_version: string,
  alternate_greetings: string[],    // shuffleable alternate first messages
  extensions: {                     // Marinara-specific
    talkativeness: number,          // 0-1; affects autonomous messaging rate
    fav: boolean,
    world: string,                  // linked lorebook name
    depth_prompt: {
      prompt: string,
      depth: number,                // how many messages from the end to inject at
      role: "system" | "user" | "assistant",
    },
    backstory: string,
    appearance: string,
    // Additional Marinara extensions (passthrough — extras preserved):
    nameColor: string,              // CSS color or gradient for the character's name
    dialogueColor: string,
    boxColor: string,
    conversationStatus: "online" | "idle" | "dnd" | "offline",
    isBuiltInAssistant: boolean,    // Mari only
    // ...and more
  },
  character_book: CharacterBook | null,  // embedded lorebook (optional)
}
```

## Where Each Field Shows Up in the Prompt

Not all fields get sent to the model on every turn. Here's roughly what happens:

| Field | Sent to model? | When? |
|---|---|---|
| `name` | yes | Always, as the character identifier. |
| `description` | yes | Core system prompt on every turn. Usually the biggest block. |
| `personality` | yes | Usually appended to description in the prompt preset. |
| `scenario` | yes | As a separate section; sets the framing. |
| `first_mes` | yes | Only as the first assistant turn. Not re-sent afterward. |
| `mes_example` | yes | Early in the prompt; teaches the model voice. |
| `system_prompt` | yes | Replaces the preset's system prompt section if non-empty. |
| `post_history_instructions` | yes | Inserted at the end, after recent messages. |
| `tags`, `creator`, `creator_notes` | no | Metadata, not sent to model. |
| `extensions.appearance` | yes | Used in image generation and can be referenced in prompts. |
| `extensions.backstory` | sometimes | Depends on preset configuration. |
| `extensions.depth_prompt` | yes | Inserted at N messages deep. |
| `extensions.talkativeness` | no (structurally) | Used by autonomous messaging logic. |
| `character_book` (embedded lorebook) | yes | Entries trigger normally based on keywords. |

**Practical implication:** anything you want the model to *always* know goes in `description` / `personality` / `system_prompt`. Anything it only needs when a keyword is mentioned goes in the lorebook (either character-scoped or a separate file).

## Character vs. Persona: A Critical Distinction

**Character** = an AI entity the user chats with.
**Persona** = the user's own identity in the chat.

They have similar fields but serve opposite roles. If the user asks "how do I give my character a detailed backstory," you're building a character. If they ask "how do I tell the AI about *me*," you're building a persona. The engine substitutes `{{user}}` in prompts with the active persona's name and injects the persona's data into the prompt too.

## The Professor Mari Pattern

Mari is the built-in assistant (seeded at first run; see `packages/server/src/db/seed-mari.ts`). She's the canonical example of a "does-things" character. Her definition demonstrates:

### Heavy use of `system_prompt` for domain knowledge
Mari's `system_prompt` is blank in her card, but the server injects a giant `MARI_ASSISTANT_PROMPT` (320+ lines) when she's the active character in a conversation. This prompt has:
- `<assistant_role>` — framing ("you are not a generic AI, you live inside this app")
- `<app_knowledge>` — the actual Marinara Engine documentation, XML-tagged by section
- `<assistant_commands>` — the tools she can emit (more on this below)
- `<data_access>` — how to use `[fetch: ...]` to load items on demand

**For a custom character with a lot of domain knowledge:** either do what Mari does structurally (large `description` + `system_prompt` with XML-tagged sections) or use a lorebook for the reference material.

### Command protocol vs. real tool calling
Mari uses a **custom regex-parsed command protocol** (`[create_persona: ...]`, `[fetch: ...]`, `[navigate: ...]`). This is NOT public — you can't add new meta-commands of your own.

**For custom characters that need to do things, use real Custom Tools** (see `custom-tools.md`). They're better supported, use proper OpenAI function-calling, and can be integrated with real backends.

### Personality in character voice
Mari's card description is ~280 words and includes voice, quirks, speech patterns, backstory, appearance, and a few behavioral rules. That's a solid starting length — long enough to establish voice, short enough not to dominate the context window.

### `isBuiltInAssistant: true`
This flag is Mari-specific and causes the server to inject her special prompt. You can't set it on your own characters — doing so won't trigger any behavior, since the server checks against the hardcoded `PROFESSOR_MARI_ID`.

## Recommended Card Structure for Different Use Cases

### Pure roleplay character (fictional persona, creative writing)
- `description` — detailed physical and personality description (~300–800 words)
- `personality` — speech patterns, quirks, MBTI/tropes if useful, behavioral examples
- `scenario` — the setting/context; can be short
- `first_mes` — a compelling opening that establishes voice
- `mes_example` — 2–3 example dialogue exchanges showing voice
- `extensions.appearance` — for image gen (selfies, sprites)
- Lorebook — world info, other NPCs, locations

### "Expert assistant" character (like Mari, for a specific domain)
- `description` — who they are, their expertise, how they speak (~200–400 words)
- `personality` — shorter; focus on how they respond to users
- `system_prompt` — the domain reference material, XML-tagged
- `first_mes` — greeting + menu of what they can help with
- Custom tools — for any actions they can take (see `custom-tools.md`)

### "Live data" character (answers questions against current data)
- `description` — thin; mostly voice and framing
- `personality` — how they respond (concise, data-forward, etc.)
- `system_prompt` — rules for using tools ("always call `get_latest` before answering")
- Custom tools — webhook-based, one per lookup type
- Lorebook — any stable background context that doesn't fit in the card

### Group chat member
- Normal character fields, plus:
- `extensions.talkativeness` — tune based on how vocal they should be
- Clear `personality` — distinguishable voice from other group members
- Lorebook — shared group lore if applicable

## Import/Export

Characters can be imported from:
- **SillyTavern** — via the built-in migration import (Settings → Import tab), which handles characters, lorebooks, presets, and chat history.
- **PNG files with embedded metadata** — the V2 spec standard. Drop the PNG into the Characters panel.
- **JSON files** — raw V2 card JSON.
- **Chub.ai, CharacterTavern, JannyAI, Pygmalion, Wyvern** — all searchable from the in-app Bot Browser.

Characters can be exported as:
- JSON (via the export endpoint)
- PNG with embedded V2 card metadata (via the export endpoint)

## Sprite System

Characters can have expression sprites for VN-style overlays in roleplay mode. Sprites live in a folder keyed to the character; filenames are expression names (`happy.png`, `sad.png`, `angry.png`, `smug.png`, etc.). The Expression Engine agent picks the matching sprite per message. There's also an automated sprite generation feature (uses image gen + a pose prompt) introduced in recent versions.

## Common Mistakes

- **Putting everything in `description`** — fine up to ~1000 words, bad past that. Split into `personality`, `scenario`, and `system_prompt` (or use a lorebook).
- **Writing examples in narrative instead of dialogue** — `mes_example` is for teaching voice. Show dialogue exchanges, not backstory.
- **Forgetting `first_mes`** — without it, the character opens the chat with nothing, and the model often misinterprets silence.
- **Setting `system_prompt` without understanding it replaces the preset's system prompt** — you lose any framing the preset provides. Usually you want to leave `system_prompt` blank unless you specifically need to override.
- **Not setting `extensions.appearance`** — breaks selfie generation and image prompts.
- **Using purple-prose descriptions** — cram too many adjectives in and the model starts writing florid overwrought prose. Be concrete.
- **Expecting the character to "remember" stuff you didn't put in a prompt** — the card + lorebook + history is all the model sees. If you want persistence outside a chat, use a tool that writes to your own backend.

## API Endpoints

- `GET /api/characters` — list
- `GET /api/characters/:id` — one character
- `POST /api/characters` — create
- `PATCH /api/characters/:id` — update
- `DELETE /api/characters/:id` — delete
- `POST /api/characters/import` — import from PNG or JSON
- `GET /api/characters/:id/export` — export as JSON or PNG
- `POST /api/character-maker/generate` — AI-generate a character from a prompt (SSE)
- `GET /api/characters/groups`, `POST /api/characters/groups` — group CRUD
