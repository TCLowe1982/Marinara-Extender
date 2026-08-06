// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Unit tests for Stage 0: Chunker pure functions
//
// parseTurns, cosine, and mergeByTurnOnly are pure/sync — no sidecar needed.
// chunkMessages (the async entry point) is not tested here since it requires
// a live sidecar; integration testing covers that path.

import { describe, it, expect } from "vitest";
import { parseTurns, cosine, mergeByTurnOnly } from "../sentiment/chunker.js";
import type { DigestMessage } from "../digest.js";

// ── parseTurns ─────────────────────────────────────────────────────────────────

describe("parseTurns", () => {
  it("attributes user messages to 'user'", () => {
    const msgs: DigestMessage[] = [
      { role: "user", content: "Are you okay?" },
    ];
    const turns = parseTurns(msgs, "Lara");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.speaker).toBe("user");
    expect(turns[0]?.text).toBe("Are you okay?");
  });

  it("attributes assistant messages to the character name", () => {
    const msgs: DigestMessage[] = [
      { role: "assistant", content: "I'm fine, really." },
    ];
    const turns = parseTurns(msgs, "Lara");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.speaker).toBe("Lara");
  });

  it("uses a per-message speaker for assistant messages (group chat)", () => {
    const msgs: DigestMessage[] = [
      { role: "user", content: "Hi both." },
      { role: "assistant", content: "Hello there.", speaker: "Dr. Priya Chandrasekaran" },
      { role: "assistant", content: "And me.", speaker: "Mari" },
    ];
    const turns = parseTurns(msgs, "DefaultChar");
    expect(turns[0]?.speaker).toBe("user");
    expect(turns[1]?.speaker).toBe("Dr. Priya Chandrasekaran"); // periods/spaces survive (no regex)
    expect(turns[2]?.speaker).toBe("Mari");
  });

  it("falls back to the primary character when no per-message speaker is set", () => {
    const turns = parseTurns([{ role: "assistant", content: "Hello." }], "Mari");
    expect(turns[0]?.speaker).toBe("Mari");
  });

  // CONTRACT CHANGED 2026-08-06 (4ghy) — and this edit is called out rather than
  // slipped in, because it is an author changing a pre-existing test to accommodate
  // his own change.
  //
  // A label must now EARN the right to mint a speaker: match the roster, or recur
  // within the import. The old fixture had each name appear exactly once, which no
  // longer qualifies Marcus (Lara is the roster character and is exempt).
  //
  // Measured before the change, across all 542 stored labels: the one-off,
  // name-shaped labels this rejects contain NO actual character names. They are
  // report headings and capitalised fragments — "On one side", "WHEN TO USE",
  // "Cross-Origin Request Blocked", "Signal detection". Real dialogue recurs; the
  // rule stops the chunker minting people out of prose.
  it("detects 'Name: text' speaker prefix and overrides role speaker", () => {
    const msgs: DigestMessage[] = [
      { role: "assistant", content: "Marcus: Hey.\nLara: Hi back.\nMarcus: You came." },
    ];
    const turns = parseTurns(msgs, "Lara");
    expect(turns).toHaveLength(3);
    expect(turns[0]?.speaker).toBe("Marcus");
    expect(turns[0]?.text).toBe("Hey.");
    expect(turns[1]?.speaker).toBe("Lara");
    expect(turns[1]?.text).toBe("Hi back.");
  });

  // The other half of that contract, asserted so the fallback is never accidental.
  // A false positive mints a permanent phantom entity and pollutes the entity index;
  // a false negative leaves the line with the sender, where the raw text still says
  // the label and it stays re-derivable. Always take the recoverable error.
  it("does not invent a speaker from a one-off label — the line stays with the sender", () => {
    const msgs: DigestMessage[] = [
      { role: "assistant", content: "so the plan is: we wait.\nLara: fine." },
    ];
    const turns = parseTurns(msgs, "Lara");
    expect(turns.map((t) => t.speaker)).not.toContain("so the plan is");
    expect(turns.some((t) => t.text.includes("we wait"))).toBe(true);
  });

  it("treats *narration* lines as narrator turns", () => {
    const msgs: DigestMessage[] = [
      { role: "assistant", content: "*she sighs deeply*" },
    ];
    const turns = parseTurns(msgs, "Lara");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.speaker).toBe("Narrator");
    expect(turns[0]?.text).toBe("*she sighs deeply*");
  });

  it("handles mixed narration and dialogue in one message", () => {
    const msgs: DigestMessage[] = [
      {
        role: "assistant",
        content: "*Lara looks away*\nLara: I don't want to talk about it.\n*silence falls*",
      },
    ];
    const turns = parseTurns(msgs, "Lara");
    expect(turns).toHaveLength(3);
    expect(turns[0]?.speaker).toBe("Narrator");
    expect(turns[1]?.speaker).toBe("Lara");
    expect(turns[2]?.speaker).toBe("Narrator");
  });

  it("skips empty content", () => {
    const msgs: DigestMessage[] = [
      { role: "user", content: "   " },
      { role: "assistant", content: "Hello." },
    ];
    const turns = parseTurns(msgs, "Lara");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.speaker).toBe("Lara");
  });

  it("accumulates multi-line same-speaker content into one turn", () => {
    const msgs: DigestMessage[] = [
      { role: "assistant", content: "Line one.\nLine two.\nLine three." },
    ];
    const turns = parseTurns(msgs, "Lara");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toContain("Line one.");
    expect(turns[0]?.text).toContain("Line three.");
  });

  it("assigns sequential turnIndex values", () => {
    const msgs: DigestMessage[] = [
      { role: "user", content: "Hello." },
      { role: "assistant", content: "Hi." },
    ];
    const turns = parseTurns(msgs, "Lara");
    expect(turns[0]?.turnIndex).toBe(0);
    expect(turns[1]?.turnIndex).toBe(1);
  });
});

// ── cosine ─────────────────────────────────────────────────────────────────────

describe("cosine", () => {
  it("returns 1.0 for identical vectors", () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  it("returns -1.0 for opposite vectors", () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  it("returns 0.0 for a zero vector", () => {
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });

  it("is symmetric", () => {
    const a = [0.3, 0.7, 0.5];
    const b = [0.9, 0.1, 0.4];
    expect(cosine(a, b)).toBeCloseTo(cosine(b, a));
  });

  it("returns correct value for known vectors", () => {
    // [1,1] · [1,0] = 1; |[1,1]| = √2; |[1,0]| = 1; cos = 1/√2 ≈ 0.707
    expect(cosine([1, 1], [1, 0])).toBeCloseTo(0.707, 2);
  });
});

// ── mergeByTurnOnly ────────────────────────────────────────────────────────────

describe("mergeByTurnOnly", () => {
  it("returns empty array for empty input", () => {
    expect(mergeByTurnOnly([])).toEqual([]);
  });

  it("returns a single chunk for a single turn", () => {
    const turns = [{ speaker: "Lara", text: "Hello.", turnIndex: 0 }];
    const chunks = mergeByTurnOnly(turns);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.speaker).toBe("Lara");
    expect(chunks[0]?.text).toBe("Hello.");
    expect(chunks[0]?.turnStart).toBe(0);
    expect(chunks[0]?.turnEnd).toBe(0);
  });

  it("merges consecutive same-speaker turns into one chunk", () => {
    const turns = [
      { speaker: "Lara", text: "First part.", turnIndex: 0 },
      { speaker: "Lara", text: "Second part.", turnIndex: 1 },
    ];
    const chunks = mergeByTurnOnly(turns);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain("First part.");
    expect(chunks[0]?.text).toContain("Second part.");
    expect(chunks[0]?.turnStart).toBe(0);
    expect(chunks[0]?.turnEnd).toBe(1);
  });

  it("splits on speaker change", () => {
    const turns = [
      { speaker: "Lara", text: "Hi.", turnIndex: 0 },
      { speaker: "Marcus", text: "Hey.", turnIndex: 1 },
    ];
    const chunks = mergeByTurnOnly(turns);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.speaker).toBe("Lara");
    expect(chunks[1]?.speaker).toBe("Marcus");
  });

  it("handles A-A-B pattern: merges first two, keeps third separate", () => {
    const turns = [
      { speaker: "Lara", text: "Part one.", turnIndex: 0 },
      { speaker: "Lara", text: "Part two.", turnIndex: 1 },
      { speaker: "Marcus", text: "My turn.", turnIndex: 2 },
    ];
    const chunks = mergeByTurnOnly(turns);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.speaker).toBe("Lara");
    expect(chunks[0]?.turnStart).toBe(0);
    expect(chunks[0]?.turnEnd).toBe(1);
    expect(chunks[1]?.speaker).toBe("Marcus");
    expect(chunks[1]?.turnStart).toBe(2);
    expect(chunks[1]?.turnEnd).toBe(2);
  });

  it("handles alternating speakers without merging across speakers", () => {
    const turns = [
      { speaker: "A", text: "1", turnIndex: 0 },
      { speaker: "B", text: "2", turnIndex: 1 },
      { speaker: "A", text: "3", turnIndex: 2 },
      { speaker: "B", text: "4", turnIndex: 3 },
    ];
    const chunks = mergeByTurnOnly(turns);
    expect(chunks).toHaveLength(4);
    expect(chunks.map((c) => c.speaker)).toEqual(["A", "B", "A", "B"]);
  });

  it("splits a same-speaker run at the maxTurns cap", () => {
    // 8 same-speaker turns with maxTurns=3 → should produce 3 chunks: [3,3,2]
    const turns = Array.from({ length: 8 }, (_, i) => ({
      speaker: "Narrator",
      text: `Para ${i + 1}.`,
      turnIndex: i,
    }));
    const chunks = mergeByTurnOnly(turns, 3);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.text).toContain("Para 1.");
    expect(chunks[0]?.text).toContain("Para 3.");
    expect(chunks[1]?.text).toContain("Para 4.");
    expect(chunks[1]?.text).toContain("Para 6.");
    expect(chunks[2]?.text).toContain("Para 7.");
    expect(chunks[2]?.text).toContain("Para 8.");
  });
});
