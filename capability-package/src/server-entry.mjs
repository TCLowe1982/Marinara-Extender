// Marinara Extender — capability package server entrypoint
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.
//
// Contributes scoped memory to the prompt WHILE IT IS BEING ASSEMBLED, so recall
// is scored against the message being answered rather than the one before it.
//
// THIS IS THE WHOLE POINT (MarinaraExtender-771t). On the lorebook path the block
// is built after the turn completes, for the next one — turn-bridge.ts says so in
// its own header: "memory has always been one turn behind on this path". The
// symptom is a character who misses on the first ask and has the whole thing on
// the second.
//
// The memory itself stays in the sidecar. This file is a BROKER: no store, no
// ranking, no model, and deliberately no Engine-protocol knowledge beyond one
// loopback POST. If the sidecar is down, every call degrades to "no extra
// context" and the turn proceeds normally.

const AGENT_ID = "marinara-extender";
const DEFAULT_PORT = 3001;

// Mirrors agents.json modeAllowlist. Enforced HERE as well because the shipped
// contributor registry is keyed by PACKAGE and is consulted on every generation
// (see the gate note in contribute) — the manifest's allowlist governs where the
// agent can be switched on, not where this function runs.
const MODES = new Set(["conversation", "roleplay", "game"]);

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
 * Single-character chats resolve cleanly; a group scene has no single owner, so
 * we take the first participant, matching how the sidecar scopes a chat today.
 * Returning null makes this a no-op rather than guessing wrong.
 */
function primaryCharacterId(characterIds) {
  return Array.isArray(characterIds) && characterIds.length > 0 ? String(characterIds[0]) : null;
}

export async function activate({ api, runtime } = {}) {
  const host = runtime ?? api?.runtime;
  const log = host?.logger ?? console;

  // REGISTERED-BUT-NEVER-INVOKED IS THE FAILURE THIS GUARDS (Mari, 2026-08-29):
  // "registerService vs registerPromptContext fails SILENTLY. wrong convention,
  // never invoked, nothing raised. the symptom is 'mari misses cold'."
  //
  // That is not hypothetical — v1.0.0 of this package registered under
  // registerService("marinara-extender:prompt-context"), which the shipped
  // Engine accepts, never consults for prompt context, and still reports
  // active/ready. Silence is therefore not evidence of anything, so the first
  // invocation is announced and prolonged silence is escalated.
  let invoked = false;
  let contributed = false;
  const silenceWatch = setTimeout(() => {
    if (!invoked) {
      log.warn?.(
        `[${AGENT_ID}] NOT INVOKED in 10 minutes. The contributor registered but the Engine has ` +
          `never called it. Either no generation has run, or this build registered against a seam ` +
          `this Engine does not consult — check that activate() used api.registerPromptContext(), ` +
          `NOT api.registerService().`,
      );
    }
  }, 600_000);
  silenceWatch.unref?.();

  const contribute = async (request) => {
    const { chatId, chatMeta = {}, mode, targetCharacterIds } = request ?? {};

    if (!invoked) {
      invoked = true;
      clearTimeout(silenceWatch);
      log.info?.(`[${AGENT_ID}] prompt-context contributor INVOKED — the seam is live (chat:${chatId}).`);
    }

    // PER-CHAT GATE, AND IT IS LOAD-BEARING.
    //
    // The shipped registry is keyed by package and collectCapabilityPromptContext
    // iterates every registered contributor with NO agent-activation check — so
    // without this, memory would be injected into every chat on the install, for
    // every character, whether or not the user asked for it. agents.json declares
    // enabledByDefault:false and tells the user to add the agent per chat; this is
    // what makes that promise true instead of decorative.
    if (chatMeta.enableAgents === false) return null;
    const active = Array.isArray(chatMeta.activeAgentIds) ? chatMeta.activeAgentIds.map(String) : [];
    if (!active.includes(AGENT_ID)) return null;

    if (!MODES.has(String(mode))) return null;

    const characterId = primaryCharacterId(targetCharacterIds);
    if (!chatId || !characterId) return null;

    // NO userText IS SENT ON PURPOSE. The shipped contributor is handed no
    // messages, so there is nothing here to pass; the sidecar resolves the
    // outgoing message by chatId and LOGS which one it scored against. Keeping
    // that lookup there rather than here is what stops this file from growing
    // Engine-protocol knowledge, and it is where the log lives that proves we
    // ranked on turn N rather than N-1.
    const result = await postJson("/api/pre-turn", { chatId, characterId }, request?.signal);
    const memoryBlock = typeof result?.memoryBlock === "string" ? result.memoryBlock : "";
    if (!memoryBlock.trim()) return null;

    if (!contributed) {
      contributed = true;
      log.info?.(`[${AGENT_ID}] first contribution shipped (${memoryBlock.length} chars, chat:${chatId}).`);
    }
    return memoryBlock;
  };

  // Wrapped so a sidecar that is down, slow, or mid-restart can never fail a
  // turn. The Engine already bounds (2s) and swallows throws, but a broker whose
  // dependency's outage surfaces as an Engine warning every single turn is noise
  // the user cannot act on.
  const guarded = async (request) => {
    try {
      return await contribute(request);
    } catch (error) {
      if (request?.signal?.aborted) return null;
      log.warn?.(`[${AGENT_ID}] pre-turn recall unavailable: ${String(error)}`);
      return null;
    }
  };

  const release = api.registerPromptContext(guarded);
  log.info?.(`[${AGENT_ID}] prompt-context contributor registered against ${sidecarBase()}`);
  return () => {
    clearTimeout(silenceWatch);
    release();
  };
}

export async function selfCheck() {
  const response = await fetch(`${sidecarBase()}/api/health`).catch(() => null);
  if (!response?.ok) {
    throw new Error(
      `Marinara Extender sidecar is not reachable at ${sidecarBase()}. Start it, then re-enable this agent.`,
    );
  }
}
