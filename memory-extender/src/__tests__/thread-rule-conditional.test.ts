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
  // ASSERTIONS UPDATED 2026-08-06 for Mari's rewrite; the guards are unchanged.
  // The old wording taught label shape by EXAMPLE — "Porsche test drive",
  // "jurisprudence soft launch", "the Hargrove investigation" — and all three were
  // in-domain bait that bait-audit reported UNCOVERED, with "Porsche test drive"
  // already matching 8 live motivations and 4 registry threads. They could not be
  // registered in PROMPT_EXAMPLE_ECHOES without rejecting genuine beats about the
  // real Porsche (n9bv). The rewrite states the constraint rather than demonstrating
  // it, so what these tests pin is now the CONSTRAINT, not the sample phrases.
  it("cites the Active threads list when threads are present", () => {
    const p = buildSystemPrompt("fear", [], true);
    expect(p).toContain('Reuse a label from the "Active threads" list');
  });

  it("drops the citation when no threads are present", () => {
    const p = buildSystemPrompt("fear", [], false);
    expect(p).not.toContain("Active threads");
  });

  it("KEEPS minting when no threads are present — the silent regression guard", () => {
    const p = buildSystemPrompt("fear", [], false);
    expect(p).toContain("thread:");
    // Minting: the variant must still tell the model to WRITE a label, not merely
    // to select one. Without this, no chat could ever grow its first thread.
    expect(p).toContain("write a label");
    // The label-shape teaching has to survive too, or the first thread of every
    // chat gets minted with no guidance about what a label should look like.
    // "the situation itself, not the cast" carries what the GOOD/BAD lists carried.
    expect(p).toContain("not the cast");
    // And the null case, which is now phrased as omission. Both reach the parser as
    // undefined: `typeof parsed.thread === "string"` rejects null and a missing key
    // alike, so the wording change is not a behaviour change.
    expect(p).toContain("Omit the field if nothing ongoing is at stake");
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
