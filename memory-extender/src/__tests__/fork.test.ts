// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// IDENTITY FORK (yi70) — two cards that were the same person until a date.
//
// TC: "They should read more as sisters who shared the same household, ie, the
// pre-split memories, rather than be shared."
//
// The rule is a UNION, not a cutoff. That distinction is the whole ticket: on
// the live store a plain cutoff leaves the retired card with 1% of its memory,
// because 6,983 of 7,052 beats postdate the split. These pin the union.

import { describe, it, expect, vi, beforeEach } from "vitest";

const SPLIT = "2026-05-23";
// chat -> owning card, standing in for the Engine's chat list.
const OWNERS: Record<string, string[]> = {
  "chat-old": ["__professor_mari__"],   // the retired card's surviving chat
  "chat-new": ["Po_H0vIbkPUMbZmt7aUoQ"], // the current card
  "chat-group": ["Po_H0vIbkPUMbZmt7aUoQ", "someone-else"],
};

vi.mock("../engine-client.js", () => ({
  listChats: async () =>
    Object.entries(OWNERS).map(([id, characterIds]) => ({ id, characterIds })),
}));

const { rowInBranch, _resetChatOwnerCache } = await import("../fork.js");

const OLD = { splitAt: SPLIT, primary: false, mine: ["__professor_mari__"] };
const NEW = { splitAt: SPLIT, primary: true, mine: ["Po_H0vIbkPUMbZmt7aUoQ"] };

const row = (over: Record<string, unknown> = {}) =>
  ({ created: "2026-06-01", lastAccessed: "2026-06-01", ...over }) as never;

beforeEach(() => _resetChatOwnerCache());

describe("the shared childhood is shared", () => {
  it("a pre-split memory belongs to BOTH sisters", async () => {
    const r = row({ created: "2026-05-20", sourceChatId: "chat-new" });
    expect(await rowInBranch(r, OLD)).toBe(true);
    expect(await rowInBranch(r, NEW)).toBe(true);
  });

  it("a memory created ON the split date is still shared — the boundary is inclusive", async () => {
    const r = row({ created: SPLIT, sourceChatId: "chat-new" });
    expect(await rowInBranch(r, OLD)).toBe(true);
    expect(await rowInBranch(r, NEW)).toBe(true);
  });
});

describe("after the split they live separate lives", () => {
  it("the current card's memory is HIDDEN from the retired card", async () => {
    // This is the bug TC reported: the retired card was reading all of this.
    const r = row({ created: "2026-06-10", sourceChatId: "chat-new" });
    expect(await rowInBranch(r, OLD)).toBe(false);
    expect(await rowInBranch(r, NEW)).toBe(true);
  });

  it("the retired card's OWN memory is hidden from the current card", async () => {
    // TC's ruling on the reverse direction: "She shouldn't."
    const r = row({ created: "2026-06-10", sourceChatId: "chat-old" });
    expect(await rowInBranch(r, OLD)).toBe(true);
    expect(await rowInBranch(r, NEW)).toBe(false);
  });

  it("a card keeps its own post-split life — this is why it is a union, not a cutoff", async () => {
    // A pure "ignore everything after splitAt" would return false here and leave
    // the retired card amnesiac. 40 real beats live in exactly this position.
    const r = row({ created: "2026-06-25", sourceChatId: "chat-old" });
    expect(await rowInBranch(r, OLD)).toBe(true);
  });
});

describe("unattributable rows follow the PRIMARY branch", () => {
  // 42.9% of the live store carries no sourceChatId. Absent provenance means
  // "unknown", never "shared" — the retired fork gets nothing it cannot prove,
  // and the live character loses nothing.
  it("no source chat, post-split → primary keeps it, the fork does not", async () => {
    const r = row({ created: "2026-07-01" });
    expect(await rowInBranch(r, NEW)).toBe(true);
    expect(await rowInBranch(r, OLD)).toBe(false);
  });

  it("a source chat the Engine no longer has → primary", async () => {
    const r = row({ created: "2026-07-01", sourceChatId: "chat-deleted-long-ago" });
    expect(await rowInBranch(r, NEW)).toBe(true);
    expect(await rowInBranch(r, OLD)).toBe(false);
  });

  it("no date at all falls back to lastAccessed, then to primary", async () => {
    const undated = { lastAccessed: "", sourceChatId: undefined } as never;
    expect(await rowInBranch(undated, NEW)).toBe(true);
    expect(await rowInBranch(undated, OLD)).toBe(false);
  });
});

describe("group chats", () => {
  it("a chat counts as mine if I am ANY of its participants", async () => {
    const r = row({ created: "2026-06-10", sourceChatId: "chat-group" });
    expect(await rowInBranch(r, NEW)).toBe(true);
    expect(await rowInBranch(r, OLD)).toBe(false);
  });
});

describe("citesChatId is honoured when sourceChatId is absent", () => {
  it("provenance without ownership still attributes the branch", async () => {
    const r = row({ created: "2026-06-10", citesChatId: "chat-old" });
    expect(await rowInBranch(r, OLD)).toBe(true);
    expect(await rowInBranch(r, NEW)).toBe(false);
  });
});
