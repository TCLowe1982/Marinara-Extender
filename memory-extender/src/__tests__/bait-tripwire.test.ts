// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// THE LIVE HALF OF THE ROT DEFENCE (TC, 2026-08-06).
//
// "Bait only rots if it gets mentioned explicitly in the chat by accident. There
// needs to be a mechanism for that as well."
//
// scripts/bait-rot.mjs sweeps periodically and reports rot the store has ALREADY
// absorbed. This fires at ingestion, on the source text, before the damage runs. The
// distinction matters because of what happened to the boat: it was discussed in a
// chat, the sidecar chunked and analysed the discussion, the discussion made the
// probe corroborable, and ten echoes went in on the character it was discussed with.
// A periodic sweep finds that afterwards. A tripwire finds it on the first chunk.
//
// As with the fixture tests, nothing here quotes the bait — only its probe words,
// read from the fixture at runtime.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { detectBaitContamination, excerptAround } from "../sentiment/bait-tripwire.js";
import { listEchoEntries } from "../sentiment/analyzer.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../sentiment/bait.json");
const bait = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
  specific: { text: string; probe: string[] }[];
};
const entries = listEchoEntries();

describe("bait contamination tripwire", () => {
  it("stays silent on ordinary conversation", () => {
    const ordinary =
      "she said she was afraid the memory loss meant none of it was real, and asked " +
      "him to stay through the night for once, and then put the kettle on.";
    expect(detectBaitContamination(ordinary, entries)).toEqual([]);
  });

  it("stays silent on empty or missing source", () => {
    expect(detectBaitContamination("", entries)).toEqual([]);
    expect(detectBaitContamination(undefined as unknown as string, entries)).toEqual([]);
  });

  // A SINGLE probe word is already the leak. Waiting for the full set would mean only
  // reporting the case where the hatch would have opened — i.e. only after the damage
  // is possible, which is the failure the tripwire exists to pre-empt.
  it("fires on ONE bait word, not only on the full set", () => {
    for (const e of bait.specific) {
      const one = e.probe[0]!;
      const hits = detectBaitContamination(`what even is a ${one}, anyway`, entries);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.words).toContain(one);
    }
  });

  it("fires when the whole example is pasted into a chat", () => {
    for (const e of bait.specific) {
      const hits = detectBaitContamination(`the prompt says "${e.text}" which is absurd`, entries);
      expect(hits.length).toBeGreaterThan(0);
    }
  });

  // The words are skeleton STEMS, so they must match inflections: a stem like "tarr"
  // has to find "tarred" and "tarring", or the tripwire misses the ordinary way a
  // person would mention it.
  it("matches inflected forms of a stemmed probe word", () => {
    const e = bait.specific[0]!;
    const w = e.probe[0]!;
    expect(detectBaitContamination(`they ${w}ing it yesterday`, entries).length).toBeGreaterThan(0);
  });

  it("ignores retired entries — only current bait can still leak into the prompt", () => {
    // Legacy entries carry no probeAll, so they can never trip this.
    const hits = detectBaitContamination("i called the locksmith about the green, not blue boat", entries);
    expect(hits).toEqual([]);
  });

  it("excerpts around the hit so meta-talk is distinguishable from real talk", () => {
    const w = bait.specific[0]!.probe[0]!;
    const src = `${"x".repeat(300)} the ${w} thing ${"y".repeat(300)}`;
    const ex = excerptAround(src, w);
    expect(ex).toContain(w);
    expect(ex.length).toBeLessThan(src.length);
  });
});
