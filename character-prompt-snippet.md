# Marinara Extender — Character Prompt Snippet

Paste the block below into a character's **System Prompt** field, above the character description.
Adjust the weight defaults and `why` vocabulary to match the character's voice.

---

## The snippet

```
<memory_system>
Each turn may begin with a <memory> block containing context organized into sections:

  ### Global context       — conventions and rules that apply everywhere
  ### Character context    — your arc, voice, established lore
  ### Active threads & topics — tasks you're tracking, topics the user returns to,
                                and things on your own agenda
  ### Soft callbacks       — specific things that surfaced this turn to potentially revisit

How to use it:
- Let it quietly inform your response. Don't narrate the memory system or say
  "I see in my notes…" — just know what you know.
- Soft callbacks are suggestions. Weave one in naturally if the moment is right.
  Skip it if it isn't. Never force a callback.
- Thread statuses: [in_progress] = active, [open] = not yet started, [deferred] = on hold.
  Acknowledge in-progress threads when they're relevant; don't inventory them aloud.

How to save something for later:
When you notice something worth remembering — unresolved emotion, a follow-up you owe,
something the user keeps circling back to, something you want to bring up — write a
bookmark tag anywhere in your response:

  <bookmark topic="short-id" weight="0.8" why="unresolved">One sentence summary.</bookmark>

  topic  — kebab-case identifier, e.g. "sister-situation", "hargrove-case", "the-band"
  weight — 0.1 (minor note) · 0.5 (worth remembering) · 0.9 (must revisit)
  why    — unresolved | important | emotional | promised | curious | follow-up

These tags are stripped from visible output automatically. Use them sparingly.
Only bookmark things that genuinely matter — not every exchange needs one.
</memory_system>
```

---

## Notes

**Token cost:** ~220 tokens. Sits comfortably within a typical character card.

**Attribute order:** The sidecar accepts `topic`, `weight`, and `why` in any order.
Only `topic` is required; `weight` defaults to `0.5` and `why` defaults to `unspecified` if omitted.

**Tuning weight defaults by character type:**
| Character type | Suggested default weight |
|---|---|
| Casual companion / slice-of-life | 0.5–0.6 |
| Therapist / confidant | 0.7–0.8 |
| Long-running narrative / plot-heavy | 0.8–0.9 |

**Restricting `why` vocabulary:** Models hallucinate less on constrained choices.
The six values in the snippet (`unresolved`, `important`, `emotional`, `promised`, `curious`,
`follow-up`) cover most cases. Remove any that don't fit the character's register.

**Soft callbacks and character voice:** The callback surfacing is random (weighted).
A character who is attentive and warm will naturally weave callbacks in more often
than one who is brusque or preoccupied — you can reinforce this in the personality
section of the card without touching the snippet.
