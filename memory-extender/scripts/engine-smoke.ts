// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Live smoke test for the engine REST client (MarinaraExtender-7nx).
//
// The unit tests stub fetch(), so they prove the client's logic but say nothing
// about whether a real Marinara Engine accepts these calls. This script is the
// other half: it runs the client against a RUNNING engine and reports what
// actually happened.
//
//   npm run smoke:engine            # read-only — safe on a live install
//   npm run smoke:engine -- --write # also round-trips a throwaway lorebook
//
// Read-only is the default on purpose: this points at a real install with real
// characters and chats, and nobody should have to read the source to be sure a
// diagnostic won't touch their data.
//
// The --write pass creates ONE clearly-named lorebook, exercises the full
// create/patch/entry/delete cycle on it, and removes it in a finally block so a
// mid-test failure still cleans up. If cleanup ever fails, the name below is
// what to search for in Marinara.

import {
  engineUrl,
  engineFetch,
  listChats,
  listMessages,
  listCharacters,
  listLorebooks,
  createLorebook,
  patchLorebook,
  deleteLorebook,
  listLorebookEntries,
  createLorebookEntry,
  patchLorebookEntry,
  deleteLorebookEntry,
  parseData,
  EngineError,
} from "../src/engine-client.js";

const SMOKE_LOREBOOK_NAME = "Marinara Extender — SMOKE TEST (safe to delete)";
const ME_LOREBOOK_TOKEN_BUDGET = 16384;

let passed = 0;
let failed = 0;

function ok(label: string, detail = "") {
  passed++;
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
}
function bad(label: string, err: unknown) {
  failed++;
  const msg = err instanceof EngineError ? err.message : String(err);
  console.log(`  FAIL  ${label}\n        ${msg}`);
}

async function step<T>(label: string, fn: () => Promise<T>, describe?: (v: T) => string): Promise<T | null> {
  try {
    const v = await fn();
    ok(label, describe ? describe(v) : "");
    return v;
  } catch (e) {
    bad(label, e);
    return null;
  }
}

/** First non-empty string field among the candidates, checking the `data` envelope too. */
function field(obj: Record<string, unknown> | undefined, ...names: string[]): string | null {
  if (!obj) return null;
  const d = parseData(obj);
  for (const n of names) {
    const v = obj[n] ?? d[n];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

async function readOnlyChecks() {
  console.log(`\nEngine: ${engineUrl()}\n`);
  console.log("READ-ONLY CHECKS");

  const reachable = await step(
    "engine reachable",
    () => engineFetch("/chats"),
    () => "responded",
  );
  if (reachable === null) {
    console.log(
      "\n  Engine did not respond. Start Marinara, or set MARINARA_EXTENDER_ENGINE_URL\n" +
        "  if it runs somewhere other than http://127.0.0.1:7860.\n" +
        "  If it needs Basic auth, set MARINARA_EXTENDER_ENGINE_BASIC_AUTH=user:pass.",
    );
    return null;
  }

  const chats = await step("listChats()", () => listChats(), (c) => `${c.length} chat(s)`);
  await step("listCharacters()", () => listCharacters(), (c) => `${c.length} character(s)`);
  await step("listLorebooks()", () => listLorebooks(), (l) => `${l.length} lorebook(s)`);

  // Messages are the poller's actual input — prove a real chat returns real
  // turns, and that the limit is honoured (the endpoint is unbounded without it).
  if (chats && chats.length > 0) {
    const chatId = field(chats[0], "id");
    if (chatId) {
      await step(
        `listMessages("${chatId}", { limit: 5 })`,
        () => listMessages(chatId, { limit: 5 }),
        (m) => {
          if (m.length === 0) return "0 messages (empty chat)";
          const last = m[m.length - 1];
          const role = field(last, "role", "sender") ?? "?";
          const text = (field(last, "content", "text", "message") ?? "").replace(/\s+/g, " ").slice(0, 60);
          return `${m.length} message(s), last role=${role} "${text}…"`;
        },
      );
    }
  } else {
    console.log("  SKIP  listMessages — no chats exist yet");
  }

  return chats;
}

async function writeRoundTrip(chats: Record<string, unknown>[] | null) {
  console.log("\nWRITE ROUND-TRIP (throwaway lorebook, cleaned up at the end)");

  const characters = await listCharacters().catch(() => [] as Record<string, unknown>[]);
  const characterId =
    field(characters[0], "id") ?? (chats && chats[0] ? field(chats[0], "characterId", "character_id") : null);

  if (!characterId) {
    console.log("  SKIP  no character found to attach a lorebook to — create one in Marinara first");
    return;
  }

  let lorebookId: string | null = null;
  try {
    const created = await step(
      "createLorebook()",
      () =>
        createLorebook({
          name: SMOKE_LOREBOOK_NAME,
          characterId,
          enabled: true,
          tokenBudget: ME_LOREBOOK_TOKEN_BUDGET,
        }),
      (r) => `id=${field(r ?? undefined, "id") ?? "?"}`,
    );
    lorebookId = field(created ?? undefined, "id");
    if (!lorebookId) {
      console.log("        Create returned no usable id — aborting the write pass.");
      return;
    }

    // The single most important assertion in this script. The engine's default
    // per-lorebook budget is 2048 and it SILENTLY DROPS entries above it — the
    // recurring cause of "memory just stopped working" with everything else
    // green. If this ever stops holding, memory injection is broken.
    await step(
      "patchLorebook() tokenBudget honoured",
      async () => {
        await patchLorebook(lorebookId!, { tokenBudget: ME_LOREBOOK_TOKEN_BUDGET });
        const all = await listLorebooks();
        const mine = all.find((lb) => field(lb, "id") === lorebookId);
        const budget = Number(field(mine, "tokenBudget") ?? 0);
        if (budget < ME_LOREBOOK_TOKEN_BUDGET) {
          throw new Error(`tokenBudget read back as ${budget}, expected ${ME_LOREBOOK_TOKEN_BUDGET}`);
        }
        return budget;
      },
      (b) => `tokenBudget=${b}`,
    );

    await step("createLorebookEntry()", () =>
      createLorebookEntry(lorebookId!, {
        keys: [],
        constant: true,
        locked: false,
        role: "system",
        noVector: true,
        sticky: 0,
        cooldown: 0,
        delay: 0,
        ephemeral: 0,
        name: "Memory System — SMOKE TEST",
        content: "smoke test entry",
        order: 0,
        enabled: true,
      }),
    );

    const entries = await step(
      "listLorebookEntries()",
      () => listLorebookEntries(lorebookId!),
      (e) => `${e.length} entry(ies)`,
    );

    const entryId = entries && entries.length > 0 ? field(entries[0], "id", "uid", "_id") : null;
    if (entryId) {
      // Unlock-then-delete: a locked entry refuses deletion and silently
      // survives, which is how stale memory used to linger. Slice lxp depends
      // on this sequence working.
      await step("patchLorebookEntry() unlock + deleteLorebookEntry()", async () => {
        await patchLorebookEntry(lorebookId!, entryId, { locked: false });
        await deleteLorebookEntry(lorebookId!, entryId);
        const left = await listLorebookEntries(lorebookId!);
        if (left.some((e) => field(e, "id", "uid", "_id") === entryId)) {
          throw new Error("entry still present after delete");
        }
        return true;
      });
    } else {
      console.log("  SKIP  entry delete — no entry id came back from listLorebookEntries()");
    }
  } finally {
    if (lorebookId) {
      try {
        await deleteLorebook(lorebookId);
        console.log(`  CLEAN removed smoke lorebook ${lorebookId}`);
      } catch (e) {
        failed++;
        console.log(
          `  FAIL  cleanup — could not delete lorebook ${lorebookId}: ${String(e)}\n` +
            `        Delete "${SMOKE_LOREBOOK_NAME}" by hand in Marinara.`,
        );
      }
    }
  }
}

async function main() {
  const write = process.argv.includes("--write");
  const chats = await readOnlyChecks();

  if (chats === null) {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(1);
  }

  if (write) await writeRoundTrip(chats);
  else console.log("\n(write round-trip skipped — re-run with --write to exercise lorebook mutations)");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke test crashed:", e);
  process.exit(1);
});
