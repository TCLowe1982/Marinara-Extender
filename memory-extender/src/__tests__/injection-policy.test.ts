// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// 771t: where pre-turn memory may inject.
//
// The Engine calls our contributor on EVERY generation in EVERY chat, so this is
// the only thing standing between "scoped memory" and "memory in all 102 chats".
// It is asymmetric on purpose, and the asymmetry is the part worth pinning: the
// Engine has an agent picker in roleplay/game and NONE in conversation, so the
// same rule in both modes is wrong in one of them.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { decideInjection, conversationMemoryEnabled } from "../injection-policy.js";

const KEY = "MARINARA_EXTENDER_CONVERSATION_MEMORY";
beforeEach(() => { delete process.env[KEY]; });
afterEach(() => { delete process.env[KEY]; });

describe("decideInjection — modes WITH an agent picker", () => {
  it("injects in roleplay only when the user actually enabled the agent", () => {
    expect(decideInjection("roleplay", true).allow).toBe(true);
    expect(decideInjection("roleplay", false).allow).toBe(false);
  });

  it("injects in game only when enabled", () => {
    expect(decideInjection("game", true).allow).toBe(true);
    expect(decideInjection("game", false).allow).toBe(false);
  });

  it("names the picker in the refusal, because that is the fix", () => {
    // "no injection" with no route to a remedy is the failure this codebase
    // keeps re-learning. The reason string is what someone reads in the log.
    expect(decideInjection("roleplay", false).reason).toMatch(/Misc Agents/);
  });

  it("is NOT overridden by the conversation setting", () => {
    // The conversation default exists because that mode has no UI. Letting it
    // leak into roleplay would silently overrule a real user decision.
    process.env[KEY] = "1";
    expect(decideInjection("roleplay", false).allow).toBe(false);
  });
});

describe("decideInjection — conversation, which has no agent picker", () => {
  it("injects by default, because there is no UI anywhere to turn it on", () => {
    // Default-OFF here is not a safe default, it is a dead feature: the Engine
    // conversation surface exposes long-term-memory by hard-coded id and calls
    // by manifest kind, and nothing else. activeAgentIds can never contain us.
    expect(decideInjection("conversation", false).allow).toBe(true);
  });

  it("honours the kill switch", () => {
    for (const off of ["0", "off", "false", "OFF"]) {
      process.env[KEY] = off;
      expect(decideInjection("conversation", false).allow).toBe(false);
    }
  });

  it("ignores agentActive entirely — it can never be true in this mode", () => {
    expect(decideInjection("conversation", true).allow).toBe(true);
    process.env[KEY] = "0";
    expect(decideInjection("conversation", true).allow).toBe(false);
  });
});

describe("decideInjection — anything else", () => {
  it("REFUSES an unknown mode rather than guessing", () => {
    // A future Engine mode must arrive as a visible refusal, not as memory
    // quietly appearing somewhere nobody has reasoned about.
    const d = decideInjection("holodeck", true);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/unknown chat mode/);
  });

  it("refuses an absent mode", () => {
    expect(decideInjection(undefined, true).allow).toBe(false);
  });
});

describe("conversationMemoryEnabled()", () => {
  it("defaults on and reads at call time, not module load", () => {
    expect(conversationMemoryEnabled()).toBe(true);
    process.env[KEY] = "0";
    expect(conversationMemoryEnabled()).toBe(false);
    process.env[KEY] = "1";
    expect(conversationMemoryEnabled()).toBe(true);
  });
});
