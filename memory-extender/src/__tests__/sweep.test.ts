// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Ledger hygiene sweep (MarinaraExtender-0kk). The clustering is pure (tested
// offline); the sweep orchestration is tested with an injected cluster-curator,
// so the real Agent SDK call (clusterCurator) stays out of the offline suite.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createEntry } from "../dedup.js";
import { readIndex, readColdIndex } from "../storage.js";
import { clusterFacts, clusterFactsEmbedding, buildSweepLedger, applySweepLedger, readSweepLedger } from "../sweep.js";
import type { ClusterVerdict } from "../reconcile.js";

describe("clusterFacts (pure)", () => {
  const E = (id: string, summary: string, lane = "character_topics", supersededBy?: string) =>
    ({ id, lane, summary, ...(supersededBy ? { supersededBy } : {}) });

  it("clusters near-duplicate facts, leaves distinct ones apart", () => {
    const cs = clusterFacts([
      E("a", "Mari sold a solution to someone"),
      E("b", "Mari sold a fix to someone"),
      E("c", "Mari grew up in Krakow"),
    ], { threshold: 0.4 });
    expect(cs.length).toBe(1); // a+b cluster; c is a singleton (dropped)
    expect(cs[0]!.memberIds.slice().sort()).toEqual(["a", "b"]);
  });

  it("excludes incident beats, scene recaps, and open_threads — not the sweep's domain", () => {
    const cs = clusterFacts([
      E("i1", "[tense] Mari sold a solution to someone"),
      E("i2", "[tense] Mari sold a fix to someone"),
      E("r1", "[scene recap] Mari sold a solution to someone"), // the space-in-tag case looksIncident missed
      E("r2", "[scene recap] Mari sold a fix to someone"),
      E("t1", "Mari sold a solution to someone", "open_threads"),
      E("t2", "Mari sold a fix to someone", "open_threads"),
    ], { threshold: 0.4 });
    expect(cs.length).toBe(0);
  });

  it("excludes superseded entries", () => {
    const cs = clusterFacts([
      E("a", "Mari sold a solution to someone"),
      E("b", "Mari sold a fix to someone", "character_topics", "a"),
    ], { threshold: 0.4 });
    expect(cs.length).toBe(0); // only a is active -> no multi-member cluster
  });

  it("flags oversized clusters past the cap (guardrail)", () => {
    const entries = Array.from({ length: 6 }, (_, i) => E(`e${i}`, "Mari repeated identical fact text here"));
    const cs = clusterFacts(entries, { threshold: 0.4, cap: 3 });
    expect(cs.length).toBe(1);
    expect(cs[0]!.oversized).toBe(true);
    expect(cs[0]!.memberIds.length).toBe(6);
  });
});

describe("buildSweepLedger + applySweepLedger", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "me-sweep-")); process.env.MARINARA_EXTENDER_DATA = join(dir, "data"); });
  afterEach(async () => { delete process.env.MARINARA_EXTENDER_DATA; await rm(dir, { recursive: true, force: true }); });

  const seedPair = async () => ({
    a: await createEntry("character", "mari", { lane: "character_topics", summary: "Mari sold a solution to someone", content: "Mari sold a solution to someone", kind: "trait" }),
    b: await createEntry("character", "mari", { lane: "character_topics", summary: "Mari sold a fix to someone", content: "Mari sold a fix to someone", kind: "trait" }),
  });
  const activeIds = async () => ((await readIndex("character", "mari"))?.entries ?? []).filter((e) => !e.supersededBy).map((e) => e.id);

  it("build writes a reviewable ledger and mutates nothing; apply replays it (preview == apply)", async () => {
    const { a, b } = await seedPair();
    const curate = async (): Promise<ClusterVerdict> => ({ verdict: "merge", canonicalId: a!.id, redundantIds: [b!.id], rationale: "same fact", confidence: "high" });

    const built = await buildSweepLedger("character", "mari", { threshold: 0.4, curate });
    expect(built).toMatchObject({ clusters: 1, merges: 1 });
    expect((await activeIds()).slice().sort()).toEqual([a!.id, b!.id].slice().sort()); // build mutates nothing
    const led = await readSweepLedger("character", "mari");
    expect(led?.merges).toHaveLength(1);
    expect(led?.merges[0]).toMatchObject({ canonicalId: a!.id, redundantIds: [b!.id] });

    const applied = await applySweepLedger("character", "mari");
    expect(applied).toMatchObject({ merges: 1, superseded: 1 });
    const active = await activeIds();
    expect(active).toContain(a!.id);
    expect(active).not.toContain(b!.id);
    const cold = await readColdIndex("character", "mari");
    expect(cold?.entries.find((e) => e.id === b!.id)?.supersededBy).toBe(a!.id);
  });

  it("a distinct verdict writes no merge to the ledger; apply supersedes nothing", async () => {
    const { a, b } = await seedPair();
    const curate = async (): Promise<ClusterVerdict> => ({ verdict: "distinct", rationale: "different facts", confidence: "high" });
    await buildSweepLedger("character", "mari", { threshold: 0.4, curate });
    expect((await readSweepLedger("character", "mari"))?.merges).toHaveLength(0);
    const applied = await applySweepLedger("character", "mari");
    expect(applied).toMatchObject({ merges: 0, superseded: 0 });
    expect((await activeIds()).length).toBe(2);
    expect(a && b).toBeTruthy();
  });

  it("apply with no prior build is a no-op (null)", async () => {
    expect(await applySweepLedger("character", "ghost")).toBeNull();
  });

  it("hand-editing the ledger before apply is honored (drop a merge -> not applied)", async () => {
    const { a, b } = await seedPair();
    const curate = async (): Promise<ClusterVerdict> => ({ verdict: "merge", canonicalId: a!.id, redundantIds: [b!.id], rationale: "same", confidence: "high" });
    await buildSweepLedger("character", "mari", { threshold: 0.4, curate });
    // Simulate the human trimming the ledger to empty before apply.
    const { writeFile } = await import("node:fs/promises");
    const { join: pj } = await import("node:path");
    const led = await readSweepLedger("character", "mari");
    await writeFile(pj(dir, "data", "reconcile-queue", "sweep-ledger", "character__mari.json"), JSON.stringify({ ...led, merges: [] }), "utf8");
    const applied = await applySweepLedger("character", "mari");
    expect(applied).toMatchObject({ merges: 0, superseded: 0 });
    expect((await activeIds()).length).toBe(2); // nothing retired
  });
});

describe("clusterFactsEmbedding (and — semantic clustering)", () => {
  const E = (id: string, summary: string, lane = "character_topics") => ({ id, lane, summary });
  // alpha≈beta (cosine ~0.98), gamma orthogonal.
  const embed = async (texts: string[]) =>
    texts.map((t) => (t.includes("alpha") ? [1, 0, 0] : t.includes("beta") ? [0.98, 0.2, 0] : [0, 0, 1]));

  it("clusters by cosine — groups the semantically-close pair lexical would miss", async () => {
    const cs = await clusterFactsEmbedding([E("a", "alpha one"), E("b", "beta two"), E("c", "gamma three")], { embed });
    expect(cs).not.toBeNull();
    expect(cs!.length).toBe(1);
    expect(cs![0]!.memberIds.slice().sort()).toEqual(["a", "b"]);
  });

  it("returns null when the embed model is unavailable (caller falls back)", async () => {
    expect(await clusterFactsEmbedding([E("a", "x"), E("b", "y")], { embed: async () => null })).toBeNull();
  });

  it("excludes incidents and threads before embedding", async () => {
    expect(await clusterFactsEmbedding([E("a", "[fear] alpha"), E("b", "beta", "open_threads")], { embed })).toEqual([]);
  });
});

describe("buildSweepLedger clustering mode", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "me-sweepmode-")); process.env.MARINARA_EXTENDER_DATA = join(dir, "data"); });
  afterEach(async () => { delete process.env.MARINARA_EXTENDER_DATA; await rm(dir, { recursive: true, force: true }); });
  const embed = async (texts: string[]) =>
    texts.map((t) => (t.includes("alpha") ? [1, 0, 0] : t.includes("beta") ? [0.98, 0.2, 0] : [0, 0, 1]));

  it("uses embedding clustering when embed is available (catches what lexical misses)", async () => {
    const a = await createEntry("character", "mari", { lane: "character_topics", summary: "alpha trait", content: "alpha trait", kind: "trait" });
    const b = await createEntry("character", "mari", { lane: "character_topics", summary: "beta trait", content: "beta trait", kind: "trait" });
    const curate = async (): Promise<ClusterVerdict> => ({ verdict: "merge", canonicalId: a!.id, redundantIds: [b!.id], rationale: "same", confidence: "high" });
    const res = await buildSweepLedger("character", "mari", { clustering: "auto", embed, curate });
    expect(res.mode).toBe("embedding");
    expect(res.merges).toBe(1); // alpha/beta cluster semantically (jaccard would NOT — they share only "trait")
  });

  it("falls back to lexical when the embed model is unavailable", async () => {
    await createEntry("character", "mari", { lane: "character_topics", summary: "Mari sold a solution to someone", content: "x", kind: "trait" });
    await createEntry("character", "mari", { lane: "character_topics", summary: "Mari sold a fix to someone", content: "y", kind: "trait" });
    const curate = async (): Promise<ClusterVerdict> => ({ verdict: "distinct", rationale: "d", confidence: "high" });
    const res = await buildSweepLedger("character", "mari", { clustering: "auto", embed: async () => null, threshold: 0.4, curate });
    expect(res.mode).toBe("lexical");
    expect(res.clusters).toBe(1); // lexical caught the solution/fix pair
  });
});

describe("sweep apply gate (mjp)", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "me-sweepgate-")); process.env.MARINARA_EXTENDER_DATA = join(dir, "data"); });
  afterEach(async () => { delete process.env.MARINARA_EXTENDER_DATA; await rm(dir, { recursive: true, force: true }); });
  const activeIds = async () => ((await readIndex("character", "mari"))?.entries ?? []).filter((e) => !e.supersededBy).map((e) => e.id);
  const trait = (s: string) => ({ lane: "character_topics" as const, summary: s, content: s, kind: "trait" as const });

  it("gated apply holds the trauma cluster, applies the clean high-confidence one", async () => {
    const a1 = await createEntry("character", "mari", trait("Mari has PTSD flashbacks from the deployment"));
    const a2 = await createEntry("character", "mari", trait("Mari experiences PTSD flashbacks from the deployment"));
    const b1 = await createEntry("character", "mari", trait("Mari founded the Venturecon conference"));
    const b2 = await createEntry("character", "mari", trait("Mari founded the Venturecon conference event"));
    // Merge whatever cluster is presented; high confidence, first member canonical.
    const curate = async (members: { id: string }[]): Promise<ClusterVerdict> =>
      ({ verdict: "merge", canonicalId: members[0]!.id, redundantIds: members.slice(1).map((m) => m.id), rationale: "same", confidence: "high" });

    await buildSweepLedger("character", "mari", { clustering: "lexical", threshold: 0.4, curate });
    const res = await applySweepLedger("character", "mari"); // gated by default
    expect(res!.applied).toBe(1); // the clean Venturecon merge
    expect(res!.held).toBe(1);    // the PTSD merge — domain-sensitive, held even at high confidence

    const active = await activeIds();
    expect(active).toContain(a1!.id); // trauma pair untouched
    expect(active).toContain(a2!.id);
    expect([b1!.id, b2!.id].filter((id) => active.includes(id)).length).toBe(1); // exactly one Venturecon retired
  });
});
