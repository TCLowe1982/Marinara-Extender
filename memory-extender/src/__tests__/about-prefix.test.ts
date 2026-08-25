// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// THE PROSE PREFIX CANNOT BE WRITTEN ANY MORE (oc4w).
//
// qlib gave aboutness a field. It did not remove the way to write it as prose,
// and the live turn — the ONE path that runs on every message — kept doing so
// for another day and 1,552 entries, because api.ts held an inline COPY of
// resolveFactTarget and only the copy in facts.ts was updated. resolveFactTarget's
// own header said it "mirrors the live tier-3 routing in api.ts"; a mirror is a
// promise that two people will remember, and that is not a safety property.
//
// The duplicate is gone. These pin the boundary that makes it not come back:
// a prefix arriving at the mint point is ABSORBED into the field, not refused
// and not stored, and the event is counted.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  absorbAboutPrefix, aboutPrefixAbsorptions, resetAboutPrefixAbsorptions,
} from "../subject.js";
import { createEntry } from "../dedup.js";
import { readIndex } from "../storage.js";

describe("absorbAboutPrefix", () => {
  beforeEach(() => resetAboutPrefixAbsorptions());

  it("moves a real name out of the prose and into the field", () => {
    const r = absorbAboutPrefix("[about: Cole] Cole mains a warlock");
    expect(r.summary).toBe("Cole mains a warlock");
    expect(r.subjects).toEqual([{ name: "Cole" }]);
    expect(aboutPrefixAbsorptions()).toBe(1);
  });

  it("strips a NESTED bracket token without welding a stray ] onto the prose", () => {
    // "[about: [character]]" is 373 live entries. A naive [^\]]* leaves "] …".
    const r = absorbAboutPrefix("[about: [character]] [character] asks for a phrase");
    expect(r.summary).toBe("[character] asks for a phrase");
    expect(r.subjects).toBeUndefined(); // the placeholder is refused, not recorded
  });

  it("refuses a pronoun subject but keeps the memory", () => {
    // "[about: She]" and "[about: I]" are both live, minted 2026-08-25.
    const r = absorbAboutPrefix("[about: She] The speaker requests eye contact");
    expect(r.summary).toBe("The speaker requests eye contact");
    expect(r.subjects).toBeUndefined();
    expect(aboutPrefixAbsorptions()).toBe(1); // counted even though refused
  });

  it("an EXPLICIT subjects[] wins — the field is the assertion, the prefix a symptom", () => {
    const r = absorbAboutPrefix("[about: Cole] Cole mains a warlock", [
      { name: "Cole", key: "cole", kind: "character" },
    ]);
    expect(r.subjects).toEqual([{ name: "Cole", key: "cole", kind: "character" }]);
  });

  it("leaves an ordinary summary completely alone, and counts nothing", () => {
    const r = absorbAboutPrefix("Thomas is from Independence, MO");
    expect(r.summary).toBe("Thomas is from Independence, MO");
    expect(r.subjects).toBeUndefined();
    expect(aboutPrefixAbsorptions()).toBe(0);
  });

  it("does not fire on a bracket that is not the about tag", () => {
    // Tier-2 companions are "[emotion] motivation" and must survive untouched.
    const r = absorbAboutPrefix("[grief] She is still mourning her father");
    expect(r.summary).toBe("[grief] She is still mourning her father");
    expect(aboutPrefixAbsorptions()).toBe(0);
  });
});

describe("the mint point is the boundary", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "me-about-"));
    process.env.MARINARA_EXTENDER_DATA = join(dir, "data");
    resetAboutPrefixAbsorptions();
  });
  afterEach(async () => {
    delete process.env.MARINARA_EXTENDER_DATA;
    await rm(dir, { recursive: true, force: true });
  });

  it("a caller that still writes the prefix cannot get it into the store", async () => {
    // This is the re-inlined-router case, simulated. The entry is kept; the
    // claim lands in the field; the summary is clean prose.
    const e = await createEntry("chat", "chat-1", {
      lane: "character_topics",
      summary: "[about: Cole] Cole mains a blood elf affliction warlock",
      content: "Cole mains a warlock",
    });
    expect(e.summary).toBe("Cole mains a blood elf affliction warlock");
    expect(e.subjects).toEqual([{ name: "Cole" }]);

    // The INDEX row is what the loader scans — a prefix surviving there would
    // be invisible to the entry-file check and visible in every prompt.
    const idx = await readIndex("chat", "chat-1");
    const row = idx?.entries.find((r) => r.id === e.id);
    expect(row?.summary).toBe("Cole mains a blood elf affliction warlock");
    expect(row?.subjects).toEqual([{ name: "Cole" }]);

    expect(aboutPrefixAbsorptions()).toBe(1);
  });
});
