// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// citesChatId — citation without re-import ownership (fqnl).
//
// sourceChatId means two things at once and the overload is why 9,109 live
// entries carry no provenance: "which chat is my receipt" (what the fact-lane
// guard needs) and "which import owns me" (what removeEntriesBySourceChat
// purges by). Paths whose entries a re-import will NOT recreate — [remember:]
// tags, the long-form story path — could never afford the second meaning, so
// they recorded nothing and stayed unconvictable.
//
// citesChatId carries the first meaning alone. The property everything rests
// on is INERTNESS: the purge must never read it. If that regresses, stamping
// [remember:] entries becomes the data-loss bug the old comment warned about —
// purged on re-import, never recreated (the digest does not process remember
// tags).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readIndex, readEntry, removeEntriesBySourceChat } from "../storage.js";
import { createEntryIfUnique } from "../dedup.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-cites-"));
  process.env.MARINARA_EXTENDER_DATA = join(dir, "data");
});
afterEach(async () => {
  delete process.env.MARINARA_EXTENDER_DATA;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("citesChatId", () => {
  it("flows through createEntryIfUnique onto both the entry file and the index row", async () => {
    const e = await createEntryIfUnique("character", "mari", {
      lane: "character_topics", summary: "Remembers the reactor alarm drill.",
      content: "Spoken during chat-42.", kind: "incident", citesChatId: "chat-42",
    });
    expect(e!.citesChatId).toBe("chat-42");

    const row = (await readIndex("character", "mari"))!.entries.find((r) => r.id === e!.id)!;
    expect(row.citesChatId).toBe("chat-42");
    const file = await readEntry("character", "mari", row.path);
    expect(file!.citesChatId).toBe("chat-42");
  });

  it("is INERT to the re-import purge — the property the whole design rests on", async () => {
    // Same chat id in both fields' worlds: one entry OWNED by chat-42 (import
    // artifact, must purge), one merely CITING chat-42 (a [remember:], must
    // survive — a re-import will never recreate it).
    const owned = await createEntryIfUnique("character", "mari", {
      lane: "character_topics", summary: "Companion entry from the import.",
      content: "c", kind: "incident", sourceChatId: "chat-42",
    });
    const citing = await createEntryIfUnique("character", "mari", {
      lane: "character_topics", summary: "A remember tag spoken in that same chat.",
      content: "c", kind: "incident", citesChatId: "chat-42",
    });

    const purged = await removeEntriesBySourceChat("character", "mari", "chat-42");

    expect(purged).toBe(1);
    const live = (await readIndex("character", "mari"))!.entries.map((r) => r.id);
    expect(live).not.toContain(owned!.id);
    expect(live).toContain(citing!.id);
  });
});
