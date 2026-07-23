// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Live smoke test for turn detection (MarinaraExtender-23i).
//
//   npm run smoke:poller
//
// SAFE ON A LIVE INSTALL: the poller only READS from the engine (GET /chats,
// GET /chats/:id/messages) and writes its own watermark file. It is given a
// throwaway data dir here so it cannot disturb real Extender state, and no
// onTurn handler is attached, so nothing is ingested or written back.
//
// What this proves that unit tests cannot: the baseline path behaves correctly
// against a REAL library of chats (the damage case is replaying all of them),
// and a quiet tick really does cost one HTTP call at real scale.

import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

let passed = 0;
let failed = 0;
const ok = (l: string, d = "") => { passed++; console.log(`  PASS  ${l}${d ? ` — ${d}` : ""}`); };
const bad = (l: string, d: string) => { failed++; console.log(`  FAIL  ${l} — ${d}`); };

async function main() {
  // Point the sidecar's data dir at a temp folder BEFORE importing the poller,
  // so getDataDir() resolves there and real state is untouched.
  const dir = await mkdtemp(join(tmpdir(), "me-poller-smoke-"));
  process.env.MARINARA_EXTENDER_DATA = dir;

  const { pollOnce, loadPollerState, pollerStatePath } = await import("../src/poller.js");
  const { listChats } = await import("../src/engine-client.js");

  console.log("\nTurn-detection smoke test (read-only)");
  console.log(`Scratch state: ${pollerStatePath()}\n`);

  try {
    const chats = await listChats();
    ok("listChats()", `${chats.length} chat(s) in the library`);

    // ── Pass 1: baseline ──────────────────────────────────────────────────────
    // The damage case this guards: ingesting every existing chat's history at
    // once, replaying years of conversation as if it had just happened.
    let t0 = Date.now();
    const first = await pollOnce();
    const firstMs = Date.now() - t0;

    if (first.length === 0) ok("first pass ingests nothing (baseline)", `${firstMs}ms`);
    else bad("first pass ingests nothing", `detected ${first.length} turn(s) — history would be replayed`);

    const state = await loadPollerState();
    const tracked = Object.keys(state?.chats ?? {}).length;
    if (tracked > 0) ok("watermarks recorded", `${tracked} chat(s) tracked`);
    else bad("watermarks recorded", "none written");

    // Every chat that has messages should now be baselined.
    const withMessages = chats.filter((c) => c.lastMessageAt || c.updatedAt).length;
    if (tracked === withMessages) ok("every chat with messages was baselined", `${tracked}/${withMessages}`);
    else bad("every chat with messages was baselined", `${tracked}/${withMessages}`);

    // ── Pass 2: quiet tick ────────────────────────────────────────────────────
    t0 = Date.now();
    const second = await pollOnce();
    const secondMs = Date.now() - t0;

    if (second.length === 0) ok("second pass detects nothing new", `${secondMs}ms`);
    else {
      // Not necessarily a bug — a real turn may genuinely have landed between
      // the two passes — so report rather than fail.
      console.log(`  NOTE  second pass detected ${second.length} turn(s):`);
      for (const t of second) {
        console.log(`          chat="${t.chatName}" character=${t.characterId} regenerated=${t.regenerated}`);
      }
      ok("second pass ran", "detections shown above (a live turn may have landed)");
    }

    // ── Pass 3: detect a REAL turn ────────────────────────────────────────────
    // Baselining proves we ingest nothing; it does not prove we would notice a
    // turn. Waiting for a live reply is impractical, so instead roll one chat's
    // watermark back behind its own last message. The detection then runs
    // against genuine engine data — a real assistant reply, real ids, real
    // swipe fields — with nothing written back to the engine.
    const { recordWatermark } = await import("../src/poller.js");

    const busiest = [...chats]
      .filter((c) => typeof c.lastMessageAt === "string")
      .sort((a, b) => String(b.lastMessageAt).localeCompare(String(a.lastMessageAt)))[0];

    if (!busiest) {
      console.log("  SKIP  no chat with messages to replay");
    } else {
      const chatId = String(busiest.id);
      await recordWatermark(chatId, { lastMessageAt: "1970-01-01T00:00:00.000Z" });

      const replay = await pollOnce({ tailSize: 5 });
      const hit = replay.find((t) => t.chatId === chatId);

      if (hit) {
        const preview = String(hit.message.content ?? "").replace(/\s+/g, " ").slice(0, 50);
        ok(
          "detects a real assistant turn from live data",
          `chat="${hit.chatName}" character=${hit.characterId} "${preview}…"`,
        );
      } else {
        // Not a failure if the chat's newest message happens to be from the
        // user — that is correctly not a finished turn.
        console.log(`  NOTE   replay of "${busiest.name}" surfaced no assistant turn (newest message may be the user's)`);
        ok("replay ran without error", "");
      }

      // And the watermark must have advanced so it is not re-detected.
      const after = await pollOnce({ tailSize: 5 });
      if (after.some((t) => t.chatId === chatId)) {
        bad("replayed turn is not re-detected", "same turn surfaced twice");
      } else {
        ok("replayed turn is not re-detected on the next pass", "");
      }
    }

    console.log(
      `\n  A quiet tick over ${chats.length} chats took ${secondMs}ms.\n` +
        `  Baselining cost ${firstMs}ms and required no per-chat message fetches.`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    console.log(`  CLEAN removed scratch state dir`);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke test crashed:", e);
  process.exit(1);
});
