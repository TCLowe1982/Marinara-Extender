// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// 771t precondition canary — "did we get THE one", not "did we get something".
//
// THE QUESTION. The shipped Engine's prompt-context contributor (2.4.3) hands us
// chatId and NOT the assembled messages, so to score recall against the message
// being answered we would have to fetch the latest user message ourselves. That
// only works if the outgoing message is COMMITTED and visible over REST at the
// moment the contributor fires, during prompt assembly.
//
// WHY A NONCE AND NOT A COUNT (Mari, 2026-08-29): "if the outgoing message isn't
// persisted when the contributor fires, you don't get an error, you get turn N-1.
// and in a real conversation N-1 is topically adjacent to N almost always, so
// ranking on stale text produces plausible rows and looks exactly like it's
// working." A test that asserts "a user message came back" passes in both worlds.
// So this asserts on an EXACT nonce and treats anything else as failure.
//
// WHAT IT PROVES. If the nonce message is visible over REST strictly BEFORE the
// assistant's reply for that turn exists, then it was committed pre-generation
// and a contributor running during assembly would read turn N. If the nonce only
// becomes visible at the same moment as the reply, the fetch-it-ourselves
// workaround is dead and the upstream ask becomes mandatory.
//
// Usage:  node scripts/preturn-canary.mjs
//         -> prints a nonce; paste it into a message in ANY chat and send.

import { setTimeout as sleep } from "node:timers/promises";

const ENGINE = (process.env.MARINARA_EXTENDER_ENGINE_URL ?? "http://127.0.0.1:7860").replace(/\/+$/, "");
const POLL_MS = 200;

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
};

// REUSABLE NONCE. The watcher and the human are not synchronised: the window
// lapses while someone is mid-sentence, and regenerating the nonce on restart
// silently invalidates the one they already pasted. --nonce lets a restart keep
// watching for the SAME string.
const NONCE = arg("--nonce") ?? `canary-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
const WINDOW_MS = (Number.parseInt(arg("--window") ?? "", 10) || 1800) * 1000;

async function api(path) {
  const res = await fetch(`${ENGINE}/api${path}`, { headers: { "x-marinara-csrf": "1" } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

const list = (payload, key) =>
  Array.isArray(payload) ? payload : Array.isArray(payload?.[key]) ? payload[key] : [];

const ms = (t0) => `${String(Date.now() - t0).padStart(6)} ms`;

console.log("");
console.log("  771t PRE-TURN CANARY");
console.log("  ────────────────────");
console.log(`  engine: ${ENGINE}`);
console.log("");
console.log("  1. Copy the nonce below.");
console.log("  2. Send a message in any chat that CONTAINS it (any other text is fine).");
console.log("  3. Let the reply generate. Do not stop it.");
console.log("");
console.log(`      ${NONCE}`);
console.log("");
console.log(`  watching every ${POLL_MS}ms for up to ${WINDOW_MS / 1000}s ...`);
console.log("");

// Snapshot lastMessageAt for every chat up front, so "which chat just moved"
// is a diff rather than a scan. A chat that appears later (a brand-new chat) has
// no baseline entry and is skipped — send the nonce in an existing chat.
const baseline = new Map();
try {
  for (const c of list(await api("/chats"), "chats")) {
    baseline.set(String(c.id ?? ""), String(c.lastMessageAt ?? ""));
  }
  console.log(`  baseline: ${baseline.size} chats
`);
} catch (err) {
  console.log(`  could not reach the engine: ${String(err)}`);
  process.exit(2);
}

// ALREADY-SENT IS NOT THE SAME ANSWER AS NEVER-APPEARED. On a restart with a
// reused nonce the message may already be in the store, and the arrival timing
// we exist to measure is then unobservable. Saying "never appeared" there would
// be a false negative about the Engine rather than a true one about the test.
try {
  const recent = list(await api("/chats"), "chats")
    .sort((a, b) => String(b.lastMessageAt ?? "").localeCompare(String(a.lastMessageAt ?? "")))
    .slice(0, 12);
  for (const c of recent) {
    const msgs = list(await api(`/chats/${String(c.id)}/messages`), "messages").slice(-12);
    if (msgs.some((m) => typeof m?.content === "string" && m.content.includes(NONCE))) {
      console.log(`  ALREADY SENT — the nonce is already in chat ${String(c.id)}.`);
      console.log("  Arrival timing cannot be measured after the fact. Re-run with a FRESH nonce");
      console.log("  (omit --nonce) and send a new message.");
      process.exit(2);
    }
  }
} catch { /* fall through and watch; an unreachable engine is reported below */ }

const start = Date.now();
let chatId = null;
let userSeenAt = null;
let userMessageId = null;
let assistantSeenAt = null;

while (Date.now() - start < WINDOW_MS) {
  try {
    const chats = list(await api("/chats"), "chats");
    // NARROW BEFORE FETCHING. There are ~100 chats on a real install; pulling
    // every message list every tick would hammer the Engine hard enough to
    // change the very timing this test measures. One /chats call per tick is
    // cheap, and lastMessageAt tells us which chat just moved — so message
    // fetches only happen for a chat that actually changed, or for the one we
    // have already locked onto.
    let candidates;
    if (chatId) {
      candidates = [{ id: chatId }];
    } else {
      candidates = chats.filter((c) => {
        const id = String(c.id ?? "");
        const stamp = String(c.lastMessageAt ?? "");
        const seen = baseline.get(id);
        return seen !== undefined && seen !== stamp;
      });
    }
    for (const chat of candidates) {
      const id = String(chat.id ?? "");
      if (!id) continue;
      let messages;
      try {
        messages = list(await api(`/chats/${id}/messages`), "messages");
      } catch {
        continue;
      }

      const hit = messages.find(
        (m) => m?.role === "user" && typeof m.content === "string" && m.content.includes(NONCE),
      );
      if (!hit) continue;

      if (!userSeenAt) {
        chatId = id;
        userSeenAt = Date.now();
        userMessageId = String(hit.id ?? "");
        console.log(`  [${ms(start)}]  USER MESSAGE VISIBLE   chat:${id} msg:${userMessageId}`);
      }

      // The assistant reply that FOLLOWS the nonce message — not merely any
      // assistant message, or an older reply would end the test immediately.
      const at = messages.findIndex((m) => String(m?.id ?? "") === userMessageId);
      const reply = at >= 0 ? messages.slice(at + 1).find((m) => m?.role === "assistant") : null;
      if (reply && !assistantSeenAt) {
        assistantSeenAt = Date.now();
        console.log(`  [${ms(start)}]  ASSISTANT REPLY VISIBLE  msg:${String(reply.id ?? "")}`);
      }
    }
  } catch (err) {
    // The engine restarting mid-test is not a verdict; keep watching.
    if (!userSeenAt) console.log(`  [${ms(start)}]  (engine unreachable: ${String(err).slice(0, 60)})`);
  }

  if (userSeenAt && assistantSeenAt) break;
  await sleep(POLL_MS);
}

console.log("");
console.log("  ── VERDICT ──");
if (!userSeenAt) {
  console.log("  INCONCLUSIVE — the nonce never appeared. Was the message sent, and did it contain the nonce verbatim?");
  process.exit(2);
}
if (!assistantSeenAt) {
  console.log("  INCONCLUSIVE — the user message was seen but no reply followed within the window.");
  console.log("  The user message WAS committed and readable before any reply existed, which is the");
  console.log("  encouraging half, but a completed turn is needed to state the gap.");
  process.exit(2);
}

const gap = assistantSeenAt - userSeenAt;
console.log(`  user message visible ${gap} ms BEFORE its reply.`);
console.log("");
if (gap >= 1000) {
  console.log("  PASS — the outgoing user message is committed and REST-visible well before generation");
  console.log("  finishes. A contributor firing during prompt assembly can fetch turn N by chatId.");
  console.log("");
  console.log("  NOT PROVEN by this test: that it is visible at the exact instant the contributor runs.");
  console.log("  This bounds it from one side only — commit happens before the reply, not necessarily");
  console.log("  before assembly. The conclusive version needs the contributor itself to report the");
  console.log("  nonce it saw. Treat this as necessary-but-not-sufficient.");
} else {
  console.log("  SUSPECT — the user message became visible less than a second before its reply.");
  console.log("  That is too tight to conclude commit-before-assembly. The fetch-by-chatId workaround");
  console.log("  may read turn N-1. Do not build on it without the contributor-side nonce check.");
}
console.log("");
