// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Structural shape classification — telling code-SHAPED content from prose.
//
// ⚠ NOT WIRED IN, AND IT CLASSIFIES ONLY. Nothing calls this yet, and nothing
// here deletes, strips or drops anything. It answers one question — "is this
// chunk code-shaped?" — and the answer is meant to ROUTE (ops lane, marked and
// greppable forever), never to discard. Disposition belongs to the lane.
//
// WHY IT IS SCOPED THIS NARROWLY (Mari, 2026-08-05). Two kinds of contamination
// reached the pipeline and they need different instruments:
//
//   CODE-SHAPED — yaml, opie reports, bench tables, logs, file paths. Structure
//     is visible without understanding content, so a dumb structural scorer
//     earns it at high precision and no LLM belongs anywhere near the path.
//     `status: open` dies here. This module is that scorer, and that is ALL it is.
//
//   PROSE-SHAPED — "insists the boat was green" has no braces to detect. It is
//     grammatical English wearing a lab coat, and content-level detection will
//     never catch it, because content-wise it IS conversation. The only honest
//     signal is PROVENANCE: it arrived inside a paste. That is mechanics (fence
//     + size prior), not regex, and it does not live in this file.
//
// The lesson underneath both: what died on 2026-08-04 was string-matching
// against shape-shifting content. Regex is hired here only where shape is
// genuinely stable, and is explicitly not asked to do the other job.
//
// HOUSE LAW — A NET THAT DEPENDS ON REMEMBERING TO TAG IS ADHD-HOSTILE. Fences
// and explicit markers are an OVERRIDE that raises confidence, never the
// dependency. The structural layers do the work whether or not anyone marked
// anything. Combined with mark-don't-drop, a miss is a re-file, not a wound.
//
// CHUNK-LEVEL, NOT MESSAGE-LEVEL. The prose AROUND a paste is real memory —
// "Thomas pasted the bench and Mari amended her ruling live" is a true event
// that happened. partitionProse keeps the two separable, so a message carrying
// a paste is never judged as one indivisible unit.

/** A line that is structurally not prose, with the rule that caught it. */
export interface NonProseHit {
  line: string;
  rule: string;
}

export interface ShapeVerdict {
  /** Code-shaped enough to route to the ops lane. */
  opsShaped: boolean;
  /** Fraction of non-blank lines that are structurally non-prose. */
  lineRatio: number;
  /** Which rules fired, most frequent first — for reports and for the lane's record. */
  signals: string[];
  /** Lines that read as prose. May be non-empty even when opsShaped. */
  prose: string[];
  /** Lines that read as structure. */
  dropped: NonProseHit[];
}

// ── Individual rules ──────────────────────────────────────────────────────────
//
// Each is deliberately narrow. A missed code line costs one junk beat; a false
// positive silently misfiles a confession. Recall is sacrificed for precision
// everywhere the two conflict.

const RULES: { name: string; test: (line: string) => boolean }[] = [
  {
    // `status: open`, `merge_threshold: 0.72`, `- name: foo`
    //
    // THE KEY MUST START LOWERCASE AND CONTAIN NO SPACES — the one condition
    // separating a YAML key from a speaker. Character names are capitalised, so
    // "Mari: I can't do this" is untouched. This is the same vocabulary 4ghy
    // needs in the chunker's speaker rule: yaml keys and filenames aren't people.
    //
    // THE VALUE MUST NOT BE A SENTENCE, or prose like "note: she never came
    // back" is swept up. >3 tokens or terminal punctuation means prose.
    name: "config-key",
    test: (l) => {
      const m = /^\s*(?:[-*]\s*)?["']?([a-z_][a-z0-9_.-]*)["']?\s*:\s*(.*)$/.exec(l);
      if (!m) return false;
      const value = m[2]!.trim();
      if (value === "") return true;                      // `chunking:` — a bare key
      if (/[.!?]["')]?$/.test(value)) return false;       // ends like a sentence
      return (value.match(/[\p{L}\p{N}]+/gu) ?? []).length <= 3;
    },
  },
  {
    // `"POST",` — a bare string literal, optionally comma-terminated.
    name: "bare-literal",
    test: (l) => /^\s*["'][^"']{0,40}["'],?\s*$/.test(l),
  },
  {
    // `README.md`, `src/foo.ts`, `D:\path\file.json`
    name: "path-or-filename",
    test: (l) => /^\s*[\w./\\@-]+\.(md|markdown|ts|tsx|js|jsx|mjs|cjs|json|ya?ml|txt|py|rs|go|sh|ps1|bat|toml|ini|lock|csv)\s*$/i.test(l),
  },
  {
    // `ca23ba8`, `1f8ef6c feat(s8qe): ...` — a git short hash at line start.
    // Requires a digit so ordinary lowercase words ("deadbeef" aside) don't hit.
    name: "commit-hash",
    test: (l) => /^\s*[0-9a-f]{7,40}\b/.test(l) && /\d/.test((/^\s*([0-9a-f]{7,40})\b/.exec(l) ?? ["", ""])[1]!),
  },
  {
    // `.......#.##...`, `###.###.###`, box drawing, `| --- | --- |`
    //
    // Ratio-based rather than a character list, so it catches art nobody
    // predicted. The length floor keeps it off "...", "?!", "--" — ordinary
    // emotional punctuation, and the ellipsis_shutdown signal depends on it.
    name: "diagram-or-rule",
    test: (l) => {
      const s = l.trim();
      if (s.length < 8) return false;
      const symbols = (s.match(/[^\p{L}\p{N}\s]/gu) ?? []).length;
      return symbols / s.length >= 0.6;
    },
  },
  {
    // `[ME:pipeline] speakers found: ...`
    name: "log-line",
    test: (l) => /^\s*\[[A-Za-z][\w:.-]*\]\s/.test(l),
  },
  {
    // `$ npm test`, `> node script.mjs`, `npx vitest run`, `git push`
    name: "shell-command",
    test: (l) => /^\s*(?:[$>]\s+|PS[^>]*>\s*)/.test(l) ||
                 /^\s*(?:npm|npx|node|git|bd|cd|ls|cat|grep|curl|docker|pnpm|yarn)\s+[\w./-]/.test(l),
  },
  {
    // `+++ b/file`, `--- a/file`, `@@ -1,4 +1,4 @@`
    name: "diff-marker",
    test: (l) => /^\s*(?:\+\+\+|---)\s+\S|^\s*@@\s/.test(l),
  },
  {
    // `});`, `}`, `[`, `),`
    name: "punctuation-only",
    test: (l) => /^\s*[{}\[\]()<>,;:]+\s*$/.test(l),
  },
  {
    // `const x = 1;`, `import { y } from "z";`, `function foo() {`
    //
    // Requires a terminal `;` or `{`, so prose beginning "if" or "return"
    // survives — "return to me" is a sentence somebody says.
    name: "code-statement",
    test: (l) => /^\s*(?:import|export|const|let|var|function|class|async|await|return|throw|if|for|while|switch)\b.*[;{]\s*$/.test(l),
  },
  {
    // `| id | summary |`
    name: "table-row",
    test: (l) => /^\s*\|.*\|\s*$/.test(l),
  },
  {
    name: "bare-url",
    test: (l) => /^\s*https?:\/\/\S+\s*$/.test(l),
  },
];

/** Fraction of non-prose lines above which a chunk reads as structure, not speech. */
export const OPS_LINE_RATIO = 0.5;

// ── Public API ────────────────────────────────────────────────────────────────

/** Which rule (if any) marks this single line as non-prose. */
export function nonProseRule(line: string): string | null {
  for (const r of RULES) if (r.test(line)) return r.name;
  return null;
}

/**
 * Split text into prose and non-prose lines.
 *
 * Fenced blocks are handled at block level: the contents of a ``` fence are
 * arbitrary, and prose inside one is still not something a character said.
 * The fence is an OVERRIDE — strong evidence when present, never required.
 */
export function partitionProse(text: string): { prose: string[]; dropped: NonProseHit[] } {
  const prose: string[] = [];
  const dropped: NonProseHit[] = [];
  let inFence = false;

  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      dropped.push({ line, rule: "code-fence" });
      continue;
    }
    if (inFence) { dropped.push({ line, rule: "code-fence" }); continue; }
    if (!line.trim()) { prose.push(line); continue; }

    const rule = nonProseRule(line);
    if (rule) dropped.push({ line, rule });
    else prose.push(line);
  }
  return { prose, dropped };
}

/**
 * Is this chunk code-shaped? A density judgement, not a per-line one.
 *
 * Density rather than "any rule fired", because one file path inside a
 * paragraph is someone talking about a file, while eight of ten lines being
 * key:value is a config dump wearing a speaker's name.
 */
export function classifyShape(text: string): ShapeVerdict {
  const { prose, dropped } = partitionProse(text);
  const proseLines = prose.filter((l) => l.trim()).length;
  const total = proseLines + dropped.length;
  const lineRatio = total === 0 ? 0 : dropped.length / total;

  const counts = new Map<string, number>();
  for (const d of dropped) counts.set(d.rule, (counts.get(d.rule) ?? 0) + 1);
  const signals = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);

  return {
    opsShaped: total > 0 && lineRatio >= OPS_LINE_RATIO,
    lineRatio,
    signals,
    prose,
    dropped,
  };
}

/** Is this text entirely non-prose — nothing a character could have said? */
export function isAllNonProse(text: string): boolean {
  const { prose, dropped } = partitionProse(text);
  return dropped.length > 0 && prose.join("").trim() === "";
}
