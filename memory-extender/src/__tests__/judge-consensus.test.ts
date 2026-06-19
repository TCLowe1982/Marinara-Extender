// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Multi-pass judge consensus (MarinaraExtender-8jw). The per-pass judge call is
// injected, so the vote/threshold/abstain logic is tested deterministically
// offline — the model's actual judgment is the LIVE concern (judge-calibration).

import { describe, it, expect } from "vitest";
import type { AmbientFact, JudgePass } from "../ambient.js";
import { judgeDurableFacts } from "../ambient.js";

const f = (fact: string): AmbientFact => ({ text: fact, fact, lane: "character_topics", scope: "character", subject: "Mari" });
// 0 = abstract durable (flips), 1 = masked transient (flips), 2 = concrete durable (stable)
const FACTS = [f("durable-abstract"), f("masked-transient"), f("durable-concrete")];

// A scripted judge: returns the next keep-set per call (null = pass abstains).
const scripted = (...sets: (number[] | null)[]): JudgePass => {
  let i = 0;
  return async () => sets[i++] ?? null;
};
const factsOf = (kept: AmbientFact[]) => kept.map((k) => k.fact).sort();

describe("judgeDurableFacts — multi-pass consensus (8jw)", () => {
  it("keeps on a strict majority: abstract durable 2/3 stays, transient 1/3 drops", async () => {
    // votes — idx0: 2, idx1: 1, idx2: 3. threshold floor(3/2)+1 = 2.
    const judgePass = scripted([0, 1, 2], [0, 2], [2]);
    const kept = await judgeDurableFacts(FACTS, { passes: 3, judgePass });
    expect(factsOf(kept)).toEqual(["durable-abstract", "durable-concrete"]);
  });

  it("drops a candidate that only ever appears in a minority", async () => {
    // idx1 kept once across 3 passes -> below threshold 2 -> dropped.
    const judgePass = scripted([0, 2], [0, 2], [0, 1, 2]);
    const kept = await judgeDurableFacts(FACTS, { passes: 3, judgePass });
    expect(factsOf(kept)).toEqual(["durable-abstract", "durable-concrete"]);
  });

  it("a dead pass ABSTAINS (null), it does not vote everything down", async () => {
    // pass 2 is null -> okPasses=2, threshold floor(2/2)+1 = 2 (unanimous of the
    // two that voted). idx0 kept by both -> stays; idx1 kept by one -> drops.
    const judgePass = scripted([0, 1], null, [0]);
    const kept = await judgeDurableFacts(FACTS, { passes: 3, judgePass });
    expect(factsOf(kept)).toEqual(["durable-abstract"]);
  });

  it("fail-open: ALL passes unavailable -> keep everything (no silent wipe)", async () => {
    const judgePass = scripted(null, null, null);
    const kept = await judgeDurableFacts(FACTS, { passes: 3, judgePass });
    expect(factsOf(kept)).toEqual(factsOf(FACTS));
  });

  it("passes=1 reduces to plain single-pass filtering (default path unchanged)", async () => {
    const judgePass = scripted([0, 2]);
    const kept = await judgeDurableFacts(FACTS, { passes: 1, judgePass });
    expect(factsOf(kept)).toEqual(["durable-abstract", "durable-concrete"]);
  });

  it("single available pass behaves as single-pass even when N>1 requested", async () => {
    // Only the first pass reaches a model; okPasses=1 -> threshold 1 -> that pass wins.
    const judgePass = scripted([2], null, null);
    const kept = await judgeDurableFacts(FACTS, { passes: 3, judgePass });
    expect(factsOf(kept)).toEqual(["durable-concrete"]);
  });

  it("out-of-range indices from a noisy pass are ignored", async () => {
    const judgePass = scripted([0, 99, -1], [0], [0]);
    const kept = await judgeDurableFacts(FACTS, { passes: 3, judgePass });
    expect(factsOf(kept)).toEqual(["durable-abstract"]);
  });
});
