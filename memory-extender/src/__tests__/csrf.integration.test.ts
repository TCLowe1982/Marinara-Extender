// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// CSRF guard (MarinaraExtender-cb4) — drives the real routes via app.inject.
// The rule: mutating /api/* requests carrying a browser Origin must pass the
// CORS allowlist AND present the per-process token; Origin-less requests are
// non-browser tooling and pass untouched.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { registerApiRoutes } from "../api.js";
import { csrfToken, CSRF_HEADER } from "../csrf.js";

let app: FastifyInstance;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-csrf-"));
  process.env.MARINARA_EXTENDER_DATA = dir;
  app = Fastify();
  registerApiRoutes(app);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true });
});

const MARINARA_ORIGIN = "http://127.0.0.1:7860";

describe("CSRF guard", () => {
  it("Origin-less mutating requests pass (non-browser tooling)", async () => {
    const r = await app.inject({ method: "POST", url: "/api/cleanup" });
    expect(r.statusCode).not.toBe(403);
  });

  it("a loopback-origin POST without the token is blocked", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/cleanup",
      headers: { origin: MARINARA_ORIGIN },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/CSRF/);
  });

  it("a loopback-origin POST with the token proceeds", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/cleanup",
      headers: { origin: MARINARA_ORIGIN, [CSRF_HEADER]: csrfToken() },
    });
    expect(r.statusCode).not.toBe(403);
  });

  it("a disallowed origin is blocked even WITH the token", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/cleanup",
      headers: { origin: "https://evil.example", [CSRF_HEADER]: csrfToken() },
    });
    expect(r.statusCode).toBe(403);
  });

  it("a stale/wrong token is blocked", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/cleanup",
      headers: { origin: MARINARA_ORIGIN, [CSRF_HEADER]: "not-the-token" },
    });
    expect(r.statusCode).toBe(403);
  });

  it("GETs never require the token, and the token endpoint serves it", async () => {
    const health = await app.inject({ method: "GET", url: "/api/entries?scope=character&scopeId=x", headers: { origin: MARINARA_ORIGIN } });
    expect(health.statusCode).not.toBe(403);
    const tok = await app.inject({ method: "GET", url: "/api/csrf-token", headers: { origin: MARINARA_ORIGIN } });
    expect(tok.statusCode).toBe(200);
    expect(tok.json().token).toBe(csrfToken());
  });
});
