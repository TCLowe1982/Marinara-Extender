// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Every prompt this system sends to a model, assembled (MarinaraExtender-pifl).
//
// WHY THIS EXISTS. The prompts live as template literals spread across six files,
// stitched together at call time from shared fragments. Reading one meant assembling
// it by hand from three places — so in practice nobody read them, and a prompt change
// shipped without review. That is not a hypothetical: the single most repeated
// sentence in the store (669 beats, 9% of everything) was a prompt EXAMPLE nobody had
// looked at end to end since it was added.
//
// A prompt you cannot read as a whole is a prompt nobody reviews.
//
// Two consumers, deliberately the same source:
//   - GET /prompts        the live text from the RUNNING build, so it is never stale
//   - docs/PROMPTS.md     regenerated and committed, so a prompt change shows up in
//                         a diff as readable prose instead of as a template-literal hunk
//
// Modules are imported DYNAMICALLY and individually guarded. Some prompt owners pull
// heavy dependencies (the curator drags the Agent SDK), and a catalogue that can break
// the sidecar to show you a string is not worth having.

export interface PromptDoc {
  id: string;
  title: string;
  /** Where it lives, so the reader can go and edit it. */
  source: string;
  /** When it fires, and against which model — the context a reviewer needs. */
  when: string;
  text: string;
}

async function safe(id: string, title: string, source: string, when: string, load: () => Promise<string>): Promise<PromptDoc> {
  try {
    return { id, title, source, when, text: await load() };
  } catch (err) {
    return { id, title, source, when, text: `(could not load: ${err instanceof Error ? err.message : String(err)})` };
  }
}

/** Every prompt, in the order a turn actually uses them. */
export async function collectPrompts(): Promise<PromptDoc[]> {
  const out: PromptDoc[] = [];

  out.push(await safe(
    "memory-instructions", "Memory instructions (injected into every character)",
    "src/loader.ts — memorySystemInstructions()",
    "Rides in the lorebook block on every turn. This is what teaches the character the [remember:] / [bookmark:] vocabulary.",
    async () => (await import("./loader.js")).memorySystemInstructions(),
  ));

  // Tier 2 — one system prompt per emotion, all sharing SHARED_RULES. Emitted in
  // full rather than as "one example plus a note": the shared block is where the
  // example-echo bug lived, and a reviewer has to see it in the form the model does.
  const emotions = ["fear", "shame", "hope", "desire", "relief", "vulnerability", "trust", "anger", "joy", "dysregulation"] as const;
  for (const e of emotions) {
    out.push(await safe(
      `analyzer-${e}`, `Tier 2 analyzer — ${e}`,
      "src/sentiment/analyzer.ts — buildSystemPrompt()",
      `Fires per salient chunk whose primary emotion is ${e}. Local model first, external API on failure. Its "motivation" rules are shared across all ten.`,
      // NO ANGLE BRACKETS IN REVIEW PLACEHOLDERS. `<structural subpatterns, when
      // matched>` reads as an HTML tag and vanishes somewhere in the path that
      // delivers this file to a reviewer — even inside a ```text fence. The result
      // is a line reading "...in the text: ." with a hollow slot, which has now been
      // reported as a code bug THREE times: at the 2026-08-04 prompt-suite review
      // (bookmark w4famc1gwc, "dysregulation empty-slot bug"), in the vikj packet,
      // and again on reading this dump. The analyzer was correct every time.
      //
      // This file exists so prompts are REVIEWABLE. A placeholder that disappears
      // defeats its only purpose, so placeholders here are parenthesised caps.
      async () => (await import("./sentiment/analyzer.js")).buildSystemPrompt(e, e === "dysregulation" ? ["(STRUCTURAL SUBPATTERNS, WHEN MATCHED)"] : []),
    ));
  }

  // The SECOND shipped variant of the shared block. buildSystemPrompt swaps the
  // thread rule when the user prompt will carry no "Active threads" list, so this
  // is live text on every call in a chat with no open threads — which is every
  // chat's first turns. Emitted because a variant nobody can read is a variant
  // nobody reviews, and the whole point of this file is that TC sees what ships.
  out.push(await safe(
    "analyzer-no-threads", "Tier 2 analyzer — fear, with NO active threads",
    "src/sentiment/analyzer.ts — buildSystemPrompt(e, [], hasThreads=false)",
    "Identical to the above except the thread rule drops its reference to the absent \"Active threads\" list. The label-minting half is deliberately KEPT: every chat starts with zero threads, so this variant is the only path by which a first thread is ever created. Measured delta: 23 tokens.",
    async () => (await import("./sentiment/analyzer.js")).buildSystemPrompt("fear", [], false),
  ));

  out.push(await safe(
    "ambient-facts", "Tier 3 ambient facts (live turn)",
    "src/ambient.ts — SYSTEM_PROMPT",
    "One batched call per turn over pre-filtered candidate sentences. Extracts durable identity/preference facts the beat path would miss.",
    async () => (await import("./ambient.js")).SYSTEM_PROMPT,
  ));

  out.push(await safe(
    "scene-facts", "Scene facts (import)",
    "src/ambient.ts — SCENE_FACTS_SYSTEM_PROMPT",
    "Import path only. Reads scene prose directly rather than pre-filtered sentences, because a durable fact often spans fragments.",
    async () => (await import("./ambient.js")).SCENE_FACTS_SYSTEM_PROMPT,
  ));

  out.push(await safe(
    "fact-judge", "Durability judge",
    "src/ambient.ts — JUDGE_SYSTEM_PROMPT",
    "Second pass over scene-fact candidates before anything reaches permanent memory. Fails OPEN (keeps all) if the model is unavailable.",
    async () => (await import("./ambient.js")).JUDGE_SYSTEM_PROMPT,
  ));

  out.push(await safe(
    "digest", "Tier 1 digest (full import)",
    "src/digest.ts — buildSystemPrompt()",
    "Bulk import of a chat log into memory entries.",
    async () => (await import("./digest.js")).buildSystemPrompt("(CHARACTER NAME)"),
  ));

  out.push(await safe(
    "snapshot", "Tier 1 snapshot (periodic)",
    "src/digest.ts — buildSnapshotSystemPrompt()",
    "Roughly every 30 minutes of active chat. Deliberately framed narrower than the full digest — this window, not the archive.",
    async () => (await import("./digest.js")).buildSnapshotSystemPrompt("(CHARACTER NAME)"),
  ));

  out.push(await safe(
    "arc-renderer", "Arc renderer",
    "src/arc-renderer.ts — SYSTEM_PROMPT",
    "Every 60 turns. Renders clustered beats into a named through-line arc; one call per touched arc, hence the slow cadence.",
    async () => (await import("./arc-renderer.js")).SYSTEM_PROMPT,
  ));

  out.push(await safe(
    "curator-live", "Reconciliation curator — live collision",
    "src/reconcile.ts — SYSTEM_PROMPT",
    "Out-of-band drain, gated by MARINARA_EXTENDER_RECONCILE. Never runs on the turn path.",
    async () => (await import("./reconcile.js")).SYSTEM_PROMPT,
  ));

  out.push(await safe(
    "curator-cluster", "Reconciliation curator — cluster sweep",
    "src/reconcile.ts — CLUSTER_SYSTEM_PROMPT",
    "Ledger hygiene sweep. Judges a whole similarity cluster at once rather than pairwise.",
    async () => (await import("./reconcile.js")).CLUSTER_SYSTEM_PROMPT,
  ));

  return out;
}

/** The catalogue as Markdown — what docs/PROMPTS.md contains. */
export async function promptsAsMarkdown(version: string): Promise<string> {
  const docs = await collectPrompts();
  const lines: string[] = [
    "# Marinara Extender — every prompt, assembled",
    "",
    "**Generated — do not edit by hand.** Regenerate with `node scripts/dump-prompts.mjs`.",
    "",
    "The prompts live as template literals across six files and are stitched together at",
    "call time. This file is the assembled truth, committed so that a prompt change shows",
    "up in review as readable prose rather than as a diff of string fragments.",
    "",
    `Build: \`${version}\``,
    "",
    "| Prompt | Fires |",
    "|---|---|",
    ...docs.map((d) => `| [${d.title}](#${d.id}) | ${d.when.split(".")[0]}. |`),
    "",
  ];
  for (const d of docs) {
    lines.push(
      `<a id="${d.id}"></a>`,
      "",
      `## ${d.title}`,
      "",
      `**Source:** \`${d.source}\`  `,
      `**When:** ${d.when}`,
      "",
      "```text",
      d.text,
      "```",
      "",
    );
  }
  return lines.join("\n");
}
