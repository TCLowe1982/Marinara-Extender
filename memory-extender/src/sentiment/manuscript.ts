// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// Memoir or manuscript — the ABOUTNESS half of long-message intake (wosh).
//
// ⚠ CLASSIFIES ONLY. Nothing here drops, deletes, or gates. The answer is a score
// and a signal list; what a caller does with it is the caller's business.
//
// WHY NOT PROVENANCE. The instinct is to detect the paste, and it fails twice over.
// There is no surface to read one from (server-side sidecar; Engine 2.3.4 removed
// client extensions; the poller sees stored messages only). And paste-prior.ts —
// which already exists and is wired through ops-lane — deliberately lets this text
// through, because by its own header "a novel-length scene is exactly what this
// system exists to remember". A pasted RP scene and a pasted manuscript arrive
// identically because structurally they ARE identical. Provenance cannot separate
// them at any tuning, so this module asks a different question: not how it arrived,
// but who it is ABOUT.
//
// THE FAILURE TO DESIGN AGAINST, stated first because it is the whole risk. A real
// memoir is full of people who are not in the chat — a sergeant, men in a unit, a
// mother. A gate built on "names strangers" would reject the single most important
// memory this system exists to capture. So strangers are corroboration and never a
// verdict, and heavy first-person testimony actively PROTECTS a message here.
//
//   memoir      first person throughout, teller is the subject, strangers appear as
//               objects of his experience, often addressed to someone ("you")
//   manuscript  third person about named strangers, teller absent, dialogue carrying
//               the scene, nobody addressed
//
// A prior times a likelihood, never a prior alone — the same discipline paste-prior
// applies to size.

import { pasteEvidence } from "./paste-prior.js";

export interface ManuscriptEvidence {
  chars: number;
  sentences: number;
  /** Fraction of sentences carrying a first-person marker. Memoir runs high. */
  firstPersonRatio: number;
  /** Fraction carrying second person. Telling it TO someone is memoir behaviour. */
  addressRatio: number;
  /** Fraction carrying third person. Somebody else is the subject. */
  thirdPersonRatio: number;
  /** Attributed-dialogue hits per 1k chars, normalised. Fiction's load-bearing tic. */
  dialogueRatio: number;
  /** Names recurring >=3 times that are not in the roster and not the teller. */
  strangerNames: string[];
  /** Roster / persona / self mentions. Zero is suspicious; nonzero is protective. */
  rosterMentions: number;
  /** Chapter headings and scene-break rules. Rare in speech, common in drafts. */
  sceneMarkers: number;
  /** 0-1 narrative distance: how far this reads from first-person testimony. */
  narrativeDistance: number;
  /** 0-1 posterior. */
  score: number;
  isManuscript: boolean;
  signals: string[];
}

// ── Calibration ───────────────────────────────────────────────────────────────
// Provisional. Set from the store by scripts/manuscript-scan.mjs before this gates
// anything — the same measure-first rule paste-prior's constants were set under.

/** Below this the question is not asked; it matches LONG_USER_MSG_CHARS. */
export const SIZE_FLOOR = 1500;
/** First-person ratio at or above which a message reads as testimony. */
export const MEMOIR_FIRST_PERSON = 0.35;
/** Strong testimony. At or above this the memoir guard caps the score outright. */
export const MEMOIR_STRONG = 0.55;
/** A name must recur this often before it counts as cast rather than a mention. */
export const NAME_RECURRENCE = 3;
/** Posterior at or above which a message is called a manuscript. */
export const MANUSCRIPT_THRESHOLD = 0.6;

const FIRST_PERSON_RE = /\b(?:I|I'm|I've|I'd|I'll|me|my|mine|myself|we|we're|we've|our|ours|us)\b/i;
const SECOND_PERSON_RE = /\b(?:you|you're|you've|you'd|you'll|your|yours)\b/i;

// Third-person narration — the signal the first pass lacked, and the reason it
// MISSED the specimen it was written for. The NaNoWriMo draft scored 1p 0.19 and
// was spared at 0.47 because it is narration rather than dialogue: "He awoke from
// his bed" contains no attributed speech at all. Low first-person is only half the
// evidence; SOMEBODY ELSE BEING THE SUBJECT is the other half. Without it a terse
// first-person message and a novel look alike.
const THIRD_PERSON_RE = /\b(?:he|him|his|she|her|hers|they|them|their)\b/i;

// Attributed dialogue: a close-quote followed by a speech verb, or a speech verb
// introducing a quote. This is the tic a sincere hand-written message does not
// accidentally produce at volume — the structural term, and it carries most weight.
const DIALOGUE_ATTRIB_RE = /["“”'](?:\s*[,.!?])?\s*(?:he|she|they|[A-Z][a-z]+)\s+(?:said|asked|replied|answered|whispered|muttered|shouted|snapped|murmured|breathed|added|continued)\b|\b(?:said|asked|replied|whispered|muttered)\s+[A-Z][a-z]+[,.]?\s*["“]/g;

// Chapter headings and scene-break rules.
//
// MARKDOWN HEADINGS ARE NOT SCENE BREAKS, and that was a measured false positive:
// including /#{1,3}\s/ gave a design document scene-markers:16 and pushed it over
// the line. A "###" means DOCUMENT, which is paste-prior and ops-lane's territory,
// not a novel's. Chapter words and typographic rules only.
const SCENE_MARKER_RE = /^\s*(?:chapter\s+(?:\d+|[ivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten)\b|\*\s*\*\s*\*|—{3,}|-{3,}$)/gim;

// A capitalised token that is plausibly a person's name. Deliberately loose; the
// recurrence requirement below is what makes it mean anything.
const NAME_TOKEN_RE = /\b([A-Z][a-z]{2,15})\b/g;

// A NAME IS NOT A PERSON, and the first measurement proved it: the census called
// "Tracker", "Roleplay", "Game" and "Experience" strangers in a changelog, and
// "Oath", "Pact" and "Tome" strangers in a design doc. Capitalised technical nouns
// look exactly like a cast list to a frequency count, which is how two documents
// scored as high as a novel.
//
// A character DOES things and OWNS things. So a candidate only counts once it has
// been seen acting or possessing at least once — "Terrill thought", "Hargrove's".
// This is what separates a protagonist from a product feature.
// NO COPULAS OR AUXILIARIES HERE, and that was measured too. The first list
// included is/are/was/were/had, which made "the Game is", "the Tome was" and
// "Experience had" all read as people acting — the technical nouns survived the
// very check written to remove them. Only ACTIVE verbs a person performs.
const PERSON_ACTS_RE =
  /\b(?:said|says|asked|thought|knew|felt|saw|looked|turned|walked|stood|sat|smiled|laughed|nodded|shook|took|gave|held|watched|wondered|realised|realized|remembered|replied|answered|whispered|shouted|awoke|woke|rose|moved|reached|pulled|pushed|ran|came|went|spoke|stepped|glanced|frowned|sighed|breathed|waited|listened|decided|wore|carried)\b/;

// Sentence-initial position is where ordinary words get capitalised, so a name that
// only ever appears there is not evidence. These are the words that would otherwise
// dominate the census. Ranks and kin terms are here deliberately: "Sergeant" and
// "Mom" recur in exactly the memoir this gate must never reject.
const NAME_STOPWORDS = new Set([
  "The", "And", "But", "That", "This", "There", "Then", "They", "When", "What", "With", "We", "You", "Your",
  "He", "She", "It", "His", "Her", "Him", "Their", "Was", "Were", "Had", "Have", "Has", "Did", "Does", "Not",
  "For", "From", "After", "Before", "Because", "While", "Would", "Could", "Should", "One", "Two", "All",
  "Just", "Like", "Even", "Only", "Some", "Something", "Nothing", "Anything", "Everything", "Now", "Later",
  "Yes", "No", "Okay", "Well", "So", "If", "As", "At", "In", "On", "Of", "To", "By", "Up", "Out", "Over", "Off",
  "God", "Jesus", "Christ", "Sergeant", "Sarge", "Captain", "Lieutenant", "Colonel", "Doctor", "Nurse",
  "Mom", "Mum", "Dad", "Mother", "Father", "Grandma", "Grandpa", "Sir", "Maam", "Army", "Navy", "Marines",
]);

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Weigh whether a long message is a manuscript rather than something the teller
 * lived.
 *
 * `roster` is the chat's cast — character names, the persona, known aliases. Their
 * presence is protective, their absence merely suspicious.
 *
 * The four terms are unequal on purpose. DIALOGUE carries most because it is the
 * only one a sincere first-person account cannot accidentally satisfy at volume.
 * NARRATIVE DISTANCE is next, and is the axis this ticket is built on. STRANGERS and
 * ROSTER-SILENCE are corroboration only — each is individually true of real memories
 * and neither may convict alone.
 */
export function manuscriptEvidence(text: string, roster: string[] = []): ManuscriptEvidence {
  const s = String(text ?? "");
  const chars = s.length;
  const sents = sentencesOf(s);
  const n = sents.length;

  // EMPTY IS NOT SUSPICIOUS, and it scored 0.40 before a test said so: with no
  // sentences, firstPersonRatio is 0, which makes narrativeDistance 1.0, and no
  // roster name appears, which makes it roster-silent. Two absences read as
  // evidence. Nothing is nothing.
  if (n === 0 || chars === 0) {
    return {
      chars, sentences: 0, firstPersonRatio: 0, addressRatio: 0, thirdPersonRatio: 0,
      dialogueRatio: 0, strangerNames: [], rosterMentions: 0, sceneMarkers: 0,
      narrativeDistance: 0, score: 0, isManuscript: false, signals: ["empty"],
    };
  }

  const firstPersonRatio = n === 0 ? 0 : sents.filter((x) => FIRST_PERSON_RE.test(x)).length / n;
  const addressRatio = n === 0 ? 0 : sents.filter((x) => SECOND_PERSON_RE.test(x)).length / n;
  const thirdPersonRatio = n === 0 ? 0 : sents.filter((x) => THIRD_PERSON_RE.test(x)).length / n;

  // Per 1k chars, saturating at 3 — three attributed lines in a thousand characters
  // is already a scene, and more is not more informative.
  const attribHits = countMatches(s, DIALOGUE_ATTRIB_RE);
  const dialogueRatio = chars === 0 ? 0 : Math.min(1, (attribHits / (chars / 1000)) / 3);

  const sceneMarkers = countMatches(s, SCENE_MARKER_RE);

  const rosterNames = roster.filter(Boolean).flatMap((r) => String(r).split(/\s+/)).filter((w) => w.length >= 2);
  const rosterLower = new Set(rosterNames.map((r) => r.toLowerCase()));
  const lower = s.toLowerCase();
  let rosterMentions = 0;
  for (const r of rosterLower) {
    rosterMentions += countMatches(lower, new RegExp(`\\b${escapeRe(r)}\\b`, "g"));
  }

  // Census capitalised tokens.
  //
  // AN EARLIER VERSION DROPPED THE FIRST WORD OF EVERY SENTENCE, to stop "The" and
  // "And" dominating the count. A test caught what that costs: a protagonist STARTS
  // SENTENCES — "Terrill awoke", "Terrill took the stairs" — so the exclusion made
  // the main character invisible and left only names that happened to fall
  // mid-clause. The stopword list, the recurrence floor and the personhood check
  // below already do that filtering on merit, so position is not consulted.
  const counts = new Map<string, number>();
  for (const sent of sents) {
    const re = new RegExp(NAME_TOKEN_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(sent))) {
      const w = m[1]!;
      if (NAME_STOPWORDS.has(w)) continue;
      if (rosterLower.has(w.toLowerCase())) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  // Personhood check: the candidate must have been seen acting or possessing.
  const acts = new Set<string>();
  for (const [w] of counts) {
    const re = new RegExp(`\\b${escapeRe(w)}\\b(?:'s|’s)?\\s+(?:\\w+\\s+){0,2}?`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const tail = s.slice(m.index, m.index + w.length + 40);
      if (/['’]s\b/.test(tail.slice(w.length, w.length + 3)) || PERSON_ACTS_RE.test(tail.slice(w.length))) {
        acts.add(w);
        break;
      }
    }
  }
  const strangerNames = [...counts.entries()]
    .filter(([w, c]) => c >= NAME_RECURRENCE && acts.has(w))
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w)
    .slice(0, 12);

  // Distance from testimony. Saturates: below MEMOIR_FIRST_PERSON it climbs, and a
  // message at or above that ratio is reading as an account of something lived.
  const narrativeDistance = Math.max(0, Math.min(1, 1 - firstPersonRatio / MEMOIR_FIRST_PERSON));

  const strangerDensity = Math.min(1, strangerNames.length / 4);
  const rosterSilent = rosterMentions === 0 ? 1 : 0;

  const signals: string[] = [];
  if (attribHits > 0) signals.push(`dialogue:${attribHits}`);
  if (sceneMarkers > 0) signals.push(`scene-markers:${sceneMarkers}`);
  if (strangerNames.length > 0) signals.push(`strangers:${strangerNames.slice(0, 4).join(",")}`);
  if (rosterSilent) signals.push("roster-silent");
  signals.push(`1p:${firstPersonRatio.toFixed(2)}`);

  // WEIGHTS, REBALANCED AFTER THE FIRST MEASUREMENT. The first cut put 0.40 on
  // dialogue, reasoning that attributed speech is the tic sincere writing cannot
  // fake. True, but it describes DIALOGUE-HEAVY fiction, and the specimen this gate
  // exists for is narration: 10 attributions across 39,219 characters contributed
  // 0.03 and the draft was spared at 0.47. Narration is the common case; dialogue is
  // a bonus when present. So the axis this ticket is actually built on — who the
  // subject is — now carries the weight, split between the teller's absence
  // (narrativeDistance) and somebody else's presence (thirdPersonRatio).
  let score =
    0.30 * narrativeDistance +
    0.25 * thirdPersonRatio +
    0.20 * strangerDensity +
    0.15 * dialogueRatio +
    0.10 * rosterSilent;

  // Scene markers are a booster, not a verdict — the paste-prior fence lesson. A
  // person can write "***" as a break in a long sincere message; a person does not
  // also write it while narrating strangers in the third person. It only lifts a
  // score that other evidence already raised.
  if (sceneMarkers >= 2 && score >= 0.35) {
    score = Math.min(1, score + 0.15);
    signals.push("scene-boost");
  }

  // ── THE MEMOIR GUARD ────────────────────────────────────────────────────────
  // The motivating false positive, blocked structurally rather than by tuning.
  // Sustained first-person testimony is not a manuscript no matter who else it
  // names, and being ADDRESSED to someone is the strongest tell of all: a novel
  // does not talk to the person reading it. Expressed as a cap rather than a
  // subtraction so no accumulation of weak signals can climb past it.
  if (firstPersonRatio >= MEMOIR_STRONG) {
    score = Math.min(score, 0.35);
    signals.push("memoir-guard:1p");
  }
  if (rosterMentions > 0 && firstPersonRatio >= MEMOIR_FIRST_PERSON) {
    score = Math.min(score, 0.40);
    signals.push("memoir-guard:roster");
  }
  if (addressRatio >= 0.2 && firstPersonRatio >= MEMOIR_FIRST_PERSON) {
    score = Math.min(score, 0.40);
    signals.push("memoir-guard:addressed");
  }

  // ── DEFER TO THE OPS LANE ───────────────────────────────────────────────────
  // A DOCUMENT IS NOT A MANUSCRIPT, and conflating them was the other measured
  // false positive: a <memory> block spec and a design doc both scored over the
  // line. paste-prior already owns document-shaped text and routes it to ops-lane,
  // so this gate abstains rather than competing for the same input. Two detectors
  // reaching opposite verdicts on one message is worse than either being wrong.
  if (pasteEvidence(s).isPaste) {
    return {
      chars, sentences: n, firstPersonRatio, addressRatio, thirdPersonRatio,
      dialogueRatio, strangerNames, rosterMentions, sceneMarkers, narrativeDistance,
      score: 0, isManuscript: false,
      signals: [...signals, "deferred:ops-lane"],
    };
  }

  // Short messages are not asked the question at all. The long-form path is the only
  // caller and it trips at the same size.
  const isManuscript = chars >= SIZE_FLOOR && score >= MANUSCRIPT_THRESHOLD;

  return {
    chars,
    sentences: n,
    firstPersonRatio,
    addressRatio,
    thirdPersonRatio,
    dialogueRatio,
    strangerNames,
    rosterMentions,
    sceneMarkers,
    narrativeDistance,
    score,
    isManuscript,
    signals,
  };
}
