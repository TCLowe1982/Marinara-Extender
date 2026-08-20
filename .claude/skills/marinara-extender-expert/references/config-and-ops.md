# Marinara Extender: Config & Ops

*The support-facing reference: env vars, model choice, token tuning, and the troubleshooting tree. Grounded in `index.ts`, `llm-config.ts`. Defaults are baked in — a fresh install works with **no `.env`** if Ollama is running `dolphin3:8b`.*

## The moving parts

1. **The sidecar process** — `npm run dev` / `npm start` / `Marinara_Extender_Start.bat`. Binds **`127.0.0.1:3001`**. If it isn't running, the extension's panel button never appears and the lorebook freezes on whatever was last injected.
2. **`.env`** — optional, at `memory-extender/.env`. Loaded at startup by `loadDotEnv` (`env.ts`). **The shell wins; `.env` fills in what the environment did not set** (`bkdz`, changed 2026-08-04). It used to be the other way round, which meant a value passed on the command line was read and then silently replaced — so a per-run override was impossible for tests, demos or reproductions, and the failure was invisible. Shadowed keys are now named on startup (`[ME:env] taken from the environment, overriding .env: …`), and a shadowed **credential** gets its own `console.warn`, because a shadowed flag announces itself in the banner two lines later while a shadowed key is invisible until an unrelated request fails. Paths resolve relative to the install, not the launch cwd.
3. **The loader** — pasted once into Marinara → Settings → Extensions; fetches the live extension each Marinara load (see `extension.md`).
4. **The memory browser** — `http://127.0.0.1:3001/` (or `/memory`). The user-facing way to read and manage memories; see `architecture.md`. Needs nothing but the sidecar. Reachable without knowing the URL (`c2wd`): the startup banner prints it, `/setup` has an *Open memory browser* button, and the launcher console takes **`M`**. The header carries a **capture-liveness pill** (state + event: "capturing (poller) · last turn Xm ago", red **NOT CAPTURING** only when poller *and* hook are both off) fed by `/api/health`'s `capture` block, which reads `data/capture-status.yaml` — written by `turn-bridge` at the moment a turn actually ingests, tagged `live` or `backfill`. A watermark advance is deliberately *not* capture.

**Capture depends on ONE line: `MARINARA_EXTENDER_POLLER=1` in `.env`.** The code default is off; the extension is dead (Engine 2.3.4); the turn hook is opt-in. So `POLLER=0` means *zero* capture paths — which is exactly what ran silently 08-04→08-10 after a bench quarantine was never lifted. The off-state banner now warns "NOTHING IS CAPTURING" when the hook is off too.

**Outage recovery — the backfill utility** (`backfill.ts`): `POST /api/backfill {from, to?, chatId?, dryRun?}` replays an engine-history window through the live path (`buildTurns` → `handleDetectedTurn`), `GET /api/backfill` reports progress. Dry runs return inline; real runs are async (hours-shaped: full local-model analysis per turn). It runs **in-process on purpose** (1akw: a script beside the live sidecar is a second uncoordinated writer); idempotency is structural (provenance beat ids + entry dedup), so generous window overlap is safe and preferred; watermarks are never touched; lorebooks sync once per character (each character's final turn), not per turn. The poller cannot self-recover by design — new chats baseline without ingesting, and catch-up reads a 10-message tail then seals the watermark — so this endpoint is the *only* way to recover a gap.
5. **The launcher/watchdog** — `Marinara_Extender_Start.bat` → `start.ps1`. **`[M]` opens the memory browser; `[Q]` quits and stops the sidecar; `[D]` detaches and leaves it running.** Quit used to leave the server up, which made shutting down a two-window dance in a specific order — kill the sidecar first and the watchdog resurrects it. Ctrl+C also stops it now; a hard window kill notifies nothing by design and still leaves it running.

   **It opens TWO consoles, and both now name themselves** (`n24d`, 2026-08-20): `Marinara Extender - console` (the watchdog and `[M]/[R]/[L]/[A]` command loop) and `Marinara Extender - sidecar log` (the worker that runs `npm start` and tees to `logs/sidecar.log`). The worker sets its title **twice** — once up front and again on its first line of output — because npm renames the console to `npm start` a second after launch, and `npm start` is the identical label the *Engine's* window wears. Before this, telling the two apart took a process-tree walk plus a port-ownership lookup, and the maintainer reported two windows that both "look to be the extender".

   **Canonical launch path is the AI_Startup stack** (TC's ruling, 2026-08-20), `D:\Projects\AI_Startup\Start-AIStack.ps1` → `Marinara_Extender_Start.bat`. It is the only path that gets dependency order right — Ollama before the Extender, Extender before the Engine so `:3001` answers when the Engine's client asks — and it probes `:3001` first and **attaches to a running instance rather than racing a second one onto the port**, which is what keeps a double launch from becoming the `1akw` two-uncoordinated-writers bug. Running `start.ps1` directly is a post-reboot rescue, not a routine. **Do not enable the `[A]` auto-start**: it drops `Marinara Extender.cmd` in the Startup folder, creating a third launch path that starts the Extender *before* Ollama and defeats the ordering. Boot autostart belongs on `AI_Startup_Start.bat` instead.

Config can also be saved from the **`/setup` page** form or `POST /api/config`, which writes `.env` and applies immediately (no restart).

## Environment variables

**Local inference (the primary path):**

| Var | Default | Notes |
|---|---|---|
| `MARINARA_EXTENDER_LOCAL_URL` | `http://127.0.0.1:11434/v1` | OpenAI-compatible endpoint (Ollama default). **Unset → Ollama default; explicitly empty → local disabled (external-only).** |
| `MARINARA_EXTENDER_LOCAL_MODEL` | `dolphin3:8b` | Analysis model. **Uncensored on purpose** (see below). |
| `MARINARA_EXTENDER_EMBED_MODEL` | — | Optional Ollama embedding model (e.g. `nomic-embed-text`) for semantic dedup/recall. Unset → lexical fallback. |

**External fallback (optional — only used when local is unavailable):**

| Var | Default | Notes |
|---|---|---|
| `MARINARA_EXTENDER_API_KEY` | — | Key for the fallback. Cached at startup (`auth-cache.ts`). |
| `MARINARA_EXTENDER_DIGEST_UPSTREAM` | `https://api.openai.com` | OpenAI-compatible base URL for the fallback. |
| `MARINARA_EXTENDER_DIGEST_MODEL` | `gpt-4o-mini` | Fallback model (a local model name wouldn't exist upstream). |

**Engine-facing inference proxy (`hq7` — the client-extension replacement):**

| Var | Default | Notes |
|---|---|---|
| `MARINARA_EXTENDER_PROXY_UPSTREAM` | `https://api.openai.com` | Where `proxy.ts` forwards chat generations from an **OpenAI-compatible** (Custom) connection. Accepts `https://host` or `https://host/v1` (the `/v1` is stripped). **Distinct from the analysis config above** — that's the sidecar's own small model, this is the user's real chat provider. The proxy never stores an API key: the caller's `Authorization` is forwarded upstream, so keys stay in Marinara's connection config. |
| `MARINARA_EXTENDER_ANTHROPIC_UPSTREAM` | `https://api.anthropic.com` | Where `proxy.ts` forwards chat generations from the **native Anthropic** connection. Same accepted forms. Anthropic isn't OpenAI-compatible, so it gets its own route (`/anthropic/v1/messages`) rather than a translation layer — the engine's Anthropic connection has an editable `baseUrl`, so the format passes through untouched. Credentials (`x-api-key`) are forwarded, never stored. |

**The proxy is the OPT-IN path, not the default** — the default is the poller (see `references/architecture.md`). To use it, set the connection's base URL to `http://127.0.0.1:3001/proxy/v1` (Custom / OpenAI-compatible) or `http://127.0.0.1:3001/anthropic/v1` (native Anthropic), and keep the **Agents / Images / Videos** default connections pointed **directly** at the provider (`kxk`).

**⛔ The proxy is impossible on the three CLI-login providers** — **Claude (Subscription)**, **OpenAI (ChatGPT)**, **Grok CLI (Subscription)**. They have no base URL or API key field because the engine drives a vendor SDK in-process off a local CLI login. A user on any of these must use the poller. Check which provider they're on *before* walking anyone through proxy setup — this is the first support question to ask.

**Anthropic support gotcha (not a proxy bug):** on Opus 4.7/4.8 and Fable 5 the Anthropic API rejects `temperature`/`top_p`/`top_k` with a 400, and rejects last-assistant-turn prefill with a 400. Roleplay frontends commonly send both. The proxy passes upstream 400s through verbatim precisely so the real message is visible — read the error text before suspecting the sidecar.

**Server & data:**

| Var | Default | Notes |
|---|---|---|
| `MARINARA_EXTENDER_PORT` | `3001` | Binds `127.0.0.1` only. |
| `MARINARA_EXTENDER_DATA` | `<install>/data` | YAML store location. |
| `MARINARA_EXTENDER_ALLOWED_ORIGIN` | — | Extra CORS origin if Marinara runs on a non-loopback URL. |

**Turn capture** (the extension replacement — see `references/architecture.md`):

| Var | Default | Notes |
|---|---|---|
| `MARINARA_EXTENDER_POLLER` | `0` | `1` starts the pull detector. Off by default: it nuke-and-recreates real lorebooks, so double-writing with the extension must be a decision, not a surprise. **Always set `0` when starting a SECOND sidecar** — see the hazard below. |
| `MARINARA_EXTENDER_POLLER_INTERVAL_MS` | `5000` | Poll period. Detection latency ≈ one interval. |
| `MARINARA_EXTENDER_TURN_HOOK` | `0` | `1` enables `POST /api/engine/turn-complete`, the push detector. **Also needs the engine to be sending** — `TURN_NOTIFY_URL=http://127.0.0.1:3001/api/engine/turn-complete` on the `feat/turn-complete-notification` branch. Stock Marinara never calls it, so the flag alone does nothing. |

Independent flags — either detector alone, or both. They share one watermark behind a per-chat lock, so running both does not double-ingest. **The hook is the only path that sees a regeneration** (`4kbt`): a swipe moves nothing the poll gate reads.

**Behavior & budgets:**

| Var | Default | Notes |
|---|---|---|
| `MARINARA_EXTENDER_BUDGET_CHAT` | `4000` | Per-turn token budget for chat-scope memory. |
| `MARINARA_EXTENDER_BUDGET_CHARACTER` | `2000` | …character scope. |
| `MARINARA_EXTENDER_BUDGET_GLOBAL` | `1000` | …global scope. |
| `MARINARA_EXTENDER_EIDETIC` | `0` | `1` injects **every** non-done entry, ignoring budget. **Testing only.** |
| `MARINARA_EXTENDER_TIMESENSE` | `0` | `1` enables narrative time-sense (soft clock). Off in v1.0. |
| `MARINARA_EXTENDER_PROGRESS` | `1` | Console progress bar during imports; `0` disables. |

**Advanced / opt-in:**

| Var | Default | Notes |
|---|---|---|
| `MARINARA_EXTENDER_RECONCILE` | off | `1`/`on` enables the FR3 fact-reconciliation curator (Agent SDK; Claude CLI auth). Opt-in, offline — see `internals.md`. |
| `MARINARA_EXTENDER_RECONCILE_MODEL` | `opus` | Curator model. |
| `MARINARA_RWA_PATH` | — | Path to a local Rewrite Assistant `extension.js` to serve from `GET /rewrite-assistant.js`. |
| `ME_HTTP_LOG` | off | `1` enables Fastify's pino-pretty HTTP request/response logs (otherwise log level is `warn`; the app's own `console.info` carries the meaningful context). A debug toggle, not a convention. |

> The long-form story trip point (a user message long enough to route through the windowed pipeline) is a constant in `api.ts` (~1500 chars). Check `api.ts` before quoting it as configurable.

## Hazard: a second sidecar is not isolated by its data dir

Spinning up a second instance on a scratch `MARINARA_EXTENDER_DATA` is the normal way to demo, test or reproduce a bug — and it looks isolated. It is not. **The data dir isolates the STORE, not the ENGINE CONNECTION**, and the poller defaults to on, so the second instance polls the *live* engine, ingests real turns into the scratch store, and **rewrites real character lorebooks from it** on every ingest (`1akw`, observed live 2026-08-03).

`lorebook-writer`'s serialization (`_lorebookWriteChain`) is **per process**, so two sidecars against one engine are two uncoordinated writers, and each write nukes and recreates both entries by design — last writer wins outright.

Always: `MARINARA_EXTENDER_POLLER=0` on any second instance. **Verify it took effect** — read the banner, which must say `Engine poller: off`. Before the `bkdz` env fix, `.env` silently overrode the flag and the banner was the only way to notice.

To detect after the fact: compare `updatedAt` on the `Marinara Extender — *` lorebooks' *Active Context* entry; a timestamp inside the second instance's lifetime names the affected character. It self-heals on the next real turn (turn-bridge is the only caller of `syncMemoryToLorebook`).

## Choosing a model

- **`dolphin3:8b` is a functional requirement, not a preference.** The sentiment analyzer must classify adult roleplay content; an alignment-tuned small model (phi3, etc.) refuses or moralizes and **breaks the pipeline**. Use an uncensored local model.
- **Any OpenAI-compatible server works** — point `MARINARA_EXTENDER_LOCAL_URL` at LM Studio / KoboldCpp / llama.cpp (e.g. `http://127.0.0.1:5001/v1`); the launcher then skips the Ollama steps.
- **The user's chat model is never *substituted*.** The sidecar's own model is only for *analysis*. Two separate endpoints exist and get confused constantly: `/v1/chat/completions` is the **Rewrite Assistant relay**, which deliberately picks the model/key for its caller; `/proxy/v1/chat/completions` is the **engine-facing proxy** (`hq7`), which changes nothing and forwards the caller's own model and key. Under the proxy model chat generation *does* pass through the sidecar — but the sidecar only relays it, it never answers a chat turn itself.
- **Embeddings are optional** — without an embed model, semantic dedup/recall degrade to lexical. Degradation is logged at boot, never silent.

## Tuning how much memory is injected

Raise `BUDGET_CHAT` / `BUDGET_CHARACTER` / `BUDGET_GLOBAL` to inject more memory per turn (more recall, more context/latency cost); lower them to inject less. `EIDETIC=1` is the "inject everything" debug switch — useful to confirm an entry *exists* vs. *isn't being selected*, but not for normal use.

## Boot output & health

The boot banner (`index.ts`) prints the server URL, `/setup` link, data dir, local-model + external-API status, eidetic/progress state, and embeddings status — a fast "is it configured right?" check. `GET /api/health` returns `{ ok, ollama: ok|unavailable|not_configured, embeddings, <update> }` (pings the local provider root with a 1s timeout).

## Troubleshooting tree

**"It's not remembering / the panel button is gone."** Walk the chain in order:
1. **Is the sidecar running?** No process → no button, frozen lorebook. Start it; check `http://127.0.0.1:3001/setup` loads.
2. **Is the loader installed and fresh?** Reload Marinara so it re-fetches the live extension.
3. **Are the two constant lorebook entries present?** (See `extension.md`.) Missing → the block isn't being written.
4. **Is a model reachable?** `GET /api/health` → `ollama: "unavailable"` means analysis silently no-ops. Start Ollama / fix `LOCAL_URL`, or set an external key.

**"The sidecar keeps closing" / memory went stale with no error.** A blind crash leaves the engine injecting the last (frozen) lorebook with nothing saying so. Check **`logs/sidecar.log`** — the crash *breadcrumb* names the last exit (`uncaughtException`, signal, etc.). Hard kills (`taskkill /F`, native fault) can't self-log; the launcher watchdog catches those.

**"It says it's already running / duplicate window."** `EADDRINUSE` — another sidecar owns port 3001. The running one is fine; close the duplicate. The guarded launcher refuses to start a second copy; `npm start` and double-launches hit this.

**Mutations 403 after a restart.** The CSRF token is minted per process, so a restart invalidates old tokens — the extension refreshes on the 403 automatically. A persistent 403 from a non-browser client means it isn't sending `x-me-csrf` (browsers without an `Origin` header pass through).

**The model refuses / moralizes during analysis.** It's alignment-tuned. Switch to an uncensored model (`dolphin3:8b`).

**Semantic recall seems weak.** No embed model → lexical-only matching. Set `MARINARA_EXTENDER_EMBED_MODEL`; confirm the boot line / `health` shows embeddings available.

**Time-sense isn't doing anything.** Off by default — set `MARINARA_EXTENDER_TIMESENSE=1`. It's *narrative* time inferred from prose, not wall-clock.

**Marinara is on another device / LAN.** Set `MARINARA_EXTENDER_ALLOWED_ORIGIN` so CORS lets that origin read responses (the server still binds loopback — front it accordingly).
