// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Through-line arc promotion (ceiling, MarinaraExtender-ajb). Deterministic
// coverage with an injected renderer and the embedding kill switch ON — the
// thread-id candidate generator and entity overlap drive clustering, so the
// tests exercise: clustering, match-before-mint (extend vs mint), renderer
// confirmation, watermark advance, dormancy + H4 reactivation rules.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runArcPromotion } from "../arc-promotion.js";
import { readArcs, readArcMemberships } from "../arcs.js";
import { writeBeat } from "../sentiment/encoder.js";
import { readIndex } from "../storage.js";
import type { EmotionalBeat } from "../sentiment/types.js";
import type { RenderInput, RenderResult } from "../arc-renderer.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-arcprom-"));
  process.env.MARINARA_EXTENDER_DATA = join(dir, "data");
  process.env.MARINARA_EXTENDER_EMBED_MODEL = "0"; // kill switch — deterministic signals only
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  delete process.env.MARINARA_EXTENDER_EMBED_MODEL;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function beat(id: string, over: Partial<EmotionalBeat> = {}): EmotionalBeat {
  return {
    id, speaker: "Priya", emotion: "desire", text: `text ${id}`,
    motivation: `motivation ${id}`, relationalDynamics: "r", outcome: "o",
    salience: 0.7, turnStart: 1, turnEnd: 1, created: "2026-06-10",
    sourceType: "chat", ...over,
  };
}

// Accept-everything renderer with a fixed label.
const acceptAll = (label: string) => async (input: RenderInput): Promise<RenderResult> => ({
  label,
  lead: "current state",
  body: "the trajectory so far",
  members: input.beats.map((b) => ({ beatId: b.beatId, role: "escalation", keep: true })),
});

describe("runArcPromotion", () => {
  it("clusters thread-linked beats, mints an arc, writes the recap, binds memberships", async () => {
    for (let i = 0; i < 4; i++) {
      await writeBeat("priya", beat(`beat-t${i}`, { threadId: "nthr-one" }));
    }
    await writeBeat("priya", beat("beat-lone", { threadId: undefined, salience: 0.9 }));

    const r = await runArcPromotion("priya", "Priya", acceptAll("the experiment arc"));
    expect(r.minted).toBe(1);
    expect(r.extended).toBe(0);

    const arcs = (await readArcs("priya")).arcs.filter((a) => a.kind === "through_line");
    expect(arcs).toHaveLength(1);
    expect(arcs[0]!.label).toBe("the experiment arc");
    expect(arcs[0]!.signature.threadIds).toContain("nthr-one");
    expect(arcs[0]!.watermark.version).toBe(1);
    expect(arcs[0]!.watermark.coveredThroughSeq).toBeGreaterThan(0);

    const members = await readArcMemberships("priya");
    expect(members.filter((m) => m.arcId === arcs[0]!.id)).toHaveLength(4);

    const hot = (await readIndex("character", "priya"))!;
    const recap = hot.entries.find((e) => e.id === `recap-${arcs[0]!.id}`)!;
    expect(recap.summary).toContain("[arc recap] the experiment arc");
  });

  it("match-before-mint: a later cluster sharing the threadId EXTENDS, recap updates in place", async () => {
    for (let i = 0; i < 3; i++) await writeBeat("priya", beat(`beat-a${i}`, { threadId: "nthr-x" }));
    const first = await runArcPromotion("priya", "Priya", acceptAll("arc v1"));
    expect(first.minted).toBe(1);

    for (let i = 0; i < 3; i++) await writeBeat("priya", beat(`beat-b${i}`, { threadId: "nthr-x", created: "2026-06-11" }));
    const second = await runArcPromotion("priya", "Priya", acceptAll("arc v2"));
    expect(second.minted).toBe(0);
    expect(second.extended).toBe(1);

    const arcs = (await readArcs("priya")).arcs.filter((a) => a.kind === "through_line");
    expect(arcs).toHaveLength(1); // accreted, not duplicated
    expect(arcs[0]!.label).toBe("arc v2"); // label re-renderable
    expect(arcs[0]!.watermark.version).toBe(2);
    const hot = (await readIndex("character", "priya"))!;
    expect(hot.entries.filter((e) => e.id.startsWith("recap-arc-"))).toHaveLength(1); // stable id, updated in place
  });

  it("renderer confirmation gates membership — a rejecting renderer mints nothing", async () => {
    for (let i = 0; i < 3; i++) await writeBeat("priya", beat(`beat-r${i}`, { threadId: "nthr-rej" }));
    const rejectAll = async (input: RenderInput): Promise<RenderResult> => ({
      label: "no", lead: "", body: "x",
      members: input.beats.map((b) => ({ beatId: b.beatId, role: "minor", keep: false })),
    });
    const r = await runArcPromotion("priya", "Priya", rejectAll);
    expect(r.minted).toBe(0);
    expect(r.rejectedByRenderer).toBeGreaterThan(0);
    expect((await readArcs("priya")).arcs.filter((a) => a.kind === "through_line")).toHaveLength(0);
  });

  it("low-salience and already-bound beats are not candidates", async () => {
    for (let i = 0; i < 3; i++) await writeBeat("priya", beat(`beat-low${i}`, { threadId: "nthr-low", salience: 0.3 }));
    const r = await runArcPromotion("priya", "Priya", acceptAll("never"));
    expect(r.candidates).toBe(0);
    expect(r.minted).toBe(0);
  });

  it("dormancy: untouched arcs quiesce; a threadId hit reactivates (H4)", async () => {
    for (let i = 0; i < 3; i++) await writeBeat("priya", beat(`beat-d${i}`, { threadId: "nthr-dorm" }));
    await runArcPromotion("priya", "Priya", acceptAll("sleeper"));

    // Age the arc: rewrite lastPromotedAt into the past.
    const { mutateYamlFile } = await import("../storage.js");
    const arcsPath = join(process.env.MARINARA_EXTENDER_DATA!, "characters", "priya", "arcs.yaml");
    await mutateYamlFile<{ arcs: Array<{ lastPromotedAt: string; status: string }> }>(
      arcsPath, () => ({ arcs: [] }),
      (f) => { for (const a of f.arcs) a.lastPromotedAt = "2026-01-01T00:00:00.000Z"; },
    );

    // A pass with no candidates still sweeps dormancy.
    const sweep = await runArcPromotion("priya", "Priya", acceptAll("x"));
    expect(sweep.dormanted).toBe(1);
    let arcs = (await readArcs("priya")).arcs.filter((a) => a.kind === "through_line");
    expect(arcs[0]!.status).toBe("dormant");

    // New beats on the same thread reactivate it (threadId hit beats dormancy).
    for (let i = 0; i < 3; i++) await writeBeat("priya", beat(`beat-d2${i}`, { threadId: "nthr-dorm", created: "2026-06-12" }));
    const wake = await runArcPromotion("priya", "Priya", acceptAll("awake"));
    expect(wake.extended).toBe(1);
    arcs = (await readArcs("priya")).arcs.filter((a) => a.kind === "through_line");
    expect(arcs[0]!.status).toBe("active");
  });
});
