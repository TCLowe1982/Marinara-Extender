// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// THE MEMORY BROWSER MUST BE REACHABLE WITHOUT KNOWING ITS URL (c2wd).
//
// The browser shipped 2026-08-04 and was invisible for six days. It answered on /
// and /memory the whole time and NOTHING linked there — not the setup page, not the
// startup banner, not the launcher console. The only href="/memory" in the repo was
// the page's own header linking to itself, so the sole access path was typing the
// address. TC: "I have no idea how to get that page pulled up."
//
// A link is trivially easy to drop during an unrelated refactor of a 700-line HTML
// template literal, and its absence is SILENT — every route still returns 200 and
// every other test still passes. That is exactly the failure that already happened,
// so the link itself is the thing under test.
//
// This pins REACHABILITY, not markup: that a user who lands on either page can get
// to the other one by clicking. It says nothing about how the link looks.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { registerUiRoutes } from "../ui.js";
import { registerSetupRoutes } from "../setup.js";

let app: FastifyInstance;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-access-"));
  process.env.MARINARA_EXTENDER_DATA = dir;
  app = Fastify();
  registerUiRoutes(app);
  registerSetupRoutes(app, { port: 3001 });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true });
});

const body = async (url: string) => {
  const r = await app.inject({ url });
  expect(r.statusCode).toBe(200);
  return r.body;
};

describe("the memory browser has a way in", () => {
  it("is linked from the setup page", async () => {
    // /setup is where the launcher sends a first-run user, so it is the one page a
    // newcomer is guaranteed to see. If the door is anywhere, it is here.
    expect(await body("/setup")).toContain('href="/memory"');
  });

  it("links back to setup, so the round trip closes", async () => {
    expect(await body("/memory")).toContain('href="/setup"');
  });

  it("keeps /prompts reachable from the browser too", async () => {
    // /prompts already linked TO /memory; without the return leg it was a one-way
    // trip out of the only page anyone can find.
    expect(await body("/memory")).toContain('href="/prompts"');
  });
});
