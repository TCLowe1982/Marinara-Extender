// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// The prompt teaches exactly what the parser accepts (MarinaraExtender-t6ox).
//
// These two drifted apart and nobody noticed for months: the parser accepted
// global, the prompt taught only character and chat. That is a bug in BOTH
// directions and neither is visible from either side alone.
//
//   Taught but not accepted -> the model emits a value that is silently
//   rewritten to the default. It believes it saved something it did not.
//
//   Accepted but not taught -> a whole capability is unreachable except by a
//   model that guesses the word. That was the live case, and the scope it
//   applied to is the broadest one in the system: global is injected into EVERY
//   character's context.
//
// So the vocabulary is asserted as a set equality, not as "contains global".
// Adding a scope to the type without teaching it fails here, and so does
// documenting one the parser will throw away.

import { describe, it, expect } from "vitest";
import { memorySystemInstructions } from "../loader.js";
import { extractRememberTags } from "../writer.js";

const PROMPT = memorySystemInstructions();

/** The scope line, as taught. Parsed from the prompt rather than hardcoded — a
 *  copy here would drift exactly the way the two sides already did. */
function taughtScopes(): Set<string> {
  const section = PROMPT.split(/^\s*scope\s+—/m)[1];
  expect(section, "the prompt no longer has a 'scope —' block").toBeDefined();
  // Stop at the next all-caps heading; scope names are the leading bare word of
  // each line in between.
  const block = section!.split(/\n[A-Z][A-Z ]{4,}:/)[0]!;
  const found = new Set<string>();
  for (const line of block.split("\n")) {
    // A declaration is `name` or `name (note)` followed by an em dash. Wrapped
    // continuation lines of a description also start with a bare lowercase word
    // ("stay true no matter...") and would otherwise read as scope names.
    const m = line.match(/^\s*([a-z_]+)(?:\s*\([^)]*\))?\s*—/);
    if (m) found.add(m[1]!);
  }
  return found;
}

/** What extractRememberTags will actually honour, probed through the real parser. */
function acceptedScopes(candidates: string[]): Set<string> {
  const accepted = new Set<string>();
  for (const s of candidates) {
    const [tag] = extractRememberTags(`[remember: scope="${s}", content="A durable fact to save."]`);
    if (tag?.scope === s) accepted.add(s);
  }
  return accepted;
}

describe("prompt vocabulary matches the parser", () => {
  it("teaches every scope the parser honours, and no others", () => {
    const taught = taughtScopes();
    // Probe the union of what is taught and every scope the type allows, so a
    // value that is accepted but undocumented is caught rather than skipped.
    const universe = [...new Set([...taught, "chat", "character", "global"])];
    expect(acceptedScopes(universe)).toEqual(taught);
  });

  it("teaches global specifically — it was accepted but undocumented", () => {
    // The regression. Kept as its own case so the failure names the cause.
    expect(taughtScopes()).toContain("global");
  });

  it("does not describe character as persisting everywhere", () => {
    // The old wording claimed character "persists everywhere", which is the
    // phrase a model reaches for when it means global — so the one scope that
    // really is everywhere was both undocumented AND pre-empted.
    expect(PROMPT).not.toMatch(/character \(default, persists everywhere\)/);
  });

  it("marks global as the exceptional case", () => {
    // It rides a 1000-token budget shared across every character, so the prompt
    // has to discourage routine use rather than merely permit it.
    const scopeBlock = PROMPT.split(/^\s*scope\s+—/m)[1]!.split(/\n[A-Z][A-Z ]{4,}:/)[0]!;
    expect(scopeBlock).toMatch(/rare/i);
  });

  it("teaches every lane the parser honours", () => {
    const laneLine = PROMPT.match(/^\s*lane\s+—\s*(.+)$/m)?.[1] ?? "";
    for (const lane of ["user_topics", "open_threads", "character_topics"]) {
      expect(laneLine).toContain(lane);
    }
  });

  it("every worked example in the prompt actually parses", () => {
    // A malformed example teaches malformed output. Each [remember: ...] shown
    // is run through the real extractor and must survive with the scope and lane
    // it advertises.
    // Only real examples: the prose also contains the bare placeholder
    // "[remember: ...]", which is not meant to parse.
    const examples = (PROMPT.match(/\[remember:[^\]]*\]/g) ?? []).filter((e) => e.includes('content="'));
    expect(examples.length).toBeGreaterThan(3);
    for (const example of examples) {
      const [tag] = extractRememberTags(example);
      expect(tag, `example did not parse: ${example}`).toBeDefined();
      const declared = example.match(/scope="([^"]+)"/)?.[1];
      if (declared) expect(tag!.scope, `example lost its scope: ${example}`).toBe(declared);
      const lane = example.match(/lane="([^"]+)"/)?.[1];
      if (lane) expect(tag!.lane, `example lost its lane: ${example}`).toBe(lane);
    }
  });
});
