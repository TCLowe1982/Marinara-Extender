// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// How many stored facts are unsupported by their own receipts (fqnl)? READ-ONLY.
//
// Two layers, and they answer different questions:
//
//   LAYER 2 (local, always available) — does the fact assert a proper noun that
//     appears nowhere in the source sentence stored beside it? Runs against the
//     store alone.
//
//   LAYER 1 (needs the Engine) — is that stored "source sentence" a real quotation
//     of anything in the chat it cites? The extractor asks the MODEL for the
//     original sentence and writes what it gets, so the receipt is self-reported.
//     A model that invents a fact invents its receipt. Only the raw chat log can
//     settle it, so this layer is opt-in via --engine.
//
// Layer 1 is the one that catches the Kraków case, and it is the reason this script
// bothers to talk to the Engine at all: utopic-deaau6ak's receipt is fluent,
// plausible, internally consistent with its own fact, and completely fictional.
//
// Usage:
//   node scripts/fact-support-scan.mjs [--engine] [--show=N] [--json]

import { readdir } from "fs/promises";
import { join } from "path";

const { getDataDir, readIndex, readEntry } = await import("../dist/storage.js");
const { factSupport, receiptCorpusOverlap, receiptMissingWords, RECEIPT_MIN_OVERLAP } = await import("../dist/fact-support.js");

const args = process.argv.slice(2);
const USE_ENGINE = args.includes("--engine");
const JSON_OUT = args.includes("--json");
const SHOW = parseInt((args.find((a) => a.startsWith("--show=")) ?? "").split("=")[1] ?? "15", 10);

const dataDir = getDataDir();

// ── Which names are exempt from layer 2 ───────────────────────────────────────
// A fact legitimately names its own subject while the source says only "she".
// Convicting that would flag every correct extraction in the store, so the scope's
// own identity — and the user's — never count as external assertions.
const { readUserIdentity, userTokens } = await import("../dist/user-identity.js");
const identity = await readUserIdentity().catch(() => null);
const userNames = identity ? [...userTokens(identity)] : [];

// The scope's OWN name, resolved through the alias table. Passing the scopeId is
// useless — for most characters it is an opaque identity key
// ("8v1krexzyjkyrawik7yc3"), so the exemption never fires and every fact naming its
// own subject gets convicted. That mistake alone produced ~2000 false accusations on
// the first run of this script, which is a good demonstration of why the number gets
// calibrated before it gets reported.
const { readAliasTable } = await import("../dist/aliases.js");
const aliasTable = await readAliasTable().catch(() => ({}));
function namesFor(scopeId) {
  const rec = aliasTable[scopeId];
  const out = [scopeId.replace(/[_-]/g, " ")];
  if (rec?.canonicalName) out.push(rec.canonicalName);
  for (const a of rec?.aliases ?? []) out.push(a);
  return out;
}

// EVERY KNOWN PERSON, not just this scope's subject.
//
// Measured, and this is the calibration that matters: person-names cannot be
// evidence of fabrication in this store, because naming is fluid BY DESIGN. The
// extractor writes a canonical full name where the source used a short form
// ("Dr. Mari Zielińska" from "professor mari"), and facts legitimately reference
// other characters by canonical name ("Priya" where the source said
// "Dr. Chandrasekaran"). The alias layer exists precisely to absorb that variance.
// Convicting on it produced ~1700 false accusations.
//
// What survives the exemption is the class this test was built for: proper nouns
// that are not known people — places, institutions, works. Kraków is one.
const rosterNames = Object.values(aliasTable).flatMap((rec) => [
  rec?.canonicalName ?? "",
  ...(rec?.aliases ?? []),
]).filter(Boolean);

// An acronym introduced beside its expansion is a summarising device, not an
// invented name: "borderline personality disorder (BPD)". Convicting BPD because the
// source spelled it out is a false accusation of exactly the kind this must avoid.
const ACRONYM = /^[A-Z]{2,6}$/;

async function scopes() {
  const out = [];
  for (const [kind, sub] of [["character", "characters"], ["chat", "chats"]]) {
    for (const id of await readdir(join(dataDir, sub)).catch(() => [])) out.push({ scope: kind, scopeId: id });
  }
  return out;
}

// ── Layer 2 ───────────────────────────────────────────────────────────────────

const rows = [];
for (const { scope, scopeId } of await scopes()) {
  const index = await readIndex(scope, scopeId).catch(() => null);
  for (const r of index?.entries ?? []) {
    if (r.discardedAt) continue;
    if (!r.path) continue;                       // readEntry takes the relative PATH, not the id
    const full = await readEntry(scope, scopeId, r.path).catch(() => null);
    if (!full) continue;
    // Only fact-shaped entries carry a source SENTENCE as content. A beat companion
    // renders the beat into content instead — "Emotion: / Motivation: / …" — so its
    // "receipt" restates the summary and testing it is vacuous. That is exactly the
    // trap that made 0y2i's first corroboration pass hold back 574 of 580.
    // `kind` lives on the entry, not the index row.
    if (full.kind === "incident") continue;
    if (/^\s*(emotion|motivation|relational dynamics|outcome)\s*:/im.test(String(full.content ?? ""))) continue;
    const source = String(full?.content ?? "");
    const fact = String(r.summary ?? "").replace(/^\[[^\]]+\]\s*/, "");
    if (!fact || !source) continue;
    const v0 = factSupport(fact, source, [...userNames, ...rosterNames, ...namesFor(scopeId)]);
    // Drop acronyms from the verdict rather than from properNouns(), so `checked`
    // still records that they were looked at.
    const v = {
      ...v0,
      unsupported: v0.unsupported.filter((n) => !ACRONYM.test(n)),
    };
    v.supported = v.unsupported.length === 0;
    rows.push({ scope, scopeId, id: r.id, fact, source, sourceChatId: r.sourceChatId, verdict: v });
  }
}

const tested = rows.filter((r) => r.verdict.checked.length > 0);
const failed = tested.filter((r) => !r.verdict.supported);

console.log(`fact-shaped entries examined : ${rows.length}`);
console.log(`  asserting a checkable name : ${tested.length}`);
console.log(`  UNSUPPORTED by their source: ${failed.length}`);
console.log(`  (the rest assert no external proper noun — the test is silent, not approving)`);

if (failed.length) {
  console.log(`\nLAYER 2 FAILURES (showing ${Math.min(SHOW, failed.length)})`);
  for (const f of failed.slice(0, SHOW)) {
    console.log(`\n-- ${f.scope}/${f.scopeId}  ${f.id}   unsupported: ${f.verdict.unsupported.join(", ")}`);
    console.log(`   fact  : ${f.fact.slice(0, 150)}`);
    console.log(`   source: ${f.source.slice(0, 150)}`);
  }
}

// ── Layer 1 ───────────────────────────────────────────────────────────────────

if (!USE_ENGINE) {
  console.log(`\nLayer 1 (receipt authenticity) SKIPPED — pass --engine to check stored`);
  console.log(`receipts against the real chat logs. Layer 2 alone cannot catch a fact whose`);
  console.log(`receipt was invented alongside it, which is the live Kraków case.`);
} else {
  const BASE = process.env.MARINARA_EXTENDER_ENGINE_URL || "http://127.0.0.1:7860";
  const H = { "x-marinara-csrf": "1" };
  const get = async (p) => {
    const r = await fetch(`${BASE}/api${p}`, { headers: H });
    if (!r.ok) throw new Error(`${p} -> ${r.status}`);
    return r.json();
  };
  const list = (j, k) => (Array.isArray(j) ? j : (j?.[k] ?? j?.data ?? []));

  const cache = new Map();
  async function chatText(chatId) {
    if (cache.has(chatId)) return cache.get(chatId);
    let text = "";
    try {
      const msgs = list(await get(`/chats/${chatId}/messages`), "messages");
      text = msgs.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m))).join("\n");
    } catch { text = ""; }
    cache.set(chatId, text);
    return text;
  }

  const withChat = rows.filter((r) => r.sourceChatId);
  console.log(`\n\nLAYER 1 — receipt authenticity against the Engine`);
  console.log(`entries citing a chat : ${withChat.length}`);
  console.log(`entries with NO chat  : ${rows.length - withChat.length}  <- unconvictable; needs its own disposition`);

  const fabricated = [];
  for (const r of withChat) {
    const text = await chatText(r.sourceChatId);
    if (!text) continue;                        // chat gone; cannot convict on absence of the log
    // Recap entries synthesise their content by design — it is rendered prose, not
    // a quotation — so testing them for verbatim presence is vacuous, the same trap
    // as testing a beat companion's rendered body.
    if (String(r.id).startsWith("recap-")) continue;
    const missing = receiptMissingWords(r.source, text);
    if (missing.length > 0) fabricated.push({ ...r, missing, overlap: receiptCorpusOverlap(r.source, text) });
  }

  // SPLIT BY EVIDENCE GRADE. A missing word that is a PROPER NOUN in the receipt is
  // strong: summarising rewords freely but cannot invent a name. A missing ordinary
  // word is usually just the summariser's own vocabulary ("describing", "includes",
  // "reflecting") and convicting on it is noise — the receipt is a near-quote, not a
  // byte-copy, and long verbs drift.
  const { properNouns: pn } = await import("../dist/fact-support.js");
  for (const f of fabricated) {
    const nouns = new Set(pn(f.source).map((s) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "")));
    f.missingNouns = f.missing.filter((w) => nouns.has(w));
  }
  const strong = fabricated.filter((f) => f.missingNouns.length > 0);

  console.log(`receipts containing words absent from their own chat : ${fabricated.length}`);
  console.log(`  of those, missing a PROPER NOUN (high confidence)  : ${strong.length}`);
  console.log(`  the rest are missing only ordinary words — usually summariser drift, not fabrication`);

  console.log(`\nHIGH-CONFIDENCE (a name in the receipt occurs nowhere in the chat it cites)`);
  strong.sort((a, b) => b.missingNouns.length - a.missingNouns.length);
  for (const f of strong.slice(0, SHOW)) {
    console.log(`\n-- ${f.scope}/${f.scopeId}  ${f.id}   invented: ${f.missingNouns.join(", ")}  chat=${f.sourceChatId}`);
    console.log(`   fact  : ${f.fact.slice(0, 140)}`);
    console.log(`   claims: ${f.source.slice(0, 140)}`);
  }
  if (JSON_OUT) console.log("\n" + JSON.stringify({ layer2: failed.length, layer1: fabricated.length, fabricated }, null, 2));
}

console.log("\n\nREAD-ONLY. Nothing was changed.");
