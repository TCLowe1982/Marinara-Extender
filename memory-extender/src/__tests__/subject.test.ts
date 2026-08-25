// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// SUBJECT as a real field (4g9w slice 1, ticket qlib).
//
// Scope says who can RECALL a memory; it has never said who it is ABOUT. The
// answer was being encoded into the summary PROSE as "[about: X] …" — 3,380
// entries carry one, and 2,768 of those name the prompt's own placeholder
// rather than a person (q5pk). These tests pin both halves: the field exists
// and round-trips, and a non-name can no longer reach it.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  rejectSubjectName, isValidSubjectName, makeSubject, normalizeSubjects,
  subjectKindFor, subjectRejectionCounts, resetSubjectRejectionCounts,
} from "../subject.js";
import { createEntry } from "../dedup.js";
import { readIndex, readEntry } from "../storage.js";
import { resolveFactTarget } from "../facts.js";

describe("subject validity — the q5pk population, as fixtures", () => {
  beforeEach(() => resetSubjectRejectionCounts());

  // Counts are the live store's, 2026-08-25. These are not invented examples.
  it.each([
    ["character",         "placeholder"], // 2,395 live entries
    ["[character]",       "bracketed"],   //   373 live entries
    ["the character",     "placeholder"], //    19 live entries
    ["unknown",           "placeholder"], //    56 live entries
    ["unknown character", "placeholder"], //    14 live entries
    ["someone",           "placeholder"], //    12 live entries
    ["she",               "pronoun"],     //    62 live entries
    ["him",               "pronoun"],     //    40 live entries
    ["I",                 "pronoun"],     //    19 live entries
    ["he",                "pronoun"],     //    13 live entries
    ["we",                "pronoun"],     //     6 live entries
    ["himself",           "pronoun"],     //     6 live entries
  ])("refuses %j as %s", (name, reason) => {
    expect(rejectSubjectName(name)).toBe(reason);
    expect(makeSubject(name)).toBeNull();
  });

  // The names in the same population that ARE real referents and must survive.
  it.each([
    "Thomas", "holyknight3", "Ashley", "opie", "The Doctor", "TC",
    "River Song", "Rebecca Collier", "Jack Harkness", "real-thomas",
  ])("accepts %j", (name) => {
    expect(rejectSubjectName(name)).toBeNull();
    expect(makeSubject(name)).toEqual({ name });
  });

  it("normalizes case and stray punctuation before judging — one verdict per value", () => {
    // The sentence-case trap's lesson applied at the boundary: "Character",
    // "character." and " CHARACTER " are all the same bad value.
    for (const v of ["Character", "character.", "  CHARACTER  ", "character,"]) {
      expect(rejectSubjectName(v)).toBe("placeholder");
    }
  });

  it("rejects card-template tokens, which would produce q5pk from a new direction", () => {
    for (const v of ["{{char}}", "{{user}}", "<char>", "<user>"]) {
      expect(isValidSubjectName(v)).toBe(false);
    }
  });

  it("does NOT reject a real name that merely contains brackets", () => {
    // "Dr. Mari Zielińska (Traveling)" is an actual card in this store. Only a
    // value that is ENTIRELY a bracketed token is a template artifact.
    expect(isValidSubjectName("Dr. Mari Zielińska (Traveling)")).toBe(true);
    expect(isValidSubjectName("Dr. Mari Zielińska")).toBe(true);
  });

  it("treats 'user' as VALID — it is the extractor's sentinel for the human, not a placeholder", () => {
    expect(rejectSubjectName("user")).toBeNull();
    expect(subjectKindFor("user")).toBe("user");
    expect(subjectKindFor("Mari")).toBeUndefined();
  });

  it("refuses a summary that leaked into the subject slot", () => {
    expect(rejectSubjectName("a".repeat(81))).toBe("too-long");
  });

  it("COUNTS refusals by reason — a guard nobody can audit is a guard that drifts", () => {
    makeSubject("character");
    makeSubject("[character]");
    makeSubject("she");
    makeSubject("he");
    expect(subjectRejectionCounts()).toEqual({ placeholder: 1, bracketed: 1, pronoun: 2 });
  });
});

describe("normalizeSubjects", () => {
  it("returns undefined rather than [] — absent means UNASSESSED, never 'about nobody'", () => {
    expect(normalizeSubjects(undefined)).toBeUndefined();
    expect(normalizeSubjects([])).toBeUndefined();
    expect(normalizeSubjects([{ name: "character" }])).toBeUndefined();
  });

  it("drops invalid members but keeps the valid ones", () => {
    expect(normalizeSubjects([{ name: "Mari" }, { name: "she" }, { name: "Priya" }]))
      .toEqual([{ name: "Mari" }, { name: "Priya" }]);
  });

  it("de-duplicates by name, case-insensitively", () => {
    expect(normalizeSubjects([{ name: "Mari" }, { name: "mari" }])).toEqual([{ name: "Mari" }]);
  });

  it("keeps several subjects — 'Mari and Priya argued' is about both", () => {
    expect(normalizeSubjects([{ name: "Mari" }, { name: "Priya" }])).toHaveLength(2);
  });
});

describe("persistence round-trip", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "me-subject-"));
    process.env.MARINARA_EXTENDER_DATA = join(dir, "data");
  });
  afterEach(async () => {
    delete process.env.MARINARA_EXTENDER_DATA;
    await rm(dir, { recursive: true, force: true });
  });

  it("survives to BOTH the entry file and the index row", async () => {
    // The index is what the loader scans; a field that reaches only the entry
    // file is invisible to every retrieval path that matters.
    const e = await createEntry("character", "mari", {
      lane: "character_topics",
      summary: "Thomas is from Independence, MO",
      content: "you're from independence, missouri",
      subjects: [{ name: "Thomas", kind: "persona" }],
    });
    expect(e.subjects).toEqual([{ name: "Thomas", kind: "persona" }]);

    const idx = await readIndex("character", "mari");
    const row = idx?.entries.find((r) => r.id === e.id);
    expect(row?.subjects).toEqual([{ name: "Thomas", kind: "persona" }]);

    // readEntry takes the index row's relative PATH, not the id.
    const onDisk = await readEntry("character", "mari", row!.path);
    expect(onDisk?.subjects).toEqual([{ name: "Thomas", kind: "persona" }]);
  });

  it("a refused subject does not discard the fact — route and mark, never drop", async () => {
    const e = await createEntry("character", "mari", {
      lane: "character_topics",
      summary: "A character expresses an idea",
      content: "…",
      subjects: [{ name: "character" }],
    });
    expect(e.id).toBeTruthy();
    expect(e.summary).toBe("A character expresses an idea");
    expect(e.subjects).toBeUndefined(); // the claim is refused; the memory is kept
  });

  it("an entry written without subjects is unchanged — the field is additive", async () => {
    const e = await createEntry("character", "mari", {
      lane: "user_topics", summary: "User has DMed since 2e", content: "…",
    });
    expect(e.subjects).toBeUndefined();
    expect("subjects" in e).toBe(false); // absent, not present-and-empty
  });
});

describe("no [about:] prefix is ever written into a summary again", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "me-subject2-"));
    process.env.MARINARA_EXTENDER_DATA = join(dir, "data");
  });
  afterEach(async () => {
    delete process.env.MARINARA_EXTENDER_DATA;
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = { identityKey: "mari", fallbackChatId: "chat-1", characterName: "Mari" };

  it("an unresolved subject lands in the field, and the summary stays clean prose", async () => {
    const t = await resolveFactTarget(
      {
        text: "Cole mains a warlock", fact: "Cole mains a blood elf affliction warlock",
        lane: "character_topics", scope: "character", subject: "Cole",
      },
      ctx,
    );
    expect(t?.summary).not.toMatch(/\[about:/);
    expect(t?.subjects).toEqual([{ name: "Cole" }]);
  });

  it("a placeholder subject yields NO subjects field and still no prefix — q5pk cannot recur", async () => {
    const t = await resolveFactTarget(
      {
        text: "…", fact: "A character expresses an idea",
        lane: "character_topics", scope: "character", subject: "character",
      },
      ctx,
    );
    expect(t?.summary).toBe("A character expresses an idea");
    expect(t?.summary).not.toMatch(/\[about:/);
    expect(t?.subjects).toBeUndefined();
  });
});
