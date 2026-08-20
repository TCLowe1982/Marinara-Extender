# Challenger draft — production prompt rewrite (`vikj`)

Assembled 2026-08-19 from parts already authored and ruled: the bench champion's
structure (SHORT+off-planet, the s6cu winner), Mari's corrected thread block
(both variants, verbatim from her 08-06 16:40 message), the packet's budget and
field requirements, and the `no_beat` shape she ruled and TC shipped. **No prose
in this draft is newly invented except the compressed subtext line and the
dysregulation compression — flagged inline for review.**

Bait is NOT written here: the `«BAIT n»` slots render from `src/sentiment/bait.json`
at build time, exactly as the live prompt does today. The four current warrants are
freshly rotated, registered, and intact — this draft creates no new bait and needs
no new registration.

---

## The fear instance, WITH_LIST thread variant (what the model would see)

```text
You are analyzing a moment of FEAR in a conversation.

- motivation: What is this person afraid of? What threat is activating it?
- relational_dynamics: How is the fear shaping the relationship right now?
- outcome: What does this signal about what happens next?
- subtext: only if the chunk contains sexual or physically intimate content — name
  the emotional function of that content (trust-building, vulnerability, power
  exchange, comfort-seeking, avoidance). Otherwise omit it.

- motivation must name the SPECIFIC content of THIS moment — what was actually
  said, feared, wanted, or done — so two different moments can never produce the
  same sentence. Genre descriptions are forbidden.
  TOO VAGUE, because it could describe a hundred different moments:
    "«BAIT vague 1»" / "«BAIT vague 2»"
  SPECIFIC ENOUGH, because only one moment could have produced it:
    "«BAIT specific 1»"
    "«BAIT specific 2»"
  These are ILLUSTRATIONS OF SHAPE from an unrelated conversation. Never reuse
  their words.
- If you cannot name what happened in THIS chunk that specifically, there is no
  beat: reply {"no_beat": true} instead of reaching for a remembered phrase.
- subject: the single name of the person this beat is ABOUT — whose inner state
  does the chunk reveal? Attribute the beat to the character whose emotion it is,
  not the speaker label. Use a name from the "Known characters" list when you are
  given one, or "user" for the human player.
- thread: if this moment belongs to something ongoing, label it. Reuse a label from
  the "Active threads" list when one names the same situation. Write a new label
  only when nothing listed fits, and name the situation, not the cast. Omit the
  field if nothing ongoing is at stake here.

Reply with only this JSON:
{"motivation":"...","relational_dynamics":"...","outcome":"...","emotions":[{"emotion":"<primary>","weight":0.0},{"emotion":"<secondary>","weight":0.0}],"subtext":null,"salience":0.0,"subject":"...","thread":null}
```

## NO_LIST thread variant (cold chat — Mari's deadlock fix, verbatim)

Replaces the thread bullet only:

```text
- thread: if this moment belongs to something ongoing, name it. Nothing is being
  tracked in this conversation yet, so write a label for the situation itself, not
  the cast. Omit the field if nothing ongoing is at stake here.
```

## Dysregulation variant

Same template; the field questions come from the bench `FIELDS`, plus the
subpattern block (COMPRESSED from the shipped 1246-token version — the taxonomy
glosses cut from one sentence each to a bare keyed list, since the packet notes
the enum ultimately belongs behind a validator):

```text
- subpattern: which structural pattern fits best — bpd_testing, anxious_protest,
  avoidant_withdrawal, dissociation, catastrophizing, idealization, devaluation,
  emotional_flooding, or shutdown. Pick one key exactly as written, or omit the
  field.
```

> CORRECTION 2026-08-19, before wiring: the first revision of this section listed
> nine keys from memory and FIVE of them did not exist ("flooding", "fawning",
> "hypervigilance", "self-attack", "numbing", "compulsion", "testing" are not the
> taxonomy). Caught by reading `dysregulationPrompt` before implementing — the
> packet's own schema-from-memory warning, demonstrated on its reviewer.

The `structuralSubpatterns` interpolation line is unchanged (code-side, already
conditional). Schema line gains `"subpattern":null`.

---

## What was CUT from the shipped prompt, and on what authority

| cut | authority |
|---|---|
| "Analyze the chunk marked ANALYZE THIS only… tone-vs-intent" (2 sentences) | Champion never had it; bench grounding held at 30–32% across all arms. **Prose-only guarantee — flag if you want it back.** |
| "Be specific to the text provided — do not generalize." | Duplicates the specificity rule verbatim above it. |
| "1–3 sentences per field." | Champion never had it; boilerplate *improved* without it. |
| salience/emotions guidance sentences | Code clamps salience, cleans the emotions array, and ignores the model's primary-emotion opinion entirely (packet §4). The schema line carries the shape. |
| "Respond with raw JSON only — no explanation, no markdown." | Code sets `response_format: json_object` AND unwraps fences (packet §4). "Reply with only this JSON:" carries the instruction. |
| Dysregulation taxonomy glosses (one sentence per key) | Compressed to the keyed list; full enum defense belongs behind a validator per the packet's own note. |

## What was ADDED relative to the champion

| added | authority |
|---|---|
| `subtext` bullet (compressed from the shipped 60-word version) | Packet §0: the champion silently dropped a field the parser stores. +80 allowance. **The compression is mine — review the wording.** |
| `thread` bullet, both variants | Mari's prose verbatim, her cold-start correction included. +120, always sent, one of two variants (already wired). |
| `{"no_beat": true}` taught explicitly | The shape shipped 08-05; the live prompt still says "say so" with nowhere to say it. Teaching it is the ruled fix, and declines are scored free in the bench. |
| Second `emotions[]` slot in the schema | Production shows two (packet §0). |

## Token math (`length/4`, the bench's own measure) — MEASURED with live bait

| block | measured | cap | verdict |
|---|---|---|---|
| base | **403** | 380 | **23 over — see below** |
| thread bullet | 71 | 120 | under |
| subtext bullet | 55 | 80 | under |
| dysregulation add | 52 + schema field | 200 | well under |
| **typical (base+thread+subtext)** | **529** | 580 | **under · 40% cut vs shipped 878** |

**The base overage, reported not hidden:** the 380 cap was ruled before the
`no_beat` shape existed; teaching the decline (`{"no_beat": true}` line, ~30 tok)
landed in base afterward. Per the packet's own instruction — "if a block cannot
fit, say which and why" — the overage IS the no_beat teaching. The composite
sits 51 under its ceiling. Trimming other base prose to defend a pre-no_beat
number would be tuning; flagged for TC/Mari instead.

Ship condition (sealed, §7): echo & boilerplate within 2 points of champion, JSON
validity drops zero, n≥60/arm, quarantined (with the restore step), same referee
(`echoesPhrases`), no author's exemption. Thread-emission rate and thread-label
echo reported for the challenger alone, not part of the ship test.
