// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// r0kc — a beat's identity must be derivable from things that cannot be improved.
//
// beatIdForChunk hashes `speaker` and `text`. Both are readings of a chunk rather
// than facts about it, and this system keeps getting better at both: 5dqr
// unmangled 171 speaker names, 4ghy stopped minting phantom ones, hjt9's ops
// routing rewrites `text` before the chunker ever sees it. Every one of those
// improvements renamed the beats it touched, so the next import failed to
// recognise its own work and wrote them again — and duplicate beats read as
// independent corroborations of a single utterance, which is the exact failure
// "count utterances, never hits" exists to prevent.
//
// The fix is a SECOND key. Matching moves to `provenanceKey`, which does not budge
// when the reading changes. NOTHING STORED IS RENAMED — beats written before the
// message id reached the chunker have no provenance to derive one from, so they
// keep the legacy hash and a re-import still recognises them.
//
// The plan was for `id` to stay the legacy hash for new beats too. It could not,
// and the reason is in "SEPARATES two identical utterances" below: the legacy hash
// gives one filename to two different moments that happen to read the same. Resume
// used to hide that by skipping the second as a duplicate. Matching on provenance
// stops hiding it, so the filename had to follow — for new beats only.
//
// The tests are mostly pairs: the same edit, asserted to MOVE the legacy id and NOT
// move the provenance key. The contrast is the point.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  beatIdForChunk,
  beatIdFor,
  provenanceKeyForChunk,
  encodeBeat,
  readBeat,
  readBeatIndex,
} from "../sentiment/encoder.js";
import type { Chunk, ClassificationResult, BeatAnalysis } from "../sentiment/types.js";

const chunk = (over: Partial<Chunk> = {}): Chunk => ({
  speaker: "Mari",
  text: "I said I would stay.",
  turnStart: 0,
  turnEnd: 0,
  messageId: "m-7f3a",
  swipeIndex: 0,
  ordinalStart: 0,
  ordinalEnd: 0,
  ...over,
});

describe("provenanceKeyForChunk", () => {
  it("names the message, the swipe and the turn within it", () => {
    expect(provenanceKeyForChunk(chunk())).toBe("m-7f3a:0:0");
  });

  it("holds still when the SPEAKER is corrected — the 5dqr case", () => {
    // "Thomas Today at 8" -> "Thomas". A parsing fix, not a different moment.
    const before = chunk({ speaker: "Thomas Today at 8" });
    const after = chunk({ speaker: "Thomas" });
    expect(provenanceKeyForChunk(before)).toBe(provenanceKeyForChunk(after));
    expect(beatIdForChunk(before)).not.toBe(beatIdForChunk(after)); // …and the id does not
  });

  it("holds still when the TEXT is filtered — the hjt9 case", () => {
    // Ops routing strips a pasted log out of a message before chunking. Same
    // utterance, fewer lines. Mari's first formulation kept content in the key;
    // she withdrew it for precisely this.
    const before = chunk({ text: "god yeah dotenv is the KRYPTONITE $ npm run build" });
    const after = chunk({ text: "god yeah dotenv is the KRYPTONITE" });
    expect(provenanceKeyForChunk(before)).toBe(provenanceKeyForChunk(after));
    expect(beatIdForChunk(before)).not.toBe(beatIdForChunk(after));
  });

  it("holds still when the chunker's merge window changes the extent", () => {
    // Where a chunk starts is provenance; how far it runs is a config setting.
    // ordinalEnd is deliberately not in the key.
    expect(provenanceKeyForChunk(chunk({ ordinalEnd: 0 })))
      .toBe(provenanceKeyForChunk(chunk({ ordinalEnd: 4 })));
  });

  it("SEPARATES two swipes of one message — the pair stays a pair", () => {
    // A re-roll keeps the message id and moves only the swipe index. Dropping it
    // would declare the kept reply and the discarded one the same moment.
    expect(provenanceKeyForChunk(chunk({ swipeIndex: 0 })))
      .not.toBe(provenanceKeyForChunk(chunk({ swipeIndex: 1 })));
  });

  it("SEPARATES two turns within one message", () => {
    expect(provenanceKeyForChunk(chunk({ ordinalStart: 0 })))
      .not.toBe(provenanceKeyForChunk(chunk({ ordinalStart: 1 })));
  });

  it("SEPARATES the two halves of a turn", () => {
    // The failure 2pbi found: both halves used to carry the reply's id.
    expect(provenanceKeyForChunk(chunk({ messageId: "m-user", swipeIndex: undefined })))
      .not.toBe(provenanceKeyForChunk(chunk({ messageId: "m-reply" })));
  });

  it("records 'no swipes' as a fact, distinct from swipe 0", () => {
    expect(provenanceKeyForChunk(chunk({ swipeIndex: undefined }))).toBe("m-7f3a:-:0");
    expect(provenanceKeyForChunk(chunk({ swipeIndex: 0 }))).toBe("m-7f3a:0:0");
  });

  it("is undefined when there is no message to name", () => {
    // The story importer, and everything written before 2pbi. Those keep matching
    // on the id, permanently — nothing exists to backfill a key from.
    expect(provenanceKeyForChunk(chunk({ messageId: undefined }))).toBeUndefined();
    // A swipe index alone identifies nothing.
    expect(provenanceKeyForChunk(chunk({ messageId: undefined, swipeIndex: 3 }))).toBeUndefined();
  });

  it("does not collide across messages that share an ordinal", () => {
    // Every live turn stamps ordinal 0, the way every live turn stamped
    // turnStart 0. The message id is what stops that being a collision.
    const keys = new Set(
      ["m1", "m2", "m3"].map((m) => provenanceKeyForChunk(chunk({ messageId: m }))),
    );
    expect(keys.size).toBe(3);
  });
});

// ── encodeBeat ────────────────────────────────────────────────────────────────

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-prov-"));
  process.env.MARINARA_EXTENDER_DATA = join(dir, "data");
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const result = (c: Chunk): ClassificationResult => ({
  chunk: c,
  scores: { vulnerability: 0.8 },
  primaryEmotion: "vulnerability",
  salience: 0.8,
  structuralMatches: [],
  passesThreshold: true,
});

const analysis: BeatAnalysis = {
  motivation: "m", relationalDynamics: "r", outcome: "o", salience: 0.8,
};

describe("encodeBeat provenance", () => {
  it("stamps the key on the beat and mirrors it into the index", () => {
    // Mirrored for the same reason retiredAt is: resume must not open 8,000 files
    // to answer "have I already done this one".
    return (async () => {
      const beat = await encodeBeat("lara", result(chunk()), analysis, "chat", "c1");
      expect(beat.provenanceKey).toBe("m-7f3a:0:0");
      const index = await readBeatIndex("lara");
      expect(index?.entries[0]?.provenanceKey).toBe("m-7f3a:0:0");
    })();
  });

  it("omits the key entirely when the chunk has no message — never an empty string", () => {
    return (async () => {
      const beat = await encodeBeat("lara", result(chunk({ messageId: undefined })), analysis, "chat");
      expect(beat.provenanceKey).toBeUndefined();
      expect("provenanceKey" in beat).toBe(false);
    })();
  });

  it("writes OVER the existing beat when the caller supplies its id", async () => {
    // The forced-re-import case. Without reuseId the improved reading mints a
    // second file and the store grows a duplicate of a moment it already holds.
    const first = await encodeBeat("lara", result(chunk()), analysis, "chat", "c1");

    const improved = chunk({ speaker: "Dr. Mari Zielińska", text: "I said I would stay. Really." });
    expect(beatIdForChunk(improved)).not.toBe(beatIdForChunk(chunk())); // the reading moved…

    const second = await encodeBeat("lara", result(improved), analysis, "chat", "c1", undefined, first.id);
    expect(second.id).toBe(first.id);                    // …the file did not
    expect(second.provenanceKey).toBe(first.provenanceKey);

    const index = await readBeatIndex("lara");
    expect(index?.entries).toHaveLength(1);              // one moment, one row

    const stored = await readBeat("lara", first.id);
    expect(stored?.speaker).toBe("Dr. Mari Zielińska");  // the correction landed
  });
});

describe("beatIdFor", () => {
  it("names the file from provenance, so a correction cannot rename it", () => {
    const before = chunk({ speaker: "Thomas Today at 8", text: "stay. please." });
    const after = chunk({ speaker: "Thomas", text: "stay." });
    expect(beatIdFor(before)).toBe(beatIdFor(after));
    expect(beatIdForChunk(before)).not.toBe(beatIdForChunk(after));
  });

  it("SEPARATES two identical utterances from different messages", () => {
    // The hole the legacy hash has always had, exposed by matching on provenance.
    // Someone says "I know." twice in a chat: same speaker, same text, and — on
    // the live path, where turnNumber is always 0 — the same turn range. One
    // filename for two moments. Resume used to hide it by skipping the second as
    // a duplicate, so the loss looked like successful deduplication.
    const a = chunk({ text: "I know.", messageId: "m-first" });
    const b = chunk({ text: "I know.", messageId: "m-second" });
    expect(beatIdForChunk(a)).toBe(beatIdForChunk(b));  // the old name collides…
    expect(beatIdFor(a)).not.toBe(beatIdFor(b));        // …the new one does not
  });

  it("falls back to the legacy hash when there is no provenance, renaming nothing", async () => {
    // Pre-2pbi beats and the story importer. This is permanent, not a migration
    // waiting to happen: nothing exists to backfill a message id from.
    const legacy = chunk({ messageId: undefined });
    expect(beatIdFor(legacy)).toBe(beatIdForChunk(legacy));

    const beat = await encodeBeat("lara", result(legacy), analysis, "story");
    expect(beat.id).toBe(beatIdForChunk(legacy));
    expect(beat.provenanceKey).toBeUndefined();
  });
});
