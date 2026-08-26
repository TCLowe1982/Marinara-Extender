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

  it("no date at all falls through to primary", async () => {
    const undated = { lastAccessed: "", sourceChatId: undefined } as never;
    expect(await rowInBranch(undated, NEW)).toBe(true);
    expect(await rowInBranch(undated, OLD)).toBe(false);
  });
});

// dqs1. These are the regression: the rule above was written assuming index rows
// carry `created`, and NOT ONE OF THE 9,185 ROWS IN THE LIVE STORE DID. The
// interface never declared the field. So `row.created ?? row.lastAccessed` made
// the shared-childhood test mean "has not been READ since the split" — it
// admitted 17 of 175 genuinely pre-split rows, and the ones it dropped were the
// ones used most, because loading a memory refreshes lastAccessed (gwny).
//
// The old suite could not catch it: every fixture set `created`, so the fallback
// branch was never executed. The test that named it asserted an EMPTY
// lastAccessed, which falls through for the same reason with or without the bug.
describe("a retrieval timestamp is never a creation date", () => {
  // COMPANION, not the regression: with a recent lastAccessed the date gate
  // fails either way and both versions fall through to ownership. It is here to
  // pin the pair, and it is labelled so nobody mistakes it for the guard.
  it("a row with NO created and a recent lastAccessed is not treated as pre-split", async () => {
    const r = { lastAccessed: "2026-08-25", sourceChatId: "chat-old" } as never;
    expect(await rowInBranch(r, NEW)).toBe(false); // belongs to the retired card's chat
    expect(await rowInBranch(r, OLD)).toBe(true);
  });

  // THIS ONE IS THE GUARD. Verified to FAIL against the old
  // `created ?? lastAccessed`: an untouched row passed the shared-childhood
  // test for the wrong reason — because nobody had read it, not because it was
  // old.
  it("a row with NO created and an OLD lastAccessed is still not shared", async () => {
    const r = { lastAccessed: "2026-01-01", sourceChatId: "chat-new" } as never;
    expect(await rowInBranch(r, OLD)).toBe(false);
    expect(await rowInBranch(r, NEW)).toBe(true); // its own chat, not the shared past
  });
});

// TC's ruling (2026-08-26): name the shared set BY CHAT. `created` is an ingest
// stamp on this store — 950 beats spanning 2,500 turns under three dates — so a
// date can never sort imported history onto the right side of the split.
describe("chats can be declared shared outright", () => {
  const SHARED = { ...OLD, sharedChats: ["chat-old"] };
  const SHARED_NEW = { ...NEW, sharedChats: ["chat-old"] };

  it("a declared shared chat reaches BOTH sisters, whatever its dates say", async () => {
    const r = { created: "2026-06-23", lastAccessed: "2026-08-26", sourceChatId: "chat-old" } as never;
    expect(await rowInBranch(r, SHARED_NEW)).toBe(true);
    expect(await rowInBranch(r, SHARED)).toBe(true);
  });

  it("declaring one chat shared does not leak the rest of that card's life", async () => {
    const r = { created: "2026-06-23", lastAccessed: "2026-08-26", sourceChatId: "chat-group" } as never;
    const other = { ...SHARED, mine: ["__professor_mari__"] };
    expect(await rowInBranch(r, other)).toBe(false);
  });

  it("citesChatId counts as the chat for sharing too", async () => {
    const r = { created: "2026-06-23", citesChatId: "chat-old", sourceChatId: undefined } as never;
    expect(await rowInBranch(r, SHARED_NEW)).toBe(true);
  });
});

describe("one person is one branch", () => {
  it("a sister with several card ids owns the chats of ALL of them", async () => {
    // Professor Mari is both `__professor_mari__` (which her chats still name)
    // and `Z4MZQbJLgLF`. Filtering on the single owning card made her memory
    // depend on which of her own chats she happened to be in.
    const whole = { splitAt: SPLIT, primary: false, mine: ["__professor_mari__", "Z4MZQbJLgLF"] };
    const r = { created: "2026-06-23", sourceChatId: "chat-old" } as never;
    expect(await rowInBranch(r, whole)).toBe(true);
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
