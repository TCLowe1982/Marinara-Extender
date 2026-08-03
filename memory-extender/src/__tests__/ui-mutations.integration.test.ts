// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// The memory browser's mutation contract (MarinaraExtender-b1nu).
//
// The UI is a served string with no DOM harness, so asserting its markup would
// only pin the markup. What is actually at risk is the CONTRACT the page
// depends on: that a browser-shaped request (Origin present, token attached)
// can edit, soft-delete, list and restore an entry, and that soft-delete really
// is soft. Every case below sends the headers a real browser sends from the
// page's own origin — the same-origin case is the one that is easy to assume
// exempt from CSRF and is not.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { registerApiRoutes } from "../api.js";
import { registerUiRoutes } from "../ui.js";
import { csrfToken, CSRF_HEADER } from "../csrf.js";

let app: FastifyInstance;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-ui-"));
  process.env.MARINARA_EXTENDER_DATA = dir;
  app = Fastify();
  registerApiRoutes(app);
  registerUiRoutes(app);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true });
});

// The page is served BY the sidecar, so this is its own origin — not a
// cross-origin caller. It still has to carry the token.
const PAGE_ORIGIN = "http://127.0.0.1:3001";
const browser = { origin: PAGE_ORIGIN, [CSRF_HEADER]: csrfToken() };

const SCOPE = { scope: "character", scopeId: "char-ui" };
const qs = `scope=${SCOPE.scope}&scopeId=${SCOPE.scopeId}`;

async function seed(summary = "User's sister is called Lin.", lane = "user_topics") {
  const r = await app.inject({
    method: "POST",
    url: "/api/entries",
    headers: browser,
    payload: { ...SCOPE, lane, summary, content: "Established over dinner, corrected once." },
  });
  expect(r.statusCode).toBe(201);
  return r.json().entry.id as string;
}

const list = async () => (await app.inject({ url: `/api/entries?${qs}&status=all` })).json();
const deleted = async () => (await app.inject({ url: `/api/deleted?${qs}` })).json().deleted;

describe("the page itself", () => {
  it("serves at both / and /memory", async () => {
    for (const url of ["/", "/memory"]) {
      const r = await app.inject({ url });
      expect(r.statusCode).toBe(200);
      expect(r.headers["content-type"]).toContain("text/html");
      expect(r.body).toContain("Marinara Extender");
    }
  });

  it("hands out a CSRF token the page can read", async () => {
    const r = await app.inject({ url: "/api/csrf-token", headers: { origin: PAGE_ORIGIN } });
    expect(r.statusCode).toBe(200);
    expect(r.json().token).toBe(csrfToken());
  });
});

describe("edit", () => {
  it("updates summary, body and status, and re-costs the entry", async () => {
    const id = await seed();
    const before = (await list())[0];

    const r = await app.inject({
      method: "PATCH",
      url: `/api/entries/${id}`,
      headers: browser,
      payload: { ...SCOPE, summary: "User's sister is called Mei.", content: "Corrected — Lin was wrong.", status: "deferred" },
    });

    expect(r.statusCode).toBe(200);
    const entry = r.json().entry;
    expect(entry.summary).toBe("User's sister is called Mei.");
    expect(entry.status).toBe("deferred");
    // The card patches itself in place from this response, so the response must
    // carry the recomputed token cost rather than leaving the old one on screen.
    expect(entry.tokens).not.toBe(before.tokens);

    const row = (await list()).find((e: { id: string }) => e.id === id);
    expect(row.summary).toBe("User's sister is called Mei.");
    expect(row.status).toBe("deferred");
    expect(row.tokens).toBe(entry.tokens);
  });

  it("rejects a status outside the closed set", async () => {
    const id = await seed();
    const r = await app.inject({
      method: "PATCH",
      url: `/api/entries/${id}`,
      headers: browser,
      payload: { ...SCOPE, status: "archived" },
    });
    expect(r.statusCode).toBe(400);
  });

  it("is blocked without the token, even from the page's own origin", async () => {
    const id = await seed();
    const r = await app.inject({
      method: "PATCH",
      url: `/api/entries/${id}`,
      headers: { origin: PAGE_ORIGIN },
      payload: { ...SCOPE, summary: "not happening" },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe("delete is soft", () => {
  it("moves the entry out of the list and into recently-deleted, intact", async () => {
    const id = await seed();

    const r = await app.inject({ method: "DELETE", url: `/api/entries/${id}?${qs}`, headers: browser });
    expect(r.statusCode).toBe(200);
    // The UI promises this in so many words at the point of action.
    expect(r.json().recoverable).toBe(true);

    expect((await list()).some((e: { id: string }) => e.id === id)).toBe(false);
    const gone = await deleted();
    expect(gone).toHaveLength(1);
    expect(gone[0].id).toBe(id);
    expect(gone[0].summary).toBe("User's sister is called Lin.");
  });

  it("restores it to the live list with its body intact", async () => {
    const id = await seed();
    await app.inject({ method: "DELETE", url: `/api/entries/${id}?${qs}`, headers: browser });

    const r = await app.inject({ method: "POST", url: `/api/entries/${id}/restore?${qs}`, headers: browser });
    expect(r.statusCode).toBe(200);

    expect(await deleted()).toHaveLength(0);
    expect((await list()).some((e: { id: string }) => e.id === id)).toBe(true);

    const full = await app.inject({ url: `/api/entries/${id}?${qs}` });
    expect(full.json().content).toContain("Established over dinner");
  });

  it("only surfaces the fields the deleted view actually renders", async () => {
    // The view showed "undefined tok" the first time because it assumed this
    // list carried tokens. It does not, and this pins the shape.
    const id = await seed();
    await app.inject({ method: "DELETE", url: `/api/entries/${id}?${qs}`, headers: browser });
    const [row] = await deleted();
    expect(Object.keys(row).sort()).toEqual(["deletedAt", "id", "lane", "summary"]);
  });
});

describe("purge is the irreversible one", () => {
  it("destroys an already-deleted entry for good", async () => {
    const id = await seed();
    await app.inject({ method: "DELETE", url: `/api/entries/${id}?${qs}`, headers: browser });

    const r = await app.inject({ method: "DELETE", url: `/api/entries/${id}?${qs}&purge=true`, headers: browser });
    expect(r.statusCode).toBe(200);
    expect(r.json().purged).toBe(true);

    expect(await deleted()).toHaveLength(0);
    expect((await list()).some((e: { id: string }) => e.id === id)).toBe(false);
    // Unrecoverable, which is exactly why the UI keeps it two decisions deep.
    const restore = await app.inject({ method: "POST", url: `/api/entries/${id}/restore?${qs}`, headers: browser });
    expect(restore.statusCode).toBe(404);
  });

  it("refuses to purge a LIVE entry — cold-only, so one click can never destroy", async () => {
    const id = await seed();
    const r = await app.inject({ method: "DELETE", url: `/api/entries/${id}?${qs}&purge=true`, headers: browser });
    expect(r.statusCode).toBe(404);
    expect((await list()).some((e: { id: string }) => e.id === id)).toBe(true);
  });
});
