// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// THE WHO IS SPEAKING HEADER (avii, icke arm E).
//
// qs67 measured the ambient extractor at 92% SUPPORTED but 45% ATTRIBUTED: it
// almost never invents a fact, it files true sentences against the wrong person.
// Arm E moved attribution 45% -> 60% and halved misattribution 15% -> 12% by
// telling the extractor two things and nothing else — who the human player is,
// and which character spoke the [character] block.
//
// WHAT THESE TESTS PROTECT. The gain is in the TEXT, and arm D proved the
// surrounding change is a REGRESSION without it (40% attributed, 22%
// misattributed — worse than shipping nothing). So a header that silently stops
// being emitted does not fail loudly; it quietly returns the extractor to a state
// measured to be worse than where it started. That is the failure worth pinning.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { speakerHeader } from "../ambient.js";

let dir: string;

const writeIdentity = async (body: string) => {
  await mkdir(join(dir, "data"), { recursive: true });
  await writeFile(join(dir, "data", "user-identity.yaml"), body, "utf8");
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-speaker-"));
  process.env.MARINARA_EXTENDER_DATA = join(dir, "data");
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true });
});

describe("speakerHeader", () => {
  it("names the player, the lookalike, and the speaking character", async () => {
    await writeIdentity([
      "version: 1",
      "canonical: TC Lowe",
      "aliases:",
      "  - thomas lowe",
      "  - tc",
      "excludes:",
      "  - thomas collier",
    ].join("\n"));

    const header = await speakerHeader("Professor Mari");

    // Canonical FIRST, then aliases in declared order — arm E sent them that way.
    expect(header).toContain("The [user] block was spoken by the human player: TC Lowe, thomas lowe, tc.");
    expect(header).toContain("Any of those names means the user.");
    // The exclusion is the half that stops "thomas collier" being read as the player.
    expect(header).toContain("NOT the player, despite the resemblance: thomas collier.");
    expect(header).toContain("The [character] block was spoken by Professor Mari.");
    // Trailing blank line: the header is prepended to the roster line and must not
    // run into it.
    expect(header.endsWith("\n\n")).toBe(true);
  });

  it("omits the exclusion line when nothing is excluded", async () => {
    await writeIdentity("version: 1\ncanonical: TC Lowe\n");
    const header = await speakerHeader("Mari");
    expect(header).toContain("TC Lowe");
    expect(header).not.toContain("NOT the player");
  });

  it("omits the speaker line when no character name is supplied", async () => {
    // A narrator turn, or a call that never resolved a session character. The
    // player half still pays for itself; inventing a speaker would not.
    await writeIdentity("version: 1\ncanonical: TC Lowe\n");
    const header = await speakerHeader(undefined);
    expect(header).toContain("TC Lowe");
    expect(header).not.toContain("[character] block was spoken by");
  });

  it("returns NOTHING rather than a header with no player in it", async () => {
    // The whole lever is naming the player. A header that lists no names teaches
    // the model nothing and still spends tokens on every turn, so absent identity
    // must produce an empty string — not a hollow header.
    await writeIdentity("version: 1\n");
    expect(await speakerHeader("Mari")).toBe("");
  });

  it("never throws when the identity file is missing or unreadable", async () => {
    // This runs inside turn ingestion. A header that can fail a turn is worse than
    // no header at all.
    expect(await speakerHeader("Mari")).toBe("");
    await writeIdentity(":\n  not: [valid yaml");
    await expect(speakerHeader("Mari")).resolves.toBeTypeOf("string");
  });
});
