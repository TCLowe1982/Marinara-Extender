// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Subject attribution routing (MarinaraExtender-6qx — the porsche bug).
// In multi-character RP the whole AI message carries the session character's
// speaker label, so beats are routed by the analyzer's `subject` instead.
// These tests cover the name→identity resolution that routing depends on:
// known names resolve, the session character matches loosely (token
// containment), and unknown names refuse to resolve (→ holding pool).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveIdentity,
  resolveNameToKey,
  matchesSessionName,
  buildSubjectRoster,
} from "../identity.js";
import { addAlias } from "../aliases.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-subject-"));
  process.env.MARINARA_EXTENDER_DATA = join(dir, "data");
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true });
});

describe("resolveNameToKey", () => {
  it("resolves identity-map names, case-insensitively", async () => {
    const key = await resolveIdentity("card-priya-01", "Dr. Priya Chandrasekaran");
    expect(await resolveNameToKey("dr. priya chandrasekaran")).toBe(key);
  });

  it("resolves alias-table canonical names and aliases", async () => {
    const key = await resolveIdentity("card-priya-01", "Dr. Priya Chandrasekaran");
    await addAlias(key, "Dr. Priya Chandrasekaran", "Priya");
    expect(await resolveNameToKey("Priya")).toBe(key);
    expect(await resolveNameToKey("Dr. Priya Chandrasekaran")).toBe(key);
  });

  it("returns null for unknown names — never guesses", async () => {
    await resolveIdentity("card-priya-01", "Dr. Priya Chandrasekaran");
    expect(await resolveNameToKey("James")).toBeNull();
    expect(await resolveNameToKey("")).toBeNull();
  });

  it("returns null when two identities claim the same label (ambiguous)", async () => {
    const k1 = await resolveIdentity("card-a", "Lara");
    const k2 = await resolveIdentity("card-b", "Lara Morrigan");
    await addAlias(k1, "Lara", "Lara");
    await addAlias(k2, "Lara Morrigan", "Lara");
    expect(await resolveNameToKey("Lara")).toBeNull();
  });
});

describe("matchesSessionName", () => {
  it("matches exactly and via significant-token containment", () => {
    expect(matchesSessionName("Dr. Mari Zielińska", "Dr. Mari Zielińska")).toBe(true);
    expect(matchesSessionName("Mari", "Dr. Mari Zielińska")).toBe(true); // "Mari" ⊂ full name
    expect(matchesSessionName("Zielińska", "Dr. Mari Zielińska")).toBe(true);
  });

  it("rejects co-star and unknown names", () => {
    expect(matchesSessionName("Priya", "Dr. Mari Zielińska")).toBe(false);
    expect(matchesSessionName("Dr. Priya Chandrasekaran", "Dr. Mari Zielińska")).toBe(false);
    expect(matchesSessionName("Mari", undefined)).toBe(false);
  });
});

describe("buildSubjectRoster", () => {
  it("includes the session name, alias canonical names, and map names; skips ID-like names", async () => {
    const priyaKey = await resolveIdentity("card-priya-01", "Dr. Priya Chandrasekaran");
    await addAlias(priyaKey, "Dr. Priya Chandrasekaran", "Priya");
    // A card imported before its name was known: map name === characterId.
    await resolveIdentity("8V1kReXzyJkyRAwIk7yc3");

    const roster = await buildSubjectRoster("Dr. Mari Zielińska");
    expect(roster).toContain("Dr. Mari Zielińska");
    expect(roster).toContain("Dr. Priya Chandrasekaran");
    expect(roster).not.toContain("8V1kReXzyJkyRAwIk7yc3"); // raw card ID — never shown to the model
  });
});
