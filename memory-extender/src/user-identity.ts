// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// The user's declared identity (MarinaraExtender-egj3).
//
// Every other entity in the store is INFERRED from the corpus. This one is not,
// because inference demonstrably cannot do it and the user can settle it in a
// sentence.
//
// The evidence, measured while building the mention-entity index (76aw):
//
//   "thomas" points at 11 entities — a character, the user, and extraction
//   noise — so the ambiguity bound suppresses it entirely. Safe, but wrong:
//   Thomas Lowe, Thomas Charles Lowe and TC Lowe are one real person.
//
//   Nothing in the text can fix that. "Collier" and "Lowe" NEVER co-occur in a
//   single entry anywhere in the store, so no amount of corpus analysis can
//   separate the character from the user. The discriminator has to come from
//   outside, and the user is holding it.
//
// A declaration is not a guess, so declared forms are exempt from the bound that
// exists to constrain guesses. That is the whole point of the file: it replaces
// a suppression with an answer.
//
// It is AUTHORED, not derived — which is why it lives outside entities.yaml.
// That file is a pure function of the corpus and is deleted and rebuilt freely;
// this one must survive every rebuild.

import { join } from "path";
import { stringify } from "yaml";
import { atomicWriteFile_UNLOCKED_takeSerializedWriteYourself, getDataDir, readYamlFile } from "./storage.js";

export interface UserIdentity {
  version: 1;
  /** Display form, e.g. "TC Lowe". */
  canonical: string;
  /**
   * Every surface form that means the user. Lowercased on write.
   *
   * A form here is treated as unambiguously the user, so an ambiguous given
   * name should NOT be listed. "Thomas" alone is the RP character's usual name;
   * listing it would hand the character's memories to the user, which is the
   * exact failure this file exists to prevent.
   */
  aliases: string[];
  /**
   * Entities that share a form with the user and are explicitly NOT them.
   *
   * Without this, a declared "thomas lowe" and an inferred "Thomas Collier"
   * still meet through the token they share. Naming the exclusions is what makes
   * the separation hold — and it is knowledge only the author has, since the
   * corpus contains no evidence either way.
   */
  excludes: string[];
  updated: string;
}

export function userIdentityPath(): string {
  return join(getDataDir(), "user-identity.yaml");
}

export async function readUserIdentity(): Promise<UserIdentity | null> {
  const raw = await readYamlFile<UserIdentity>(userIdentityPath());
  if (!raw?.canonical) return null;
  return {
    version: 1,
    canonical: raw.canonical,
    aliases: normalizeForms(raw.aliases),
    excludes: normalizeForms(raw.excludes),
    updated: raw.updated ?? "",
  };
}

export async function writeUserIdentity(
  input: { canonical: string; aliases?: string[]; excludes?: string[] },
): Promise<UserIdentity> {
  const canonical = input.canonical.trim();
  if (!canonical) throw new Error("canonical name is required");
  // The canonical form is always a form that means the user; requiring the
  // caller to repeat it in aliases is a footgun.
  const aliases = normalizeForms([...(input.aliases ?? []), canonical]);
  const identity: UserIdentity = {
    version: 1,
    canonical,
    aliases,
    excludes: normalizeForms(input.excludes).filter((x) => !aliases.includes(x)),
    updated: new Date().toISOString(),
  };
  await atomicWriteFile_UNLOCKED_takeSerializedWriteYourself(userIdentityPath(), stringify(identity));
  return identity;
}

function normalizeForms(forms: string[] | undefined): string[] {
  const out: string[] = [];
  for (const f of forms ?? []) {
    const norm = String(f ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    if (norm && !out.includes(norm)) out.push(norm);
  }
  return out;
}

/** Every single token that appears in a declared user form. */
export function userTokens(identity: UserIdentity | null): Set<string> {
  const tokens = new Set<string>();
  for (const form of identity?.aliases ?? []) for (const t of form.split(" ")) if (t) tokens.add(t);
  return tokens;
}

/** Canonical forms the user has explicitly disclaimed, lowercased. */
export function excludedForms(identity: UserIdentity | null): Set<string> {
  return new Set(identity?.excludes ?? []);
}

/**
 * Cue links contributed by the declaration.
 *
 * Every declared form reaches every other, in both directions, so "tc" finds
 * entries that say "Thomas Lowe" and vice versa. Multi-word forms also register
 * their individual tokens — a cue is a loose bag of words, and someone typing
 * "what did Lowe say" is asking about the user.
 *
 * Tokens shared with an EXCLUDED entity are deliberately left out. "thomas" is
 * the obvious case: it belongs to both the user and the character, so linking it
 * would undo the exclusion the user just declared.
 */
export function userCueLinks(identity: UserIdentity | null): Map<string, string[]> {
  const links = new Map<string, string[]>();
  if (!identity?.aliases.length) return links;

  const excludedTokens = new Set<string>();
  for (const form of identity.excludes) for (const t of form.split(" ")) if (t) excludedTokens.add(t);

  const forms = new Set<string>(identity.aliases);
  for (const form of identity.aliases) for (const t of form.split(" ")) if (t) forms.add(t);

  // A form identifies the user only if something in it distinguishes them from
  // what they disclaimed. "thomas" alone is shared with the character and is
  // dropped; "thomas lowe" keeps a token the character does not have, so it
  // stays. Requiring EVERY token to be unshared would throw away the very forms
  // that do the disambiguating.
  const safe = [...forms].filter((f) => f.split(" ").some((t) => !excludedTokens.has(t)));

  for (const from of safe) {
    const targets = safe.filter((t) => t !== from);
    if (targets.length) links.set(from, targets);
  }
  return links;
}
