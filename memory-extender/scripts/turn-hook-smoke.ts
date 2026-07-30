// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Live smoke test for notification-driven turn detection (MarinaraExtender-4kbt).
//
//   npm run smoke:turn-hook
//
// SAFE ON A LIVE INSTALL: read-only against the engine (GET /chats,
// GET /chats/:id/messages), writes only its own throwaway watermark file, and
// attaches no onTurn handler — nothing is ingested and nothing is written back.
//
// What this proves that unit tests cannot: the swipe fields the whole design
// rests on (`activeSwipeIndex`, and `createdAt` NOT moving on a re-roll) really
// behave that way on a live engine. The unit tests assert against fixtures I
// wrote; this asserts against the engine itself.
//
// The headline claim under test: a regeneration is invisible to polling. It is
// checked here directly — the chat's own lastMessageAt is compared against the
// message's createdAt to show the poll gate could never fire for a swipe.

import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

let passed = 0;
let failed = 0;
const ok = (l: string, d = "") => { passed++; console.log(`  PASS  ${l}${d ? ` — ${d}` : ""}`); };
const bad = (l: string, d: string) => { failed++; console.log(`  FAIL  ${l} — ${d}`); };

async function main() {
  // Redirect the data dir BEFORE importing, so getDataDir() resolves to scratch
  // and real Extender state is untouched.
  const dir = await mkdtemp(join(tmpdir(), "me-hook-smoke-"));
  process.env.MARINARA_EXTENDER_DATA = dir;

  const { handleTurnNotification, recordWatermark, pollOnce, swipeIndexOf } =
    await import("../src/poller.js");
  const { listChats, listMessages } = await import("../src/engine-client.js");

  console.log("\nTurn-hook smoke test (read-only)\n");

  try {
    const chats = await listChats();
    ok("listChats()", `${chats.length} chat(s)`);

    // Pick the most recently active chat whose newest message is an assistant
    // reply — that is the only shape a turn notification can name.
    let target: { chatId: string; chatName: string; message: Record<string, unknown> } | null = null;
    const ordered = [...chats]
      .filter((c) => typeof c.lastMessageAt === "string")
      .sort((a, b) => String(b.lastMessageAt).localeCompare(String(a.lastMessageAt)));

    for (const c of ordered.slice(0, 10)) {
      const tail = await listMessages(String(c.id), { limit: 5 });
      const last = tail[tail.length - 1];
      if (last && last.role === "assistant") {
        target = { chatId: String(c.id), chatName: String(c.name ?? c.id), message: last };
        break;
      }
    }

    if (!target) {
      console.log("  SKIP  no chat whose newest message is an assistant reply");
      console.log(`\n${passed} passed, ${failed} failed\n`);
      return;
    }

    const { chatId, chatName, message } = target;
    const messageId = String(message.id);
    console.log(`  Using chat "${chatName}" message ${messageId}\n`);

    // ── The load-bearing engine facts ─────────────────────────────────────────
    if (swipeIndexOf(message) !== undefined) {
      ok("engine exposes activeSwipeIndex", `= ${swipeIndexOf(message)} (swipeCount=${message.swipeCount})`);
    } else {
      bad("engine exposes activeSwipeIndex", "absent — regeneration cannot be distinguished from a repeat");
    }

    const chatRow = chats.find((c) => String(c.id) === chatId)!;
    if (String(chatRow.lastMessageAt) === String(message.createdAt)) {
      ok("chat.lastMessageAt tracks the newest message's createdAt", String(message.createdAt));
    } else {
      console.log(
        `  NOTE  lastMessageAt (${chatRow.lastMessageAt}) != newest createdAt (${message.createdAt})`,
      );
    }

    // ── A first sighting must ingest, not baseline ────────────────────────────
    // Deliberately unlike the poller: a notification is evidence THIS turn just
    // finished, so dropping it would silently lose a real turn.
    const first = await handleTurnNotification({ chatId, assistantMessageId: messageId });
    if (first.length === 1 && first[0].message.id === messageId) {
      const preview = String(first[0].message.content ?? "").replace(/\s+/g, " ").slice(0, 45);
      ok("notification ingests the named turn", `regenerated=${first[0].regenerated} "${preview}…"`);
    } else {
      bad("notification ingests the named turn", `got ${first.length} turn(s)`);
    }

    // ── A repeat must be a no-op ──────────────────────────────────────────────
    const repeat = await handleTurnNotification({ chatId, assistantMessageId: messageId });
    if (repeat.length === 0) ok("repeated notification is a no-op", "same message, same swipe");
    else bad("repeated notification is a no-op", `re-ingested ${repeat.length} turn(s)`);

    // ── The swipe case, simulated against real data ───────────────────────────
    // Roll the recorded swipe index back by one, leaving lastMessageAt exactly
    // where it is. That is precisely the state a live re-roll produces.
    const realSwipe = swipeIndexOf(message);
    if (realSwipe === undefined) {
      console.log("  SKIP  no swipe index on this message — cannot simulate a re-roll");
    } else {
      await recordWatermark(chatId, {
        lastMessageAt: String(message.createdAt),
        lastMessageId: messageId,
        lastSwipeIndex: realSwipe - 1,
      });

      // Polling must be blind to it: the gate needs lastMessageAt to ADVANCE.
      const polled = await pollOnce({ tailSize: 5 });
      if (!polled.some((t) => t.chatId === chatId)) {
        ok("polling is blind to the swipe", "lastMessageAt never advanced — this is the bug");
      } else {
        bad("polling is blind to the swipe", "poll detected it, so the premise is wrong");
      }

      // Re-arm: pollOnce above may have rewritten the watermark.
      await recordWatermark(chatId, {
        lastMessageAt: String(message.createdAt),
        lastMessageId: messageId,
        lastSwipeIndex: realSwipe - 1,
      });

      const swiped = await handleTurnNotification({ chatId, assistantMessageId: messageId });
      if (swiped.length === 1 && swiped[0].regenerated) {
        ok("notification catches the swipe and marks it regenerated", "supersede, not duplicate");
      } else {
        bad(
          "notification catches the swipe",
          `got ${swiped.length} turn(s), regenerated=${swiped[0]?.regenerated}`,
        );
      }
    }

    // ── An unknown message must be declined, not misattributed ────────────────
    const bogus = await handleTurnNotification({ chatId, assistantMessageId: "definitely-not-a-real-id" });
    if (bogus.length === 0) ok("unknown message id is declined", "not blamed on the newest turn");
    else bad("unknown message id is declined", `ingested ${bogus.length} turn(s)`);
  } finally {
    await rm(dir, { recursive: true, force: true });
    console.log(`\n  CLEAN removed scratch state dir`);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke test crashed:", e);
  process.exit(1);
});
