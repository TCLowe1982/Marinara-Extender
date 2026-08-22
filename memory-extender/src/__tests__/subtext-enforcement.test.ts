// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// PROMPT ASKS, CODE ENFORCES — the subtext half (MarinaraExtender-5x5y).
//
// The field was requested from May and emitted on 0.7% of the chunks that warranted
// one, because nothing checked. These tests cover the checking, and the two that
// matter most are the ones asserting what enforcement REFUSES to do:
//
//   - it never fabricates. A second refusal from the model is an accepted outcome,
//     recorded and left alone. Enforcement whose only accepted answer is a filled
//     field produces invented subtext, which is epf4 in a new field.
//   - it never asks twice. "One retry" is a rule about CALL COUNT, so it is asserted
//     by counting calls, not by reading the code and believing it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { enforceSubtext } from "../sentiment/analyzer.js";
import { subtextLedgerPath } from "../sentiment/intimacy.js";
import type { BeatAnalysis } from "../sentiment/types.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-subtext-"));
  process.env.MARINARA_EXTENDER_DATA = join(dir, "data");
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true });
});

const INTIMATE = "his fingers find my nipple through the cotton and my whole spine gives out";
const ORDINARY = "i want the number for the sleep-debt ledger, soldier. actual wake time?";

const base = (over: Partial<BeatAnalysis> = {}): BeatAnalysis => ({
  motivation: "she lets the sentence go unfinished",
  relationalDynamics: "he waits rather than filling it",
  outcome: "the silence is allowed to stand",
  emotions: undefined,
  salience: 0.6,
  ...over,
} as BeatAnalysis);

/** A model reply carrying whatever fields the test needs. */
const reply = (o: Record<string, unknown>) => JSON.stringify({
  motivation: "retry motivation", relational_dynamics: "retry dynamics",
  outcome: "retry outcome", ...o,
});

async function ledger(): Promise<Array<Record<string, unknown>>> {
  const p = subtextLedgerPath(process.env.MARINARA_EXTENDER_DATA!);
  if (!existsSync(p)) return [];
  const raw = await readFile(p, "utf8");
  return raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("when the chunk is not intimate", () => {
  it("does not retry and does not log — enforcement is silent where it does not apply", async () => {
    const call = vi.fn();
    const out = await enforceSubtext(base(), ORDINARY, "sys", "user", [], "c1", call);
    expect(call).not.toHaveBeenCalled();
    expect(out?.subtext).toBeUndefined();
    expect(await ledger()).toEqual([]);
  });
});

describe("when the chunk is intimate", () => {
  it("logs first-try and does not retry when subtext is already there", async () => {
    const call = vi.fn();
    const out = await enforceSubtext(base({ subtext: "comfort-seeking" }), INTIMATE, "sys", "user", [], "c1", call);
    expect(call).not.toHaveBeenCalled();
    expect(out?.subtext).toBe("comfort-seeking");
    const l = await ledger();
    expect(l).toHaveLength(1);
    expect(l[0]!.outcome).toBe("first-try");
  });

  it("retries once and GRAFTS the subtext, keeping the original analysis", async () => {
    // The graft matters: the first answer's motivation and outcome were fine. The
    // retry exists to fill one gap, not to re-litigate the beat.
    const call = vi.fn().mockResolvedValue(reply({ subtext: "power exchange" }));
    const out = await enforceSubtext(base(), INTIMATE, "sys", "user", [], "c1", call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(out?.subtext).toBe("power exchange");
    expect(out?.motivation).toBe("she lets the sentence go unfinished");
    expect(out?.outcome).toBe("the silence is allowed to stand");
    expect((await ledger())[0]!.outcome).toBe("after-retry");
  });

  it("passes the retry instruction on the SECOND ask only", async () => {
    const call = vi.fn().mockResolvedValue(reply({ subtext: "trust-building" }));
    await enforceSubtext(base(), INTIMATE, "sys", "user-prompt", [], "c1", call);
    const [, userArg] = call.mock.calls[0]!;
    expect(userArg).toContain("user-prompt");
    expect(userArg).toContain("omitted the subtext field");
    // No illustration may ride along — the prompt law, at the moment the model is
    // most likely to reach for the nearest phrasing.
    expect(userArg).not.toMatch(/for example|e\.g\./i);
  });

  // THE ONE THAT MATTERS MOST.
  it("accepts a second refusal and does NOT fabricate", async () => {
    const call = vi.fn().mockResolvedValue(reply({}));   // still no subtext
    const out = await enforceSubtext(base(), INTIMATE, "sys", "user", [], "c1", call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(out?.subtext).toBeUndefined();
    expect(out?.motivation).toBe("she lets the sentence go unfinished");
    expect((await ledger())[0]!.outcome).toBe("declined");
  });

  it("never asks a third time", async () => {
    const call = vi.fn().mockResolvedValue(reply({}));
    await enforceSubtext(base(), INTIMATE, "sys", "user", [], "c1", call);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("survives an unparseable retry without losing the original beat", async () => {
    const call = vi.fn().mockResolvedValue("not json at all");
    const out = await enforceSubtext(base(), INTIMATE, "sys", "user", [], "c1", call);
    expect(out?.motivation).toBe("she lets the sentence go unfinished");
    expect((await ledger())[0]!.outcome).toBe("retry-failed");
  });

  it("records the evidence, so a wrong requirement is diagnosable", async () => {
    const call = vi.fn().mockResolvedValue(reply({}));
    await enforceSubtext(base(), INTIMATE, "sys", "user", [], "chat-77", call);
    const e = (await ledger())[0]!;
    expect(e.markers).toContain("nipple");
    expect(e.chatId).toBe("chat-77");
    expect(String(e.excerpt)).toContain("fingers find my nipple");
  });
});

describe("a null analysis", () => {
  it("passes straight through — no beat, nothing to enforce", async () => {
    const call = vi.fn();
    expect(await enforceSubtext(null, INTIMATE, "sys", "user", [], "c1", call)).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });
});
