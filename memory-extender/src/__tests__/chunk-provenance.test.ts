// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// 2pbi — a chunk must be able to say WHICH MESSAGE it came from.
//
// Beat ids currently hash speaker + text because there is nothing else to hash:
// turnIndex counts across the array the caller happened to pass in, and the live
// path passes one turn at a time. Measured over the store before this was written:
// chat Auaol3n0UB6Vpb03gFJTB holds 25 distinct beats on turnStart 0 and 11 on
// turnStart -1, chat J1eQgrf-OA3xO8CqpWREX holds 22 and 7. A provenance key built
// on chatId+turnStart+turnEnd would have merged all of them.
//
// So these tests pin the distinction the fix rests on: turnIndex is a position in
// a SLICE, ordinal is a position in a MESSAGE, and only the latter survives the
// caller deciding to hand over ten messages instead of one.

import { describe, it, expect } from "vitest";
import { parseTurns, mergeByTurnOnly } from "../sentiment/chunker.js";
import type { DigestMessage } from "../digest.js";

describe("parseTurns provenance", () => {
  it("carries the message id and swipe index onto every turn it produces", () => {
    const msgs: DigestMessage[] = [
      { role: "assistant", content: "*she looks up*\nLara: you came back.\nLara: i wasn't sure.", messageId: "m-abc", swipeIndex: 2 },
    ];
    const turns = parseTurns(msgs, "Lara");
    expect(turns.length).toBeGreaterThan(1);
    for (const t of turns) {
      expect(t.messageId).toBe("m-abc");
      expect(t.swipeIndex).toBe(2);
    }
  });

  it("resets the ordinal per message while turnIndex keeps counting", () => {
    // THE WHOLE POINT OF THE TICKET, in one assertion. If ordinal ever tracked
    // turnIndex, it would inherit turnIndex's flaw and buy nothing.
    const msgs: DigestMessage[] = [
      { role: "user", content: "first.\nsecond.", messageId: "m1" },
      { role: "assistant", content: "*a pause*\nLara: third.", messageId: "m2" },
    ];
    const turns = parseTurns(msgs, "Lara");
    expect(turns.map((t) => t.turnIndex)).toEqual([0, 1, 2]);
    expect(turns.map((t) => t.messageId)).toEqual(["m1", "m2", "m2"]);
    // "first.\nsecond." is one same-speaker run, so it is ONE turn at ordinal 0;
    // m2 splits into narration + dialogue, restarting at 0.
    expect(turns[0]!.ordinal).toBe(0);
    expect(turns[1]!.ordinal).toBe(0);
    expect(turns[2]!.ordinal).toBe(1);
  });

  it("leaves provenance absent when the caller supplied none — never zero", () => {
    // Absent means unknown. A default of 0 here would be indistinguishable from a
    // genuine first message, which is precisely how turnStart failed.
    const turns = parseTurns([{ role: "user", content: "hello." }], "Lara");
    expect(turns[0]!.messageId).toBeUndefined();
    expect(turns[0]!.swipeIndex).toBeUndefined();
  });

  it("does not let the swipe index travel without its message id", () => {
    // The pair is the identity of a moment (06pq/s2lw). A swipe index alone
    // identifies nothing, and a chunk carrying one would look provenanced.
    const turns = parseTurns([{ role: "user", content: "hi.", swipeIndex: 1 }], "Lara");
    expect(turns[0]!.messageId).toBeUndefined();
    expect(turns[0]!.swipeIndex).toBe(1); // recorded on the turn…
    const chunks = mergeByTurnOnly(turns);
    expect(chunks[0]!.messageId).toBeUndefined(); // …but the chunk has no identity
  });
});

describe("chunk provenance", () => {
  it("takes the id from the chunk's FIRST turn and the ordinal span from both ends", () => {
    const turns = parseTurns(
      [{ role: "assistant", content: "Lara: one.\nLara: two.\nLara: three.", messageId: "m9", swipeIndex: 0 }],
      "Lara",
    );
    const chunks = mergeByTurnOnly(turns);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.messageId).toBe("m9");
    expect(chunks[0]!.swipeIndex).toBe(0);
    expect(chunks[0]!.ordinalStart).toBe(0);
    expect(chunks[0]!.ordinalEnd).toBe(turns[turns.length - 1]!.ordinal);
  });

  it("identifies a chunk that spans two messages by where it STARTS", () => {
    // Consecutive same-speaker turns merge across messages, and that behaviour is
    // deliberately unchanged — tightening it would re-chunk every stored import.
    // A chunk therefore names its starting point, not its extent, which is enough:
    // no two chunks of one run start at the same (messageId, ordinal).
    const turns = parseTurns(
      [
        { role: "assistant", content: "first reply.", messageId: "mA" },
        { role: "assistant", content: "second reply.", messageId: "mB" },
      ],
      "Lara",
    );
    const chunks = mergeByTurnOnly(turns);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.messageId).toBe("mA");
    expect(chunks[0]!.ordinalStart).toBe(0);
  });

  it("gives the two halves of one turn different message ids", () => {
    // The failure this ticket found in passing: the live path knew only the
    // ASSISTANT's id and stamped it on both halves, so a turn's user line and its
    // reply claimed the same moment — and a re-roll retired the user's entry
    // although the user retracted nothing.
    const turns = parseTurns(
      [
        { role: "user", content: "say it again.", messageId: "m-user" },
        { role: "assistant", content: "I said I would stay.", messageId: "m-reply", swipeIndex: 1 },
      ],
      "Lara",
    );
    const chunks = mergeByTurnOnly(turns);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.messageId).toBe("m-user");
    expect(chunks[1]!.messageId).toBe("m-reply");
    expect(chunks[0]!.messageId).not.toBe(chunks[1]!.messageId);
    // Only the assistant half has swipes.
    expect(chunks[0]!.swipeIndex).toBeUndefined();
    expect(chunks[1]!.swipeIndex).toBe(1);
  });

  it("stays absent end to end when nothing upstream had an id", () => {
    const chunks = mergeByTurnOnly(parseTurns([{ role: "user", content: "hello." }], "Lara"));
    expect(chunks[0]!.messageId).toBeUndefined();
    expect(chunks[0]!.swipeIndex).toBeUndefined();
  });
});
