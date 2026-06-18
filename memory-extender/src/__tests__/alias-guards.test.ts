// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Alias-learner guards (MarinaraExtender-50e): never learn a compound label
// ("Mari and TC") or the player's name ("Thomas") as a character alias — both
// had polluted the table and routed the player's memory into a character.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  addAlias,
  readAliasTable,
  findExactMatches,
  isCompoundLabel,
  USER_IDENTITY_KEY,
} from "../aliases.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-alias-"));
  process.env.MARINARA_EXTENDER_DATA = join(dir, "data");
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true });
});

describe("isCompoundLabel", () => {
  it("flags conjunctions and separators", () => {
    for (const l of ["Mari and TC", "Priya, Mari", "Mari & TC", "Mari/TC", "TC with Mari", "Mari + Priya"]) {
      expect(isCompoundLabel(l)).toBe(true);
    }
  });
  it("does not flag ordinary names that merely contain the letters", () => {
    for (const l of ["Anderson", "Sandra", "Mari", "Dr. Mari Zielińska", "Withers", "Roland"]) {
      expect(isCompoundLabel(l)).toBe(false);
    }
  });
});

describe("addAlias guards", () => {
  it("refuses a compound label", async () => {
    await addAlias("mari", "Dr. Mari Zielińska", "Mari and TC");
    const table = await readAliasTable();
    expect(findExactMatches(table, "Mari and TC")).toHaveLength(0);
  });

  it("refuses to attach a player/persona name to a character", async () => {
    // Persona registered first (as process-turn now does).
    await addAlias(USER_IDENTITY_KEY, "Thomas", "Thomas");
    // The learner then tries to alias "Thomas" to a character — must be refused.
    await addAlias("mari", "Dr. Mari Zielińska", "Thomas");

    const table = await readAliasTable();
    const matches = findExactMatches(table, "Thomas");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.identityKey).toBe(USER_IDENTITY_KEY); // never Mari
  });

  it("still learns a normal single-name alias", async () => {
    await addAlias("mari", "Dr. Mari Zielińska", "Mari");
    const table = await readAliasTable();
    const matches = findExactMatches(table, "Mari");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.identityKey).toBe("mari");
  });
});
