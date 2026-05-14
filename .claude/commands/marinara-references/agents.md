# Agents

Agents are autonomous LLM subsystems that run during message generation to handle auxiliary tasks: state tracking, quality enforcement, image/music control, and more. **All agents are disabled by default** — users enable only what they need.

**Source of truth:** `packages/shared/src/schemas/agent.schema.ts`, `packages/server/src/routes/agents.routes.ts`

## Phases

Every agent has a phase that determines when it runs relative to the main response:

### `pre_generation`
Runs **before** the main model is called. Use for:
- Injecting additional context into the prompt (result type: `context_injection`)
- Reviewing or rewriting the user's message
- Enforcing narrative directives before the response starts
- Pulling in data the main model needs

**Latency impact:** Adds a full LLM call before every main response.

### `parallel`
Runs **simultaneously** with the main response. Use for:
- Image generation (sprite selection, background generation, selfies)
- Music suggestions
- Side characters' reactions that don't need to be in the main response
- Any task that doesn't need to block the main output

**Latency impact:** Minimal — runs at the same time, doesn't delay the user.

### `post_processing`
Runs **after** the main model finishes. Use for:
- Extracting structured state (HP, quest flags, world state variables)
- Continuity checking
- Style rewriting
- Summarizing the message for long-term memory

**Latency impact:** Adds a full LLM call after every main response.

## Built-In Agents (~25 total)

Key built-ins include:

| Agent | Phase | Purpose |
|---|---|---|
| `prose-guardian` | post | Enforces literary quality, removes AI tells |
| `continuity-checker` | post | Flags lore contradictions |
| `world-state` | post | Extracts and maintains a world-state JSON |
| `character-tracker` | post | Tracks NPC states, emotions, locations |
| `expression-engine` | parallel | Picks character sprite expressions |
| `background-engine` | parallel | Selects scene backgrounds |
| `weather-engine` | parallel | Sets weather particle effects |
| `image-generator` | parallel | Generates scene images |
| `music-suggester` | parallel | Picks background music |
| `spotify-dj` | parallel | Controls Spotify playback |
| `knowledge-retrieval` | pre | Semantic lorebook entry retrieval |
| `scene-director` | pre | Injects narrative direction |
| `response-orchestrator` | pre | In group chats: picks who responds |
| `love-toys` | parallel | Buttplug.io haptic device control |
| `echo-reactions` | parallel | Reactions from absent group members |
| `chat-summary` | post | Summarizes long chats for context compression |
| `editor` | post | Light edit pass on the generated message |
| `game-master` | pre | Game Mode GM logic |
| `combat-tracker` | post | Extracts combat stats from narration |

Each built-in has a customizable prompt template and optional dedicated connection (so you can point a tracker agent at a cheap model).

## Custom Agents

Users can define their own agents. Required fields:

```typescript
{
  type: string,          // unique identifier, snake_case
  name: string,          // display name
  phase: "pre_generation" | "parallel" | "post_processing",
  prompt: string,        // the agent's system prompt
  resultType: "context_injection" | "state_update" | "message_edit" | "none",
  connection: string | null,  // optional dedicated LLM connection ID
  enabled: boolean,
}
```

**Result types:**
- `context_injection` — the agent's output is injected into the next turn's prompt
- `state_update` — the agent outputs JSON that updates the world/character state
- `message_edit` — the agent rewrites the main response (post-processing only)
- `none` — side effect only (triggers an action, doesn't affect the prompt)

**Custom agent best practice:** Keep the prompt narrow. A good custom agent does one thing — "extract the current HP values from this message and return JSON." Broad agents are unreliable.

## Performance Math

Every agent = one additional LLM call per turn.

- 0 agents: 1 call (just the main response)
- 3 agents (1 pre, 1 parallel, 1 post): still 3 calls (parallel doesn't add latency)
- 8 agents: 9 calls

**Recommendation:** 0–3 agents for most characters. More than 5 noticeably impacts response time and cost.

**Optimization:** Assign cheaper models (`gpt-4o-mini`, `claude-haiku`, `gemma`) to extraction/tracking agents. Reserve frontier models for prose work.

## The Agent vs. Tool vs. Lorebook Decision

| Scenario | Use |
|---|---|
| Needs to happen every turn automatically | Agent |
| Needs to happen when a topic comes up in conversation | Lorebook |
| Needs to happen when the user or character requests it | Custom Tool |
| Needs real-time external data | Tool (webhook) |
| Needs to modify UI | Client Extension |

"Needs to happen every turn without being prompted? → Agent. Needs to happen when a topic comes up? → Lorebook. Needs to happen when the user asks for it? → Tool."

## Common Mistakes

- **Enabling too many agents** — start with zero, add one at a time, measure.
- **Using an agent for something a tool would do** — if the user has to ask for it, it's a tool.
- **Conflicting post-processing agents** — two agents both trying to rewrite the message will fight. Pick one editor.
- **Custom pre-generation agent for live data** — wastes tokens every turn. Use a tool the model calls when needed.
- **Not assigning a cheap model to tracker agents** — tracking tasks don't need GPT-4. Use a smaller model.

## API Endpoints

- `GET /api/agents` — list all agents (built-in + custom)
- `GET /api/agents/:id` — get one
- `POST /api/agents` — create custom agent
- `PATCH /api/agents/:id` — update (including enable/disable)
- `DELETE /api/agents/:id` — delete custom agent
- `POST /api/agents/:id/toggle` — toggle enabled state
- `POST /api/agents/echo` — send an echo message via the echo-reactions agent
