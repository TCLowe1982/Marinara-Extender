// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// WHERE PRE-TURN MEMORY IS ALLOWED TO INJECT (771t).
//
// The shipped Engine calls a prompt-context contributor on EVERY generation, in
// every chat, with no agent-activation check — the registry is keyed by package
// (collectCapabilityPromptContext). So the gate is entirely ours to define, and
// it has to be, or installing the package would silently put memory into every
// chat on the machine.
//
// THE ASYMMETRY THIS EXISTS TO HANDLE. The Engine's Chat Settings drawer picks a
// different agent surface per mode (CHAT_SETTINGS_SURFACES):
//
//   roleplay / game  -> "generation" surface: Writer/Tracker/Misc pickers.
//                       The user CAN add our agent, so activeAgentIds is a real
//                       user decision and we honour it.
//   conversation     -> "conversation" surface: commands plus two hard-coded
//                       packages (long-term-memory by literal id, calls by
//                       manifest kind). THERE IS NO AGENT PICKER AT ALL, so
//                       activeAgentIds can never contain us, and gating on it
//                       would make the feature permanently unreachable in the
//                       mode most people use.
//
// Exposing package agents on the conversation surface is an upstream ask (TC,
// 2026-08-30: "It NEEDS to be an upstream ask ... but that is part of a package
// of asks"). Until it lands, conversation is governed by a setting WE own, so
// nothing here depends on modifying the Engine and no Engine update can
// invalidate it.
//
// DEFAULT-ON WITH A KILL SWITCH, matching embeddings.ts and for the same stated
// reason: "opt-in capability flags cause silent degradation - the median user
// gets restricted results that look fine because they have nothing to compare
// to." A conversation default of OFF would be worse than that here, because
// there is no UI anywhere to turn it on.

export type ChatMode = "conversation" | "roleplay" | "game" | (string & {});

/** Modes where the Engine gives the user a real agent picker. */
const MODES_WITH_AGENT_PICKER = new Set(["roleplay", "game"]);

/**
 * Is pre-turn memory enabled for conversation chats?
 *
 * Read at CALL time, not module load - the same convention as the loader budgets
 * and hotEntryCap. A module-load read cannot be changed without a restart and,
 * worse, silently freezes at whatever the first import happened to see.
 */
export function conversationMemoryEnabled(): boolean {
  const v = process.env.MARINARA_EXTENDER_CONVERSATION_MEMORY?.trim().toLowerCase();
  return !(v === "0" || v === "off" || v === "false");
}

export interface InjectionDecision {
  allow: boolean;
  /** Why, in words, for the log. Never a bare boolean in the record. */
  reason: string;
}

/**
 * Decide whether to contribute memory for one generation.
 *
 * @param mode        chat mode as the Engine reports it
 * @param agentActive whether the Extender agent is in this chat's activeAgentIds
 */
export function decideInjection(mode: ChatMode | undefined, agentActive: boolean): InjectionDecision {
  const m = String(mode ?? "").toLowerCase();

  if (MODES_WITH_AGENT_PICKER.has(m)) {
    return agentActive
      ? { allow: true, reason: `${m}: agent enabled for this chat` }
      : { allow: false, reason: `${m}: agent not enabled for this chat (Chat Settings -> Agents -> Misc Agents)` };
  }

  if (m === "conversation") {
    return conversationMemoryEnabled()
      ? { allow: true, reason: "conversation: on by default (no agent picker exists in this mode)" }
      : { allow: false, reason: "conversation: disabled via MARINARA_EXTENDER_CONVERSATION_MEMORY" };
  }

  // An unrecognised mode is not a licence to inject. A future Engine mode should
  // arrive as a visible refusal in the log, not as memory quietly appearing
  // somewhere nobody has reasoned about.
  return { allow: false, reason: `unknown chat mode "${mode}" - refusing rather than guessing` };
}

/**
 * Should a captured turn still be written to the character's LOREBOOK?
 *
 * THE TWO PATHS COLLIDE (measured 2026-08-30). The poller writes "Memory System
 * — Instructions" (4,105 chars) and "Memory System — Active Context" (32,402
 * chars) as enabled+constant lorebook entries. The capability package now ALSO
 * contributes a ~29,000-char block during prompt assembly. Both carry the same
 * memory, and they compete for one prompt budget: on the boat probe the
 * dispatched system message came back at 20,854 chars — smaller than either
 * contribution alone — with the instructions kept and every memory row trimmed
 * away. The character answered "no color, no boat, nothing" while the loader had
 * selected the canon rows two seconds earlier.
 *
 * The lorebook path is also the ONE-TURN-LATE one (771t): its entries are
 * written after the turn completes, so its content answers the previous
 * question. Keeping it alongside a working contributor buys nothing and costs
 * the budget that would have carried the right answer.
 *
 * DEFAULT ON, because it is the only path when the capability package is not
 * installed, and silently dropping capture-to-lorebook would strand every user
 * who has not adopted the package. Turn it OFF once the contributor is
 * confirmed firing — the startup banner says which mode you are in.
 */
export function lorebookSyncEnabled(): boolean {
  const v = process.env.MARINARA_EXTENDER_LOREBOOK_SYNC?.trim().toLowerCase();
  return !(v === "0" || v === "off" || v === "false");
}
