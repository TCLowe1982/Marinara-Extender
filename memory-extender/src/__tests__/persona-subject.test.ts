// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// PERSONA vs PERSON (qhej) — the store could not say WHICH Thomas.
//
// TC is from Nodaway County, Missouri. His in-character persona Thomas is from
// Independence, MO. Three user_topics entries place "the user" in Texas, all
// three sourced from RP dialogue — a character's line filed as biography of the
// human. resolveFactTarget has carried a persona branch since it was written,
// but no caller ever populated ctx.personaName, so it was dead code and every
// persona fact routed as though it were about a stranger.
//
// These pin the branch alive, and the collision rule that decides ties.

import { describe, it, expect } from "vitest";
import { resolveFactTarget } from "../facts.js";
import type { AmbientFact } from "../ambient.js";

const fact = (over: Partial<AmbientFact>): AmbientFact => ({
  text: "…", fact: "…", lane: "character_topics", scope: "character", ...over,
});

describe("persona facts are marked as persona facts", () => {
  const ctx = { identityKey: "mari", fallbackChatId: "chat-1", characterName: "Mari", personaName: "Thomas" };

  it("a fact about the player's persona stays on the session ledger, kind=persona", async () => {
    const t = await resolveFactTarget(
      fact({ fact: "Thomas is from Independence, MO", subject: "Thomas" }),
      ctx,
    );
    // Routing is unchanged — the persona's facts have always belonged here.
    expect(t?.scope).toBe("character");
    expect(t?.scopeId).toBe("mari");
    // What is new: the store can now say it is about the PERSONA.
    expect(t?.subjects).toEqual([{ name: "Thomas", kind: "persona" }]);
  });

  it("WITHOUT personaName the same fact is demoted to a stranger — the bug, pinned", async () => {
    const noPersona = { identityKey: "mari", fallbackChatId: "chat-1", characterName: "Mari" };
    const t = await resolveFactTarget(
      fact({ fact: "Thomas is from Independence, MO", subject: "Thomas" }),
      noPersona,
    );
    // This is what produced the 22 "[about: Thomas]" rows: the persona read as
    // an unresolvable third party and fell out to chat scope.
    expect(t?.scope).toBe("chat");
    expect(t?.subjects).toEqual([{ name: "Thomas" }]);
    expect(t?.subjects?.[0].kind).toBeUndefined();
  });

  it("the session CHARACTER's own facts are marked kind=character", async () => {
    const t = await resolveFactTarget(
      fact({ fact: "Mari is Polish", subject: "Mari" }),
      ctx,
    );
    expect(t?.scopeId).toBe("mari");
    expect(t?.subjects).toEqual([{ name: "Mari", kind: "character" }]);
  });

  it("the human is still kind=user — persona and person stay distinct", async () => {
    const t = await resolveFactTarget(
      fact({ fact: "User has DMed since 2e", lane: "user_topics", subject: "user" }),
      ctx,
    );
    expect(t?.subjects).toEqual([{ name: "user", kind: "user" }]);
  });

  it("PERSONA WINS A NAME COLLISION with the session character", async () => {
    // The tie that must not be decided by accident: if a character shares the
    // persona's name, the human's declared identity wins. A declaration is not
    // a guess — the same principle that exempts user-identity.yaml from the
    // alias ambiguity cap.
    const collision = {
      identityKey: "thomas_char", fallbackChatId: "chat-1",
      characterName: "Thomas", personaName: "Thomas",
    };
    const t = await resolveFactTarget(fact({ fact: "Thomas is an Army veteran", subject: "Thomas" }), collision);
    expect(t?.subjects).toEqual([{ name: "Thomas", kind: "persona" }]);
  });

  it("a genuine third party is still unmarked and demoted — the persona branch did not widen", async () => {
    const t = await resolveFactTarget(
      fact({ fact: "Cole mains a warlock", subject: "Cole" }),
      ctx,
    );
    expect(t?.scope).toBe("chat");
    expect(t?.subjects?.[0].kind).toBeUndefined();
  });

  it("a placeholder subject is still refused, persona or not", async () => {
    const t = await resolveFactTarget(fact({ fact: "A character does a thing", subject: "character" }), ctx);
    expect(t?.subjects).toBeUndefined();
  });
});
