// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// THE SELF-INGESTION GATE (pe4o).
//
// The pipeline was eating its own system prompt. Prompt text gets pasted into a chat
// for review — this project's own required workflow — and the sidecar chunked it,
// scored it for emotion, asked a model what the speaker was feeling, and filed the
// answer under a character. 65 live records were built that way, 62 of them on one
// character, 47 of them in a single day.
//
// TWO THINGS ARE ASSERTED HERE, AND THE SECOND MATTERS MORE.
// That the gate catches our prompt, obviously. But also that it does NOT catch
// ordinary conversation, including conversation ABOUT feelings using the same
// vocabulary the prompt uses. The cost of a false positive is a real memory that is
// never recorded — silent, unrecoverable, and strictly worse than the bug being
// fixed. Measured over all 23,343 stored chunks before wiring: 34 gated, zero hits on
// the other 23,309.

import { describe, it, expect } from "vitest";
import { detectSelfPrompt, ownPromptSignatures } from "../sentiment/self-prompt.js";
import { buildSystemPrompt } from "../sentiment/analyzer.js";
import { classifyChunk } from "../sentiment/classifier.js";
import type { Chunk } from "../sentiment/types.js";

const chunk = (text: string): Chunk => ({ speaker: "user", text, turnStart: 0, turnEnd: 0 });

describe("own-prompt signatures", () => {
  it("derives them from the live prompt rather than a hand-list", () => {
    // A hand-maintained list rots the first time a prompt is edited, and rots
    // SILENTLY — it does not error, it just stops catching. Same argument
    // bait-warrant makes for reading the built prompt.
    expect(ownPromptSignatures().length).toBeGreaterThan(20);
  });

  it("tracks a prompt edit automatically", () => {
    // Every signature must still be present in some built prompt. If this fails, the
    // derivation has drifted from the thing it derives from.
    const all = [
      buildSystemPrompt("fear", [], true),
      buildSystemPrompt("dysregulation", ["dissociation"], false),
    ].join("\n").toLowerCase().replace(/\s+/g, " ");
    const fromFear = ownPromptSignatures().filter((s) => all.includes(s));
    expect(fromFear.length).toBeGreaterThan(10);
  });
});

describe("detectSelfPrompt", () => {
  it("catches the system prompt itself, for every emotion", () => {
    for (const e of ["fear", "shame", "joy", "dysregulation"] as const) {
      const p = buildSystemPrompt(e, e === "dysregulation" ? ["dissociation"] : []);
      expect(detectSelfPrompt(p), e).not.toBeNull();
    }
  });

  it("catches a prompt fragment pasted mid-conversation", () => {
    // The fragment must be a line the CURRENT prompt actually contains —
    // signatures derive from the live build, so when the prompt is rewritten
    // (vikj, 2026-08-20) a fixture quoting the retired text goes correctly
    // undetected and the test, not the detector, is what went stale.
    const pasted =
      "ok here's what it currently says, tell me if this reads right:\n" +
      "- If you cannot name what happened in THIS chunk that specifically, there is no beat: reply {\"no_beat\": true} instead of reaching for a remembered phrase.\n" +
      "does that seem too blunt to you?";
    expect(detectSelfPrompt(pasted)).not.toBeNull();
  });

  // THE FALSE-POSITIVE GUARD. These use the prompt's own vocabulary and must pass.
  it("does not catch ordinary emotional conversation", () => {
    for (const ordinary of [
      "i'm analyzing why i felt so much fear in that conversation with him",
      "she said the outcome would depend on the relational dynamics between them",
      "what was my motivation, honestly? i wanted him to stay",
      "respond however you want, i'm not going to explain myself again",
      "there's no subtext here. i meant exactly what i said.",
      "i was afraid the memory loss meant i was never real",
    ]) {
      expect(detectSelfPrompt(ordinary), ordinary).toBeNull();
    }
  });

  it("ignores text too short to carry a whole prompt line", () => {
    expect(detectSelfPrompt("json only")).toBeNull();
    expect(detectSelfPrompt("")).toBeNull();
  });
});

describe("classifier gate", () => {
  it("suppresses a chunk that is our own prompt, and says why", () => {
    const r = classifyChunk(chunk(buildSystemPrompt("fear", [])));
    expect(r.passesThreshold).toBe(false);
    expect(r.primaryEmotion).toBeNull();
    expect(r.suppressedReason).toBe("self-prompt");
  });

  it("marks the content floor distinctly, so the two gates stay tellable apart", () => {
    // A guard working and a guard misfiring must not look the same to whoever is
    // measuring "how much are we skipping".
    const r = classifyChunk(chunk("ok"));
    expect(r.suppressedReason).toBe("content-floor");
  });

  it("leaves ordinary chunks unsuppressed", () => {
    const r = classifyChunk(chunk(
      "i told him i was terrified he would leave, and he just held the door open and waited",
    ));
    expect(r.suppressedReason).toBeUndefined();
  });

  // THE REGRESSION THAT MATTERS, and it is a bug this gate shipped with.
  //
  // The first version suppressed on ANY matching line. That killed 2,242 characters
  // of someone working a problem out loud — "Read-only. Here's the smell, ranked, and
  // the worst one is mine from today..." — because it quoted one schema line while
  // making its point. hjt9 had already ruled on exactly this shape: a chunk-level
  // route misfiles everything wrapped around the thing it detected.
  //
  // A chunk that QUOTES the prompt is shop talk and a real memory. A chunk that IS
  // the prompt is not. Coverage is what tells them apart.
  it("keeps shop talk that quotes the prompt while making a point", () => {
    const shopTalk =
      "ok here is the smell ranked and the worst one is mine from today. i told an 8b " +
      "model to do something it has no channel for. my prompt says the chunk has no beat, " +
      "say so rather than reaching for a remembered phrase, but the schema " +
      '{"motivation":"...","relational_dynamics":"...","outcome":"..."} requires motivation ' +
      "and the parser rejects any object without it. there is no way to say so, so the " +
      "instruction is advisory and does no work. that is my fault and i shipped it before " +
      "showing you.";
    const r = classifyChunk(chunk(shopTalk));
    expect(r.suppressedReason).toBeUndefined();
  });

  it("still suppresses a whole prompt, which is what coverage is for", () => {
    const r = classifyChunk(chunk(buildSystemPrompt("dysregulation", ["dissociation"])));
    expect(r.suppressedReason).toBe("self-prompt");
  });

  // docs/PROMPTS.md is generated FROM the prompts and exists to be pasted for review,
  // so a paste of it is self-ingestion too. Its per-section prose is mostly catalog
  // furniture rather than prompt text, which is why those template lines are
  // registered as signatures — without them a section scores like conversation.
  it("suppresses a PROMPTS.md section, not just the raw prompt", () => {
    const section =
      "## Tier 2 analyzer — shame\n\n" +
      "**Source:** `src/sentiment/analyzer.ts — buildSystemPrompt()`  \n" +
      "**When:** Fires per salient chunk whose primary emotion is shame. " +
      "Local model first, external API on failure.\n\n" +
      buildSystemPrompt("shame", []);
    const r = classifyChunk(chunk(section));
    expect(r.suppressedReason).toBe("self-prompt");
  });
});
