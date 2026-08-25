// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// One-click update plumbing (uo4): version compare drives the panel's Update
// button — it must never offer a downgrade or same-version "update".

import { describe, it, expect } from "vitest";
import { compareVersions, currentVersion, buildVersion } from "../update.js";

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

  it("ignores build-metadata suffixes — a +sha build of a release is not an update", () => {
    expect(compareVersions("1.1.1+cba43f8", "1.1.1")).toBe(0);
    expect(compareVersions("1.1.2", "1.1.1+cba43f8")).toBe(1);
  });
});

describe("currentVersion", () => {
  it("reads a real dotted version from package.json", () => {
    expect(currentVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("buildVersion", () => {
  // Accepted build codes, all three real:
  //   +345da35        git sha, or the build stamp's sha
  //   +345da35-dirty  built from a MODIFIED tree — it is not the commit it names,
  //                   and saying so beats impersonating a clean checkout
  //   +c1a2b3c4       content hash, for a ZIP/release install with no .git
  const BUILD_CODE = /^\d+\.\d+\.\d+(\+(?:[0-9a-f]+(?:-dirty)?|c[0-9a-f]{8}))?$/;

  it("starts with the release version, optionally followed by a build code", () => {
    expect(buildVersion()).toMatch(BUILD_CODE);
    expect(buildVersion().startsWith(currentVersion())).toBe(true);
  });

  it("is STABLE across calls — the value must not depend on when it is asked", () => {
    // The defect this replaced: buildVersion() was memoized and reachable only
    // from request handlers, so the sha froze at whatever HEAD was when somebody
    // first happened to look. Ask early and a stale process looked honest; ask
    // only after a commit and it reported a HEAD it never ran. The observer
    // changed the answer, which is the one thing a build identifier must not do.
    const a = buildVersion();
    const b = buildVersion();
    expect(b).toBe(a);
  });

  it("builtAt is an ISO timestamp when a build stamp exists, else null", async () => {
    const { builtAt } = await import("../update.js");
    const t = builtAt();
    if (t !== null) {
      expect(t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(Number.isNaN(Date.parse(t))).toBe(false);
    }
    // null is correct and expected when running from src (tsx/vitest) with no
    // dist/build-info.json — absent means "unstamped", never "built at epoch".
  });
});

describe("embeddingsStatus kill switch", () => {
  it("reports disabled without any network probe when the switch is set", async () => {
    const prev = process.env.MARINARA_EXTENDER_EMBED_MODEL;
    process.env.MARINARA_EXTENDER_EMBED_MODEL = "0";
    try {
      const { embeddingsStatus, describeEmbeddingsStatus } = await import("../embeddings.js");
      const s = await embeddingsStatus();
      expect(s).toBe("disabled");
      expect(describeEmbeddingsStatus(s)).toContain("MARINARA_EXTENDER_EMBED_MODEL");
    } finally {
      if (prev === undefined) delete process.env.MARINARA_EXTENDER_EMBED_MODEL;
      else process.env.MARINARA_EXTENDER_EMBED_MODEL = prev;
    }
  });
});
