// Unit tests for the speaker alias table + orphan-beat holding pool (P1 backbone).
//
// These touch the filesystem, so each test runs against a fresh temp data dir
// pointed at by MARINARA_EXTENDER_DATA (read at call time by getDataDir()).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  jaroWinkler,
  normalizeLabel,
  addAlias,
  readAliasTable,
  findExactMatches,
  findFuzzySuggestion,
  removeAlias,
  removeAliasRecord,
} from "../aliases.js";
import {
  addPending,
  listPendingSpeakers,
  migratePendingBeats,
  routeOrphans,
  ignoreSpeaker,
  restoreIgnored,
  purgeExpiredIgnored,
  readHoldingPool,
  orphanCharacterBeats,
} from "../holding-pool.js";
import { readBeatIndex, readBeat, writeBeat } from "../sentiment/encoder.js";
import { readIndex } from "../storage.js";
import type { ClassificationResult, EmotionalBeat } from "../sentiment/types.js";
import type { AnalyzedBeat as AB } from "../sentiment/analyzer.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-alias-"));
  process.env.MARINARA_EXTENDER_DATA = dir;
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true });
});

// ── Fixtures ───────────────────────────────────────────────────────────────────

function classification(speaker: string, text: string, turn: number): ClassificationResult {
  return {
    chunk: { speaker, text, turnStart: turn, turnEnd: turn },
    scores: { fear: 0.7 },
    primaryEmotion: "fear",
    salience: 0.7,
    structuralMatches: [],
    passesThreshold: true,
  };
}

function beatFixture(speaker: string, id: string, turn: number): EmotionalBeat {
  return {
    id, speaker, emotion: "fear", text: "a line",
    motivation: "m", relationalDynamics: "r", outcome: "o",
    salience: 0.7, turnStart: turn, turnEnd: turn,
    created: "2026-01-01", sourceType: "chat", sourceChatId: "chat-1",
  };
}

// Stand-in analyzer: skips the LLM, returns a trivial analysis per chunk.
const stubAnalyze = async (targets: ClassificationResult[]): Promise<AB[]> =>
  targets.map((result) => ({
    result,
    analysis: {
      motivation: "wants reassurance",
      relationalDynamics: "leaning in",
      outcome: "stays engaged",
      salience: result.salience,
    },
  }));

// ── jaro-winkler ─────────────────────────────────────────────────────────────

describe("jaroWinkler", () => {
  it("is 1 for identical strings", () => {
    expect(jaroWinkler("priya", "priya")).toBe(1);
  });
  it("rewards a shared prefix (names)", () => {
    expect(jaroWinkler("dr. mari", "dr. mary")).toBeGreaterThan(0.85);
  });
  it("keeps short distinct names below the auto-route bar", () => {
    // "Mari" vs "Maria" must not exceed threshold enough to be a confident hit
    // we'd auto-route on — it stays a *suggestion* at most.
    expect(jaroWinkler("xavier", "priya")).toBeLessThan(0.85);
  });
});

describe("normalizeLabel", () => {
  it("casefolds, trims, and collapses whitespace", () => {
    expect(normalizeLabel("  Dr.   Priya  ")).toBe("dr. priya");
  });
});

// ── alias table ────────────────────────────────────────────────────────────────

describe("alias table", () => {
  it("exact-matches case-insensitively across canonical + aliases", async () => {
    await addAlias("priya-uuid", "Dr. Priya Chandrasekaran", "Priya");
    await addAlias("priya-uuid", "Dr. Priya Chandrasekaran", "Dr. P");

    const table = await readAliasTable();
    expect(findExactMatches(table, "priya")).toHaveLength(1);
    expect(findExactMatches(table, "DR. P")[0]?.identityKey).toBe("priya-uuid");
    // canonical name itself matches
    expect(findExactMatches(table, "dr. priya chandrasekaran")[0]?.identityKey).toBe("priya-uuid");
    expect(findExactMatches(table, "nobody")).toHaveLength(0);
  });

  it("dedups aliases on normalized form and records usage meta", async () => {
    await addAlias("mari-uuid", "Dr. Mari Zielinska", "Mari");
    await addAlias("mari-uuid", "Dr. Mari Zielinska", "  mari "); // same after normalize
    const table = await readAliasTable();
    expect(table["mari-uuid"]!.aliases).toEqual(["Mari"]);
    expect(table["mari-uuid"]!.aliasMeta?.["mari"]).toBeTruthy();
  });

  it("offers a fuzzy suggestion for a near-miss but not a far one", async () => {
    await addAlias("mari-uuid", "Dr. Mari Zielinska", "Dr. Mari");
    const table = await readAliasTable();
    const hit = findFuzzySuggestion(table, "Dr. Mri"); // typo
    expect(hit?.identityKey).toBe("mari-uuid");
    expect(findFuzzySuggestion(table, "Alejandra")).toBeNull();
  });

  it("auto-suggests on token containment (honorific added to a known name)", async () => {
    await addAlias("priya-uuid", "Dr. Priya Chandrasekaran", "Chandrasekaran");
    const table = await readAliasTable();
    // "Dr. Chandrasekaran" contains the known "Chandrasekaran" token → suggest.
    const hit = findFuzzySuggestion(table, "Dr. Chandrasekaran");
    expect(hit?.identityKey).toBe("priya-uuid");
    // A distinct name shares no significant token → no false suggestion.
    expect(findFuzzySuggestion(table, "Professor Bartholomew")).toBeNull();
  });

  it("detects a collision when a label maps to two characters", async () => {
    await addAlias("a-uuid", "Alex Stone", "Alex");
    await addAlias("b-uuid", "Alexandra Reed", "Alex");
    const table = await readAliasTable();
    expect(findExactMatches(table, "Alex")).toHaveLength(2);
  });

  it("removeAlias never drops the canonical; removeAliasRecord cascades", async () => {
    await addAlias("p-uuid", "Priya", "Dr. P");
    await removeAlias("p-uuid", "Priya");       // canonical — ignored
    await removeAlias("p-uuid", "Dr. P");       // alias — dropped
    let table = await readAliasTable();
    expect(findExactMatches(table, "priya")).toHaveLength(1);
    expect(findExactMatches(table, "dr. p")).toHaveLength(0);

    const removed = await removeAliasRecord("p-uuid");
    expect(removed?.canonicalName).toBe("Priya");
    table = await readAliasTable();
    expect(table["p-uuid"]).toBeUndefined();
  });
});

// ── holding pool ─────────────────────────────────────────────────────────────

describe("holding pool", () => {
  it("adds pending beats, dedups by deterministic id, and lists by speaker", async () => {
    await addPending({ speaker: "Priya", classification: classification("Priya", "I can't do this.", 1), sourceType: "story" });
    await addPending({ speaker: "Priya", classification: classification("Priya", "I can't do this.", 1), sourceType: "story" }); // dup
    await addPending({ speaker: "Priya", classification: classification("Priya", "Help me.", 2), sourceType: "story" });
    await addPending({ speaker: "Alejandra", classification: classification("Alejandra", "Leave it.", 3), sourceType: "story" });

    const rows = await listPendingSpeakers();
    const priya = rows.find((r) => r.normalized === "priya");
    expect(priya?.count).toBe(2); // dup collapsed
    expect(rows.find((r) => r.normalized === "alejandra")?.count).toBe(1);
  });

  it("migrates pending beats to a character scope and is idempotent", async () => {
    await addPending({
      speaker: "Priya",
      classification: classification("Priya", "I can't do this.", 1),
      sourceType: "chat",
      sourceChatId: "chat-xyz",
    });
    await addPending({ speaker: "Priya", classification: classification("Priya", "Help me.", 2), sourceType: "chat", sourceChatId: "chat-xyz" });

    const r1 = await migratePendingBeats("priya", "priya-real-uuid", { analyze: stubAnalyze });
    expect(r1.migrated).toBe(2);

    const index = await readBeatIndex("priya-real-uuid");
    expect(index?.entries).toHaveLength(2);
    const beat = await readBeat("priya-real-uuid", index!.entries[0]!.id);
    expect(beat?.sourceChatId).toBe("chat-xyz"); // provenance carried through

    // Companion ledger entries must exist or the loader can't retrieve the beats.
    const ledger = await readIndex("character", "priya-real-uuid");
    expect((ledger?.entries ?? []).some((e) => e.lane === "character_topics")).toBe(true);

    // Pool is now empty for that label; re-migrating is a no-op.
    const pool = await readHoldingPool();
    expect(pool.pendingBySpeaker["priya"]).toBeUndefined();
    const r2 = await migratePendingBeats("priya", "priya-real-uuid", { analyze: stubAnalyze });
    expect(r2.migrated).toBe(0);
  });

  it("ignore moves beats to a recoverable bucket; restore brings them back", async () => {
    await addPending({ speaker: "Walk-On", classification: classification("Walk-On", "...", 1), sourceType: "story" });
    const ig = await ignoreSpeaker("walk-on");
    expect(ig.ignored).toBe(1);
    expect((await listPendingSpeakers()).length).toBe(0);

    const re = await restoreIgnored("Walk-On");
    expect(re.restored).toBe(1);
    expect((await listPendingSpeakers())[0]?.normalized).toBe("walk-on");
  });

  it("routeOrphans auto-routes exact aliases, holds fuzzy + miss, skips user", async () => {
    await addAlias("priya-uuid", "Dr. Priya Chandrasekaran", "Priya");

    const orphans = [
      { classification: classification("Priya", "I can't.", 1), sourceType: "story" as const },     // exact → auto-route
      { classification: classification("Prija", "Typo of priya.", 2), sourceType: "story" as const }, // fuzzy → held + suggestion
      { classification: classification("Stranger", "Who?", 3), sourceType: "story" as const },        // miss → held
      { classification: classification("user", "my line", 4), sourceType: "story" as const },          // user → skipped
    ];
    const summary = await routeOrphans(orphans, { analyze: stubAnalyze });

    expect(summary.autoRouted).toBe(1);
    expect(summary.held).toBe(2);
    // Priya's beat landed under her character, not the pool.
    expect((await readBeatIndex("priya-uuid"))?.entries).toHaveLength(1);

    const rows = await listPendingSpeakers();
    const labels = rows.map((r) => r.normalized).sort();
    expect(labels).toEqual(["prija", "stranger"]);
    // The fuzzy one carries a suggestion toward Priya; the miss does not.
    expect(rows.find((r) => r.normalized === "prija")?.suggestion?.identityKey).toBe("priya-uuid");
    expect(rows.find((r) => r.normalized === "stranger")?.suggestion).toBeUndefined();
  });

  it("routeOrphans holds (no suggestion) when a label collides across characters", async () => {
    await addAlias("a-uuid", "Alex Stone", "Alex");
    await addAlias("b-uuid", "Alexandra Reed", "Alex");
    const summary = await routeOrphans(
      [{ classification: classification("Alex", "ambiguous", 1), sourceType: "story" as const }],
      { analyze: stubAnalyze },
    );
    expect(summary.autoRouted).toBe(0);
    expect(summary.held).toBe(1);
    expect((await listPendingSpeakers())[0]?.suggestion).toBeUndefined(); // forced manual
  });

  it("cascades a deleted character's beats back to the pool and re-homes them without re-analysis", async () => {
    await writeBeat("char-A", beatFixture("Mari", "beat-aaa", 1));
    await addAlias("char-A", "Mari", "Mari");

    const { orphaned } = await orphanCharacterBeats("char-A");
    expect(orphaned).toBe(1);
    expect((await readBeatIndex("char-A"))?.entries ?? []).toHaveLength(0); // beats cleared
    expect((await readAliasTable())["char-A"]).toBeUndefined();             // alias record dropped
    expect((await listPendingSpeakers()).find((r) => r.normalized === "mari")?.count).toBe(1);

    // Re-home to a new character: the analyzer must NOT be called for an already-
    // analyzed beat (it would throw if it were), and the beat id is preserved.
    const throwAnalyze = (async () => { throw new Error("must not re-analyze a re-homed beat"); }) as unknown as typeof stubAnalyze;
    const { migrated } = await migratePendingBeats("mari", "char-B", { analyze: throwAnalyze });
    expect(migrated).toBe(1);
    const idx = await readBeatIndex("char-B");
    expect(idx?.entries).toHaveLength(1);
    expect(idx?.entries[0]?.id).toBe("beat-aaa");
  });

  it("purges ignored groups older than the TTL only", async () => {
    await addPending({ speaker: "Old", classification: classification("Old", "x", 1), sourceType: "story" });
    await ignoreSpeaker("old");
    // Nothing is older than 30 days yet.
    expect((await purgeExpiredIgnored()).purged).toBe(0);
    // Pretend it's 40 days later.
    const future = Date.now() + 40 * 24 * 60 * 60 * 1000;
    expect((await purgeExpiredIgnored(future)).purged).toBe(1);
  });
});
