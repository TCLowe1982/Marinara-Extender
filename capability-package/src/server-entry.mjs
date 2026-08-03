// Marinara Extender — capability package server entrypoint
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.
//
// Registers a prompt-context contributor so the Engine can ask us for memory
// while it is assembling the prompt, instead of us writing a lorebook entry
// that only lands on the NEXT generation.
//
// THIS IS THE WHOLE POINT. On the lorebook path, retrieval is scored against
// the turn that already happened — turn-bridge.ts says so in its own header:
// "memory has always been one turn behind on this path". Here the Engine hands
// us the outgoing message before it generates, so we score against the message
// actually being answered.
//
// The memory itself stays in the sidecar. This file is a broker: it holds no
// store, no ranking, no model. If the sidecar is not running, every call
// degrades to "no extra context" and the turn proceeds normally.

const SERVICE_KEY = "marinara-extender:prompt-context";
const DEFAULT_PORT = 3001;

/** Loopback only, and never derived from anything the model can influence. */
function sidecarBase() {
  const raw = process.env.MARINARA_EXTENDER_URL?.trim();
  if (raw) return raw.replace(/\/+$/, "");
  const port = Number.parseInt(process.env.MARINARA_EXTENDER_PORT ?? String(DEFAULT_PORT), 10);
  return `http://127.0.0.1:${Number.isFinite(port) ? port : DEFAULT_PORT}`;
}

async function postJson(path, body, signal) {
  const response = await fetch(`${sidecarBase()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`sidecar ${path} returned ${response.status}`);
  return response.json();
}

/**
 * The Engine gives us the assembled prompt. The last user turn in it is the
 * relevance signal we could never see before — scoring against it is the
 * difference between recalling for this message and recalling for the last one.
 */
function latestUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && typeof message.content === "string" && message.content.trim()) {
      return message.content;
    }
  }
  return "";
}

/**
 * Single-character chats resolve cleanly; a group scene has no single owner, so
 * we take the first participant, matching how the sidecar scopes a chat today.
 * Returning null makes the contributor a no-op rather than guessing wrong.
 */
function primaryCharacterId(characterIds) {
  return Array.isArray(characterIds) && characterIds.length > 0 ? String(characterIds[0]) : null;
}

export async function activate({ api, runtime } = {}) {
  const host = runtime ?? api?.runtime;
  const log = host?.logger ?? console;

  const contributor = {
    async contribute({ chatId, characterIds, messages, signal }) {
      const characterId = primaryCharacterId(characterIds);
      if (!chatId || !characterId) return null;
      const result = await postJson(
        "/api/pre-turn",
        { chatId, characterId, userText: latestUserText(messages ?? []) },
        signal,
      );
      const memoryBlock = typeof result?.memoryBlock === "string" ? result.memoryBlock : "";
      if (!memoryBlock.trim()) return null;
      // The receipt is the text itself: acceptance is confirmed by hashing what
      // actually shipped against the receipt the sidecar stored for this turn.
      return { text: memoryBlock, receipt: memoryBlock };
    },

    /**
     * Report whether our block truly reached the dispatched prompt.
     *
     * We verify presence ourselves rather than trusting that contributing meant
     * shipping — a contribution can be dropped by preset placement or an aborted
     * request. Reporting `null` when absent is the informative case, not a
     * failure to report: "I looked and it was not there" is precisely the signal
     * that separates a broken injection from a retrieval miss.
     */
    async recordPromptAccepted({ chatId, receipt, messages }) {
      if (!chatId || typeof receipt !== "string") return;
      const present = (messages ?? []).some(
        (message) => typeof message?.content === "string" && message.content.includes(receipt),
      );
      await postJson("/api/prompt-accepted", { chatId, block: present ? receipt : null });
    },
  };

  // Wrap so a sidecar that is down, slow, or mid-restart can never fail a turn.
  // The Engine already bounds and catches these, but a broker that lets its own
  // dependency's outage surface as an Engine warning per turn is noisy in a way
  // the user cannot act on.
  const guarded = {
    async contribute(input) {
      try {
        return await contributor.contribute(input);
      } catch (error) {
        if (input?.signal?.aborted) return null;
        log.warn?.(`[marinara-extender] pre-turn recall unavailable: ${String(error)}`);
        return null;
      }
    },
    async recordPromptAccepted(input) {
      try {
        await contributor.recordPromptAccepted(input);
      } catch (error) {
        log.warn?.(`[marinara-extender] prompt accounting unavailable: ${String(error)}`);
      }
    },
  };

  const release = api.registerService(SERVICE_KEY, guarded);
  log.info?.(`[marinara-extender] prompt-context contributor registered against ${sidecarBase()}`);
  return () => release();
}

export async function selfCheck() {
  const response = await fetch(`${sidecarBase()}/api/health`).catch(() => null);
  if (!response?.ok) {
    throw new Error(
      `Marinara Extender sidecar is not reachable at ${sidecarBase()}. Start it, then re-enable this agent.`,
    );
  }
}
