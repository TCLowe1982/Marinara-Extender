// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Lexical relevance and body-term harvesting (MarinaraExtender-tp5).
//
// The property that matters most here is not any single score — it is that the
// WRITE side and the READ side agree. Terms are harvested from a body when an
// entry is written and compared against the conversation when it is ranked, so
// a disagreement about what counts as a word, a stopword, or a name would store
// terms that can never match. That failure is silent: every test exercising one
// side alone still passes. The round-trip cases below are the guard.

import { describe, it, expect } from "vitest";
import {
  harvestBodyTerms,
  relevanceScore,
  summaryTerms,
  MAX_BODY_TERMS,
  PROPER_NOUN_WEIGHT,
} from "../relevance.js";

describe("summary scoring", () => {
  it("scores accumulated evidence, not a fraction of the summary", () => {
    // vrw: a detailed summary must not lose to a short generic one. Two matched
    // terms in a long summary must beat one matched term in a short one - under
    // the old hit/words.size form the short one won outright.
    const detailed = "Erica Cathmore ran the northern survey team for three seasons";
    const generic = "wants to remember things";
    expect(relevanceScore(detailed, "the survey team met"))
      .toBeGreaterThan(relevanceScore(generic, "remember this"));
  });

  it("weights a matched name above matched common words", () => {
    const oneName = relevanceScore("The Cathmore report", "who wrote the Cathmore report");
    // "wants" + "remember" — two ordinary terms, no name.
    const twoCommon = relevanceScore("wants to remember", "she wants to remember");
    expect(oneName).toBeGreaterThan(twoCommon);
  });

  it("does not treat a leading capital as a name", () => {
    // Sentence case names nobody; that was the whole reason for the exemption.
    expect(summaryTerms("Statement about established knowledge").get("statement"))
      .toBe(1);
    expect(summaryTerms("A note about Erica").get("erica")).toBe(PROPER_NOUN_WEIGHT);
  });

  it("returns 0 with no conversation text and stays inside [0,1)", () => {
    expect(relevanceScore("anything at all", "")).toBe(0);
    const saturated = relevanceScore(
      "Erica Cathmore Marisol Priya Aurora Lara survey team season report",
      "Erica Cathmore Marisol Priya Aurora Lara survey team season report",
    );
    expect(saturated).toBeGreaterThan(0.9);
    expect(saturated).toBeLessThan(1);
  });
});

describe("harvesting body terms", () => {
  it("takes names from the body that the summary never mentions", () => {
    const terms = harvestBodyTerms("She mentioned Erica had left Cathmore by spring.", "A quiet evening");
    expect(terms).toContain("erica");
    expect(terms).toContain("cathmore");
  });

  it("drops a name the summary already scores AS a name", () => {
    // It matches from the summary anyway, at the higher weight; storing it twice
    // would inflate every row in a 2.5 MB index for nothing. "Erica" here is
    // mid-summary, so the scorer already recognises it.
    const terms = harvestBodyTerms("Erica said so.", "A note about Erica");
    expect(terms).not.toContain("erica");
  });

  it("KEEPS a name the summary holds only as sentence case", () => {
    // The leading slot forces weight 1, so without this the subject of one
    // character summary in five is scored as an ordinary word. The body is what
    // proves it is a name.
    const terms = harvestBodyTerms("Erica said so.", "Erica visited the site");
    expect(terms).toContain("erica");
  });

  it("keeps names only, not ordinary body words", () => {
    const terms = harvestBodyTerms("she walked slowly toward the harbour with Marisol", "A walk");
    expect(terms).toContain("marisol");
    expect(terms).not.toContain("walked");
    expect(terms).not.toContain("harbour");
  });

  it("ignores stopwords and very short tokens even when capitalised", () => {
    const terms = harvestBodyTerms("If He Is No Ax", "x");
    expect(terms).toEqual([]);
  });

  it("caps the list, because this rides on an index re-read every turn", () => {
    const many = Array.from({ length: 40 }, (_, i) => `Name${i}`).join(" ");
    expect(harvestBodyTerms(many, "summary").length).toBe(MAX_BODY_TERMS);
  });

  it("returns nothing for an absent or empty body", () => {
    expect(harvestBodyTerms(undefined, "s")).toEqual([]);
    expect(harvestBodyTerms(null, "s")).toEqual([]);
    expect(harvestBodyTerms("", "s")).toEqual([]);
  });

  it("counts a name at the start of a body — prose can open on one", () => {
    // Unlike a summary, where a leading capital is just sentence case.
    expect(harvestBodyTerms("Erica arrived late.", "someone arrived")).toContain("erica");
  });
});

describe("write-side / read-side round trip", () => {
  // The regression tp5 describes: 74% of entries mentioning a person named her
  // only in the body, and could never be summoned by her name.
  const summary = "A difficult conversation about the survey";
  const body = "Erica pushed back hard, and Cathmore sided with her.";

  it("makes a body-only name reachable, which it was not before", () => {
    expect(relevanceScore(summary, "what happened with Erica")).toBe(0);
    const terms = harvestBodyTerms(body, summary);
    expect(relevanceScore(summary, "what happened with Erica", terms)).toBeGreaterThan(0);
  });

  it("keeps a body mention subordinate to a summary subject", () => {
    // A passing mention must become findable without outranking the entry the
    // name is actually about. Both rows carry harvested terms, because in the
    // store both do — comparing a harvested row against an unharvested one
    // measures the backfill, not the ranking.
    const subjectSummary = "Erica resigned from the survey";
    const subjectBody = "She told the team that Erica would not be returning.";
    const aboutErica = relevanceScore(
      subjectSummary, "tell me about Erica", harvestBodyTerms(subjectBody, subjectSummary),
    );
    const mentionsErica = relevanceScore(summary, "tell me about Erica", harvestBodyTerms(body, summary));
    expect(mentionsErica).toBeGreaterThan(0);
    expect(aboutErica).toBeGreaterThan(mentionsErica);
  });

  it("counts a term in BOTH sources once, at the name weight", () => {
    // Not summed: a term the summary holds and the body confirms must not
    // outscore a term the summary is unambiguously about. The gain is that the
    // body CONFIRMS it is a name, restoring the weight sentence case hid.
    const leading = "Erica resigned from the survey";        // "Erica" reads as sentence case
    const confirmed = relevanceScore(leading, "what about Erica", ["erica"]);
    const unconfirmed = relevanceScore(leading, "what about Erica");
    expect(confirmed).toBeGreaterThan(unconfirmed);
    // Exactly one name-weighted hit, not a name plus a body bonus.
    expect(confirmed).toBeCloseTo(relevanceScore("The Erica file", "what about Erica"), 10);
  });

  it("restores the subject name that sentence case demoted - 20% of summaries", () => {
    // "Lara has borderline personality disorder" - the subject in the leading
    // slot, where the scorer must assume sentence case.
    const summary = "Lara has borderline personality disorder";
    const terms = harvestBodyTerms("She said Lara had been diagnosed years ago.", summary);
    expect(terms).toContain("lara");
    expect(relevanceScore(summary, "tell me about Lara", terms))
      .toBeGreaterThan(relevanceScore(summary, "tell me about Lara"));
  });

  it("scores an entry with no summary terms purely on its body names", () => {
    // Degenerate summaries exist in the store; they should still be reachable.
    const terms = harvestBodyTerms("Marisol was there.", "...");
    expect(relevanceScore("...", "did Marisol come", terms)).toBeGreaterThan(0);
  });

  it("is stable under re-harvest, which is what makes the backfill re-runnable", () => {
    const once = harvestBodyTerms(body, summary);
    const twice = harvestBodyTerms(body, summary);
    expect(twice).toEqual(once);
  });
});
