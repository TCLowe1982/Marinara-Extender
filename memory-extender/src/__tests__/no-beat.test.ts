// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// The decline path (vikj, Mari's ruling 2026-08-05).
//
// Before this, the prompt instructed the model "the chunk has no beat — say so
// rather than reaching for a remembered phrase" and the schema gave it nowhere to
// say so. The only way to comply was to emit malformed JSON, which made compliance
// indistinguishable from failure. An instruction that cannot be complied with is an
// advisory guard, and advisory guards do no work — the class ruled against on
// 2026-08-04.
//
// SHAPE: {"no_beat": true}. `reason` is TOLERATED, NEVER REQUIRED — a mandatory
// freeform justification is a fresh boilerplate surface bolted onto every decline,
// written by a model that reaches for the nearest phrasing. Telemetry lives in code.

import { describe, it, expect } from "vitest";
import { isDeclineResponse } from "../sentiment/analyzer.js";

describe("isDeclineResponse", () => {
  it("recognises the ruled shape", () => {
    expect(isDeclineResponse('{"no_beat": true}')).toBe(true);
  });

  it("tolerates a reason without requiring one", () => {
    expect(isDeclineResponse('{"no_beat": true, "reason": "chunk is a greeting"}')).toBe(true);
    expect(isDeclineResponse('{"no_beat": true}')).toBe(true);
  });

  it("accepts a decline inside a markdown fence, like every other reply", () => {
    expect(isDeclineResponse('```json\n{"no_beat": true}\n```')).toBe(true);
  });

  it("does NOT fire on a normal analysis", () => {
    const ok = '{"motivation":"admits she deleted the Hargrove draft","relational_dynamics":"r","outcome":"o"}';
    expect(isDeclineResponse(ok)).toBe(false);
  });

  it("does NOT fire on no_beat:false — declining is opt-in, not a default", () => {
    expect(isDeclineResponse('{"no_beat": false, "motivation":"m","relational_dynamics":"r","outcome":"o"}')).toBe(false);
  });

  it("requires the boolean, not a truthy string — a model saying \"true\" is not a contract", () => {
    // Loose coercion here would let any stray field kill a real beat.
    expect(isDeclineResponse('{"no_beat": "true"}')).toBe(false);
    expect(isDeclineResponse('{"no_beat": 1}')).toBe(false);
  });

  it("separates a decline from unparseable output — the distinction a ship test rests on", () => {
    // "JSON validity must not drop a point" is a pre-registered ship condition for
    // the rewrite. If declines counted as invalid JSON, a prompt would be penalised
    // for obeying its own instruction.
    expect(isDeclineResponse("I'm sorry, I can't analyze this.")).toBe(false);
    expect(isDeclineResponse('{"motivation": ')).toBe(false);
    expect(isDeclineResponse("")).toBe(false);
  });
});
