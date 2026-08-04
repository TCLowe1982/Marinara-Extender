// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// The mention-entity index (MarinaraExtender-76aw slice 1).
//
// The property under test is not "does it find names" — it is WHICH PARTS BECOME
// ALIASES. A missed alias costs a recall. A false one costs correctness: it drags
// unrelated memories in under a name, in a system whose first principle is that a
// wrong memory is worse than a missing one. So the cases below are built around
// the two shapes measured on the live store — a real person whose surname is used
// alone (Erica Cathmore), and a compound noun whose parts never are (Elden Ring).

import { describe, it, expect } from "vitest";
import {
  emptyObservations, observeField, buildIndex, boundTokenCounts, independence,
  buildCueMap, expandCues, ALIAS_MIN_INDEPENDENCE, MIN_ENTITY_COUNT,
} from "../entities.js";

/** Observe each string as its own field, the way the builder does. */
function observe(...fields: string[]) {
  const obs = emptyObservations();
  for (const f of fields) observeField(f, obs);
  return obs;
}

const entity = (index: ReturnType<typeof buildIndex>, canonical: string) =>
  index.entities.find((e) => e.canonical === canonical);

describe("extraction", () => {
  it("captures a run of capitalised tokens", () => {
    const obs = observe("She met Erica Cathmore at the survey.");
    expect(obs.runs.get("Erica Cathmore")).toBe(1);
  });

  it("does not join a name to the next field", () => {
    // The regression: run over concatenated text and a name runs into the next
    // YAML key. "Priya Chandrasekaran Outcome" existed 90 times that way.
    const obs = observe("A note about Priya Chandrasekaran", "Outcome was good");
    expect(obs.runs.get("Priya Chandrasekaran")).toBe(1);
    expect(obs.runs.has("Priya Chandrasekaran Outcome")).toBe(false);
  });

  it("folds the possessive into the base form", () => {
    // Otherwise "Mari Zielinska's" is a separate entity from "Mari Zielinska" —
    // measured, that split 332 sightings off from 4975.
    const obs = observe("Mari Zielinska arrived.", "Mari Zielinska's report landed.");
    expect(obs.runs.get("Mari Zielinska")).toBe(2);
    expect([...obs.runs.keys()].some((k) => k.includes("'"))).toBe(false);
  });

  it("does not glue a run together across an ordinary capitalised word", () => {
    const obs = observe("Erica Cathmore. The Survey ended.");
    expect(obs.runs.has("Cathmore The Survey")).toBe(false);
  });

  it("ignores a lone capitalised word", () => {
    expect(observe("Erica arrived alone.").runs.size).toBe(0);
  });
});

describe("independence — the alias safety metric", () => {
  it("subtracts bound occurrences, which raw counting does not", () => {
    // "Grand" appears 3 times and every one is inside "Elysium Grand". Counting
    // raw appearances makes it look independently used; that error is what made
    // a hotel read as a first/last name pair.
    const obs = observe("Elysium Grand", "Elysium Grand", "Elysium Grand");
    const bound = boundTokenCounts(obs);
    expect(independence("Grand", obs, bound)).toBe(0);
  });

  it("scores a part that is genuinely used alone", () => {
    const obs = observe(
      "Erica Cathmore spoke.", "Erica Cathmore left.", "Erica Cathmore returned.",
      "Cathmore disagreed.", "Cathmore signed off.",
    );
    const bound = boundTokenCounts(obs);
    expect(independence("Cathmore", obs, bound)).toBeGreaterThan(ALIAS_MIN_INDEPENDENCE);
  });
});

describe("alias gating", () => {
  const corpus = [
    // A person: the surname is used on its own.
    "Erica Cathmore ran the survey.", "Erica Cathmore filed it.", "Erica Cathmore again.",
    "Cathmore disagreed with the finding.", "Cathmore signed off on it.", "Cathmore left.",
    // A compound noun: neither part is ever used alone.
    "Elden Ring came up.", "Elden Ring again.", "Elden Ring once more.",
  ];

  it("links a part people actually use alone", () => {
    const index = buildIndex(observe(...corpus));
    expect(entity(index, "Erica Cathmore")?.aliases).toContain("cathmore");
  });

  it("refuses to link parts of a compound noun — the catastrophic case", () => {
    // "Elden" ≡ "Ring" is the failure this whole gate exists to prevent.
    const index = buildIndex(observe(...corpus));
    expect(entity(index, "Elden Ring")?.aliases).toEqual([]);
  });

  it("drops an entity seen too few times to be more than coincidence", () => {
    const once = buildIndex(observe("Passing Mention happened."));
    expect(once.entities).toEqual([]);
    const enough = observe(...Array.from({ length: MIN_ENTITY_COUNT }, () => "Passing Mention happened."));
    expect(buildIndex(enough).entities.length).toBe(1);
  });
});

describe("person tagging", () => {
  it("tags on pronoun proximity even when no part is used alone", () => {
    // Mari Zielinska's shape: the surname is never spoken alone (independence
    // 0.06), so only the pronoun signal can catch her.
    const obs = observe(
      "Mari Zielinska nodded. She looked away.",
      "Mari Zielinska spoke. Her voice was flat.",
      "Mari Zielinska waited. She said nothing.",
    );
    expect(entity(buildIndex(obs), "Mari Zielinska")?.person).toBe(true);
  });

  it("tags on independent use even when pronouns never follow", () => {
    // Erica Cathmore's shape, and the reason the two signals are OR-ed: she is
    // discussed analytically, which is an artifact of the very bug being fixed.
    const obs = observe(
      "The Erica Cathmore material was reviewed.",
      "The Erica Cathmore corpus again.",
      "Erica Cathmore appears throughout.",
      "Cathmore is named in the summary.", "Cathmore is named again.", "Cathmore once more.",
    );
    const e = entity(buildIndex(obs), "Erica Cathmore");
    expect(e?.pronounHits).toBe(0);
    expect(e?.person).toBe(true);
  });
});

describe("cue expansion", () => {
  // Both parts are used alone here, as they are in the live store (measured:
  // Erica 0.82, Cathmore 0.31). A part that never appears alone earns no alias,
  // which is the point of the gate — so a fixture without solo mentions would
  // be testing the wrong thing.
  const index = buildIndex(observe(
    "Erica Cathmore ran the survey.", "Erica Cathmore filed it.", "Erica Cathmore again.",
    "Cathmore disagreed.", "Cathmore signed off.", "Cathmore left.",
    "Erica was there.", "Erica objected.", "Erica wrote it up.", "Erica again.",
  ));
  const cues = buildCueMap(index);

  it("reaches the first name from a surname cue, and back", () => {
    // The measured failure both ways: half the material about one person is
    // invisible to a surname-only cue, and the same in reverse.
    expect(expandCues("what did Cathmore decide", cues).toLowerCase()).toContain("erica");
    expect(expandCues("tell me about Erica", cues).toLowerCase()).toContain("cathmore");
  });

  it("preserves the original text — it widens, never replaces", () => {
    const out = expandCues("what did Cathmore decide", cues);
    expect(out).toContain("what did Cathmore decide");
  });

  it("adds each linked form once however often the cue repeats", () => {
    const out = expandCues("Cathmore Cathmore Cathmore", cues);
    expect(out.toLowerCase().split("erica").length - 1).toBe(1);
  });

  it("is a no-op with no index, no cues, or empty text", () => {
    expect(expandCues("Cathmore", new Map())).toBe("Cathmore");
    expect(expandCues("", cues)).toBe("");
    expect(buildCueMap(null).size).toBe(0);
  });

  it("does not expand a cue whose part was never linked", () => {
    const compound = buildCueMap(buildIndex(observe(
      "Elden Ring came up.", "Elden Ring again.", "Elden Ring once more.",
    )));
    expect(expandCues("tell me about the Ring", compound).toLowerCase()).not.toContain("elden");
  });
});
