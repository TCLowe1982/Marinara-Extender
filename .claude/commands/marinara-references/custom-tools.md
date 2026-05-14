# Custom Tools

Custom tools are the primary integration surface for giving characters real capabilities. They're exposed to the chat model as OpenAI-compatible function definitions — the model decides when to call them based on their descriptions.

**Source of truth:** `packages/server/src/routes/custom-tools.routes.ts`, `tool-executor.ts`, `packages/shared/src/schemas/custom-tool.schema.ts`

## Three Execution Types

### `static`
Returns a hardcoded string. **Use only for development scaffolding** — never in production.

```json
{
  "type": "static",
  "staticResponse": "{ \"status\": \"ok\" }"
}
```

### `webhook`
POSTs to an HTTP endpoint you control. This is **the primary integration method** for real work.

- Timeout: 10 seconds
- Payload sent to your URL: `{ "tool": "<name>", "arguments": { ...args } }`
- Expected response: JSON (parsed and returned to the model)

Use for: Express backends, n8n, Zapier, Cloudflare Workers, FastAPI — anything with network access.

```json
{
  "type": "webhook",
  "webhookUrl": "https://your-backend.example.com/tools/get_weather"
}
```

**Critical:** Do NOT store API keys in the webhook URL as query parameters. Use your backend to hold secrets.

### `script`
Runs sandboxed JavaScript via Node's `vm.runInNewContext`. Timeout: 5 seconds.

**Available in the sandbox:** `args` (the tool arguments), `JSON`, `Math`, `String`, `Number`, `Date`, `Array`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `console.log` (no-op).

**NOT available:** `fetch`, `require`, `fs`, `process`, any network or filesystem access.

Use for: date math, string transforms, dice rolls, validation, pure computation.

```javascript
// Example: dice roller
const { sides, count } = args;
const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
return JSON.stringify({ rolls, total: rolls.reduce((a, b) => a + b, 0) });
```

## Tool Schema

```typescript
{
  name: string,              // snake_case verb-noun: "get_weather", "create_note"
  description: string,       // CRITICAL: 1-2 sentences; model reads this to decide when to call
  type: "static" | "webhook" | "script",
  parameters: {              // JSON Schema object
    type: "object",
    properties: {
      paramName: {
        type: "string" | "number" | "boolean" | "array",
        description: string,  // required; model reads this
        enum: string[],       // optional; use for bounded choices
      }
    },
    required: string[],
  },
  webhookUrl?: string,       // for webhook type
  staticResponse?: string,   // for static type
  script?: string,           // for script type
  enabled: boolean,
}
```

## Writing Good Tool Descriptions

The description is the most important field. The model reads it to decide:
1. **Whether** to call this tool
2. **When** to call it vs. a different tool

Good description: `"Look up the current roster and stats for a Path of Titans dinosaur species by name. Call this whenever the user asks about a specific dinosaur's stats, abilities, or meta rating."`

Bad description: `"Gets dinosaur info"` — too vague; the model may not call it or may call it at wrong times.

**Rule:** Include both what it does AND when to use it.

## Parameter Design

```json
{
  "properties": {
    "location": {
      "type": "string",
      "description": "City name or coordinates. Examples: 'London', '51.5,-0.12'"
    },
    "units": {
      "type": "string",
      "enum": ["metric", "imperial"],
      "description": "Temperature units. Default to metric unless user specifies."
    }
  },
  "required": ["location"]
}
```

- Use `enum` for bounded choices — it eliminates hallucination on that parameter
- Mark only truly required fields as `required`
- Include descriptions on every property

## Webhook Response Design

- Return compact JSON, not prose
- Keep responses small — they consume context tokens
- Handle errors structurally:

```json
{ "error": "location_not_found", "message": "Could not find weather for 'Atlantis'" }
```

The model can then explain the error to the user gracefully. Returning an HTTP error code causes the tool call to fail silently.

## Tool Attachment

Tools attach to individual chats (not globally). To use a tool in a chat:
1. Create the tool (via Settings → Custom Tools or the API)
2. Enable it on the chat (via the chat's tool panel)

A character can have multiple tools; the model sees all enabled tools as a function list.

## Full Examples

### Webhook: live sports scores
```json
{
  "name": "get_match_score",
  "description": "Get the current or most recent score for a football match. Call this when the user asks about a specific team's current game or recent result.",
  "type": "webhook",
  "webhookUrl": "https://my-sports-api.example.com/score",
  "parameters": {
    "type": "object",
    "properties": {
      "team": {
        "type": "string",
        "description": "Team name, e.g. 'Arsenal', 'Barcelona'"
      }
    },
    "required": ["team"]
  }
}
```

### Script: dice roller
```json
{
  "name": "roll_dice",
  "description": "Roll one or more dice. Use this for any dice roll the user or character requests during gameplay.",
  "type": "script",
  "script": "const { sides = 6, count = 1 } = args;\nconst rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);\nreturn JSON.stringify({ rolls, total: rolls.reduce((a, b) => a + b, 0) });",
  "parameters": {
    "type": "object",
    "properties": {
      "sides": { "type": "number", "description": "Number of sides on each die (default: 6)" },
      "count": { "type": "number", "description": "Number of dice to roll (default: 1)" }
    },
    "required": []
  }
}
```

## Common Mistakes

- **Using `script` type to call an API** — sandbox has no network. Use `webhook`.
- **Vague tool descriptions** — model won't call the tool or calls it at wrong times.
- **Returning large JSON blobs** — wastes context. Return only the fields the model needs.
- **Overlapping descriptions** — two tools that sound similar confuse the model. Make each tool's scope distinct.
- **Storing API keys in webhook URLs** — secrets in URLs appear in logs and requests. Use your backend.
- **Missing parameter descriptions** — the model uses them to populate arguments correctly.

## API Endpoints

- `GET /api/custom-tools` — list all tools
- `GET /api/custom-tools/:id` — get one
- `POST /api/custom-tools` — create
- `PATCH /api/custom-tools/:id` — update
- `DELETE /api/custom-tools/:id` — delete
- `POST /api/custom-tools/:id/test` — test execute a tool with sample arguments
