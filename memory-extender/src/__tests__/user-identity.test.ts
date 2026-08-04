// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// The user's declared identity (MarinaraExtender-egj3).
//
// The property under test is that a DECLARATION BEATS AN INFERENCE. Everything
// else in the entity index is guessed from the corpus and bounded accordingly;
// this is asserted by the person who knows, so it is exempt from the bound —
// while still refusing to link through a name the user has disclaimed.
//
// Modelled on the real case: Thomas Lowe / Thomas Charles Lowe / TC Lowe are one
// person, "Thomas Collier" is an RP character, and "thomas" alone belongs to the
// character. Measured, the corpus cannot separate them — Collier and Lowe never
// once co-occur — so nothing here can be learned, only told.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  readUserIdentity, writeUserIdentity, userCueLinks, userTokens, excludedForms,
} from "../user-identity.js";
import { emptyObservations, observeField, buildIndex, buildCueMap, expandCues } from "../entities.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-uid-"));
  process.env.MARINARA_EXTENDER_DATA = dir;
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true });
});

const DECLARED = {
  canonical: "TC Lowe",
  aliases: ["Thomas Lowe", "Thomas Charles Lowe", "TC"],
  excludes: ["Thomas Collier"],
};

describe("storage", () => {
  it("returns null when nothing has been declared", async () => {
    expect(await readUserIdentity()).toBeNull();
  });

  it("round-trips, normalising case and whitespace", async () => {
    await writeUserIdentity({ canonical: "TC Lowe", aliases: ["  Thomas   LOWE ", "tc"] });
    const identity = await readUserIdentity();
    expect(identity?.canonical).toBe("TC Lowe");
    expect(identity?.aliases).toContain("thomas lowe");
    expect(identity?.aliases).toContain("tc");
  });

  it("always includes the canonical form among the aliases", async () => {
    // Requiring the caller to repeat it is a footgun.
    const identity = await writeUserIdentity({ canonical: "TC Lowe", aliases: [] });
    expect(identity.aliases).toContain("tc lowe");
  });

  it("refuses an empty canonical name", async () => {
    await expect(writeUserIdentity({ canonical: "   " })).rejects.toThrow();
  });

  it("never lets a form be both an alias and an exclusion", async () => {
    const identity = await writeUserIdentity({
      canonical: "TC Lowe", aliases: ["Thomas Lowe"], excludes: ["Thomas Lowe", "Thomas Collier"],
    });
    expect(identity.aliases).toContain("thomas lowe");
    expect(identity.excludes).not.toContain("thomas lowe");
    expect(identity.excludes).toContain("thomas collier");
  });

  it("exposes the tokens and exclusions the entity layer needs", async () => {
    const identity = await writeUserIdentity(DECLARED);
    expect(userTokens(identity)).toContain("lowe");
    expect(excludedForms(identity)).toContain("thomas collier");
    expect(userTokens(null).size).toBe(0);
  });
});

describe("cue links", () => {
  it("reaches every declared form from any other", async () => {
    const links = userCueLinks(await writeUserIdentity(DECLARED));
    expect(links.get("tc")).toContain("thomas lowe");
    expect(links.get("lowe")).toContain("tc");
  });

  it("does NOT link the token shared with a disclaimed entity", async () => {
    // "thomas" belongs to the user AND the character. Linking it would hand the
    // character's memories to the user — the exact failure the declaration exists
    // to prevent, and the reason excludes is not decorative.
    const links = userCueLinks(await writeUserIdentity(DECLARED));
    expect(links.has("thomas")).toBe(false);
    // The unambiguous multi-word forms containing it are dropped for the same
    // reason: they cannot be told apart from the character by token alone.
    expect(links.get("lowe")).not.toContain("thomas collier");
  });

  it("contributes nothing when undeclared", () => {
    expect(userCueLinks(null).size).toBe(0);
  });
});

describe("declaration versus inference", () => {
  // A corpus where "thomas" collides many ways — the shape that made the
  // ambiguity bound suppress the user's own name.
  const crowded = () => {
    const obs = emptyObservations();
    for (let i = 0; i < 6; i++) {
      for (let n = 0; n < 3; n++) observeField(`Thomas Person${i} spoke. Thomas alone. Thomas again.`, obs);
    }
    return buildIndex(obs);
  };

  it("still suppresses an over-ambiguous INFERRED alias", async () => {
    expect(expandCues("what about Thomas", buildCueMap(crowded(), null)))
      .toBe("what about Thomas");
  });

  it("but a DECLARED form expands regardless of how ambiguous the corpus is", async () => {
    // The bound exists to stop a guess spreading. A declaration is not a guess,
    // and suppressing it is what left the user unreachable by their own name.
    const identity = await writeUserIdentity(DECLARED);
    const out = expandCues("what did TC say", buildCueMap(crowded(), identity));
    expect(out.toLowerCase()).toContain("lowe");
  });

  it("does not expand a disclaimed entity's own aliases", async () => {
    // "Thomas Collier" is indexed like anything else, but the user has said it
    // is not them, so it contributes no links at all.
    const obs = emptyObservations();
    for (let n = 0; n < 4; n++) {
      observeField("Thomas Collier spoke. Collier alone. Collier again. Collier once more.", obs);
    }
    const identity = await writeUserIdentity(DECLARED);
    const cues = buildCueMap(buildIndex(obs), identity);
    expect(expandCues("what did Collier say", cues).toLowerCase()).not.toContain("thomas collier");
  });

  it("leaves unrelated inferred entities alone", async () => {
    const obs = emptyObservations();
    for (let n = 0; n < 4; n++) {
      observeField("Erica Cathmore ran it. Cathmore alone. Erica alone. Cathmore again.", obs);
    }
    const identity = await writeUserIdentity(DECLARED);
    const cues = buildCueMap(buildIndex(obs), identity);
    expect(expandCues("what did Cathmore decide", cues).toLowerCase()).toContain("erica");
  });
});
