// Unit tests for Stage 1: Emotional Classifier
//
// Tests use real config/emotional_keywords.yaml and config/sentiment-config.yaml
// values. Exact scores are calculated from the config:
//   match_score_per_hit: 0.55
//   emotion_weights:  fear=0.80, shame=0.85, anger=0.75, joy=0.50, dysregulation=0.90
//   compound_boost:   two_matches=1.30, three_plus=1.50
//   short_message:    word_count_threshold=10, multiplier=1.20
//   salience_threshold: 0.40

import { describe, it, expect } from "vitest";
import { classifyChunk, classifyChunks } from "../sentiment/classifier.js";
import type { Chunk } from "../sentiment/types.js";

function chunk(text: string, speaker = "Lara"): Chunk {
  return { speaker, text, turnStart: 0, turnEnd: 0 };
}

// ── Neutral text ───────────────────────────────────────────────────────────────

describe("neutral text", () => {
  it("returns no scores and fails threshold", () => {
    // Deliberately avoids words that appear in any keyword list.
    // ("fine", "whatever", etc. are deflection keywords — avoid them here)
    const result = classifyChunk(chunk("The clouds drifted slowly across the afternoon sky."));
    expect(result.primaryEmotion).toBeNull();
    expect(result.salience).toBe(0);
    expect(result.passesThreshold).toBe(false);
    expect(Object.keys(result.scores)).toHaveLength(0);
    expect(result.structuralMatches).toHaveLength(0);
  });
});

// ── Standard keyword scoring ───────────────────────────────────────────────────

describe("standard keyword scoring", () => {
  it("detects fear from a single keyword", () => {
    // "afraid" → 1 fear match
    // fear score = 1 * 0.55 * 0.80 = 0.44
    // word count: "I'm afraid" = 2 words → short message boost: 0.44 * 1.20 = 0.528
    const result = classifyChunk(chunk("I'm afraid"));
    expect(result.primaryEmotion).toBe("fear");
    expect(result.scores.fear).toBeCloseTo(0.528, 2);
    expect(result.passesThreshold).toBe(true);
  });

  it("detects anger with compound boost when two matches", () => {
    // "furious" + "betrayed" → 2 anger matches
    // anger score before boost = min(1, 2 * 0.55 * 0.75) = 0.825
    // totalMatches = 2 → compound boost: 0.825 * 1.30 = 1.0 (capped)
    // word count: 5 words → short message: 1.0 * 1.20 = 1.0 (capped)
    const result = classifyChunk(chunk("I'm furious — I feel so betrayed"));
    expect(result.primaryEmotion).toBe("anger");
    expect(result.scores.anger).toBe(1.0);
    expect(result.passesThreshold).toBe(true);
  });

  it("detects joy from keywords", () => {
    // "happy" + "grateful" → 2 joy matches
    // joy score = min(1, 2 * 0.55 * 0.50) = 0.55
    // totalMatches = 2 → compound boost: 0.55 * 1.30 = 0.715
    // word count: "I'm happy and grateful" = 5 words → short message: 0.715 * 1.20 = 0.858
    const result = classifyChunk(chunk("I'm happy and so grateful"));
    expect(result.primaryEmotion).toBe("joy");
    expect(result.scores.joy).toBeCloseTo(0.858, 2);
    expect(result.passesThreshold).toBe(true);
  });

  it("highest-scoring emotion wins as primaryEmotion", () => {
    // "ashamed" → 1 shame match (weight 0.85)
    // "afraid" → 1 fear match (weight 0.80)
    // Both single matches; before boosts: shame=0.4675, fear=0.44
    // totalMatches=2 → compound boost (1.30): shame=0.6077, fear=0.572
    // word count: 8 words → short: shame=0.729, fear=0.686
    const result = classifyChunk(chunk("I feel so ashamed and so afraid of you"));
    expect(result.primaryEmotion).toBe("shame");
    expect(result.scores.shame!).toBeGreaterThan(result.scores.fear!);
    expect(result.passesThreshold).toBe(true);
  });

  it("score is capped at 1.0 regardless of match count", () => {
    const result = classifyChunk(
      chunk("afraid terrified scared horrified dread panic nightmare anxious worried nervous"),
    );
    expect(result.scores.fear).toBe(1.0);
  });
});

// ── Short-message boost ────────────────────────────────────────────────────────

describe("short-message boost", () => {
  it("applies 1.20x multiplier to messages of ≤10 words", () => {
    // "I'm scared" = 2 words → short boost: 0.44 * 1.20 = 0.528
    const short = classifyChunk(chunk("I'm scared"));
    // 12 words, 1 fear match, no compound, no short boost → 0.44
    const long = classifyChunk(chunk("I am feeling very scared about everything that has been happening lately"));
    expect(short.scores.fear!).toBeGreaterThan(long.scores.fear!);
    expect(short.scores.fear).toBeCloseTo(0.528, 2);
    expect(long.scores.fear).toBeCloseTo(0.44, 2);
  });

  it("does not apply boost when message is over 10 words", () => {
    const result = classifyChunk(
      chunk("I am feeling very scared about everything that has been happening lately"),
    );
    // 12 words — no short boost. 1 fear match, no compound → 0.44
    expect(result.scores.fear).toBeCloseTo(0.44, 2);
  });
});

// ── Compound amplification ────────────────────────────────────────────────────

describe("compound amplification", () => {
  it("applies 1.30x at exactly 2 total matches across all emotions", () => {
    // "scared" (fear) + "worried" (fear) = 2 total matches
    // fear before boost = min(1, 2 * 0.55 * 0.80) = 0.88
    // compound (two_matches): 0.88 * 1.30 = 1.0 (capped)
    // 5 words → short: 1.0 (still capped)
    const result = classifyChunk(chunk("I feel scared and worried"));
    expect(result.scores.fear).toBe(1.0);
  });

  it("applies 1.50x at 3+ total matches", () => {
    // 3 fear words: "afraid", "dread", "anxious"
    // fear before boost = min(1, 3 * 0.55 * 0.80) = 1.0 (already capped before boost)
    // Use joy (weight 0.50) for a non-capping test:
    // "happy", "smile", "grateful" → 3 joy matches
    // joy before boost = min(1, 3 * 0.55 * 0.50) = 0.825
    // three_plus boost: 0.825 * 1.50 = 1.0 (just capped)
    // Use 2 joy + 1 fear to verify three_plus fires and joy/fear both get 1.50x
    // "happy grateful" = 2 joy; "afraid" = 1 fear → totalMatches=3
    // joy = min(1, 2 * 0.55 * 0.50) = 0.55 → * 1.50 = 0.825
    // fear = min(1, 1 * 0.55 * 0.80) = 0.44 → * 1.50 = 0.66
    // Both words: "happy grateful afraid" = 3 words → short * 1.20: joy=0.99, fear=0.792
    const result = classifyChunk(chunk("happy grateful afraid"));
    expect(result.scores.joy).toBeCloseTo(0.99, 2);
    expect(result.scores.fear).toBeCloseTo(0.792, 2);
  });
});

// ── Dysregulation compound rule ────────────────────────────────────────────────

describe("dysregulation compound rule", () => {
  it("deflection alone scores weakly and fails threshold", () => {
    // "nevermind" → 1 deflection match
    // dysregScore = 0 + 1 * 0.15 = 0.15
    // totalMatches=1, no compound; 1 word → short: 0.15 * 1.20 = 0.18
    // 0.18 < 0.40 → fails threshold
    const result = classifyChunk(chunk("nevermind"));
    expect(result.scores.dysregulation).toBeCloseTo(0.18, 2);
    expect(result.passesThreshold).toBe(false);
  });

  it("deflection + attachment triggers combined boost and passes threshold", () => {
    // "i'm fine" → deflection (2 matches: "fine" and "i'm fine")
    // "don't leave me" → attachment (2 matches: "don't leave me" and "leave")
    // dysregScore = 0 + 2*0.15 = 0.30 (deflection)
    // combined boost: 0.30 * 1.50 = 0.45
    // totalMatches = 0 (standard) + 2 (deflection) + 2 (attachment) = 4 → three_plus: 0.45*1.50 = 0.675
    // word count: 7 words → short: 0.675 * 1.20 = 0.81
    const result = classifyChunk(chunk("I'm fine, just don't leave me"));
    expect(result.primaryEmotion).toBe("dysregulation");
    expect(result.scores.dysregulation).toBeCloseTo(0.81, 2);
    expect(result.passesThreshold).toBe(true);
  });

  it("direct dysregulation keywords score normally at weight 0.90", () => {
    // "spiraling" → 1 direct match
    // dysregScore = 1 * 0.55 * 0.90 = 0.495
    // totalMatches=1, no compound; word count: "I'm spiraling" = 2 words → short: 0.495 * 1.20 = 0.594
    const result = classifyChunk(chunk("I'm spiraling"));
    expect(result.primaryEmotion).toBe("dysregulation");
    expect(result.scores.dysregulation).toBeCloseTo(0.594, 2);
    expect(result.passesThreshold).toBe(true);
  });
});

// ── Structural patterns ────────────────────────────────────────────────────────

describe("structural patterns", () => {
  it("dissociation_grounding: quoted single lowercase word + period", () => {
    // Pattern: "[a-z]{1,8}\." (case-sensitive, no i flag)
    // "here." matches; no keyword hits on this text
    const result = classifyChunk(chunk('She stared blankly at the wall. "here."'));
    const sm = result.structuralMatches.find((m) => m.patternId === "dissociation_grounding");
    expect(sm).toBeDefined();
    expect(sm?.emotion).toBe("dysregulation");
    expect(sm?.subpattern).toBe("dissociation");
    expect(result.scores.dysregulation).toBe(0.75);
  });

  it("dissociation_grounding: does NOT fire on uppercase quoted word", () => {
    // "HERE." should not match [a-z]{1,8} (case-sensitive)
    const result = classifyChunk(chunk('She looked up. "HERE."'));
    const sm = result.structuralMatches.find((m) => m.patternId === "dissociation_grounding");
    expect(sm).toBeUndefined();
  });

  it("all_caps_burst: fires on ALL CAPS word of 4+ chars", () => {
    // Pattern: \b[A-Z]{4,}\b (case-sensitive — this is the bug we fixed)
    const result = classifyChunk(chunk("STOP doing that right now"));
    const sm = result.structuralMatches.find((m) => m.patternId === "all_caps_burst");
    expect(sm).toBeDefined();
    expect(sm?.emotion).toBe("anger");
  });

  it("all_caps_burst: does NOT fire on normal mixed-case words", () => {
    // With the i-flag bug, "stop" would match. Fixed: it should not.
    const result = classifyChunk(chunk("stop doing that right now"));
    const sm = result.structuralMatches.find((m) => m.patternId === "all_caps_burst");
    expect(sm).toBeUndefined();
  });

  it("ellipsis_shutdown: fires on three or more dots", () => {
    const result = classifyChunk(chunk("I don't know..."));
    const sm = result.structuralMatches.find((m) => m.patternId === "ellipsis_shutdown");
    expect(sm).toBeDefined();
    expect(sm?.emotion).toBe("dysregulation");
    expect(sm?.subpattern).toBe("shutdown");
  });

  it("self_erasure: fires case-insensitively", () => {
    // Pattern has flags: "i" — both lowercase and capital I should match
    const lower = classifyChunk(chunk("i don't deserve to be here"));
    const upper = classifyChunk(chunk("I can't exist like this"));
    const smLower = lower.structuralMatches.find((m) => m.patternId === "self_erasure");
    const smUpper = upper.structuralMatches.find((m) => m.patternId === "self_erasure");
    expect(smLower).toBeDefined();
    expect(smUpper).toBeDefined();
    expect(smLower?.emotion).toBe("shame");
    expect(smUpper?.emotion).toBe("shame");
  });

  it("structural score merges as max with keyword-boosted score", () => {
    // "i can't exist like this" has no shame keywords but triggers self_erasure.
    // keyword scores: {} (empty) → no compound, no short boost (scores empty at that point)
    // structural fires: shame = max(0, 0.80) = 0.80
    const result = classifyChunk(chunk("i can't exist like this"));
    expect(result.scores.shame).toBe(0.80);
    expect(result.structuralMatches.some((m) => m.patternId === "self_erasure")).toBe(true);
  });
});

// ── Threshold ─────────────────────────────────────────────────────────────────

describe("threshold (salience_threshold: 0.40)", () => {
  it("passesThreshold=true when salience >= 0.40", () => {
    // "afraid" → 0.44 base, 1.20 short → 0.528 → passes
    const result = classifyChunk(chunk("I'm afraid"));
    expect(result.passesThreshold).toBe(true);
  });

  it("passesThreshold=false when salience < 0.40", () => {
    // "nevermind" → dysregulation 0.18 → fails
    const result = classifyChunk(chunk("nevermind"));
    expect(result.passesThreshold).toBe(false);
  });
});

// ── Batch helper ──────────────────────────────────────────────────────────────

describe("classifyChunks", () => {
  it("processes all chunks and returns one result per chunk", () => {
    const chunks: Chunk[] = [
      chunk("I'm so afraid", "Lara"),
      chunk("The clouds drifted slowly across the afternoon sky", "Marcus"),
      chunk("I'm furious at you", "Lara"),
    ];
    const results = classifyChunks(chunks);
    expect(results).toHaveLength(3);
    expect(results[0]?.primaryEmotion).toBe("fear");
    expect(results[1]?.primaryEmotion).toBeNull();
    expect(results[2]?.primaryEmotion).toBe("anger");
  });
});
