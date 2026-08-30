// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Marinara Engine REST client — the sidecar's server-to-server channel.
//
// The client extension used to reach the engine from inside the browser via the
// scoped `marinara.apiFetch`. Extensions were removed in Engine v2.3.4, so the
// sidecar now talks to the engine directly over localhost instead. This module
// is that transport; the poller (slice 23i) and the memory write-back (slice
// lxp) are built on top of it.
//
// WHY THIS IS POSSIBLE AT ALL — the engine's CSRF guard is a **static header**,
// not a per-session token: `CSRF_HEADER = "x-marinara-csrf"` with
// `CSRF_HEADER_VALUE = "1"` (packages/shared/src/constants/security.ts), and
// loopback origins are auto-trusted. So a non-browser client on 127.0.0.1 can
// both read and mutate the engine API. If that ever changes upstream, this
// whole path breaks at once — which is why CSRF rejections are given their own
// actionable error below rather than surfacing as a bare 403.
//
// Endpoints and payload shapes here are ported from the working extension
// (`marinara-extender.js`), not inferred from the engine source — they are
// battle-tested against real installs.

const DEFAULT_ENGINE_URL = "http://127.0.0.1:7860";

/** Engine base URL, no trailing slash and no trailing /api (callers add paths). */
export function engineUrl(): string {
  const v = process.env.MARINARA_EXTENDER_ENGINE_URL || DEFAULT_ENGINE_URL;
  return v.replace(/\/+$/, "").replace(/\/api$/, "");
}

/**
 * Optional Basic auth, for installs that set BASIC_AUTH_USER/PASS on the engine
 * (documented in the engine's docs/REMOTE_ACCESS.md). Format: "user:pass".
 */
function engineAuthHeader(): string | null {
  const raw = process.env.MARINARA_EXTENDER_ENGINE_BASIC_AUTH;
  if (!raw) return null;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The engine's stable error code when it sends one (e.g. CSRF_ORIGIN_NOT_TRUSTED). */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

// The engine ships stable CSRF codes specifically so clients can act on them
// rather than guessing at a 403. Each one has a different fix, so each gets a
// different message — a generic "403 Forbidden" here would cost hours.
const CSRF_HINTS: Record<string, string> = {
  CSRF_MISSING_HEADER:
    "the engine did not see the x-marinara-csrf header (a proxy in front of the engine may be stripping it)",
  CSRF_ORIGIN_NOT_TRUSTED:
    "the engine did not trust this origin — add the sidecar's address to CSRF_TRUSTED_ORIGINS in the engine's .env, or reach the engine over loopback (auto-trusted)",
  CSRF_REFERER_NOT_TRUSTED:
    "the engine rejected the Referer — same fix as an untrusted origin (CSRF_TRUSTED_ORIGINS)",
  CSRF_CROSS_SITE: "the engine classified this as a cross-site request",
};

type EngineErrorBody = { code?: unknown; error?: unknown; message?: unknown };

function describeFailure(status: number, body: EngineErrorBody | null, text: string): EngineError {
  const code = typeof body?.code === "string" ? body.code : null;

  if (code && code in CSRF_HINTS) {
    return new EngineError(`Marinara Engine rejected the request — ${CSRF_HINTS[code]} (${code})`, status, code);
  }
  if (status === 401) {
    return new EngineError(
      "Marinara Engine returned 401. If the engine has BASIC_AUTH_USER/BASIC_AUTH_PASS set, put the same credentials in MARINARA_EXTENDER_ENGINE_BASIC_AUTH as user:pass.",
      status,
      code,
    );
  }
  if (status === 403) {
    return new EngineError(
      `Marinara Engine returned 403. If the engine sets IP_ALLOWLIST, the sidecar's address must be allowed. Body: ${text.slice(0, 200)}`,
      status,
      code,
    );
  }
  const detail =
    (typeof body?.error === "string" && body.error) ||
    (typeof body?.message === "string" && body.message) ||
    text.slice(0, 200);
  return new EngineError(`Marinara Engine returned ${status}: ${detail}`, status, code);
}

/**
 * Call the engine's /api surface. Returns parsed JSON, or null for 204 / empty
 * bodies (DELETE returns 204).
 */
export async function engineFetch<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T | null> {
  const method = init.method ?? "GET";
  const url = `${engineUrl()}/api${path}`;

  const headers: Record<string, string> = {
    // Static value, not a token — see the module header.
    "x-marinara-csrf": "1",
  };
  // ONLY set content-type when there is actually a body. Fastify rejects a
  // bodyless request that declares application/json with
  // "Body cannot be empty when content-type is set to 'application/json'" —
  // so sending it unconditionally makes every DELETE a 400. GET happens to
  // tolerate it, which is why stubbed unit tests never caught this; the live
  // smoke test did, on the first DELETE.
  if (init.body !== undefined) headers["content-type"] = "application/json";

  const auth = engineAuthHeader();
  if (auth) headers.authorization = auth;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (e) {
    throw new EngineError(
      `Could not reach Marinara Engine at ${engineUrl()} — is it running? (${String(e)})`,
      0,
    );
  }

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) throw describeFailure(res.status, parsed as EngineErrorBody | null, text);
  return parsed as T | null;
}

// ── Shape helpers (ported from the extension) ─────────────────────────────────

/**
 * Several engine objects carry their fields in a `data` property that may be a
 * JSON *string* rather than an object. Ported from the extension's parseData.
 */
export function parseData(obj: unknown): Record<string, unknown> {
  const raw = (obj as { data?: unknown } | null | undefined)?.data;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (raw as Record<string, unknown>) ?? {};
}

/**
 * List endpoints have returned a bare array, `{ <key>: [...] }`, or
 * `{ data: [...] }` depending on the endpoint and engine version. The extension
 * tolerated all three; so do we, rather than betting on one.
 */
export function unwrapList<T = Record<string, unknown>>(res: unknown, key: string): T[] {
  if (Array.isArray(res)) return res as T[];
  const obj = res as Record<string, unknown> | null | undefined;
  const named = obj?.[key];
  if (Array.isArray(named)) return named as T[];
  if (Array.isArray(obj?.data)) return obj.data as T[];
  return [];
}

// ── Chats & messages (read) ───────────────────────────────────────────────────

export function listChats(): Promise<Record<string, unknown>[]> {
  return engineFetch("/chats").then((r) => unwrapList(r, "chats"));
}

/**
 * Messages for a chat.
 *
 * IMPORTANT: this endpoint returns the FULL history when no limit is given
 * (verified against the engine: listMessages has no default LIMIT; pagination
 * is opt-in via ?limit=N&before=cursor). The poller must always pass a limit —
 * fetching thousands of messages every tick would be a self-inflicted DoS.
 */
export function listMessages(
  chatId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<Record<string, unknown>[]> {
  const qs = new URLSearchParams();
  if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
  if (opts.before) qs.set("before", opts.before);
  const suffix = qs.toString() ? `?${qs}` : "";
  return engineFetch(`/chats/${chatId}/messages${suffix}`).then((r) => unwrapList(r, "messages"));
}

/**
 * The most recent USER message in a chat, as the relevance signal for a
 * pre-turn recall (771t).
 *
 * WHY THIS EXISTS. The shipped Engine's prompt-context contributor is handed
 * { chatId, chatMeta, mode, targetCharacterIds, personaId } and NO messages, so
 * a contributor cannot see the message it is being asked to recall against. The
 * call site holds them and does not pass them. Until that changes upstream, the
 * outgoing message has to be fetched by chatId — and it lives here rather than
 * in the capability package so the package stays a thin broker and every piece
 * of Engine-protocol knowledge (auth, CSRF, list shape) stays in one file.
 *
 * THE FAILURE MODE THIS IS BUILT AROUND (Mari, 2026-08-29): if the outgoing
 * message is not yet readable, you do not get an error — you get turn N-1, and
 * N-1 is topically adjacent to N almost always, so ranking on it produces
 * plausible rows and looks exactly like it is working. Measured 2026-08-30 the
 * row is REST-visible with no observable commit lag and ~2,100 lines of handler
 * before the contributor runs, so this returns turn N. The id is returned with
 * the text so the caller can SAY which message it scored against, which is what
 * turns a silent near-miss into something a log can show.
 *
 * Returns null when the chat has no user message or the Engine is unreachable —
 * callers must degrade to their non-pre-turn behaviour rather than guess.
 */
export async function latestUserMessage(
  chatId: string,
): Promise<{ id: string; text: string } | null> {
  let messages: Record<string, unknown>[];
  try {
    // A tail, not the whole chat. The relevance signal is the last user turn;
    // fetching thousands of messages on the generation path would put our
    // latency inside someone's prompt assembly.
    messages = await listMessages(chatId, { limit: 10 });
  } catch {
    return null;
  }
  // Ascending (oldest first), so the last user row is the outgoing one.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const text = typeof m.content === "string" ? m.content : "";
    if (!text.trim()) continue;
    return { id: String(m.id ?? ""), text };
  }
  return null;
}

// ── Lorebooks (read + write) ──────────────────────────────────────────────────

export function listCharacters(): Promise<Record<string, unknown>[]> {
  return engineFetch("/characters").then((r) => unwrapList(r, "characters"));
}

/**
 * The player's PERSONAS (qhej). Distinct from characters: a persona is who the
 * HUMAN is playing, and every chat row names one via `personaId`. Without this
 * the store cannot tell a fact about the persona "Thomas" from a fact about the
 * human — the gap that filed three RP lines about Texas as biography of TC.
 *
 * GET /api/characters/personas/list returns a bare array of persona objects
 * (name, personaVersion, description, … at the TOP level — unlike characters,
 * whose payload nests a JSON-string `data`).
 */
export function listPersonas(): Promise<Record<string, unknown>[]> {
  return engineFetch("/characters/personas/list").then((r) => unwrapList(r, "personas"));
}

export function listLorebooks(): Promise<Record<string, unknown>[]> {
  return engineFetch("/lorebooks").then((r) => unwrapList(r, "lorebooks"));
}

/**
 * Delete a whole lorebook (DELETE /api/lorebooks/:id). The extension never did
 * this — it only ever swept entries — but the smoke test needs it to clean up
 * after itself rather than leaving junk in a real install.
 */
export function deleteLorebook(lorebookId: string): Promise<unknown> {
  return engineFetch(`/lorebooks/${lorebookId}`, { method: "DELETE" });
}

export function createLorebook(body: {
  name: string;
  characterId: string;
  enabled?: boolean;
  tokenBudget?: number;
}): Promise<Record<string, unknown> | null> {
  return engineFetch("/lorebooks", { method: "POST", body });
}

export function patchLorebook(
  lorebookId: string,
  patch: Record<string, unknown>,
): Promise<unknown> {
  return engineFetch(`/lorebooks/${lorebookId}`, { method: "PATCH", body: patch });
}

export function listLorebookEntries(lorebookId: string): Promise<Record<string, unknown>[]> {
  return engineFetch(`/lorebooks/${lorebookId}/entries`).then((r) => unwrapList(r, "entries"));
}

export function createLorebookEntry(
  lorebookId: string,
  entry: Record<string, unknown>,
): Promise<unknown> {
  return engineFetch(`/lorebooks/${lorebookId}/entries`, { method: "POST", body: entry });
}

export function patchLorebookEntry(
  lorebookId: string,
  entryId: string,
  patch: Record<string, unknown>,
): Promise<unknown> {
  return engineFetch(`/lorebooks/${lorebookId}/entries/${entryId}`, { method: "PATCH", body: patch });
}

/**
 * Delete an entry. The extension had to PATCH `locked: false` first — a locked
 * entry refuses deletion, which silently left stale memory behind. Callers
 * doing the nuke-and-recreate cycle must keep that unlock step (slice lxp).
 */
export function deleteLorebookEntry(lorebookId: string, entryId: string): Promise<unknown> {
  return engineFetch(`/lorebooks/${lorebookId}/entries/${entryId}`, { method: "DELETE" });
}

/** Cheap liveness probe for the panel/status surface. */
export async function engineReachable(): Promise<boolean> {
  try {
    await engineFetch("/chats");
    return true;
  } catch {
    return false;
  }
}
