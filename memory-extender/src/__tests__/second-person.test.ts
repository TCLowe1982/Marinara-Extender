// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// SECOND PERSON, WIRED (cye6 slice 2).
//
// The gate admitted a speaker describing THEMSELVES ("I") and a speaker naming a
// THIRD PARTY ("Sarah said"), and was structurally incapable of admitting a
// speaker describing THE PERSON THEY ARE TALKING TO. In a roleplay that is the
// dominant register for facts about the user, and it is why Thomas's origin was
// stated 21 times and recorded zero times (su6h).
//
// Admitting it is only half the fix. Second person is DIRECTIONAL, and getting
// the direction wrong at this volume is the qhej/hhdr referent bleed — the
// failure that filed three RP lines as biography of the human. So: the prompt is
// told the rule, and the code enforces the half that is grammatically certain.

import { describe, it, expect } from "vitest";
import {
  extractCandidates, isSecondPerson, isSecondPersonOnly, secondPersonSubject,
  enforceAddressDirection, secondPersonEnabled, type AmbientFact,
} from "../ambient.js";

// THE REGRESSION FIXTURE (su6h). Every one of these is real store text, and
// every one died on the person test alone — inside the length window, not a
// question, and carrying the fact the store never recorded.
const INDEPENDENCE = [
  "you're from independence, missouri, dead center of the dialect zone.",
  "sweeping every field: description is independence MO, army vet, eternal optimist",
  "A kitchen in independence, missouri.",
  "Who played timpani and keyboard percussion in a high school band room in Independence, Missouri.",
];

describe("the Independence case, end to end at the gate", () => {
  it("EVERY one of these was dropped by the old gate", () => {
    for (const s of INDEPENDENCE) {
      expect(extractCandidates(s)).toEqual([]);
    }
  });

  it("and the second-person one now survives", () => {
    const s = INDEPENDENCE[0];
    expect(s.length).toBeLessThanOrEqual(120); // 68 chars — never a length problem
    expect(extractCandidates(s, { admitSecondPerson: true })).toEqual([s]);
  });

  it("the ones with no grammatical person still do NOT survive, and that is honest", () => {
    // "A kitchen in independence, missouri." has no I, no you, no named subject.
    // cye6 fixes the second-person hole; it does not claim to fix every hole.
    // Recording that here so the next person does not read this fixture as a
    // clean sweep — see opyv, which catches the origin by reading the card.
    for (const s of INDEPENDENCE.slice(1)) {
      expect(extractCandidates(s, { admitSecondPerson: true })).toEqual([]);
    }
  });
});

describe("the gate is OFF by default — it failed its own bar (slice 3)", () => {
  const s = "you grew up on a barge and never once got seasick";

  it("default does NOT admit it", () => {
    // It shipped default-on. The bench measured the population it admits at 29%
    // precision and 34% misattribution against a pre-registered bar of >=60% and
    // <=25%, so the default was flipped. The mechanism stays wired and tested;
    // what is refused is turning it on before the attribution defect is fixed.
    expect(secondPersonEnabled()).toBe(false);
    expect(extractCandidates(s)).toEqual([]);
  });

  it("MARINARA_EXTENDER_SECOND_PERSON=1 turns it on", () => {
    const prev = process.env.MARINARA_EXTENDER_SECOND_PERSON;
    process.env.MARINARA_EXTENDER_SECOND_PERSON = "1";
    try {
      expect(secondPersonEnabled()).toBe(true);
      expect(extractCandidates(s, { admitSecondPerson: true })).toEqual([s]);
    } finally {
      if (prev === undefined) delete process.env.MARINARA_EXTENDER_SECOND_PERSON;
      else process.env.MARINARA_EXTENDER_SECOND_PERSON = prev;
    }
  });
});

describe("isSecondPersonOnly — a mixed sentence keeps its first-person claim", () => {
  it("second person alone", () => {
    expect(isSecondPersonOnly("you're from independence, missouri")).toBe(true);
  });

  it("second person BESIDE first person is not 'only' — the I-claim is real", () => {
    const s = "I told you I grew up in Texas";
    expect(isSecondPerson(s)).toBe(true);
    expect(isSecondPersonOnly(s)).toBe(false);
  });

  it("a named subject beside second person is not 'only' either", () => {
    expect(isSecondPersonOnly("Priya said you would hate the drive")).toBe(false);
  });
});

describe("secondPersonSubject", () => {
  it("is a mirror: the subject is whoever is NOT speaking", () => {
    expect(secondPersonSubject("character")).toBe("user");
    expect(secondPersonSubject("user")).toBe("character");
  });
});

// ── The enforced half ────────────────────────────────────────────────────────

const fact = (over: Partial<AmbientFact>): AmbientFact => ({
  text: "…", fact: "…", lane: "user_topics", scope: "character", ...over,
});

describe("a user-spoken 'you' can never be a fact about the user", () => {
  const said = "you were grown in a vat on Ceres";

  it("is reassigned to the session character — the addressee", () => {
    const { facts, counts } = enforceAddressDirection(
      [fact({ text: said, fact: "The user was grown in a vat on Ceres", subject: "user" })],
      { userAddressed: [said], characterName: "Mari" },
    );
    expect(facts[0].subject).toBe("Mari");
    expect(facts[0].lane).toBe("character_topics");
    expect(counts).toEqual({ reassigned: 1, refused: 0, speakerClaims: 0 });
  });

  it("an UNSUBJECTED user_topics fact from the same sentence is caught too", () => {
    // The model omitting `subject` and defaulting to user_topics is the same
    // claim by another route, and it is how the Texas rows were shaped.
    const { facts, counts } = enforceAddressDirection(
      [fact({ text: said, fact: "The user was grown in a vat", subject: undefined })],
      { userAddressed: [said], characterName: "Mari" },
    );
    expect(facts[0].subject).toBe("Mari");
    expect(counts.reassigned).toBe(1);
  });

  it("with NO addressee to name, the claim is dropped and the memory is kept", () => {
    const { facts, counts } = enforceAddressDirection(
      [fact({ text: said, fact: "The user was grown in a vat", subject: "user" })],
      { userAddressed: [said], characterName: undefined },
    );
    expect(facts).toHaveLength(1);            // route and mark, never drop
    expect(facts[0].subject).toBeUndefined(); // but the false claim does not survive
    expect(facts[0].scope).toBe("chat");      // and it stays out of a permanent ledger
    expect(counts).toEqual({ reassigned: 0, refused: 1, speakerClaims: 0 });
  });

  it("REFUSALS ARE COUNTED — a guard nobody can audit is a guard that drifts", () => {
    const { counts } = enforceAddressDirection(
      [
        fact({ text: said, subject: "user" }),
        fact({ text: said, subject: "user" }),
      ],
      { userAddressed: [said], characterName: "Mari" },
    );
    expect(counts.reassigned).toBe(2);
  });
});

describe("what the direction rule must NOT touch", () => {
  const said = "you were grown in a vat on Ceres";

  it("a fact about a THIRD PARTY from the same sentence is left alone", () => {
    const { facts, counts } = enforceAddressDirection(
      [fact({ text: said, fact: "Priya was grown in a vat", subject: "Priya", lane: "character_topics" })],
      { userAddressed: [said], characterName: "Mari" },
    );
    expect(facts[0].subject).toBe("Priya");
    expect(counts).toEqual({ reassigned: 0, refused: 0, speakerClaims: 0 });
  });

  it("a CHARACTER-spoken 'you' filed as a user fact is left alone — that is the correct reading", () => {
    // The 92.7% majority, and the whole recall win. Not in `userAddressed`.
    const { facts, counts } = enforceAddressDirection(
      [fact({ text: said, fact: "The user was grown in a vat", subject: "user" })],
      { userAddressed: [], characterName: "Mari" },
    );
    expect(facts[0].subject).toBe("user");
    expect(counts).toEqual({ reassigned: 0, refused: 0, speakerClaims: 0 });
  });

  it("a user-spoken FIRST-person fact is left alone", () => {
    // "I told you I grew up in Texas" is not second-person-only, so it never
    // enters userAddressed and the rule never sees it.
    const mixed = "I told you I grew up in Texas";
    const { facts } = enforceAddressDirection(
      [fact({ text: mixed, fact: "The user grew up in Texas", subject: "user" })],
      { userAddressed: [], characterName: "Mari" },
    );
    expect(facts[0].subject).toBe("user");
  });

  it("matches on normalized text, so echoed punctuation and case do not leak facts past it", () => {
    const { counts } = enforceAddressDirection(
      [fact({ text: "You were grown in a vat on Ceres.", subject: "user" })],
      { userAddressed: [said], characterName: "Mari" },
    );
    expect(counts.reassigned).toBe(1);
  });
});

// ── qs67: the speaker cannot be the subject ──────────────────────────────────
//
// Measured on 496 hand-labelled facts, this rule catches 69 genuine
// misattributions, fires wrongly on 12, and misses 16 — 85% precise. The 12 are
// speech acts where the character legitimately IS the subject, and they are
// surface-identical to the 69. So the claim is DROPPED, never reassigned:
// reassigning would mint false facts about the human, which is the failure this
// exists to stop.

describe("a character's own 'you' cannot be a fact about that character", () => {
  const said = "you were grown in a vat on Ceres";

  it("drops the claim and counts it — never reassigns", () => {
    const { facts, counts } = enforceAddressDirection(
      [fact({ text: said, fact: "Mari was grown in a vat", subject: "Mari", lane: "character_topics" })],
      { characterAddressed: [said], characterName: "Mari" },
    );
    expect(facts).toHaveLength(1);              // the memory survives
    expect(facts[0].fact).toBe("Mari was grown in a vat");
    expect(facts[0].subject).toBeUndefined();   // the claim does not
    expect(counts.speakerClaims).toBe(1);
    expect(counts.reassigned).toBe(0);          // NOT corrected to "user"
  });

  it("matches the speaker loosely — the model returns three spellings of one person", () => {
    // "Mari", "Dr. Mari Zielińska" and "Mari Zielińska" are all live in the
    // store for the same character; an exact compare would miss most of them.
    for (const subject of ["Mari", "Dr. Mari Zielińska", "Mari Zielińska"]) {
      const { counts } = enforceAddressDirection(
        [fact({ text: said, subject, lane: "character_topics" })],
        { characterAddressed: [said], characterName: "Dr. Mari Zielińska" },
      );
      expect(counts.speakerClaims).toBe(1);
    }
  });

  it("leaves a THIRD PARTY subject alone — only the speaker is refused", () => {
    const { facts, counts } = enforceAddressDirection(
      [fact({ text: said, fact: "Priya was grown in a vat", subject: "Priya", lane: "character_topics" })],
      { characterAddressed: [said], characterName: "Mari" },
    );
    expect(facts[0].subject).toBe("Priya");
    expect(counts.speakerClaims).toBe(0);
  });

  it("leaves a USER subject alone — that is the correct reading, and the whole recall win", () => {
    const { facts, counts } = enforceAddressDirection(
      [fact({ text: said, fact: "The user was grown in a vat", subject: "user" })],
      { characterAddressed: [said], characterName: "Mari" },
    );
    expect(facts[0].subject).toBe("user");
    expect(counts.speakerClaims).toBe(0);
  });

  it("does not fire on a sentence with no second person at all", () => {
    const plain = "Mari was grown in a vat on Ceres";
    const { facts, counts } = enforceAddressDirection(
      [fact({ text: plain, subject: "Mari", lane: "character_topics" })],
      { characterAddressed: [], characterName: "Mari" },
    );
    expect(facts[0].subject).toBe("Mari");
    expect(counts.speakerClaims).toBe(0);
  });

  it("records the refusal REASON, so the rate is auditable", async () => {
    const { resetSubjectRejectionCounts, subjectRejectionCounts } = await import("../subject.js");
    resetSubjectRejectionCounts();
    enforceAddressDirection(
      [fact({ text: said, subject: "Mari", lane: "character_topics" })],
      { characterAddressed: [said], characterName: "Mari" },
    );
    expect(subjectRejectionCounts().speaker).toBe(1);
  });
});
