# Requirements packet — production prompt rewrite (`vikj`)

For Mari. Everything below is read out of the code at commit time, not recalled.
Regenerate the champion text with the command in §1; everything else has a file
and line reference so you can check me.

**Jurisdiction:** TC/code owns what is enforced. Mari/prose owns what is taught.

---

## 0. READ THIS FIRST — the champion is not a drop-in

The bench arm won on the numbers, but it was never asked to emit everything the
live slot consumes. Diffing the champion against the parser:

| field | parser reads it | champion asks for it |
|---|---|---|
| `motivation` | required | yes |
| `relational_dynamics` | required | yes |
| `outcome` | required | yes |
| `emotions[]` | optional | yes (1 slot; production shows 2) |
| `salience` | optional | yes |
| `subject` | optional | yes |
| **`thread`** | **optional, drives thread membership** | **NO** |
| **`subtext`** | **optional, stored on the beat** | **NO** |
| **`subpattern`** | **optional, dysregulation only** | **NO** |

So the champion's 303 tokens buy a prompt that silently stops populating narrative
threads. Its measured echo/boilerplate/validity numbers are **valid for the three
required fields and say nothing about `thread` or `subtext`**, because it never
emitted them. Budget in §6 is set on the assumption you are adding them back.

---

## 1. The champion, verbatim

Do not retype it. Emit it:

```bash
node scripts/prompt-bench-v2.mjs --dump-arm=SHORT+off-planet --emotion=fear --allow-live
```

`--emotion=` accepts any of the ten. As-run text for `fear` (310 tok by the
bench's own `length/4`; the 303 in the results table is the mean across emotions):

```text
You are analyzing a moment of FEAR in a conversation.

- motivation: What is this person afraid of? What threat is activating it?
- relational_dynamics: How is the fear shaping the relationship right now?
- outcome: What does this signal about what happens next?

- motivation must name the SPECIFIC content of THIS moment — what was actually said, feared, wanted, or done — so two different moments can never produce the same sentence. Genre descriptions are forbidden.
  TOO VAGUE, because it could describe a hundred different moments:
    "exposes her personal fear" / "reveals her vulnerability and desire for connection"
  SPECIFIC ENOUGH, because only one moment could have produced it:
    "insists the boat was green, not blue, and will not let it go"
    "asks whether the locksmith ever called back"
  These are ILLUSTRATIONS OF SHAPE from an unrelated conversation. Never reuse their
  words. If you cannot name what happened in THIS chunk that specifically, the chunk
  has no beat — say so rather than reaching for a remembered phrase.

Reply with only this JSON:
{"motivation":"...","relational_dynamics":"...","outcome":"...","emotions":[{"emotion":"<primary>","weight":0.0}],"salience":0.0,"subject":"..."}
```

The three field questions vary per emotion — see `FIELDS` in
`scripts/prompt-bench-v2.mjs`. The rule block and schema line are identical across
all ten.

---

## 2. The output contract, as the parser actually sees it

Source: `parseAnalysisJson`, `src/sentiment/analyzer.ts:43-84`. Shape:
`BeatAnalysis`, `src/sentiment/types.ts:75-95`.

**Response handling.** Two attempts, in order: the raw trimmed string, then the
contents of a ` ```json ` fence if one is present. Either may parse. So a fenced
reply is tolerated even though the prompt forbids markdown.

**Required — all three, or the entire analysis is discarded:**

| JSON key | type | notes |
|---|---|---|
| `motivation` | `string` | trimmed |
| `relational_dynamics` | `string` | trimmed → `relationalDynamics` in TS |
| `outcome` | `string` | trimmed |

A missing or non-string value in any of these makes the whole object fail and the
parser moves to the next attempt; if both fail it returns `null`.

**Optional — read if well-formed, otherwise silently `undefined`:**

| JSON key | type | coercion |
|---|---|---|
| `subpattern` | `string` | dysregulation only; any other string passes through unvalidated |
| `emotions` | `[{emotion: string, weight: number}]` | **items missing either key are dropped**; empty result → `undefined` |
| `subtext` | `string` | must be non-empty after trim |
| `salience` | `number` | **clamped to [0,1]**; non-number → **defaults to `0.5`** |
| `subject` | `string` | non-empty after trim |
| `thread` | `string` | non-empty after trim |

**Enum reality, which is looser than it looks:**

- `emotions[].emotion` is a **freeform string**, deliberately (`types.ts:69`). It is
  not validated against the ten-emotion enum. Richer vocabulary is intentional.
- The beat's stored primary `emotion` does **not** come from the model at all — it
  is `result.primaryEmotion` from the classifier (`encoder.ts:270`). The model
  cannot change it and should not be asked to.
- `subpattern` is not validated against the nine documented keys.
- **There are no lane enums in this contract.** The analyzer never emits a lane.
  Companion entries are written with `lane: "character_topics"`, `kind: "incident"`
  hardcoded at the call sites (`pipeline.ts:187`). Nothing you write affects lane.

**`no_beat`: there is no such shape, and this is a real contradiction.**

The only ways to produce "no beat" are (a) fail the parse, or (b) trip the echo
guard. There is no field, sentinel, or enum value by which the model can decline.
The current prompt tells it to — *"the chunk has no beat — say so rather than
reaching for a remembered phrase"* — and the schema gives it nowhere to say so, so
the instruction can only be obeyed by emitting malformed JSON.

That is a decision for this rewrite, not a detail. Either:
1. give it a real shape (e.g. `{"no_beat": true, "reason": "..."}`) and I wire the
   parser to honour it, or
2. drop the instruction, since an instruction that cannot be complied with is
   exactly the advisory-guard failure this project already ruled does no work.

Flag which and I'll implement the parser side.

---

## 3. The production delta — what the live slot needs that the arm never tested

**This is a template, not one prompt.** `buildSystemPrompt(emotion, structuralSubpatterns)`
(`analyzer.ts:509`) dispatches to ten functions. Nine share one shape; dysregulation
is its own. Whatever you write is instantiated **ten times**, so second-person
address and any emotion-specific noun must survive substitution.

**Interpolation variables the template must carry:**

*System prompt* — only one, and only for dysregulation:

- `structuralSubpatterns: string[]` → rendered by `dysregulationPrompt` as
  `"The classifier also detected these structural signals in the text: <a, b>.
  Weight these in your subpattern assessment."`, and **omitted entirely when the
  array is empty** (`analyzer.ts:477-480`). This is the only conditional assembly
  that exists today.

*User prompt* — built separately in `buildUserPrompt` (`analyzer.ts:539-598`), and
you are **not** rewriting it, but your rules reference these blocks by name, so the
names must match or the rule points at nothing:

| block | appears when | text your rules refer to |
|---|---|---|
| roster | `extras.roster` non-empty | `Known characters (for the subject field): …` |
| scene | `extras.sceneTitle` non-empty | `Scene name: "…"` |
| threads | `extras.threads` non-empty | `Active threads (for the thread field): "a", "b"` |
| before/after context | neighbouring chunks exist | `Preceding context (…)` / `Following context (…)`, each truncated to 400 chars |
| the chunk | always | `ANALYZE THIS — Speaker: <name>` + emotion scores + `Structural signals detected: …` |

Two consequences worth designing around:

- Your `subject` rule currently cites *"the 'Known characters' list"* and your
  `thread` rule cites *"the 'Active threads' list"*. **Both blocks are absent when
  their arrays are empty**, so on those calls the rules reference a list the model
  cannot see. Either phrase them to degrade gracefully or tell me to make their
  inclusion conditional on the block being present — that's a code change, my side.
- `subtext` rides on **all ten** prompts unconditionally and fires on **78 of 8,836
  beats (1%)**. If you want it conditional, I need a signal to condition on; the
  classifier does not currently emit one.

**Dysregulation extra content:** a nine-key subpattern taxonomy with one-line
glosses (`analyzer.ts:484-493`), plus a `subpattern` field instruction and the
`JSON_FORMAT_WITH_SUBPATTERN` schema line. It is the reason that prompt is 1246
tokens against ~880 for the others.

---

## 4. The enforcement ledger — what code guarantees, so prose need not

House law is **PROMPT ASKS, CODE ENFORCES**. Anything on this list should not also
be a sentence in the prompt; every duplicate is wasted tokens plus a contradiction
waiting for the day the code moves and the prose doesn't.

| guarantee | where | behaviour |
|---|---|---|
| **Content floor** | `classifier.ts` `meetsContentFloor` | chunks under `min_chunk_tokens` (2 raw tokens) never reach the analyzer at all |
| **Salience gate** | `classifier.ts` | below `salience_threshold` (0.40 chat / 0.25 story) → no call |
| **Echo rejection** | `analyzer.ts:62` `rejectAsEcho` | motivation matching any registered example → whole analysis becomes `null` |
| **Echo escape hatch** | `analyzer.ts:290` | …unless the phrase is corroborated in the source text, so a real utterance stays recordable |
| **Salience clamp** | `analyzer.ts:71` | clamped to [0,1]; non-numeric defaults to 0.5 |
| **Emotion array cleanup** | `analyzer.ts:27` | malformed entries dropped; empty → `undefined` |
| **Field trimming** | `analyzer.ts:64-77` | all strings trimmed; empty optionals → `undefined` |
| **Primary emotion** | `encoder.ts:270` | taken from the classifier; the model's opinion is not used |
| **Markdown tolerance** | `analyzer.ts:46` | a ` ```json ` fence is unwrapped, so "no markdown" is belt-and-braces |
| **JSON mode** | `analyzer.ts:105` | `response_format: {type:"json_object"}` is set on the local call |
| **Subject routing** | `pipeline.ts` / `api.ts` | unknown subject → holding pool; never guessed into a ledger |
| **Thread resolution** | `threads.ts` `resolveOrMintThread` | fuzzy-matches your label against the chat's active threads; mints only when genuinely new |
| **Bait warrant** | `__tests__/bait-warrant.test.ts` | any quoted illustration in the built prompt that the echo ledger cannot arrest fails the suite |

**Not enforced — prose is genuinely the only thing holding these:** sentence count
per field, weights summing to ~1.0, "name the event not the cast" for thread
labels, using context for tone-vs-intent, and specificity itself.

---

## 5. Skeleton spec — so you can pre-compute a warrant

The matcher, exactly (`analyzer.ts:199-260`). Registering bait means adding the
**phrase** to `PROMPT_EXAMPLE_ECHOES`; the skeleton is derived, so what you need to
predict is whether your example's skeleton is ≥3 tokens and unique.

Pipeline, in order:

1. `String(s).toLowerCase()`
2. tokenize with `/[\p{L}\p{N}]+/gu` — **all punctuation and apostrophes are
   separators**, so `she's` → `she` + `s`
3. drop any token in `FUNCTION_WORDS`
4. stem: tokens of **length < 5 are left alone**; otherwise strip one trailing
   `ings|ing|edly|ed|es|s` (first match wins, `/(ings?|edly|ed|es|s)$/`)
5. drop empties

`FUNCTION_WORDS` verbatim:

```text
a an the that this these those and or but not no
is was were are am be been being will would shall
should can could may might must do does did done
have has had to of in on at by for with from
as it its he she they them his her their him
i me my we us our you your s t up out so
let go about into over than then there here if
```

Matching (`containsInOrder`): the example's skeleton must appear in the
motivation's skeleton as an **ordered subsequence with gaps allowed**, and needs
**≥3 tokens** (`MIN_SKELETON_WORDS`) or it never fires.

Worked examples, run rather than predicted:

```text
"admits she's afraid the memory loss means she was never real"
  → admit afraid memory loss mean never real        (7 tokens)
"insists the boat was green, not blue, and will not let it go"
  → insist boat green blue                          (4 tokens)
"asks whether the locksmith ever called back"
  → asks whether locksmith ever call back           (6 tokens)
"exposes her personal fear"
  → expos personal fear                             (3 tokens — at the floor)
```

Three things those show that the rules alone don't. `memory` survives intact (it
ends in `y`, not in the stripped set). `asks` survives as `asks` (length 4 → under
the stemming threshold) while `called` → `call`, so **the same verb stems
differently by length** — do not assume inflections normalise together. And
`exposes` → `expos`, which is not a word; the skeleton is a fingerprint, not
language. Verify yours rather than predicting it:

```bash
node -e "import('./dist/sentiment/analyzer.js').then(m=>console.log(m.skeleton(process.argv[1])))" "your example here"
```

**Design implication.** Bait that glows in the dark needs a skeleton that is ≥3
content tokens and that no real motivation in this domain would ever produce. The
off-planet examples work because `boat green blue` and `locksmith call back` are
not things anyone here says. Check any candidate against the store before
committing to it:

```bash
node scripts/bait-audit.mjs
```

---

## 6. Budget ruling

Measured now, same crude `length/4` the bench used:

| | tokens |
|---|---|
| shipped, nine standard emotions | **864–910** (mean 878) |
| shipped, dysregulation | **1246** |
| champion as-run (fear) | **310** — but missing `thread`, `subtext`, `subpattern` |

**Ruling — this is a cap on the always-sent base, plus named allowances, not one
number.** A single figure would force you to cut things code cannot enforce, which
is the wrong trade.

| block | cap | sent when |
|---|---|---|
| **base** (role line, three field questions, bait block, schema, subject rule) | **380** | always |
| **thread block** (rule + examples + null case) | **+120** | always, unless you ask me to make it conditional on `Active threads` being present |
| **subtext instruction** | **+80** | always today; conditional needs a classifier signal I'd have to add |
| **dysregulation taxonomy** (nine keys + subpattern field + schema) | **+200** | dysregulation only |

Worst case (dysregulation + everything) **780**, against 1246 today — a 37% cut.
Typical case (base + thread + subtext) **580**, against ~878 today — a 34% cut.
Base-only, if I make the two blocks conditional, **380** — a 57% cut.

**175 is not achievable** once `thread`, `subtext` and `subpattern` come back, and
I'd rather rule honestly than have you cut a field the pipeline reads. If you land
under these, good; they are ceilings, not targets. If a block genuinely cannot fit,
say which and why and I'll take it as a code-side problem rather than expecting
prose to absorb it.

---

## 7. Pre-registered acceptance path

Recorded before the draft exists, per Mari, and sealed on the same terms as the
bench rule. Reproduced in `bd memories pre-registered-challenger`.

- The draft enters **bench v3 as CHALLENGER**; `SHORT+off-planet` as **champion**.
- **Same referee** — `echoesPhrases` from `analyzer.ts`, never a substring test.
- **Same quarantine** — poller off, sidecar and watchdog stopped, post-run leak scan.
- **Same n or better** — n≥60 per arm.
- **Ships only if**: echo and boilerplate hold **within noise** of champion, and
  JSON validity **does not drop a single point**.
- Noise is defined **now, not after**: at n=60 one output is 1.7 points, so "within
  noise" means **within 2 points**. At larger n, one output, rounded up.
- **The added obligations must be free.** `thread`, `subtext` and `subpattern`
  coming back must not cost validity. If they do, that is a finding about the
  fields, not a reason to relax the bar.
- **No author's exemption.** Same ladder as everyone else.

Because the challenger emits fields the champion never did, v3 adds two measures
the champion will score `n/a` on — **thread-emission rate** and **thread-label
echo** (against the thread illustrations, per `n9bv`). These are reported for the
challenger alone and are **not** part of the ship/no-ship test, so they cannot be
used to argue either way after the fact.
