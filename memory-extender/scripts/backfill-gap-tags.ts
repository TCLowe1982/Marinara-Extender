// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.
//
// ONE-OFF backfill: commit the [remember:]/[bookmark:] tags that the character
// emitted while the extension was dark (2026-07-23, ~09:40 death -> 14:30 poller
// start). The tags survived verbatim in the saved messages because nothing was
// there to strip or ingest them.
//
// Correctness rules baked in:
//   - Uses the Extender's OWN parsers (extractRememberTags / extractBookmarks),
//     so parsing matches exactly what the extension would have done — including
//     the "unspecified scope defaults to character" behaviour.
//   - REMEMBER commands go through POST /api/ingest-commands, which DEDUPES, so
//     re-sending anything already captured (pre-death, or the poller's own
//     post-14:30 work) is harmless — it is skipped, not duplicated.
//   - BOOKMARK commands do NOT dedupe server-side, so we only add bookmarks
//     whose topic is confirmed ABSENT from the chat's current bookmarks.

import { extractRememberTags, extractBookmarks } from "../src/writer.js";

const ENGINE = "http://127.0.0.1:7860";
const SIDECAR = "http://127.0.0.1:3001";

// Only these two chats had activity today.
const CHATS = [
  { chatId: "FfpHDWOWtSda7XcMfSen_", characterId: "Po_H0vIbkPUMbZmt7aUoQ", characterName: "Dr. Mari Zielińska" },
  { chatId: "PX4ptLqNv_WHOto-JPL04", characterId: "K6cqCrrv9fuJuqqaMl2yF", characterName: "Dr. Priya" },
];

// Remembers: from well after last night's captured batch (which ended ~02:10Z)
// and before now. Dedup is the real guard; this window just avoids re-walking
// last night. Bookmarks are filtered by topic-absence instead of time.
const REMEMBER_FROM = "2026-07-23T10:00:00.000Z";
const APPLY = process.argv.includes("--apply");

async function engineGet(path: string): Promise<unknown> {
  const res = await fetch(`${ENGINE}/api${path}`, { headers: { "x-marinara-csrf": "1" } });
  if (!res.ok) throw new Error(`engine ${path} -> ${res.status}`);
  return res.json();
}
function unwrap<T = Record<string, unknown>>(r: unknown, key: string): T[] {
  if (Array.isArray(r)) return r as T[];
  const o = r as Record<string, unknown>;
  return (o?.[key] ?? o?.data ?? []) as T[];
}

async function existingBookmarkTopics(chatId: string): Promise<Set<string>> {
  const res = await fetch(`${SIDECAR}/api/bookmarks?scope=chat&scopeId=${chatId}`);
  const bms = unwrap<{ topic?: string }>(await res.json(), "bookmarks");
  return new Set(bms.map((b) => String(b.topic ?? "")).filter(Boolean));
}

type Cmd =
  | { type: "remember"; lane: string; content: string; scope: string; at: string }
  | { type: "bookmark"; topic: string; weight: number; why: string; summary: string; at: string };

async function main() {
  console.log(`\nGap-tag backfill  (${APPLY ? "APPLY" : "DRY RUN — pass --apply to commit"})\n`);

  for (const chat of CHATS) {
    const msgs = unwrap<Record<string, unknown>>(await engineGet(`/chats/${chat.chatId}/messages`), "messages");
    const existingTopics = await existingBookmarkTopics(chat.chatId);

    const remembers: Cmd[] = [];
    const bookmarks: Cmd[] = [];

    for (const m of msgs) {
      const at = String(m.createdAt ?? "");
      if (!at.startsWith("2026-07-23")) continue;
      const content = String(m.content ?? "");

      if (at >= REMEMBER_FROM) {
        for (const r of extractRememberTags(content)) {
          remembers.push({ type: "remember", lane: r.lane, content: r.content, scope: r.scope, at });
        }
      }
      // Bookmarks: keep only topics not already present anywhere in this chat.
      for (const b of extractBookmarks(content)) {
        if (existingTopics.has(b.topic)) continue;
        bookmarks.push({ type: "bookmark", topic: b.topic, weight: b.weight, why: b.why, summary: b.summary, at });
      }
    }

    console.log(`===== ${chat.characterName}  (${chat.chatId}) =====`);
    console.log(`  ${remembers.length} remember command(s) in window, ${bookmarks.length} new bookmark(s):`);
    for (const r of remembers) console.log(`    [${r.at.slice(11, 19)}] remember  scope=${(r as any).scope} lane=${(r as any).lane}  ${(r as any).content.slice(0, 90)}`);
    for (const b of bookmarks) console.log(`    [${b.at.slice(11, 19)}] bookmark  topic=${(b as any).topic} w=${(b as any).weight}  ${(b as any).summary.slice(0, 80)}`);

    if (!APPLY) { console.log(); continue; }

    const commands = [
      ...remembers.map((r) => ({ type: "remember", lane: (r as any).lane, content: (r as any).content, scope: (r as any).scope })),
      ...bookmarks.map((b) => ({ type: "bookmark", topic: (b as any).topic, weight: (b as any).weight, why: (b as any).why, summary: (b as any).summary })),
    ];
    if (commands.length === 0) { console.log("  nothing to commit\n"); continue; }

    const res = await fetch(`${SIDECAR}/api/ingest-commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterId: chat.characterId,
        characterName: chat.characterName,
        chatId: chat.chatId,
        commands,
      }),
    });
    const body = (await res.json()) as { created?: number; bookmarksAdded?: number; error?: string };
    if (!res.ok) console.log(`  COMMIT FAILED: ${res.status} ${JSON.stringify(body)}\n`);
    else console.log(`  COMMITTED: ${body.created} ledger entr${body.created === 1 ? "y" : "ies"} created (rest deduped), ${body.bookmarksAdded} bookmark(s) added\n`);
  }
}

main().catch((e) => { console.error("backfill crashed:", e); process.exit(1); });
