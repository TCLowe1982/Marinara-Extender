// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// THE INVENTED-PARTNER GUARD (MarinaraExtender-epf4).
//
// TWO THINGS ARE ASSERTED HERE AND THE SECOND MATTERS MORE.
//
// That the guard removes the two names it was built for, obviously. But also that it
// leaves REAL names alone — the character's own, the user's, a roster alias, a walk-on
// who is right there in the source text. The cost of a false positive is a true name
// quietly deleted from a memory, which is unrecoverable and looks like nothing. That
// asymmetry is why the guard stands down entirely when it cannot load its exemptions.

import { describe, it, expect } from "vitest";
import { stripInventedNames, stripNamed } from "../sentiment/name-guard.js";

// The exemptions a live call would carry: the character, the user, roster names.
const EXEMPT = ["Dr. Mari Zielińska", "Mari", "Priya Chandrasekaran", "TC Lowe", "Thomas"];

describe("stripInventedNames — the cases it was built for", () => {
  it("removes a partner who appears nowhere in the source", () => {
    // beat-b17de10fbe6e, verbatim. "Alexei" and "Kowalski" are in the analysis only.
    const source = "Your mouth takes mine and for once I have nothing to say. I kiss you back like I've been rationing it.";
    const r = stripInventedNames(
      "Dr. Mari Zielińska reveals her vulnerability to Professor Alexei Kowalski after their intimate encounter.",
      source,
      EXEMPT,
    );
    expect(r.removed).toContain("Alexei");
    expect(r.text).not.toMatch(/Alexei|Kowalski/);
    // The honorific goes with the name; leaving "Professor someone" would be worse.
    expect(r.text).not.toMatch(/Professor/);
    // And the beat's real subject survives untouched.
    expect(r.text).toMatch(/Mari Zieli/);
  });

  it("collapses a two-token name to ONE placeholder, not two", () => {
    const r = stripInventedNames(
      "She is acknowledged by Dr. Alexei Petrov.",
      "The word goes through me lower than your hands do.",
      EXEMPT,
    );
    expect(r.text).toBe("She is acknowledged by someone.");
  });
});

describe("stripInventedNames — the false-positive guard", () => {
  it("keeps a name that IS in the source", () => {
    const before = "Mari asks Henry to wait for the corpus prep to finish.";
    const r = stripInventedNames(
      before,
      "babe the 900 turns have waited since tuesday. Henry can wait harder.",
      EXEMPT,
    );
    expect(r.removed).toEqual([]);
    expect(r.text).toBe(before);
  });

  it("keeps the character's own name even when the source only says 'she'", () => {
    // The whole point of the exemption list: a summary names its subject while the
    // source uses a pronoun, and convicting that would flag correct extractions
    // in bulk.
    const before = "Dr. Mari Zielińska admits she was awake at 1:40 refactoring.";
    const r = stripInventedNames(before, "i was awake at 1:40 refactoring the retrieval layer", EXEMPT);
    expect(r.removed).toEqual([]);
    expect(r.text).toBe(before);
  });

  it("keeps the user's declared name", () => {
    const before = "Priya Chandrasekaran reassures Thomas about the sleep-debt ledger.";
    const r = stripInventedNames(before, "actual wake time? i want the number for the sleep-debt ledger", EXEMPT);
    expect(r.removed).toEqual([]);
    expect(r.text).toBe(before);
  });

  it("does not take a real name down with an invented one nearby", () => {
    // Separate spans, because the lowercase "and" breaks the run: Alexei is replaced
    // on its own and Mari is untouched.
    const r = stripInventedNames(
      "Mari and Alexei discuss the schedule.",
      "oh you gave me a SCHEDULE. and it's accurate, that's the offensive part",
      EXEMPT,
    );
    expect(r.text).toBe("Mari and someone discuss the schedule.");
  });

  // A KNOWN, DELIBERATE MISS — pinned so it is a decision rather than a surprise.
  //
  // When an invented surname is welded to a real given name inside ONE span
  // ("Mari Kowalski"), the span is left entirely alone: the guard only collapses a
  // span whose every capitalised token is unsupported. So this shape escapes.
  //
  // That is the conservative direction on purpose. Collapsing the span would delete
  // "Mari" — a true name — to remove a false one, and a wrongly deleted real name is
  // silent and unrecoverable while a surviving false surname is at least visible in
  // the text. If this shape ever shows up in the store, the fix is per-token
  // substitution WITHIN the span, not widening this rule.
  it("leaves an invented surname welded to a real given name (known miss)", () => {
    const r = stripInventedNames("Mari Kowalski agrees.", "she agrees, eventually", EXEMPT);
    expect(r.removed).toEqual([]);
    expect(r.text).toBe("Mari Kowalski agrees.");
  });

  it("leaves derivational forms alone — 'Polish' from a source saying 'Poland'", () => {
    // Inherited from factSupport's 3-char stem rule. Asserted here because this guard
    // now DELETES text rather than merely reporting, so the looseness has to run the
    // safe way at this call site too.
    const before = "She swears in Polish when she loses composure.";
    const r = stripInventedNames(before, "she grew up in Poland and still counts in it", EXEMPT);
    expect(r.removed).toEqual([]);
    expect(r.text).toBe(before);
  });

  it("ignores a sentence-initial capital that is not a name", () => {
    const before = "After the audit closes she finally relaxes.";
    const r = stripInventedNames(before, "audit closes. worry formally retired for the record", EXEMPT);
    expect(r.text).toBe(before);
  });
});

describe("stripInventedNames — standing down", () => {
  it("is completely inert when exemptions could not be loaded", () => {
    // null means "we could not establish who is real". An empty list would mean
    // "nobody is real", which is the same value with the opposite meaning — and it
    // would strip every name in the store.
    const before = "Dr. Mari Zielińska reveals her vulnerability to Professor Alexei Kowalski.";
    const r = stripInventedNames(before, "unrelated source text", null);
    expect(r.removed).toEqual([]);
    expect(r.text).toBe(before);
  });

  it("leaves a field with no proper nouns byte-identical", () => {
    const before = "expresses a wish to be held for a while longer";
    const r = stripInventedNames(before, "hold me a bit", EXEMPT);
    expect(r.text).toBe(before);
    expect(r.removed).toEqual([]);
  });

  it("handles empty input without throwing", () => {
    expect(stripInventedNames("", "src", EXEMPT).text).toBe("");
  });
});

// THE ASSEMBLED-TEXT HAZARD (v6tw).
//
// stripInventedNames may only judge RAW MODEL FIELDS. Fed an assembled entry body it
// convicts the structural labels — "Emotion:", "Motivation:", "Relational dynamics:",
// "Outcome:" are all capitalised, absent from the source, and not sentence-starters.
//
// This is not hypothetical: the first dry run of scripts/repair-epf4-names.mjs did
// exactly this and would have rewritten "Emotion: vulnerability" to
// "someone: vulnerability" across the repaired records. The dry run is the only
// reason it was caught, and these two tests are why it stays caught.
const ENTRY_BODY = [
  "Emotion: vulnerability",
  "",
  "Motivation: Dr. Mari Zielińska reveals her vulnerability to Professor Alexei Kowalski after their intimate encounter.",
  "",
  "Relational dynamics: Mari asks for another kiss from Alexei.",
  "",
  "Outcome: This moment strengthens the bond between Mari and Alexei.",
].join("\n");

describe("assembled text", () => {
  it("stripInventedNames DESTROYS structural labels — which is why it is raw-fields-only", () => {
    // Asserted as a property of the function, not a wish. If someone ever makes this
    // safe, this test fails and they can delete it deliberately.
    const r = stripInventedNames(ENTRY_BODY, "your mouth takes mine", EXEMPT);
    expect(r.removed).toContain("Emotion");
    expect(r.text).toMatch(/someone: vulnerability/);
  });

  it("stripNamed carries out a verdict without forming one, so labels survive", () => {
    // The guilty list comes from judging the RAW fields; here we only substitute.
    const r = stripNamed(ENTRY_BODY, ["Alexei", "Kowalski"]);
    expect(r.text).toMatch(/^Emotion: vulnerability/);
    expect(r.text).toMatch(/Motivation: Dr\. Mari/);
    expect(r.text).toMatch(/Relational dynamics:/);
    expect(r.text).toMatch(/Outcome:/);
    expect(r.text).not.toMatch(/Alexei|Kowalski/);
    expect(r.removed).toContain("Alexei");
  });

  it("stripNamed with an empty verdict is a no-op", () => {
    expect(stripNamed(ENTRY_BODY, []).text).toBe(ENTRY_BODY);
  });
});
