// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// The two-stage apply gate (MarinaraExtender-mjp): domain-sensitive flags always
// hold (regardless of confidence); otherwise high auto-applies, the rest holds.

import { describe, it, expect } from "vitest";
import { applyGate, domainFlags } from "../apply-gate.js";

describe("domainFlags (trauma lexicon)", () => {
  it("flags trauma-adjacent text", () => {
    expect(domainFlags("The user's PTSD is connected to events in Samara")).toEqual(["trauma"]);
    expect(domainFlags("flashbacks from that specific engagement")).toEqual(["trauma"]);
    expect(domainFlags("history of sexual assault")).toEqual(["trauma"]);
  });
  it("does NOT flag ordinary (incl. pervasive military) facts — avoids flooding the hold lane", () => {
    expect(domainFlags("Served in Iraq, combat engineer, veteran")).toEqual([]); // war/combat/veteran deliberately excluded
    expect(domainFlags("Mari is the head of the computer science department")).toEqual([]);
    expect(domainFlags("watersports is a core kink")).toEqual([]); // consensual kink is not trauma
  });
  it("uses word boundaries (no substring false hits)", () => {
    expect(domainFlags("therapist-assisted breathing")).toEqual([]); // 'rape' not a substring hit inside 'therapist'? n/a; 'assault' absent
    expect(domainFlags("grape harvest")).toEqual([]); // 'rape' inside 'grape' must NOT match
  });
});

describe("applyGate (two-stage)", () => {
  it("auto-applies only non-sensitive, high-confidence verdicts", () => {
    expect(applyGate({ confidence: "high", text: "Mari founded Venturecon" })).toEqual({ lane: "auto", reasons: [] });
  });

  it("holds anything below high confidence", () => {
    expect(applyGate({ confidence: "medium", text: "ordinary fact" }).lane).toBe("hold");
    expect(applyGate({ confidence: "low", text: "ordinary fact" }).lane).toBe("hold");
    expect(applyGate({ text: "ordinary fact" }).lane).toBe("hold"); // unknown confidence
  });

  it("ALWAYS holds domain-sensitive verdicts — even at high confidence (the M13 rule)", () => {
    const r = applyGate({ confidence: "high", text: "merge two PTSD flashback facts" });
    expect(r.lane).toBe("hold");
    expect(r.reasons).toContain("domain:trauma");
  });

  it("records both reasons when domain-sensitive AND low confidence", () => {
    const r = applyGate({ confidence: "medium", text: "the user's trauma from the incident" });
    expect(r.lane).toBe("hold");
    expect(r.reasons).toEqual(expect.arrayContaining(["domain:trauma", "confidence:medium"]));
  });
});
