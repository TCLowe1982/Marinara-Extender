// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// THE OPS/META LANE (hjt9) — routing, and the two regressions that nearly shipped.
//
// The detectors were built and measured a day before the destination existed. Wiring
// them turned up two false positives in code-filter's rules that were invisible at
// chunk level and lethal at line level, because per-line routing applies to EVERY
// chunk rather than only the ops-shaped 1%.

import { describe, it, expect } from "vitest";
import { routeOps } from "../sentiment/ops-lane.js";
import { nonProseRule } from "../sentiment/code-filter.js";
import { classifyChunk } from "../sentiment/classifier.js";
import type { Chunk } from "../sentiment/types.js";

const chunk = (text: string): Chunk => ({ speaker: "user", text, turnStart: 0, turnEnd: 0 });

describe("code-filter rule regressions", () => {
  // `>` IS MARKDOWN BLOCKQUOTE FAR MORE OFTEN THAN IT IS A SHELL PROMPT.
  // Measured in the store: this rule was dropping character-card prose people had
  // quoted into a message. A blockquote is how someone quotes someone; a shell
  // prompt is followed by a command.
  it("does not treat a markdown blockquote as a shell command", () => {
    expect(nonProseRule("> Do not proactively suggest breaks, rest, sleep, food, or hydration")).toBeNull();
    expect(nonProseRule("> **Domain physics.** Within her domain the rules are different.")).toBeNull();
  });

  it("still catches an actual shell prompt", () => {
    expect(nonProseRule("$ npm test")).toBe("shell-command");
    expect(nonProseRule("> node scripts/bait-rot.mjs")).toBe("shell-command");
    expect(nonProseRule("npx vitest run")).toBe("shell-command");
  });

  // A BARE QUOTED LINE IS USUALLY DIALOGUE — the most memory-worthy shape there is.
  // This rule fired 371 times across the store and its biggest hit was a line of
  // speech.
  it("does not treat a line of dialogue as a bare literal", () => {
    expect(nonProseRule('"Zielińska. Party of three. Five-thirty."')).toBeNull();
    expect(nonProseRule('"I am not going to explain myself again."')).toBeNull();
    expect(nonProseRule('"Stay. Please."')).toBeNull();
  });

  it("still catches an actual string literal", () => {
    expect(nonProseRule('"POST",')).toBe("bare-literal");
    expect(nonProseRule("'utf8'")).toBe("bare-literal");
  });
});

describe("routeOps", () => {
  it("keeps the prose that surrounds a paste", () => {
    // hjt9's own example: real conversation wrapped around a fenced block. A
    // chunk-level route would misfile all of it.
    const text = [
      "god yeah dotenv loading is sonnet's KRYPTONITE, watch this:",
      "```",
      "$ node -e \"require('dotenv').config()\"",
      "[ME:loader] env parsed: 14 keys",
      "```",
      "and that's the third time this week it silently picked the wrong file.",
    ].join("\n");
    const r = routeOps(text);
    expect(r.wholesale).toBe(false);
    expect(r.prose).toContain("KRYPTONITE");
    expect(r.prose).toContain("third time this week");
    expect(r.prose).not.toContain("[ME:loader]");
    expect(r.dropped.length).toBeGreaterThan(0);
  });

  it("reports wholesale when nothing survives as prose", () => {
    const r = routeOps([
      "[ME:pipeline] speakers found: Mari, Priya",
      "[ME:storage] corrupt YAML at data/chats/x.yaml",
      "status: open",
    ].join("\n"));
    expect(r.wholesale).toBe(true);
    expect(r.prose).toBe("");
  });

  it("leaves ordinary prose completely alone", () => {
    const text = "she set the cup down harder than she meant to and said she was not going to explain herself again.";
    const r = routeOps(text);
    expect(r.dropped).toHaveLength(0);
    expect(r.prose).toBe(text);
  });
});

// WHY THE PIPELINE ROUTES BEFORE CHUNKING, pinned as a test rather than a comment.
//
// The chunker joins turns with a SPACE (chunker.ts `groupTexts.join(" ")`), and
// parseTurns has already split the message on /\n+/. So every chunk it emits is one
// line — and every code-filter rule is line-anchored, while partitionProse splits on
// newlines. Routing at chunk level therefore has nothing to work with on the live
// path, which is why ops routing runs at Stage -1 in runSentimentPipeline.
//
// Measured: mean paste score 0.061 whole-message vs 0.003 at best chunk, a 20x
// collapse on the same texts. If someone later teaches the chunker to preserve
// newlines, this test fails and the ordering assumption gets re-examined instead of
// silently becoming wrong.
describe("chunking destroys the line structure the rules need", () => {
  it("emits single-line chunks from multi-line input", async () => {
    const { chunkMessages } = await import("../sentiment/chunker.js");
    const multiline = [
      "here's what it printed:",
      "[ME:loader] env parsed: 14 keys",
      "[ME:dedup] 14 duplicates merged",
      "and that's the third time this week.",
    ].join("\n");

    const chunks = await chunkMessages([{ role: "user", content: multiline }], "Mari");
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.text, "chunker should have joined turns with a space").not.toContain("\n");
    }
  });

  it("routeOps on the raw message still finds the structure", () => {
    const multiline = [
      "here's what it printed:",
      "[ME:loader] env parsed: 14 keys",
      "and that's the third time this week.",
    ].join("\n");
    const r = routeOps(multiline);
    expect(r.dropped).toHaveLength(1);
    expect(r.prose).toContain("third time this week");
  });
});

describe("classifier routing", () => {
  it("suppresses a wholly structural chunk and names the lane", () => {
    const r = classifyChunk(chunk([
      "[ME:pipeline] speakers found: Mari",
      "[ME:dedup] 14 duplicates merged",
      "[ME:loader] char selected: thread-b480a415",
    ].join("\n")));
    expect(r.passesThreshold).toBe(false);
    expect(r.suppressedReason).toBe("ops-lane");
    expect(r.opsLines?.length).toBeGreaterThan(0);
  });

  // THE POINT OF THE WHOLE TICKET. The chunk carried downstream is the REDUCED one,
  // so the analyzer's prompt, the stored beat's text, and the echo guard's
  // corroboration evidence all see what a person said rather than what they pasted.
  // hjt9: "rejectAsEcho's escape hatch must not accept a paste of the phrase as the
  // speaker having said it."
  it("carries the reduced chunk downstream, not the original", () => {
    const r = classifyChunk(chunk([
      "i was terrified he would leave and i said so out loud for once",
      "[ME:loader] env parsed: 14 keys",
    ].join("\n")));
    expect(r.suppressedReason).toBeUndefined();
    expect(r.chunk.text).toContain("terrified");
    expect(r.chunk.text).not.toContain("[ME:loader]");
    expect(r.opsLines).toHaveLength(1);
  });

  it("does not set opsLines when nothing was routed", () => {
    const r = classifyChunk(chunk("i told him i was terrified he would leave, and he waited."));
    expect(r.opsLines).toBeUndefined();
  });
});
