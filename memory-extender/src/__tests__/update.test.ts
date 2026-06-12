// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// One-click update plumbing (uo4): version compare drives the panel's Update
// button — it must never offer a downgrade or same-version "update".

import { describe, it, expect } from "vitest";
import { compareVersions, currentVersion } from "../update.js";

describe("compareVersions", () => {
  it("orders plain semver correctly", () => {
    expect(compareVersions("1.1.0", "1.0.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.1.0")).toBe(-1);
    expect(compareVersions("1.1.0", "1.1.0")).toBe(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.0.10", "1.0.9")).toBe(1);
  });

  it("tolerates v-prefixes and missing segments", () => {
    expect(compareVersions("v1.1.0", "1.1")).toBe(0);
    expect(compareVersions("v1.2", "v1.1.9")).toBe(1);
  });
});

describe("currentVersion", () => {
  it("reads a real dotted version from package.json", () => {
    expect(currentVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
