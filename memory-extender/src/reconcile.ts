// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Agentic fact-reconciliation curator (MarinaraExtender-5ny — implements FR3 of
// the 2r3 roadmap, via the Claude Agent SDK instead of a single gated prompt).
//
// FR2 (6x9) gave facts a supersession model: a newer fact replaces an older one
// as a TIER MOVE (active -> cold, kept-but-not-current, queryable as a negative
// fact), not a delete. FR3 is the hard part — DECIDING, for a candidate fact and
// the existing same-subject fact(s), which of four things is true:
//
//   UPDATE   incoming supersedes existing      -> save new, supersede old by it
//   NEGATE   incoming disproves existing       -> save new, supersede old by it
//                                                 (old kept as the negative fact)
//   EXPAND   both true, complementary          -> save new, keep both
//   DISTINCT false collision (different facts)  -> save new, keep both
//   (plus)   CREATE    no related fact exists   -> save new
//            DUPLICATE already represented      -> no-op
//
// The curator is a tool-using agent: it SEARCHES the subject's ledger, READS the
// candidates, then records ONE verdict. This is genuinely multi-step (which is
// why the SDK earns its place here, vs. the provider-agnostic one-shot calls the
// rest of the extender uses). It is ADDITIVE + opt-in and does NOT touch the live
// turn path: the read tools are scoped to one ledger, the act is deferred to
// applyDecision(), and the whole loop runs offline/on-demand (scripts/reconcile-
// facts.mjs), gated on the Claude CLI being logged in.
//
// AUTH: the Agent SDK resolves credentials ANTHROPIC_API_KEY -> logged-in Claude
// CLI session -> claude.ai session. We rely on the CLI-session path by default —
// no key, no baseURL — so this bills against the existing Claude login and leaves
// the OpenAI-compatible core (Ollama/linkapi) completely untouched.

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Scope, Lane } from "./storage.js";
import { readIndex, readEntry, supersedeEntry } from "./storage.js";
import { jaccardSimilarity } from "./dedup.js";
import type { AmbientFact } from "./ambient.js";
import { resolveFactTarget, saveFact, type FactContext } from "./facts.js";
import { readQueue, removeTasks, appendAudit, appendHeld, type ReconcileTask } from "./reconcile-queue.js";
import { applyGate } from "./apply-gate.js";

// FR3 decision vocabulary (verbatim from 15x), plus the two no-collision cases.
export type Verdict = "CREATE" | "UPDATE" | "EXPAND" | "DISTINCT" | "NEGATE" | "DUPLICATE";

export interface CuratorDecision {
  verdict: Verdict;
  targetId?: string; // existing entry the verdict acts on (UPDATE/NEGATE/DUPLICATE)
  rationale: string;
  confidence?: "high" | "medium" | "low"; // the curator's self-reported certainty
}

// One unit of reconciliation work — a candidate fact paired with the verdict the
// curator reached. This is what the dry-run ledger stores and --apply replays.
export interface ReconcileItem {
  candidate: AmbientFact;
  decision: CuratorDecision;
}

const MODEL = () => process.env.MARINARA_EXTENDER_RECONCILE_MODEL?.trim() || "opus";

// Opt-in flag for any live/automatic invocation. The script is an explicit
// invocation and runs regardless; this guards future live-path wiring so the
// Anthropic-coupled path never fires unless deliberately enabled.
export function reconcileEnabled(): boolean {
  const v = process.env.MARINARA_EXTENDER_RECONCILE?.trim();
  return v === "1" || v?.toLowerCase() === "on";
}

export function loginHint(): string {
  return "The reconciliation curator uses the Claude Agent SDK on your logged-in CLI session. "
    + "If it can't authenticate, run `claude` once to log in (or `claude setup-token`), "
    + "or set ANTHROPIC_API_KEY. The rest of the extender is unaffected.";
}

const SYSTEM_PROMPT = `You are a memory curator for a roleplay companion. Your ONE job: decide how a
candidate fact relates to the facts already stored about the same subject, then
record exactly one verdict.

Workflow, every time:
1. Call search_entries to see the subject's existing stored facts.
2. Call read_entry on any whose summary looks related, to read the full text.
3. Call decide ONCE with your verdict, a one-sentence rationale, and your confidence (high/medium/low: high when the ledger clearly supports the verdict, low when it is genuinely ambiguous and you are guessing).

Verdicts:
- CREATE   — no existing fact covers this. (no targetId)
- DUPLICATE — an existing fact already says this; storing it again adds nothing. (targetId = that fact)
- UPDATE   — the candidate is a newer/corrected version of an existing fact that should replace it. (targetId = the one it replaces)
- NEGATE   — the candidate disproves an existing fact (the existing one is now false). (targetId = the disproven fact)
- EXPAND   — the candidate and an existing fact are both true and complementary; keep both. (targetId = the related fact)
- DISTINCT — the candidate looks similar to an existing fact but is genuinely a different fact; keep both. (targetId = the look-alike)

Rules:
- Reconcile only against facts about the SAME subject. Never invent facts.
- Prefer DISTINCT/EXPAND over UPDATE unless the candidate clearly replaces or corrects the older fact — superseding is not free.
- When unsure between CREATE and DUPLICATE, read the candidates first.
- Decide based only on what the tools return. Do not use any other tools.`;

// Bound the curator's view of a mature ledger (5f2). Returning every active entry
// (professor_mari has ~4250) is both expensive and TRIAGES — the Ledger Pattern
// failure. Instead: always PIN the structurally-flagged colliding entry (so the
// key fact is never missed regardless of ranking), then fill up to `cap` more by
// lexical relevance to the candidate (jaccardSimilarity — the same measure that
// flagged the collision). Pure + exported so the selection is testable offline.
export const LEDGER_VIEW_CAP = 50;

export function selectLedgerView(
  entries: { id: string; lane: Lane; summary: string; supersededBy?: string }[],
  candidateText: string,
  opts?: { focusId?: string; cap?: number },
): { rows: { id: string; lane: Lane; summary: string }[]; total: number } {
  const active = entries.filter((e) => !e.supersededBy); // superseded facts live in cold
  const cap = Math.max(1, opts?.cap ?? LEDGER_VIEW_CAP);
  const picked = new Map<string, { id: string; lane: Lane; summary: string }>();
  const take = (e: { id: string; lane: Lane; summary: string }) => {
    if (!picked.has(e.id)) picked.set(e.id, { id: e.id, lane: e.lane, summary: e.summary });
  };
  // Pin the flagged collision first — it must always be in view.
  if (opts?.focusId) {
    const f = active.find((e) => e.id === opts.focusId);
    if (f) take(f);
  }
  // Then the most lexically-relevant entries to the candidate, up to the cap.
  const ranked = active
    .map((e) => ({ e, score: jaccardSimilarity(candidateText, e.summary) }))
    .sort((a, b) => b.score - a.score);
  for (const { e } of ranked) {
    if (picked.size >= cap) break;
    take(e);
  }
  return { rows: [...picked.values()], total: active.length };
}

// Build the curator's tools, scoped to ONE ledger (scope/scopeId). The read tools
// expose only summaries + content of ACTIVE (non-superseded) entries; the decide
// tool captures the verdict into `captured` and ends the turn. There is NO write
// tool — the act is deferred to applyDecision so dry-run and --apply share one
// code path and the agent can never mutate memory directly. `focusId` (when known
// from the live FR1 trigger) pins the colliding entry into the bounded view.
function buildCuratorTools(scope: Scope, scopeId: string, candidate: AmbientFact, focusId?: string) {
  let captured: CuratorDecision | null = null;

  const search_entries = tool(
    "search_entries",
    "List the subject's existing stored facts (id, lane, summary), most relevant first. Call this first.",
    { lane: z.string().optional().describe("optional lane filter: user_topics | character_topics | open_threads") },
    async ({ lane }) => {
      const idx = await readIndex(scope, scopeId);
      const filtered = (idx?.entries ?? []).filter((e) => (lane ? e.lane === lane : true));
      const { rows, total } = selectLedgerView(filtered, candidate.fact, { focusId });
      const header = `Candidate to reconcile: "${candidate.fact}" (lane ${candidate.lane}, subject ${candidate.subject ?? "?"}).`;
      if (rows.length === 0) return { content: [{ type: "text", text: `${header}\n\nThis ledger has no stored facts yet.` }] };
      const note = rows.length < total
        ? `\n\n(showing the ${rows.length} most relevant of ${total} active facts${focusId ? ", including the flagged collision" : ""} — ranked by relevance; read_entry any for full text.)`
        : "";
      return {
        content: [{
          type: "text",
          text: `${header}\n\nExisting facts in this ledger:\n${rows.map((r) => `- [${r.id}] (${r.lane}) ${r.summary}`).join("\n")}${note}`,
        }],
      };
    },
    { annotations: { readOnlyHint: true } },
  );

  const read_entry = tool(
    "read_entry",
    "Read the full text of one existing fact by its id.",
    { id: z.string().describe("the entry id from search_entries") },
    async ({ id }) => {
      const idx = await readIndex(scope, scopeId);
      const row = idx?.entries.find((e) => e.id === id);
      if (!row) return { content: [{ type: "text", text: `No entry with id ${id}.` }] };
      const entry = await readEntry(scope, scopeId, row.path);
      return {
        content: [{
          type: "text",
          text: entry ? `[${id}] (${row.lane}) ${entry.summary}\n\n${entry.content}` : `Entry ${id} has no readable content.`,
        }],
      };
    },
    { annotations: { readOnlyHint: true } },
  );

  const decide = tool(
    "decide",
    "Record your final verdict for the candidate. Call exactly once, then stop.",
    {
      verdict: z.enum(["CREATE", "UPDATE", "EXPAND", "DISTINCT", "NEGATE", "DUPLICATE"]),
      targetId: z.string().optional().describe("the existing entry id this verdict acts on (omit for CREATE)"),
      rationale: z.string().describe("one sentence: why this verdict"),
      confidence: z.enum(["high", "medium", "low"]).describe("high = the ledger clearly supports this; low = genuinely ambiguous, you are guessing"),
    },
    async ({ verdict, targetId, rationale, confidence }) => {
      captured = { verdict, targetId, rationale, confidence };
      return { content: [{ type: "text", text: `Recorded ${verdict} (${confidence}). You are done — end your turn.` }] };
    },
    { annotations: { readOnlyHint: true } }, // it mutates only our closure, not memory
  );

  return { server: createSdkMcpServer({ name: "memory", version: "1.0.0", tools: [search_entries, read_entry, decide] }), get: () => captured };
}

// LIVE PATH: run the curator agent over one candidate and return its verdict.
// Requires the Agent SDK + a logged-in Claude CLI session. Returns null if the
// candidate has no resolvable home, or if the agent ended without deciding.
// `focusId` (the live FR1 collision the structural rule flagged) is pinned into
// the curator's bounded ledger view and called out in the kickoff prompt.
export async function runCurator(candidate: AmbientFact, ctx: FactContext, opts?: { focusId?: string }): Promise<CuratorDecision | null> {
  const target = await resolveFactTarget(candidate, ctx);
  if (!target) return null; // empty/undroppable summary — nothing to reconcile

  const { server, get } = buildCuratorTools(target.scope, target.scopeId, candidate, opts?.focusId);
  const toolNames = ["mcp__memory__search_entries", "mcp__memory__read_entry", "mcp__memory__decide"];

  const run = query({
    prompt: `Reconcile this candidate fact against the subject's existing memory: "${candidate.fact}"${opts?.focusId ? `\n\nA structural duplicate check flagged it as colliding with stored entry ${opts.focusId} — examine that one first, then decide.` : ""}`,
    options: {
      model: MODEL(),
      systemPrompt: SYSTEM_PROMPT, // plain string (NOT the claude_code preset) — a focused curator, not a coding agent
      mcpServers: { memory: server },
      allowedTools: toolNames,
      // Defense in depth: deny anything that isn't one of our three tools, so the
      // curator can never reach the built-in Bash/Write/Read or escape the ledger.
      canUseTool: async (name: string) =>
        toolNames.includes(name) ? { behavior: "allow", updatedInput: {} } : { behavior: "deny", message: "Only the memory tools are available." },
      maxTurns: 12,
    },
  });

  for await (const _msg of run) { /* drive the loop to completion; verdict is captured by the decide tool */ }
  return get();
}

// PURE PATH (offline-testable): execute one already-decided verdict against the
// store. This is what --apply replays from the ledger; the agent never runs here.
// Mirrors the dedup/supersede primitives FR2 (6x9) already built — UPDATE/NEGATE
// are a tier move (save new, supersede old by it), EXPAND/DISTINCT keep both,
// DUPLICATE is a no-op.
export async function applyDecision(
  item: ReconcileItem,
  ctx: FactContext,
  sourceChatId?: string,
): Promise<{ verdict: Verdict; createdId?: string; supersededId?: string; note?: string }> {
  const { candidate, decision } = item;

  if (decision.verdict === "DUPLICATE") {
    return { verdict: "DUPLICATE", note: "no-op (already represented)" };
  }

  // Every other verdict writes the candidate. force:true bypasses the structural
  // dedup gate — the curator has already ruled this is not a pure duplicate, so
  // the Jaccard gate must not re-collapse it (it would, for UPDATE/EXPAND/DISTINCT,
  // since those are lexically near the very fact they collided with).
  const saved = await saveFact(candidate, ctx, sourceChatId, { force: true });
  if (!saved) {
    // Only happens if the candidate has no resolvable home (blank summary).
    return { verdict: decision.verdict, note: "candidate had no resolvable home — nothing written" };
  }

  // UPDATE / NEGATE supersede the targeted older fact (tier move, not delete).
  if ((decision.verdict === "UPDATE" || decision.verdict === "NEGATE") && decision.targetId) {
    const target = await resolveFactTarget(candidate, ctx); // same ledger the candidate saved into
    if (target) {
      const ok = await supersedeEntry(target.scope, target.scopeId, decision.targetId, saved.id);
      if (ok) return { verdict: decision.verdict, createdId: saved.id, supersededId: decision.targetId };
      return { verdict: decision.verdict, createdId: saved.id, note: `supersede target ${decision.targetId} not found` };
    }
  }

  // CREATE / EXPAND / DISTINCT: the save is the whole action.
  return { verdict: decision.verdict, createdId: saved.id };
}

// CONVENIENCE (live, non-ledger): decide then apply in one call. The script uses
// the split form (decide -> ledger -> apply) instead, for resumability and the
// preview==apply guarantee; this is for a future live FR1-gated integration.
export async function reconcileCandidate(
  candidate: AmbientFact,
  ctx: FactContext,
  sourceChatId?: string,
): Promise<{ verdict: Verdict; createdId?: string; supersededId?: string } | null> {
  const decision = await runCurator(candidate, ctx);
  if (!decision) return null;
  return applyDecision({ candidate, decision }, ctx, sourceChatId);
}

// ── Cluster adjudication (0kk — ledger hygiene sweep) ────────────────────────
// A DIFFERENT curator interaction from runCurator: instead of reconciling one new
// candidate against a searched ledger, the curator is GIVEN a small cluster of
// already-stored facts a similarity check flagged as possible duplicates, and
// judges the whole cluster at once — picking the canonical entry to keep and the
// redundant ones to retire, or ruling them genuinely distinct. Cluster-at-once
// (not pairwise) preserves the "which of N is most canonical" signal; measured
// max fact-cluster size is 4, so the whole cluster fits one call comfortably.

export interface ClusterMember { id: string; summary: string; content: string }

export interface ClusterVerdict {
  verdict: "merge" | "distinct";
  canonicalId?: string;    // merge: the entry to KEEP
  redundantIds?: string[]; // merge: entries to supersede by the canonical
  rationale: string;
  confidence?: "high" | "medium" | "low";
}

const CLUSTER_SYSTEM_PROMPT = `You are a memory curator. You are given a small CLUSTER of stored facts about the same subject that a similarity check flagged as possible duplicates. Judge the whole cluster at once.

Decide ONE outcome:
- merge — they describe ONE underlying fact (restatements/near-duplicates). Pick the single most complete, canonical entry to KEEP (canonicalId), and list every other cluster member as redundant (redundantIds) to be retired.
- distinct — they are genuinely different facts that merely share wording; keep them all.

Rules:
- Only merge TRUE redundancies. If members add different information (different details, different events, different relationships), prefer distinct — retiring a fact is not free.
- The canonical entry should be the most complete and accurate phrasing.
- canonicalId and every redundantId MUST be ids from the cluster. Decide based only on the cluster shown.

Call decide_cluster exactly once, then stop.`;

export async function clusterCurator(members: ClusterMember[]): Promise<ClusterVerdict | null> {
  if (members.length < 2) return null;
  let captured: ClusterVerdict | null = null;

  const ids = new Set(members.map((m) => m.id));
  const decide_cluster = tool(
    "decide_cluster",
    "Record your verdict for the whole cluster. Call exactly once, then stop.",
    {
      verdict: z.enum(["merge", "distinct"]),
      canonicalId: z.string().optional().describe("merge only: the id to KEEP"),
      redundantIds: z.array(z.string()).optional().describe("merge only: the ids to retire (supersede by canonical)"),
      rationale: z.string().describe("one sentence: why"),
      confidence: z.enum(["high", "medium", "low"]).describe("high = clearly the same/different; low = genuinely borderline"),
    },
    async ({ verdict, canonicalId, redundantIds, rationale, confidence }) => {
      // Defensive: only accept ids that are actually in the cluster.
      const canon = canonicalId && ids.has(canonicalId) ? canonicalId : undefined;
      const redund = (redundantIds ?? []).filter((r) => ids.has(r) && r !== canon);
      captured = verdict === "merge" && canon && redund.length > 0
        ? { verdict: "merge", canonicalId: canon, redundantIds: redund, rationale, confidence }
        : { verdict: "distinct", rationale, confidence };
      return { content: [{ type: "text", text: `Recorded ${captured.verdict} (${confidence}). You are done — end your turn.` }] };
    },
    { annotations: { readOnlyHint: true } },
  );

  const server = createSdkMcpServer({ name: "memory", version: "1.0.0", tools: [decide_cluster] });
  const listing = members.map((m) => `- [${m.id}] ${m.summary}\n      ${m.content.slice(0, 240).replace(/\s+/g, " ")}`).join("\n");
  const run = query({
    prompt: `These stored facts were flagged as possible duplicates of each other. Judge the cluster:\n\n${listing}`,
    options: {
      model: MODEL(),
      systemPrompt: CLUSTER_SYSTEM_PROMPT,
      mcpServers: { memory: server },
      allowedTools: ["mcp__memory__decide_cluster"],
      canUseTool: async (name: string) =>
        name === "mcp__memory__decide_cluster" ? { behavior: "allow", updatedInput: {} } : { behavior: "deny", message: "Only decide_cluster is available." },
      maxTurns: 4,
    },
  });
  for await (const _msg of run) { /* drive to completion; verdict captured by decide_cluster */ }
  return captured;
}

// ── Live queue drain (b4n) ───────────────────────────────────────────────────
// Reconstruct the curator inputs from a queued live collision. subject is left
// undefined ON PURPOSE so resolveFactTarget routes back to the ledger the
// collision happened in (scope/scopeId), rather than re-routing by a subject name.
function taskToCandidate(t: ReconcileTask): AmbientFact {
  return { text: t.content, fact: t.summary, lane: t.lane, scope: t.scope === "chat" ? "chat" : "character" };
}
function taskToCtx(t: ReconcileTask): FactContext {
  // identityKey and fallbackChatId both = scopeId so resolveFactTarget lands on
  // the exact ledger for either scope.
  return { identityKey: t.scopeId, fallbackChatId: t.scopeId, characterName: t.scopeId };
}

export type CurateFn = (candidate: AmbientFact, ctx: FactContext, focusId?: string) => Promise<CuratorDecision | null>;

// Drain the live FR1 reconciliation queue. SHADOW by default: runs the curator,
// records the proposed verdict to the audit log, applies NOTHING — the rollout
// gate. With apply:true it also executes the verdict via applyDecision. Tasks are
// removed once recorded (their structural drop already stood in the live save).
// `curate` is injectable so the orchestration is testable offline.
export async function drainReconcileQueue(opts?: {
  apply?: boolean;
  gated?: boolean;
  limit?: number;
  curate?: CurateFn;
}): Promise<{ processed: number; decided: number; applied: number; held: number }> {
  const apply = opts?.apply ?? false;
  const gated = opts?.gated ?? true; // mjp: the live path has no human review, so gate by default
  const curate = opts?.curate ?? runCurator;
  const all = await readQueue();
  const tasks = opts?.limit && opts.limit > 0 ? all.slice(0, opts.limit) : all;

  let decided = 0;
  let applied = 0;
  let held = 0;
  const handled: string[] = [];

  for (const t of tasks) {
    const candidate = taskToCandidate(t);
    const ctx = taskToCtx(t);

    let decision: CuratorDecision | null = null;
    try {
      decision = await curate(candidate, ctx, t.againstId); // pin the flagged collision
    } catch {
      decision = null; // a curator failure on one task never aborts the drain
    }
    if (decision) decided++;

    let appliedRec: { createdId?: string; supersededId?: string } | undefined;
    let heldReasons: string[] | undefined;
    if (decision && apply) {
      const gate = gated
        ? applyGate({ confidence: decision.confidence, text: `${candidate.fact} ${t.againstSummary} ${decision.rationale}` })
        : { lane: "auto" as const, reasons: [] };
      if (gate.lane === "hold") {
        held++;
        heldReasons = gate.reasons;
        await appendHeld({
          source: "live", scope: t.scope, scopeId: t.scopeId,
          summary: `${decision.verdict}: "${t.summary}"`,
          confidence: decision.confidence, reasons: gate.reasons,
          detail: { task: t, decision }, at: new Date().toISOString(),
        });
      } else {
        const r = await applyDecision({ candidate, decision }, ctx, t.sourceChatId);
        appliedRec = { createdId: r.createdId, supersededId: r.supersededId };
        if (r.createdId || r.supersededId) applied++;
      }
    }

    await appendAudit({
      taskId: t.id,
      mode: apply ? "apply" : "shadow",
      scope: t.scope,
      scopeId: t.scopeId,
      candidate: t.summary,
      againstId: t.againstId,
      verdict: decision?.verdict ?? null,
      confidence: decision?.confidence,
      targetId: decision?.targetId,
      rationale: heldReasons ? `HELD for review (${heldReasons.join(", ")})` : decision?.rationale,
      applied: appliedRec,
      at: new Date().toISOString(),
    });
    handled.push(t.id);
  }

  await removeTasks(handled);
  return { processed: handled.length, decided, applied, held };
}
