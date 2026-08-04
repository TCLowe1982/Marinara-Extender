// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// MarinaraExtender-2tro — the summarizer drops the user's clause.
//
// The two fixtures below are REAL entries from the live store, found by the np4b
// confound sweep. They are kept verbatim (content vs summary) because the failure
// is not hypothetical and a paraphrased fixture would not prove the fix.
//
// The negative cases matter as much as the positives: this pass writes an
// attribution into permanent memory, so it must stay silent whenever it is not
// certain. Each "does not fire" test names the specific way a naive version of
// this check would produce a wrong attribution.

import { describe, it, expect } from "vitest";
import type { AmbientFact } from "../ambient.js";
import { keepUserClause, splitClauses, userSpokenLines } from "../user-clause.js";

function fact(text: string, f: string, over: Partial<AmbientFact> = {}): AmbientFact {
  return { text, fact: f, lane: "user_topics", scope: "character", ...over };
}

describe("splitClauses", () => {
  it("splits on a coordinating conjunction", () => {
    expect(splitClauses("I was in the Army, and Mari is Polish.")).toEqual([
      "I was in the Army",
      "Mari is Polish",
    ]);
  });

  it("splits on sentence enders, including mid-sentence question marks", () => {
    expect(
      splitClauses("It was my fourth sapper stakes, and Sgt Roger's 6th? 7th? Sgt Lynn had done it 5 times."),
    ).toEqual([
      "It was my fourth sapper stakes",
      "Sgt Roger's 6th",
      "7th",
      "Sgt Lynn had done it 5 times",
    ]);
  });

  it("leaves a single clause alone (the closing full stop is a boundary, so it goes)", () => {
    expect(splitClauses("Mari grew up in Kraków.")).toEqual(["Mari grew up in Kraków"]);
  });
});

describe("keepUserClause — the verified fact-loss cases", () => {
  it("restores the Army clause (utopic-wzgh3ilg)", () => {
    const text = "I was in the Army, and Mari is Polish.";
    const out = keepUserClause([fact(text, "Mari is Polish", { subject: "Mari" })], {
      userText: text,
    });
    expect(out[0]!.fact).toBe("[user: I was in the Army] Mari is Polish");
  });

  it("restores the sapper-stakes clause (utopic-jakzyxe9), recognising the third party by roster", () => {
    // No subject on the fact — the roster is what establishes that the survivor
    // belongs to someone else.
    const text = "It was my fourth sapper stakes, and Sgt Roger's 6th? 7th? Sgt Lynn had done it 5 times.";
    const out = keepUserClause(
      [
        fact(
          text,
          "Sgt Roger has completed sapper stakes between 6th and 7th time; Sgt Lynn has completed it 5 times.",
        ),
      ],
      { userText: text, thirdParties: ["Sgt Roger", "Sgt Lynn"] },
    );
    expect(out[0]!.fact).toBe(
      "[user: It was my fourth sapper stakes] Sgt Roger has completed sapper stakes between 6th and 7th time; Sgt Lynn has completed it 5 times.",
    );
  });

  it("prefixes rather than appends, so the clause survives the 120-char summary cap", () => {
    const text = "I was in the Army, and Mari is Polish.";
    const out = keepUserClause([fact(text, "Mari is Polish", { subject: "Mari" })], { userText: text });
    expect(out[0]!.fact.slice(0, 120)).toContain("Army");
  });
});

describe("keepUserClause — does not fire", () => {
  it("when the model already returned the user's half as its own fact", () => {
    // The correct behaviour after the prompt fix. Amending here would duplicate it.
    const text = "I was in the Army, and Mari is Polish.";
    const out = keepUserClause(
      [
        fact(text, "Mari is Polish", { subject: "Mari" }),
        fact(text, "The user served in the Army", { subject: "user" }),
      ],
      { userText: text },
    );
    expect(out.map((f) => f.fact)).toEqual(["Mari is Polish", "The user served in the Army"]);
  });

  it("when the clause is a CHARACTER's first-person dialogue, not the user's", () => {
    // The mis-attribution this pass most has to avoid. Same sentence shape; the
    // words simply are not in what the user said.
    const text = "I grew up in Kraków, and Priya is a physicist.";
    const out = keepUserClause([fact(text, "Priya is a physicist", { subject: "Priya" })], {
      userText: "So what did you two get up to?",
    });
    expect(out[0]!.fact).toBe("Priya is a physicist");
  });

  it("when the user's clause was reworded rather than lost", () => {
    const text = "I served in the Army, and Mari is Polish.";
    const out = keepUserClause(
      [fact(text, "TC served in the Army", { subject: "Mari" })],
      { userText: text, userForms: ["tc", "tc lowe"] },
    );
    expect(out[0]!.fact).toBe("TC served in the Army");
  });

  it("when the fact keeps first-person phrasing", () => {
    const text = "I was in the Army, and Mari is Polish.";
    const out = keepUserClause([fact(text, "I was in the Army", { subject: "Mari" })], { userText: text });
    expect(out[0]!.fact).toBe("I was in the Army");
  });

  it("when the summary is about the user with the subject left IMPLICIT", () => {
    // The class a live-store scan proved dominant: 169 raw hits, mostly summaries
    // like these — already the user's fact, simply never naming them. Reading an
    // absent user as a dropped one would prefix a redundant clause onto a
    // perfectly healthy memory.
    const cases: [string, string][] = [
      ["english is a garbage language and i say that as someone who speaks three of them.", "Speaks three languages"],
      ["I was medicated through high school, but I had to go off my meds to join up.", "Was medicated through high school but had to stop medication to enlist in the military."],
      ["I generally don't take my meds till after breakfast, which is after workout and shower.", "Takes meds after breakfast, which comes after working out and showering"],
    ];
    for (const [text, summary] of cases) {
      const out = keepUserClause([fact(text, summary)], { userText: text });
      expect(out[0]!.fact, `should not have touched: ${summary}`).toBe(summary);
    }
  });

  it("when the summary only MENTIONS a third party instead of being about them", () => {
    // Hargrove is a real other person and the roster knows him, but the fact is
    // the user's. Subject position is the evidence, not presence.
    const text = "I could barely remember Hargrove's name, and had to keep looking it up too.";
    const out = keepUserClause(
      [fact(text, "has difficulty remembering character names (specifically Hargrove)")],
      { userText: text, thirdParties: ["Hargrove"] },
    );
    expect(out[0]!.fact).toBe("has difficulty remembering character names (specifically Hargrove)");
  });

  it("when nothing establishes that the survivor is about someone else", () => {
    // Same sentence as the Army fixture, but with no subject and no roster. The
    // pass stays silent rather than guessing from the leading capital.
    const text = "I was in the Army, and Mari is Polish.";
    const out = keepUserClause([fact(text, "Mari is Polish")], { userText: text });
    expect(out[0]!.fact).toBe("Mari is Polish");
  });

  it("when the sentence has only one clause", () => {
    // "I met Mari's sister yesterday." -> "Mari has a sister" is a legitimate
    // extraction, not a dropped clause. No coordination, no repair.
    const text = "I met Mari's sister yesterday.";
    const out = keepUserClause([fact(text, "Mari has a sister", { subject: "Mari" })], {
      userText: text,
    });
    expect(out[0]!.fact).toBe("Mari has a sister");
  });

  it("when there is no first-person clause at all", () => {
    const text = "Mari is Polish, and Priya is a physicist.";
    const out = keepUserClause([fact(text, "Mari is Polish", { subject: "Mari" })], {
      userText: text,
    });
    expect(out[0]!.fact).toBe("Mari is Polish");
  });

  it("twice on the same fact — the repair is idempotent", () => {
    const text = "I was in the Army, and Mari is Polish.";
    const opts = { userText: text, thirdParties: ["Mari"] };
    const once = keepUserClause([fact(text, "Mari is Polish")], opts);
    const twice = keepUserClause(once, opts);
    expect(twice[0]!.fact).toBe("[user: I was in the Army] Mari is Polish");
  });
});

describe("keepUserClause — bounds", () => {
  it("truncates a long clause so it cannot eat the whole summary", () => {
    const long = "I spent eleven consecutive winters running the northern survey line alone in the dark";
    const text = `${long}, and Mari is Polish.`;
    const out = keepUserClause([fact(text, "Mari is Polish", { subject: "Mari" })], {
      userText: text,
      maxClauseChars: 30,
    });
    expect(out[0]!.fact).toBe("[user: I spent eleven consecutive wi…] Mari is Polish");
  });

  it("bounds the prefix across clauses, not just within one", () => {
    // Found by scanning the live store: one entry's `content` was a whole
    // transcript, and capping each clause separately still produced a
    // 2,000-character prefix.
    const clauses = Array.from({ length: 40 }, (_, i) => `I did thing number ${i} myself`);
    const text = `${clauses.join(", and ")}, and Mari is Polish.`;
    const out = keepUserClause([fact(text, "Mari is Polish", { subject: "Mari" })], { userText: text });
    expect(out[0]!.fact.length).toBeLessThanOrEqual("[user: ] Mari is Polish".length + 90);
  });

  it("returns the input untouched when there is no user text", () => {
    const text = "I was in the Army, and Mari is Polish.";
    const facts = [fact(text, "Mari is Polish")];
    expect(keepUserClause(facts, { userText: "" })).toBe(facts);
  });
});

describe("userSpokenLines", () => {
  it("keeps only the User: lines from a scene transcript", () => {
    const scene = "User: I was in the Army.\n\nScene: Mari smiles. I am Polish, she says.\n\nUser: Right.";
    expect(userSpokenLines(scene)).toBe("I was in the Army.\nRight.");
  });
});
