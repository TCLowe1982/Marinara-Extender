// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// .env precedence (MarinaraExtender-bkdz).
//
// This had no coverage, which is how it stayed wrong: the loader is four lines,
// the flag it feeds is read correctly, and the bug lived entirely in which of
// the two sources won. The consequence was not cosmetic — a demo sidecar
// launched with MARINARA_EXTENDER_POLLER=0 came up polling the LIVE engine and
// rewrote a real character's lorebook from a scratch store (1akw).
//
// The rule these pin: the shell wins, .env fills gaps, and a shadowed key is
// announced rather than silently discarded.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { loadDotEnv } from "../env.js";

let dir: string;
let envFile: string;
let logs: string[];
let warnings: string[];

const KEYS = ["ME_TEST_POLLER", "ME_TEST_MODEL", "ME_TEST_QUOTED", "ME_TEST_EMPTY", "ME_TEST_API_KEY"];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-env-"));
  envFile = join(dir, ".env");
  logs = [];
  warnings = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(" ")); });
  for (const k of KEYS) delete process.env[k];
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const k of KEYS) delete process.env[k];
  await rm(dir, { recursive: true, force: true });
});

describe("precedence", () => {
  it("fills in keys the environment did not set", async () => {
    await writeFile(envFile, "ME_TEST_POLLER=1\nME_TEST_MODEL=dolphin3:8b\n");
    await loadDotEnv(envFile);
    expect(process.env.ME_TEST_POLLER).toBe("1");
    expect(process.env.ME_TEST_MODEL).toBe("dolphin3:8b");
  });

  // The regression. .env used to overwrite this unconditionally.
  it("leaves a value the shell already set alone", async () => {
    process.env.ME_TEST_POLLER = "0";
    await writeFile(envFile, "ME_TEST_POLLER=1\n");
    await loadDotEnv(envFile);
    expect(process.env.ME_TEST_POLLER).toBe("0");
  });

  it("announces every shadowed key, and does not print its value", async () => {
    process.env.ME_TEST_POLLER = "0";
    process.env.ME_TEST_MODEL = "qwen";
    await writeFile(envFile, "ME_TEST_POLLER=1\nME_TEST_MODEL=dolphin3:8b\nME_TEST_QUOTED=x\n");
    await loadDotEnv(envFile);

    const line = logs.find((l) => l.includes("[ME:env]"));
    expect(line).toBeDefined();
    expect(line).toContain("ME_TEST_POLLER");
    expect(line).toContain("ME_TEST_MODEL");
    // Not shadowed — it was only filled in, so it has no business in the warning.
    expect(line).not.toContain("ME_TEST_QUOTED");
    // Half of these keys are secrets. Naming them is the point; printing is not.
    expect(line).not.toContain("dolphin3:8b");
  });

  it("says nothing when no key is shadowed", async () => {
    await writeFile(envFile, "ME_TEST_POLLER=1\n");
    await loadDotEnv(envFile);
    expect(logs.filter((l) => l.includes("[ME:env]"))).toEqual([]);
    expect(warnings).toEqual([]);
  });

  // A shadowed FLAG announces itself in the startup banner two lines later. A
  // shadowed CREDENTIAL is invisible until a request fails somewhere else, so it
  // gets a warning of its own. Found live: a stale key in the user environment,
  // for a different provider than the configured upstream.
  it("warns separately when the shadowed key is a credential", async () => {
    process.env.ME_TEST_API_KEY = "sk-stale-from-the-user-environment";
    await writeFile(envFile, "ME_TEST_API_KEY=the-real-one\n");
    await loadDotEnv(envFile);

    const warning = warnings.find((w) => w.includes("[ME:env]"));
    expect(warning).toContain("WARNING");
    expect(warning).toContain("ME_TEST_API_KEY");
    // Naming it is the point; printing either value is not.
    expect(warning).not.toContain("sk-stale");
    expect(warning).not.toContain("the-real-one");
  });

  it("does not warn about a shadowed flag", async () => {
    process.env.ME_TEST_POLLER = "0";
    await writeFile(envFile, "ME_TEST_POLLER=1\n");
    await loadDotEnv(envFile);
    expect(warnings).toEqual([]);
    expect(logs.some((l) => l.includes("ME_TEST_POLLER"))).toBe(true);
  });

  // An empty shell value is still a value someone set — "" is how you turn a
  // thing off. Treating it as unset would hand the decision back to .env.
  it("treats an empty environment value as set, not as absent", async () => {
    process.env.ME_TEST_POLLER = "";
    await writeFile(envFile, "ME_TEST_POLLER=1\n");
    await loadDotEnv(envFile);
    expect(process.env.ME_TEST_POLLER).toBe("");
  });
});

describe("parsing", () => {
  it("ignores comments, blanks, valueless keys and lines with no =", async () => {
    await writeFile(envFile, [
      "# a comment",
      "",
      "   ",
      "NOT_AN_ASSIGNMENT",
      "=leading_equals_has_no_key",
      "ME_TEST_EMPTY=",
      "ME_TEST_POLLER=1",
    ].join("\n"));
    await loadDotEnv(envFile);
    expect(process.env.ME_TEST_POLLER).toBe("1");
    expect(process.env.ME_TEST_EMPTY).toBeUndefined();
  });

  it("strips surrounding quotes and whitespace", async () => {
    await writeFile(envFile, '  ME_TEST_QUOTED = "sk-abc123"  \n');
    await loadDotEnv(envFile);
    expect(process.env.ME_TEST_QUOTED).toBe("sk-abc123");
  });

  it("keeps '=' inside a value", async () => {
    await writeFile(envFile, "ME_TEST_MODEL=a=b=c\n");
    await loadDotEnv(envFile);
    expect(process.env.ME_TEST_MODEL).toBe("a=b=c");
  });

  it("is a no-op when there is no .env at all", async () => {
    await expect(loadDotEnv(join(dir, "nope.env"))).resolves.toBeUndefined();
  });
});
