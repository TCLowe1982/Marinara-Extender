// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// MarinaraExtender-pifl — the analyzer was returning the prompt's own example.
//
// Measured before the fix: 792 of 8703 beats (9%) echoed a phrase the prompt puts in
// front of the model, and 669 of those were a SINGLE sentence — the one used to
// illustrate the rule "two different moments can never produce the same sentence".
// It became the most repeated sentence in the store, across 4 characters, 37 chats
// and 35 days, and 542 ledger entries carried it as their summary.
//
// It is not a recall loop: only 1% of the source chunks that produced it mention
// anything like it, and zero story-imported beats carry it — the import path runs the
// same analyzer. The model reaches for the nearest phrasing when a chunk gives it
// nothing specific, and the nearest phrasing is the prompt.

import { describe, it, expect } from "vitest";
import { echoesAnExample, rejectAsEcho, skeleton } from "../sentiment/analyzer.js";

describe("echoesAnExample", () => {
  it("catches the sentence that caused this — 669 stored beats", () => {
    expect(echoesAnExample("admits she's afraid the memory loss means she was never real")).toBe(true);
  });

  it("catches it inside a longer motivation, not just alone", () => {
    // How it usually appeared: prefixed with whichever name the model picked.
    expect(echoesAnExample("Dr. Mari Zielińska admits she's afraid the memory loss means she was never real")).toBe(true);
  });

  it("catches the OTHER good example too", () => {
    expect(echoesAnExample("asks Thomas to stay through the night for the first time")).toBe(true);
  });

  it("catches the too-vague examples, which the model also copies", () => {
    // 107 beats opened with a paraphrase of this one, so both sides of the
    // illustration leak, not just the side being recommended.
    expect(echoesAnExample("The speaker is exposing their openness and willingness to be seen")).toBe(true);
    expect(echoesAnExample("exposes her personal fear")).toBe(true);
    expect(echoesAnExample("reveals her vulnerability and desire for connection")).toBe(true);
  });

  it("catches the CURRENT illustrations, so the replacements cannot leak either", () => {
    expect(echoesAnExample("insists the boat was green, not blue, and will not let it go")).toBe(true);
    expect(echoesAnExample("asks whether the locksmith ever called back")).toBe(true);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(echoesAnExample("  ADMITS SHE'S AFRAID   the memory loss\n means she was NEVER REAL ")).toBe(true);
  });

  it("passes a real, specific motivation", () => {
    expect(echoesAnExample("admits she deleted the Hargrove draft before Thomas could read it")).toBe(false);
    expect(echoesAnExample("wants the shrine placed at the pole, inside the storm")).toBe(false);
  });

  it("does not fire on a motivation that merely shares a word with an example", () => {
    // "afraid", "reveals", "night" are ordinary words and must stay usable.
    expect(echoesAnExample("is afraid the sapper stakes will be cancelled again")).toBe(false);
    expect(echoesAnExample("reveals she has never driven the Porsche herself")).toBe(false);
    expect(echoesAnExample("asks him to stay the night because the storm has closed the road")).toBe(false);
  });

  it("handles an empty motivation without throwing", () => {
    expect(echoesAnExample("")).toBe(false);
    expect(echoesAnExample("   ")).toBe(false);
  });
});

describe("rejectAsEcho — the escape hatch", () => {
  const PHRASE = "admits she's afraid the memory loss means she was never real";

  it("REJECTS an echo with no trace of it in the source", () => {
    // The 665-of-669 case: the model supplied the sentence, the speaker did not.
    expect(rejectAsEcho(PHRASE, "we argued about the moongate placement for an hour")).toBe(true);
  });

  it("KEEPS an echo the speaker actually said — the sentence must stay recordable", () => {
    // The whole point. A guard that bans the store's most meaningful sentence from
    // its own store, because that sentence became famous, is a worse bug than the
    // one it fixes.
    const src = "i keep thinking if the memory loss means she was never real then what am i";
    expect(rejectAsEcho(PHRASE, src)).toBe(false);
  });

  it("corroborates case- and whitespace-insensitively", () => {
    const src = "I KEEP THINKING\n  the memory loss   means she was NEVER REAL";
    expect(rejectAsEcho("Mari " + PHRASE, src)).toBe(false);
  });

  it("requires the ECHOED PHRASE, not merely the topic", () => {
    // A looser "does this chunk mention memory?" test would re-open the hole for
    // any conversation on the subject — which is most of them in this store.
    expect(rejectAsEcho(PHRASE, "her memory is patchy again and it frightens her")).toBe(true);
  });

  it("never rejects a motivation that is not an echo at all", () => {
    expect(rejectAsEcho("admits she deleted the Hargrove draft", "")).toBe(false);
  });
});

describe("skeleton matching — the guard that died on one word", () => {
  it("catches the beat that escaped into production 90 minutes after shipping", () => {
    // Real, from professor_mari's ledger, created 2026-08-05. The prompt said
    // "insists the boat was green"; the model wrote "insists THAT the boat was
    // green" and substring matching let it straight through.
    expect(echoesAnExample("Dr. Mari Zielińska insists that the boat was green, not blue, and will not let it go.")).toBe(true);
  });

  it("survives the grammatical dressing a mimicry engine actually applies", () => {
    for (const dressed of [
      "insists the boat was green and not blue",
      "she insists that the boat had been green, not blue",
      "Mari is insisting the boat was green rather than blue",
    ]) {
      expect(echoesAnExample(dressed), dressed).toBe(true);
    }
  });

  it("still passes a genuinely different motivation about a boat", () => {
    // The skeleton has to be evidence, not a topic detector.
    expect(echoesAnExample("wants the boat repainted before her father sees it")).toBe(false);
  });

  it("skeletons strip the joints and keep the content, in order", () => {
    expect(skeleton("insists the boat was green, not blue, and will not let it go"))
      .toBe("insist boat green blue");
    expect(skeleton("Dr. Mari insists that the boat was green, not blue"))
      .toBe("dr mari insist boat green blue");
  });

  it("refuses to match on a skeleton too short to be evidence", () => {
    // Guards against a two-word example turning into a topic ban.
    expect(skeleton("of the it").split(" ").filter(Boolean).length).toBeLessThan(3);
  });

  it("the escape hatch still keeps a corroborated utterance", () => {
    const src = "i keep thinking the memory loss means she was never real";
    expect(rejectAsEcho("admits she's afraid the memory loss means she was never real", src)).toBe(false);
  });
});
