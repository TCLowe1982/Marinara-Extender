// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// HOT INDEX TRIPWIRE — TC's 10,000-entry cap, per CHARACTER.
//
// The cap earns its place as a DETECTOR, not as a limit: an ageing process that
// silently stops leaves the hot index growing with no other signal, which is
// exactly what 7mb6 turned out to be. These pin the two properties that make it
// a usable alarm — it fires on characters, and it never fires on chats.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "me-idx-"));
  process.env.MARINARA_EXTENDER_DATA = dir;
});
afterEach(() => {
  delete process.env.MARINARA_EXTENDER_DATA;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows */ }
});

function writeIndex(kind: "characters" | "chats", id: string, hot: number, cold = 0) {
  const d = join(dir, kind, id);
  mkdirSync(d, { recursive: true });
  const rows = (n: number, p: string) =>
    "entries:\n" + Array.from({ length: n }, (_, i) => `  - id: ${p}${i}\n    summary: s\n`).join("");
  writeFileSync(join(d, "index.yaml"), rows(hot, "h"), "utf8");
  if (cold) writeFileSync(join(d, "index.cold.yaml"), rows(cold, "c"), "utf8");
}

async function health() {
  const m = await import("../index-health.js");
  m._resetIndexHealthCache();
  return m.indexHealth();
}

describe("the cap is per character", () => {
  it("a character over the cap trips it", async () => {
    process.env.MARINARA_EXTENDER_HOT_WARN = "5";
    writeIndex("characters", "mari", 6);
    const h = await health();
    expect(h.overCap.map((s) => s.id)).toEqual(["mari"]);
    expect(h.warnings).toHaveLength(1);
    delete process.env.MARINARA_EXTENDER_HOT_WARN;
  });

  it("a CHAT the same size never trips — it is bounded by one conversation", async () => {
    process.env.MARINARA_EXTENDER_HOT_WARN = "5";
    writeIndex("chats", "long-scene", 400);
    const h = await health();
    expect(h.overCap).toEqual([]);
    expect(h.warnings).toEqual([]);
    // Still counted, because the total is useful context.
    expect(h.hot).toBe(400);
    delete process.env.MARINARA_EXTENDER_HOT_WARN;
  });

  it("a character under the cap is silent", async () => {
    process.env.MARINARA_EXTENDER_HOT_WARN = "100";
    writeIndex("characters", "mari", 99);
    const h = await health();
    expect(h.overCap).toEqual([]);
    expect(h.warnings).toEqual([]);
    delete process.env.MARINARA_EXTENDER_HOT_WARN;
  });
});

describe("the cold share is the sharper signal", () => {
  it("reports what fraction has aged out", async () => {
    writeIndex("characters", "mari", 900, 100);
    const h = await health();
    expect(h.hot).toBe(900);
    expect(h.cold).toBe(100);
    expect(h.coldShare).toBeCloseTo(0.1, 5);
  });

  it("an index that has never aged reads as ~0 archived", async () => {
    // The live shape when this was written: 17,160 hot against 729 cold. No
    // character scope was over 10,000, so the cap alone would NOT have caught it.
    writeIndex("characters", "mari", 8862, 431);
    writeIndex("characters", "priya", 3051, 134);
    const h = await health();
    expect(h.overCap).toEqual([]);          // the cap stays quiet...
    expect(h.coldShare).toBeLessThan(0.05); // ...while the ratio shows the problem
  });

  it("largest names the biggest CHARACTER, not the biggest scope overall", async () => {
    writeIndex("chats", "huge-chat", 9999);
    writeIndex("characters", "mari", 120);
    const h = await health();
    expect(h.largest?.id).toBe("mari");
    expect(h.largest?.kind).toBe("character");
  });
});

describe("it never blocks on bad data", () => {
  it("an unreadable index counts as 0 rather than throwing", async () => {
    const d = join(dir, "characters", "broken");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "index.yaml"), "entries: [ this is not: valid: yaml", "utf8");
    const h = await health();
    expect(h.hot).toBe(0);
  });
});
