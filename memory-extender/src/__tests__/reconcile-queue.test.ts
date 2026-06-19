// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Live FR1 reconciliation queue + drain (MarinaraExtender-b4n). The live enqueue
// (dedup hook), the queue I/O, and the drain orchestration are all tested offline;
// the curator itself (runCurator, Agent SDK) is injected, exactly as the judge
// and scene-facts tests inject their model calls.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync } from "node:fs";
import type { AmbientFact } from "../ambient.js";
import type { FactContext } from "../facts.js";
import { saveFact } from "../facts.js";
import { createEntryIfUnique } from "../dedup.js";
import { readIndex } from "../storage.js";
import { enqueueReconcileTask, readQueue, removeTasks, auditFilePath } from "../reconcile-queue.js";
import { drainReconcileQueue, type CuratorDecision } from "../reconcile.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-rq-"));
  process.env.MARINARA_EXTENDER_DATA = join(dir, "data");
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  delete process.env.MARINARA_EXTENDER_RECONCILE;
  await rm(dir, { recursive: true, force: true });
});

const trait = (summary: string) => ({ lane: "character_topics" as const, summary, content: summary, kind: "trait" as const });

// The live enqueue is fire-and-forget (advisory — it must never block a save), so
// poll briefly for it to flush rather than reading the queue synchronously.
const waitForQueueLen = async (n: number, ms = 1500) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms && (await readQueue()).length < n) await new Promise((r) => setTimeout(r, 10));
  return readQueue();
};

describe("queue I/O", () => {
  it("enqueues, reads back, and coalesces a duplicate candidate-vs-entry", async () => {
    const base = { scope: "character" as const, scopeId: "mari", lane: "character_topics" as const, summary: "Mari is a Warlock", content: "Mari is a Warlock", againstId: "ctopic-1", againstSummary: "Mari is a Warlock", structuralAction: "skip" as const };
    await enqueueReconcileTask(base);
    await enqueueReconcileTask(base); // same candidate+entry while pending -> coalesced
    await enqueueReconcileTask({ ...base, summary: "Mari is a Wizard", content: "Mari is a Wizard" });
    expect((await readQueue()).length).toBe(2);
  });

  it("removeTasks drops handled ids", async () => {
    await enqueueReconcileTask({ scope: "character", scopeId: "mari", lane: "user_topics", summary: "a", content: "a", againstId: "x", againstSummary: "a", structuralAction: "skip" });
    const [t] = await readQueue();
    await removeTasks([t.id]);
    expect((await readQueue()).length).toBe(0);
  });
});

describe("live dedup hook (enqueue on skip)", () => {
  it("queues a dropped FACT collision when MARINARA_EXTENDER_RECONCILE=1", async () => {
    process.env.MARINARA_EXTENDER_RECONCILE = "1";
    await createEntryIfUnique("character", "mari", trait("Mari is a Pact of the Tome Warlock"));
    const dup = await createEntryIfUnique("character", "mari", trait("Mari is a Pact of the Tome Warlock"));
    expect(dup).toBeNull(); // structural dedup dropped it...
    const q = await waitForQueueLen(1); // ...and the collision was queued for the curator
    expect(q.length).toBe(1);
    expect(q[0]!.scopeId).toBe("mari");
    expect(q[0]!.summary).toMatch(/Warlock/);
  });

  it("does NOT queue when the flag is unset (default path unchanged)", async () => {
    await createEntryIfUnique("character", "mari", trait("Mari is a Warlock"));
    await createEntryIfUnique("character", "mari", trait("Mari is a Warlock"));
    expect((await readQueue()).length).toBe(0);
  });

  it("does NOT queue a non-fact (incident) collision", async () => {
    process.env.MARINARA_EXTENDER_RECONCILE = "1";
    const incident = { lane: "character_topics" as const, summary: "[tense] they argued by the river", content: "x", kind: "incident" as const, sourceChatId: "c1", turnStart: 3 };
    await createEntryIfUnique("character", "mari", incident);
    await createEntryIfUnique("character", "mari", incident); // same-moment -> skip
    expect((await readQueue()).length).toBe(0); // incidents are not the curator's domain
  });
});

describe("drainReconcileQueue", () => {
  const seedTask = async (summary: string, againstId: string) =>
    enqueueReconcileTask({ scope: "character", scopeId: "mari", lane: "character_topics", summary, content: summary, againstId, againstSummary: "old", structuralAction: "skip" });

  it("SHADOW: curates + audits + clears the queue, applies nothing", async () => {
    await seedTask("Mari's patron is the Narrative itself", "ctopic-old");
    const curate = async (): Promise<CuratorDecision> => ({ verdict: "EXPAND", targetId: "ctopic-old", rationale: "complementary", confidence: "high" });
    const res = await drainReconcileQueue({ curate }); // shadow (default)
    expect(res).toMatchObject({ processed: 1, decided: 1, applied: 0 });
    expect(await readQueue()).toEqual([]); // queue drained
    // audit line written, marked shadow, carries the verdict + confidence, no apply effects
    const audit = await readFile(auditFilePath(), "utf8");
    const rec = JSON.parse(audit.trim().split("\n").at(-1)!);
    expect(rec).toMatchObject({ mode: "shadow", verdict: "EXPAND", confidence: "high", againstId: "ctopic-old", scopeId: "mari" });
    // nothing created in the ledger
    const idx = await readIndex("character", "mari");
    expect(idx?.entries.length ?? 0).toBe(0);
  });

  it("APPLY: executes the verdict (CREATE writes the recovered fact)", async () => {
    await seedTask("Mari mains a blood-elf warlock in WoW", "ctopic-old");
    const curate = async (): Promise<CuratorDecision> => ({ verdict: "CREATE", rationale: "distinct, was wrongly dropped" });
    const res = await drainReconcileQueue({ apply: true, curate });
    expect(res).toMatchObject({ processed: 1, decided: 1, applied: 1 });
    const idx = await readIndex("character", "mari");
    expect((idx?.entries ?? []).some((e) => /blood-elf warlock/.test(e.summary))).toBe(true);
  });

  it("a curator failure on a task is recorded (verdict null) and the task still clears", async () => {
    await seedTask("something", "ctopic-old");
    const curate = async () => { throw new Error("model down"); };
    const res = await drainReconcileQueue({ curate });
    expect(res).toMatchObject({ processed: 1, decided: 0 });
    expect(await readQueue()).toEqual([]);
    const audit = await readFile(auditFilePath(), "utf8");
    expect(JSON.parse(audit.trim().split("\n").at(-1)!).verdict).toBeNull();
  });

  it("honors --limit, leaving the rest queued", async () => {
    await seedTask("fact one", "id1");
    await seedTask("fact two", "id2");
    const curate = async (): Promise<CuratorDecision> => ({ verdict: "DUPLICATE", rationale: "dup" });
    const res = await drainReconcileQueue({ curate, limit: 1 });
    expect(res.processed).toBe(1);
    expect((await readQueue()).length).toBe(1);
  });
});

// Touch saveFact so the import is exercised (guards against an accidental dep drop).
describe("smoke", () => {
  it("saveFact still imports", () => { expect(typeof saveFact).toBe("function"); });
});
