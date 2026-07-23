// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Live smoke test for the lorebook write-back (MarinaraExtender-lxp).
//
//   npm run smoke:lorebook
//
// ⚠️ SAFETY — this code is DESTRUCTIVE by design: writeMemoryToLorebook deletes
// every entry in the target lorebook before recreating two. Pointed at a real
// character it would wipe that character's actual memory.
//
// So this script only ever operates on a SYNTHETIC character id that matches no
// real character, verifies that before writing anything, and deletes the
// lorebook it created on the way out. It never touches a lorebook it did not
// create in this run.

import {
  listCharacters,
  listLorebooks,
  listLorebookEntries,
  deleteLorebook,
  parseData,
} from "../src/engine-client.js";
import { syncMemoryToLorebook, ME_LOREBOOK_TOKEN_BUDGET } from "../src/lorebook-writer.js";

// Deliberately not a nanoid: a fixed, obvious, greppable id so a leaked
// lorebook is unmistakable in the UI.
const SYNTHETIC_CHARACTER_ID = "me-smoketest-synthetic-character";
const SYNTHETIC_NAME = "SMOKE TEST (safe to delete)";

const BLOCK_1 = "How to use memory: cite it naturally.\n\n<memory>\n- smoke fact one\n</memory>";
const BLOCK_2 = "How to use memory: cite it naturally.\n\n<memory>\n- smoke fact two (replaced)\n</memory>";

let passed = 0;
let failed = 0;
const ok = (l: string, d = "") => { passed++; console.log(`  PASS  ${l}${d ? ` — ${d}` : ""}`); };
const bad = (l: string, e: unknown) => { failed++; console.log(`  FAIL  ${l}\n        ${String(e)}`); };

function field(obj: Record<string, unknown> | undefined, ...names: string[]): string | null {
  if (!obj) return null;
  const d = parseData(obj);
  for (const n of names) {
    const v = obj[n] ?? d[n];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
  }
  return null;
}

async function findOurLorebook(): Promise<Record<string, unknown> | undefined> {
  const all = await listLorebooks();
  return all.find((lb) => field(lb, "characterId") === SYNTHETIC_CHARACTER_ID);
}

async function main() {
  console.log("\nLorebook write-back smoke test");
  console.log(`Synthetic character: ${SYNTHETIC_CHARACTER_ID}\n`);

  // ── Guard ───────────────────────────────────────────────────────────────────
  // Never write against a real character. This is the difference between a
  // diagnostic and data loss.
  const characters = await listCharacters().catch(() => [] as Record<string, unknown>[]);
  if (characters.some((c) => field(c, "id") === SYNTHETIC_CHARACTER_ID)) {
    console.log("  ABORT  a real character shares the synthetic id — refusing to write.");
    process.exit(1);
  }
  ok("guard", `${characters.length} real character(s), none collide`);

  const preexisting = await findOurLorebook();
  if (preexisting) {
    console.log(`  NOTE   leftover smoke lorebook ${field(preexisting, "id")} found — removing first`);
    await deleteLorebook(field(preexisting, "id")!).catch(() => {});
  }

  let lorebookId: string | null = null;
  try {
    // ── Pass 1: create + write ────────────────────────────────────────────────
    lorebookId = await syncMemoryToLorebook({
      characterId: SYNTHETIC_CHARACTER_ID,
      characterName: SYNTHETIC_NAME,
      memoryBlock: BLOCK_1,
    });
    if (!lorebookId) { bad("syncMemoryToLorebook() first pass", "returned null"); return; }
    ok("syncMemoryToLorebook() creates the lorebook", `id=${lorebookId}`);

    const lb = await findOurLorebook();
    const budget = Number(field(lb, "tokenBudget") ?? 0);
    if (budget >= ME_LOREBOOK_TOKEN_BUDGET) ok("token budget forced on create", `tokenBudget=${budget}`);
    else bad("token budget forced on create", `got ${budget}, expected >= ${ME_LOREBOOK_TOKEN_BUDGET}`);

    const entries1 = await listLorebookEntries(lorebookId);
    if (entries1.length === 2) ok("exactly two entries written", "");
    else bad("exactly two entries written", `got ${entries1.length}`);

    const instr = entries1.find((e) => field(e, "name")?.includes("Instructions"));
    const active = entries1.find((e) => field(e, "name")?.includes("Active Context"));

    if (instr && active) ok("both entries present by name", "");
    else bad("both entries present by name", `instr=${!!instr} active=${!!active}`);

    // constant:true is the whole injection mechanism — if the engine drops it,
    // memory silently stops reaching generations.
    const bothConstant = [instr, active].every((e) => String(field(e, "constant")) === "true");
    if (bothConstant) ok("entries persisted as constant (always-injected)", "");
    else bad("entries persisted as constant", `instr=${field(instr, "constant")} active=${field(active, "constant")}`);

    if (field(active, "content")?.includes("smoke fact one")) ok("memory content round-tripped", "");
    else bad("memory content round-tripped", `content=${String(field(active, "content")).slice(0, 80)}`);

    // ── Pass 2: rewrite (the nuke-and-recreate cycle) ─────────────────────────
    // This is the behaviour that broke before the content-type fix: if deletes
    // silently fail, entry count grows every turn instead of staying at two.
    const second = await syncMemoryToLorebook({
      characterId: SYNTHETIC_CHARACTER_ID,
      characterName: SYNTHETIC_NAME,
      memoryBlock: BLOCK_2,
    });
    if (second === lorebookId) ok("second pass reuses the same lorebook (no duplicate)", "");
    else bad("second pass reuses the same lorebook", `got ${second}`);

    const entries2 = await listLorebookEntries(lorebookId);
    if (entries2.length === 2) ok("still exactly two entries after rewrite", "");
    else bad("still exactly two entries after rewrite", `got ${entries2.length} — stale entries are surviving deletion`);

    const active2 = entries2.find((e) => field(e, "name")?.includes("Active Context"));
    const text2 = String(field(active2, "content") ?? "");
    if (text2.includes("smoke fact two") && !text2.includes("smoke fact one")) {
      ok("content replaced, not appended", "");
    } else {
      bad("content replaced, not appended", `content=${text2.slice(0, 120)}`);
    }

    // ── Pass 3: concurrent calls must not duplicate the lorebook (axu) ────────
    await Promise.all([
      syncMemoryToLorebook({ characterId: SYNTHETIC_CHARACTER_ID, characterName: SYNTHETIC_NAME, memoryBlock: BLOCK_1 }),
      syncMemoryToLorebook({ characterId: SYNTHETIC_CHARACTER_ID, characterName: SYNTHETIC_NAME, memoryBlock: BLOCK_2 }),
      syncMemoryToLorebook({ characterId: SYNTHETIC_CHARACTER_ID, characterName: SYNTHETIC_NAME, memoryBlock: BLOCK_1 }),
    ]);
    const allAfter = (await listLorebooks()).filter(
      (l) => field(l, "characterId") === SYNTHETIC_CHARACTER_ID,
    );
    if (allAfter.length === 1) ok("3 concurrent syncs produced exactly one lorebook (axu guard)", "");
    else bad("concurrent syncs produced one lorebook", `got ${allAfter.length}`);

    const entries3 = await listLorebookEntries(lorebookId);
    if (entries3.length === 2) ok("still exactly two entries after concurrent syncs", "");
    else bad("still exactly two entries after concurrent syncs", `got ${entries3.length}`);
  } finally {
    // Remove every lorebook belonging to the synthetic character, not just the
    // id we captured — if a duplicate DID get created, we must not leave it.
    const strays = (await listLorebooks().catch(() => []))
      .filter((l) => field(l, "characterId") === SYNTHETIC_CHARACTER_ID);
    for (const s of strays) {
      const id = field(s, "id");
      if (!id) continue;
      try {
        await deleteLorebook(id);
        console.log(`  CLEAN removed smoke lorebook ${id}`);
      } catch (e) {
        failed++;
        console.log(`  FAIL  cleanup — delete "${SYNTHETIC_NAME}" lorebook ${id} by hand: ${String(e)}`);
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke test crashed:", e);
  process.exit(1);
});
