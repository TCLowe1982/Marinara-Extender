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

// THE HELD-REVIEW LANE MUST NOT HIDE ITSELF (385b).
//
// It used to disappear from the sidebar whenever it was empty, which cost two
// things. Its empty state — "Nothing held, re-rolls are retiring cleanly" — could
// only be seen by someone who already knew the lane existed, so nobody could learn
// what it was for. And settling the LAST held item dropped the count to zero, which
// reset state.mode and navigated the reader out of the lane at the exact moment
// they had finished clearing it.
//
// Marie hit this and reported her review queue as "invisible by construction".
//
// These assertions pin the two behaviours, not the styling. The count is still
// suppressed at zero — the original no-naked-"0" reasoning was never in dispute —
// so the ENTRY, not the number, is what must survive.
describe("the held-review lane does not vanish when it is empty (385b)", () => {
  it("never empties its own nav slot", async () => {
    // The old hide path. Its absence is silent: every route still returns 200 and
    // the lane simply stops existing for anyone who has nothing held.
    expect(await body("/memory")).not.toContain('nav.innerHTML = "";');
  });

  it("changes view in exactly one place, and that place is not data-driven", async () => {
    // Marie's question was whether "the view you are standing in navigates away
    // when its data changes" was a pattern rather than an incident. It was an
    // incident — and this pins it shut: state.mode is now assigned in goMode()
    // alone, which is only ever reached from a click handler. A second assignment
    // appearing anywhere is the regression, whether or not it is data-driven.
    const page = await body("/memory");
    expect(page.match(/state\.mode = /g) ?? []).toHaveLength(1);
    expect(page).toContain("function goMode(m)");
  });

  it("puts the view it just drew where the reader is looking", async () => {
    // The held lane sits at the BOTTOM of a long sidebar, so a reader is always
    // scrolled down when they reach it. Measured before this existed: the empty
    // state drew 599px above the viewport and the reader saw a blank panel.
    expect(await body("/memory")).toContain("window.scrollTo({ top: 0 })");
  });

  it("never navigates the reader out of the lane", async () => {
    // The force-navigate that ejected you on settling the last item.
    expect(await body("/memory")).not.toContain('if (state.mode === "held")');
  });

  it("prints the denominator beside the zero, in this lane's own words", async () => {
    // "0 held" alone cannot tell a checker that found nothing from one that never
    // ran. The population separates them — and the LABEL has to name the verb only
    // this lane performs. "scored" is true in the retrieval lane, the turn log and
    // the intake gate too, which is exactly how a denominator from one population
    // ends up printed beside a numerator from another.
    const page = await body("/memory");
    expect(page).toContain("discarded memories examined");
    expect(page).not.toContain("scored</div>");
    expect(page).toContain(".proof");
  });

  it("still renders the entry, dimmed, when the count is zero", async () => {
    // The replacement: a "quiet" modifier instead of removal. If this class is gone
    // the lane is either always loud (a naked 0) or hidden again.
    const page = await body("/memory");
    expect(page).toContain("Held for review");
    expect(page).toContain(" quiet");
    expect(page).toContain(".item.quiet .lbl");
  });
});
