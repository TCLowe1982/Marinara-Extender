// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Text support for extracted facts (fqnl).
//
// Fixtures are the real case wherever possible. The Kraków entry is quoted exactly
// as it sits in professor_mari's ledger, and the chat it cites really does contain
// 393 messages with zero mention of the city.
//
// THE ASYMMETRY THAT SETS EVERY THRESHOLD HERE: a false accusation drops a REAL
// fact, which is a silent memory loss and the failure this whole system exists to
// prevent. A miss merely leaves junk that other layers still see. So both layers
// are tuned to catch wholesale fabrication and to stay quiet on paraphrase.

import { describe, it, expect } from "vitest";
import {
  receiptOverlap, receiptIsAuthentic, properNouns, factSupport, RECEIPT_MIN_OVERLAP,
} from "../fact-support.js";

describe("layer 1 — receipt authenticity", () => {
  const real =
    "I keep thinking about what you said at dinner. My mother was born in Gdańsk and " +
    "she never once talked about the war, not to me, not to anyone.";

  it("accepts a verbatim quotation", () => {
    expect(receiptIsAuthentic("My mother was born in Gdańsk", real)).toBe(true);
  });

  it("accepts a lightly trimmed or repunctuated quotation", () => {
    // Models routinely fix punctuation or drop a stray word; a genuine receipt is
    // near-verbatim, not byte-identical.
    expect(receiptIsAuthentic("my mother was born in gdansk and she never talked about the war", real)).toBe(true);
  });

  it("REJECTS a fabricated receipt — the live Kraków case", () => {
    // utopic-deaau6ak's claimed source, against a real message from the chat it
    // cites. The real chat has 393 messages and none mention Kraków.
    const claimed = "Dr. Mari Zielińska reflects on her childhood in Kraków, where she was fascinated by the history of the city.";
    expect(receiptIsAuthentic(claimed, real)).toBe(false);
    expect(receiptOverlap(claimed, real)).toBeLessThan(RECEIPT_MIN_OVERLAP);
  });

  it("rejects an empty or absent receipt rather than passing it", () => {
    expect(receiptIsAuthentic("", real)).toBe(false);
    expect(receiptIsAuthentic("anything", "")).toBe(false);
  });

  it("scores order, not just membership — a shuffled bag of words is not a quote", () => {
    const shuffled = "war the about talked never she Gdańsk in born was mother my";
    expect(receiptOverlap(shuffled, real)).toBeLessThan(1);
  });
});

describe("layer 2 — fact support", () => {
  it("convicts a proper noun that appears nowhere in the source", () => {
    const v = factSupport(
      "Dr. Mari Zielińska grew up in Kraków and has a deep interest in its history.",
      "she mentioned she misses the mountains in winter",
      ["Mari", "Zielińska", "Dr"],
    );
    expect(v.supported).toBe(false);
    expect(v.unsupported).toContain("Kraków");
  });

  it("does NOT convict ordinary rewording — summaries are allowed to paraphrase", () => {
    // "is Polish" from "I'm from Poland" must survive; convicting it would destroy
    // correct extractions wholesale.
    const v = factSupport("Mari is Polish", "i'm from poland, obviously", ["Mari"]);
    expect(v.supported).toBe(true);
  });

  it("exempts the subject's own name — the source usually just says 'she'", () => {
    const v = factSupport(
      "Dr. Mari Zielińska is a computational linguist",
      "she's a computational linguist, which explains a lot",
      ["Mari", "Zielińska", "Dr"],
    );
    expect(v.supported).toBe(true);
    expect(v.checked).toEqual([]);   // nothing external was asserted
  });

  it("accepts a proper noun that IS in the source", () => {
    const v = factSupport(
      "Mari's ex Janek is a literature professor in Kraków",
      "There was Janek — Polish, my year in undergrad. He's a literature professor in Kraków now.",
      ["Mari"],
    );
    expect(v.supported).toBe(true);
    expect(v.checked).toEqual(expect.arrayContaining(["Janek", "Kraków"]));
  });

  it("does not mistake a sentence-initial capital for a name", () => {
    // The leading-capital trap: "After the divorce…" must not report "After".
    const v = factSupport("After the divorce she moved twice", "she moved twice after the divorce", []);
    expect(v.checked).not.toContain("After");
    expect(v.supported).toBe(true);
  });

  it("is silent, not approving, when a fact asserts no external names", () => {
    const v = factSupport("she prefers mornings", "honestly i'm better before noon", []);
    expect(v.supported).toBe(true);
    expect(v.checked).toEqual([]);   // callers can tell this was untested
  });
});

describe("properNouns", () => {
  it("finds names and places, skipping openers and honorifics", () => {
    expect(properNouns("Dr. Mari went to Kraków in April")).toEqual(
      expect.arrayContaining(["Mari", "Kraków", "April"]),
    );
    expect(properNouns("The quick brown fox")).not.toContain("The");
  });

  it("handles empty input", () => {
    expect(properNouns("")).toEqual([]);
  });
});
