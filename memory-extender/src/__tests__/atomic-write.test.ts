// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// atomicWriteFile — the v1.1 durability floor (MarinaraExtender-1nc).
// Covers the contract the call sites rely on: content lands intact, parent
// dirs are created, existing files are replaced whole, and no .tmp-* litter
// survives a successful write. fsync-on-power-loss itself isn't unit-testable,
// but the writable-handle requirement it depends on is exercised implicitly:
// if the handle were read-only, the write itself would throw.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { atomicWriteFile } from "../storage.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-atomic-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("atomicWriteFile", () => {
  it("writes content and creates missing parent directories", async () => {
    const target = join(dir, "deep", "nested", "index.yaml");
    await atomicWriteFile(target, "entries: []\n");
    expect(await readFile(target, "utf8")).toBe("entries: []\n");
  });

  it("replaces an existing file with the complete new content", async () => {
    const target = join(dir, "state.yaml");
    await atomicWriteFile(target, "version: 1\npayload: aaaaaaaaaaaaaaaaaaaa\n");
    await atomicWriteFile(target, "version: 2\n");
    expect(await readFile(target, "utf8")).toBe("version: 2\n");
  });

  it("leaves no temp files behind after successful writes", async () => {
    const target = join(dir, "clean.yaml");
    for (let i = 0; i < 5; i++) await atomicWriteFile(target, `n: ${i}\n`);
    const leftovers = (await readdir(dir)).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
    expect(await readFile(target, "utf8")).toBe("n: 4\n");
  });

  it("survives concurrent writes to the same path — file is always one complete version", async () => {
    const target = join(dir, "contended.yaml");
    const versions = Array.from({ length: 20 }, (_, i) => `v: ${i}\nbody: ${"x".repeat(500)}\n`);
    await Promise.all(versions.map((content) => atomicWriteFile(target, content)));
    const final = await readFile(target, "utf8");
    expect(versions).toContain(final); // one writer's complete output, never an interleave
    const leftovers = (await readdir(dir)).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});
