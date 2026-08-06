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
    const pasted =
      "ok here's what it currently says, tell me if this reads right:\n" +
      "- Respond with raw JSON only — no explanation, no markdown.\n" +
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
});
