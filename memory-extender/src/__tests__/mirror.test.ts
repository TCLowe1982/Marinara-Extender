// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// THE MIRROR (i83s, retargeted) — the store's own output ingested as dialogue.
//
// Fixtures are LIVE TEXT, shortened but not invented. The positives are things
// that actually reached the beat store; the negatives are things that actually
// reached it and must keep reaching it.

import { describe, it, expect, beforeEach } from "vitest";
import {
  detectMirror, isMirror, MIRROR_COVERAGE,
  noteMirrorRefusal, mirrorRefusalCounts, resetMirrorRefusalCounts,
} from "../sentiment/mirror.js";

describe("mirror signals — self-minted identifiers, not vocabulary", () => {
  it.each([
    ["entry-id",  "- ctopic-tmbg7dpu: Thomas has been mourning Mari's lost month."],
    ["beat-id",   "characters/k6c/beats/beat-840d58ad8555.yaml:22: burned eight hundred calories"],
    ["about-tag", "[about: Thomas] Thomas considers himself the first entry in a case."],
    ["me-log",    "[ME:loader] entries loaded — chat:40 char:35 global:0 bookmarks:0"],
    ["ticket-id", "MarinaraExtender-4ghy is the chunker speaker bug"],
  ])("detects %s", (name, text) => {
    const hit = detectMirror(text);
    expect(hit).not.toBeNull();
    expect(hit!.signals).toContain(name);
  });

  it("is NOT a keyword blocklist — the words themselves are free", () => {
    // A human can talk about remembering, or about someone, all day.
    for (const t of [
      "i want you to remember about the thing we talked about",
      "what about the topic of your dissertation?",
      "the character of that argument was completely different",
    ]) expect(detectMirror(t)).toBeNull();
  });
});

describe("DELIBERATE capture syntax is a feature and is never a mirror line", () => {
  // 840 live beats carry one of these and nothing else. Refusing them would
  // break the primary manual-capture path.
  it.each([
    '[remember: lane="user_topics", content="TC grew up in Nodaway County"]',
    '[bookmark: topic="batman-manuscript", weight=0.8, why="unresolved"]',
  ])("spares %j", (text) => {
    expect(detectMirror(text)).toBeNull();
  });

  it("a remember-tag line is spared even when it mentions an entry id", () => {
    const t = '[remember: lane="character_topics", content="supersedes ctopic-82p9tylw"]';
    expect(detectMirror(t)).toBeNull();
  });
});

describe("COVERAGE, not a hit — the pe4o lesson", () => {
  it("refuses a chunk that IS a paste", () => {
    const paste = [
      "[ME:loader] entries loaded — chat:40 char:35 global:0 bookmarks:0",
      "[ME:loader] bookmarks surfaced: 0/0 passed weight roll",
      "[ME:loader] sections assembled in 12ms",
    ].join("\n");
    const hit = detectMirror(paste);
    expect(hit!.coverage).toBeGreaterThanOrEqual(MIRROR_COVERAGE);
    expect(isMirror(hit)).toBe(true);
  });

  it("SPARES conversation that merely cites one of our ids", () => {
    // Live text. This is Mari doing real analysis and it is a real memory —
    // a chunk-level verdict would have eaten every word around the id.
    const talk = [
      "okay that's the actual find and it's bigger than the test.",
      "the tag writes character-scope because that's the durable cross-chat memory,",
      "which is why ctopic-8f3k2a1b ended up where it did.",
      "so the routing was right and the docs were wrong the whole time.",
      "i'm genuinely relieved — i thought we'd lost the thread on this one.",
    ].join("\n");
    const hit = detectMirror(talk);
    expect(hit).not.toBeNull();               // it IS detected
    expect(hit!.coverage).toBeLessThan(MIRROR_COVERAGE);
    expect(isMirror(hit)).toBe(false);        // and it is NOT refused
  });

  it("returns the split — matches and coverage, never a bare boolean", () => {
    const hit = detectMirror("real talk here\n[ME:poller] started\nmore real talk");
    expect(hit).toMatchObject({ matches: 1 });
    expect(hit!.coverage).toBeGreaterThan(0);
    expect(hit!.coverage).toBeLessThan(1);
    expect(hit!.sample).toContain("[ME:poller]");
  });

  it("empty and blank text yield no hit", () => {
    expect(detectMirror("")).toBeNull();
    expect(detectMirror("   \n  ")).toBeNull();
  });
});

describe("refusals are COUNTED BY REASON — watchable live, not grepped in October", () => {
  beforeEach(() => resetMirrorRefusalCounts());

  it("tallies each signal that fired", () => {
    noteMirrorRefusal(["entry-id", "about-tag"]);
    noteMirrorRefusal(["entry-id"]);
    noteMirrorRefusal(["me-log"]);
    expect(mirrorRefusalCounts()).toEqual({ "entry-id": 2, "about-tag": 1, "me-log": 1 });
  });
});

describe("the case that started it", () => {
  it("refuses a pasted store audit — the exact shape that inflated a count", () => {
    // This is what put 12 phantom "[about: Thomas]" hits into a census.
    const audit = [
      "- ctopic-tmbg7dpu: [about: Thomas] Thomas has been mourning Mari's lost month.",
      "- ctopic-sjwwu4lz: [about: Thomas] Thomas will accept the invitation.",
      "- ctopic-8lv2aeiy: [about: character] A character expresses an idea.",
    ].join("\n");
    const hit = detectMirror(audit);
    expect(isMirror(hit)).toBe(true);
    expect(hit!.signals).toEqual(expect.arrayContaining(["entry-id", "about-tag"]));
    expect(hit!.matches).toBe(3);
  });
});
