// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Agentic fact reconciliation (MarinaraExtender-5ny / FR3). These test the PURE
// applier — the half that --apply replays from the reconcile-ledger. The curator
// agent itself (runCurator) is the live path and is exercised by the script with
// a logged-in CLI session, exactly as scene-facts.test.ts injects classify/judge
// to keep the deterministic half offline.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { AmbientFact } from "../ambient.js";
import { saveFact, type FactContext } from "../facts.js";
import { applyDecision, type CuratorDecision } from "../reconcile.js";
import { readIndex, readColdIndex } from "../storage.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-recon-"));
  process.env.MARINARA_EXTENDER_DATA = join(dir, "data");
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true });
});

const ctx: FactContext = { identityKey: "mari", fallbackChatId: "chat-1", characterName: "Mari" };
const fact = (f: string): AmbientFact => ({ text: f, fact: f, lane: "character_topics", scope: "character", subject: "Mari" });

const activeIds = async () => ((await readIndex("character", "mari"))?.entries ?? []).filter((e) => !e.supersededBy).map((e) => e.id);

describe("applyDecision (FR3 verdicts)", () => {
  it("CREATE writes the candidate as a new active fact", async () => {
    const r = await applyDecision({ candidate: fact("Mari's patron is the Narrative itself"), decision: { verdict: "CREATE", rationale: "no prior fact" } }, ctx, "scene-1");
    expect(r.verdict).toBe("CREATE");
    expect(r.createdId).toBeTruthy();
    expect(await activeIds()).toEqual([r.createdId]);
  });

  it("DUPLICATE is a no-op — nothing written", async () => {
    const seed = await saveFact(fact("Mari is a Warlock"), ctx, "scene-1");
    const before = await activeIds();
    const r = await applyDecision(
      { candidate: fact("Mari is a Warlock"), decision: { verdict: "DUPLICATE", targetId: seed!.id, rationale: "already stored" } },
      ctx, "scene-2",
    );
    expect(r.verdict).toBe("DUPLICATE");
    expect(r.createdId).toBeUndefined();
    expect(await activeIds()).toEqual(before); // unchanged
  });

  it("UPDATE saves the new fact and supersedes the old (tier move, not delete)", async () => {
    const old = await saveFact(fact("Mari's patron is a fiend"), ctx, "scene-1");
    const r = await applyDecision(
      { candidate: fact("Mari's patron is the Narrative itself"), decision: { verdict: "UPDATE", targetId: old!.id, rationale: "patron retconned" } },
      ctx, "scene-2",
    );
    expect(r.createdId).toBeTruthy();
    expect(r.supersededId).toBe(old!.id);
    // old is gone from the active set...
    const active = await activeIds();
    expect(active).toContain(r.createdId);
    expect(active).not.toContain(old!.id);
    // ...but kept in cold, carrying its supersededBy link (queryable as a negative fact).
    const cold = await readColdIndex("character", "mari");
    const oldRow = cold?.entries.find((e) => e.id === old!.id);
    expect(oldRow?.supersededBy).toBe(r.createdId);
  });

  it("NEGATE supersedes the disproven fact the same way", async () => {
    const old = await saveFact(fact("Mari has never left the city"), ctx, "scene-1");
    const r = await applyDecision(
      { candidate: fact("Mari grew up sailing the coast for years"), decision: { verdict: "NEGATE", targetId: old!.id, rationale: "disproves the never-left claim" } },
      ctx, "scene-2",
    );
    expect(r.supersededId).toBe(old!.id);
    expect(await activeIds()).not.toContain(old!.id);
  });

  it("EXPAND keeps both facts active (no supersede)", async () => {
    const a = await saveFact(fact("Mari plays a Warlock"), ctx, "scene-1");
    const r = await applyDecision(
      { candidate: fact("Mari's patron is the Narrative itself"), decision: { verdict: "EXPAND", targetId: a!.id, rationale: "complementary" } },
      ctx, "scene-2",
    );
    expect(r.supersededId).toBeUndefined();
    const active = await activeIds();
    expect(active).toContain(a!.id);
    expect(active).toContain(r.createdId);
  });

  it("DISTINCT keeps both look-alike facts active", async () => {
    const a = await saveFact(fact("Mari's brother is named Cole"), ctx, "scene-1");
    const r = await applyDecision(
      { candidate: fact("Mari's mentor is named Cassius"), decision: { verdict: "DISTINCT", targetId: a!.id, rationale: "different person, similar shape" } },
      ctx, "scene-2",
    );
    expect(r.supersededId).toBeUndefined();
    expect(await activeIds()).toEqual(expect.arrayContaining([a!.id, r.createdId!]));
  });
});
