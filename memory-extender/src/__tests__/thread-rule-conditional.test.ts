// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Conditional thread rule (vikj, Mari's split ruling 2026-08-05).
//
// "A rule that must always fire degrades in prose; a rule that only fires with data
// ships with the data." The thread rule is the second kind — when the user prompt
// carries no "Active threads" block, a rule telling the model to pick from that list
// points at a wall.
//
// THE CATCH THIS FILE EXISTS TO GUARD. The rule does TWO jobs: select from the live
// list, and MINT a label when the moment starts something new. Only the first dies
// with the list. Every chat begins with zero threads, so minting is the ONLY way a
// first thread is ever created — deleting the block outright would mean no chat could
// ever grow one. The regression is silent: threads simply stop appearing.

import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../sentiment/analyzer.js";

const EMOTIONS = [
  "fear", "shame", "hope", "desire", "relief",
  "vulnerability", "trust", "anger", "joy", "dysregulation",
] as const;

describe("thread rule is conditional on the list existing", () => {
  it("cites the Active threads list when threads are present", () => {
    const p = buildSystemPrompt("fear", [], true);
    expect(p).toContain('Pick a label VERBATIM from the "Active threads" list');
  });

  it("drops the citation when no threads are present", () => {
    const p = buildSystemPrompt("fear", [], false);
    expect(p).not.toContain("Active threads");
  });

  it("KEEPS minting when no threads are present — the silent regression guard", () => {
    const p = buildSystemPrompt("fear", [], false);
    expect(p).toContain("thread:");
    expect(p).toContain("starts something new");
    expect(p).toContain("naming the EVENT or ARC");
    // The label-shape teaching has to survive too, or the first thread of every
    // chat gets minted with no guidance about what a label should look like.
    expect(p).toContain("Never name the participants");
    expect(p).toContain("Use null when the beat is incidental");
  });

  it("defaults to the full rule, so existing callers see no change", () => {
    // The bench, the prompt dump and the bait-warrant test all call with two args.
    expect(buildSystemPrompt("fear", [])).toBe(buildSystemPrompt("fear", [], true));
  });

  it("never leaks the substitution placeholder, in either variant, for any emotion", () => {
    for (const e of EMOTIONS) {
      for (const hasThreads of [true, false]) {
        const p = buildSystemPrompt(e, e === "dysregulation" ? ["dissociation"] : [], hasThreads);
        expect(p, `${e} hasThreads=${hasThreads}`).not.toContain("__THREAD_RULE__");
      }
    }
  });

  it("substitutes in all ten prompts, not just the one that was checked by hand", () => {
    for (const e of EMOTIONS) {
      const withList = buildSystemPrompt(e, [], true);
      const without = buildSystemPrompt(e, [], false);
      expect(withList, e).toContain("Active threads");
      expect(without, e).not.toContain("Active threads");
      expect(without.length, e).toBeLessThan(withList.length);
    }
  });
});
