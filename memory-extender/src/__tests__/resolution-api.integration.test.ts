// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// End-to-end integration of the speaker-resolution HTTP surface.
//
// Drives the REAL Fastify routes (registerApiRoutes + app.inject) against a temp
// data dir — exercising the routes, storage, holding pool, and alias table
// together, above the unit level. No LLM: the holding pool is seeded with
// already-analyzed beats so the migrate path re-homes them (no inference). The
// browser/extension UI and a live-LLM import remain manual, in-browser steps.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { registerApiRoutes } from "../api.js";
import { addPending } from "../holding-pool.js";
import type { EmotionalBeat } from "../sentiment/types.js";

let app: FastifyInstance;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-api-"));
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

function beatFixture(speaker: string, id: string): EmotionalBeat {
  return {
    id, speaker, emotion: "fear", text: "a line",
    motivation: "wants to be understood", relationalDynamics: "leaning in", outcome: "stays",
    salience: 0.7, turnStart: 1, turnEnd: 1, created: "2026-01-01",
    sourceType: "chat", sourceChatId: "chat-1",
  };
}

// async wrappers so the awaited type is the response (app.inject's chainable
// overload otherwise confuses tsc), and payload is cast past InjectPayload.
async function post(url: string, payload: unknown) {
  return app.inject({ method: "POST", url, payload: payload as never });
}
async function get(url: string) {
  return app.inject({ method: "GET", url });
}

describe("speaker-resolution API (integration)", () => {
  it("map: migrates held beats to the character AND writes a retrievable companion", async () => {
    await addPending({ speaker: "Aurora", analyzed: beatFixture("Aurora", "beat-aaa"), sourceType: "chat", sourceChatId: "chat-1" });

    let r = await get("/api/pending-speakers");
    expect(r.statusCode).toBe(200);
    expect(r.json().speakers.find((s: any) => s.normalized === "aurora")?.count).toBe(1);

    r = await post("/api/resolve-speaker", { label: "Aurora", action: "map", characterId: "aurora-card", characterName: "Aurora" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.migrated).toBe(1);
    expect(body.collision).toBeUndefined();

    // Pool emptied.
    r = await get("/api/pending-speakers");
    expect(r.json().speakers).toHaveLength(0);

    // Beats are RETRIEVABLE — a companion character_topics entry exists.
    r = await get(`/api/entries?scope=character&scopeId=${encodeURIComponent(body.identityKey)}`);
    const entries = r.json();
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.some((e: any) => e.lane === "character_topics")).toBe(true);
  });

  it("POST /api/aliases returns 409 on a cross-character collision", async () => {
    expect((await post("/api/aliases", { label: "Bob", characterId: "a-card", characterName: "Alex" })).statusCode).toBe(200);
    const r = await post("/api/aliases", { label: "Bob", characterId: "b-card", characterName: "Beth" });
    expect(r.statusCode).toBe(409);
    expect(r.json().collision?.length).toBeGreaterThanOrEqual(1);
  });

  it("resolve map still migrates on collision, and reports the conflict", async () => {
    // "Bob" already belongs to Alex.
    await post("/api/aliases", { label: "Bob", characterId: "a-card", characterName: "Alex" });
    await addPending({ speaker: "Bob", analyzed: beatFixture("Bob", "beat-bob"), sourceType: "chat", sourceChatId: "chat-1" });

    const r = await post("/api/resolve-speaker", { label: "Bob", action: "map", characterId: "b-card", characterName: "Beth" });
    const body = r.json();
    expect(body.migrated).toBe(1);                 // beats went to Beth regardless
    expect(body.collision?.length).toBe(1);        // but the alias clash is surfaced
    expect(body.collision[0].canonicalName).toBe("Alex");
  });

  it("ignore moves beats to the recoverable bucket; restore brings them back", async () => {
    await addPending({ speaker: "Walk-On", analyzed: beatFixture("Walk-On", "beat-w"), sourceType: "chat", sourceChatId: "chat-1" });

    expect((await post("/api/resolve-speaker", { label: "Walk-On", action: "ignore" })).json().ignored).toBe(1);
    expect((await get("/api/pending-speakers")).json().speakers).toHaveLength(0);
    expect((await get("/api/ignored-speakers")).json().ignored.find((i: any) => i.label === "Walk-On")?.count).toBe(1);

    expect((await post("/api/restore-speaker", { label: "Walk-On" })).json().restored).toBe(1);
    expect((await get("/api/pending-speakers")).json().speakers.find((s: any) => s.normalized === "walk-on")?.count).toBe(1);
  });

  it("rejects a path-traversal scopeId on the entries route", async () => {
    const r = await app.inject({ method: "GET", url: "/api/entries?scope=character&scopeId=" + encodeURIComponent("../../escape") });
    expect(r.statusCode).toBeGreaterThanOrEqual(400); // not silently read out-of-bounds
  });

  it("orphan-character cascades a character's beats back into the pool", async () => {
    // Route a held speaker to a character first.
    await addPending({ speaker: "Aurora", analyzed: beatFixture("Aurora", "beat-aaa"), sourceType: "chat", sourceChatId: "chat-1" });
    const mapped = (await post("/api/resolve-speaker", { label: "Aurora", action: "map", characterId: "aurora-card", characterName: "Aurora" })).json();
    expect(mapped.migrated).toBe(1);

    // Now "delete" the character — its beats should orphan back to the pool.
    const r = await post("/api/orphan-character", { characterId: "aurora-card", characterName: "Aurora" });
    expect(r.json().orphaned).toBe(1);
    expect((await get("/api/pending-speakers")).json().speakers.find((s: any) => s.normalized === "aurora")?.count).toBe(1);
  });
});
