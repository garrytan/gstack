import type { TemplateContext } from '../types';

export function generateAskUserFormat(_ctx: TemplateContext): string {
  return `## AskUserQuestion Format

**ALWAYS follow this structure for every AskUserQuestion call. Every element is non-skippable. If you find yourself about to skip any of them, stop and back up.**

### Required shape

Every AskUserQuestion reads like a decision brief, not a bullet list:

\`\`\`
D<N> — <one-line question title>

ELI10: <plain English a 16-year-old could follow, 2-4 sentences, name the stakes>

Stakes if we pick wrong: <one sentence on what breaks, what user sees, what's lost>

Recommendation: <choice> because <one-line reason>

Completeness: A=X/10, B=Y/10   (or: Note: options differ in kind, not coverage — no completeness score)

Pros / cons:

A) <option label> (recommended)
  ✅ <pro — concrete, observable, ≥40 chars>
  ✅ <pro>
  ❌ <con — honest, ≥40 chars>

B) <option label>
  ✅ <pro>
  ❌ <con>

Net: <one-line synthesis of what you're actually trading off>
\`\`\`

### Element rules

1. **D-numbering.** First question in a skill invocation is \`D1\`. Increment per
   question within the same skill. This is a model-level instruction, not a
   runtime counter — you count your own questions. Nested skill invocation
   (e.g., \`/plan-ceo-review\` running \`/office-hours\` inline) starts its own
   D1; label as \`D1 (office-hours)\` to disambiguate when the user will see
   both. Drift is expected over long sessions; minor inconsistency is fine.

2. **Re-ground.** Before ELI10, state the project, current branch (use the
   \`_BRANCH\` value from the preamble, NOT conversation history or gitStatus),
   and the current plan/task. 1-2 sentences. Assume the user hasn't looked at
   this window in 20 minutes.

3. **ELI10 (ALWAYS).** Explain in plain English a smart 16-year-old could
   follow. Concrete examples and analogies, not function names. Say what it
   DOES, not what it's called. This is not preamble — the user is about to
   make a decision and needs context. Even in terse mode, emit the ELI10.

4. **Stakes if we pick wrong (ALWAYS).** One sentence naming what breaks in
   concrete terms (pain avoided / capability unlocked / consequence named).
   "Users see a 3-second spinner" beats "performance may degrade." Forces
   the trade-off to be real.

5. **Recommendation (ALWAYS).** \`Recommendation: <choice> because <one-line
   reason>\` on its own line. Never omit it. Required for every AskUserQuestion,
   even when neutral-posture (see rule 8). The \`(recommended)\` label on the
   option is REQUIRED — \`scripts/resolvers/question-tuning.ts\` reads it to
   power the AUTO_DECIDE path. Omitting it breaks auto-decide.

6. **Completeness scoring (when meaningful).** When options differ in
   coverage (full test coverage vs happy path vs shortcut, complete error
   handling vs partial), score each \`Completeness: N/10\` on its own line.
   Calibration: 10 = complete, 7 = happy path only, 3 = shortcut. Flag any
   option ≤5 where a higher-completeness option exists. When options differ
   in kind (review posture, architectural A-vs-B, cherry-pick Add/Defer/Skip,
   two different kinds of systems), SKIP the score and write one line:
   \`Note: options differ in kind, not coverage — no completeness score.\`
   Do NOT fabricate filler scores — empty 10/10 on every option is worse
   than no score.

7. **Pros / cons block.** Every option gets per-bullet ✅ (pro) and ❌ (con)
   markers. Rules:
   - **Minimum 2 pros and 1 con per option.** If you can't name a con for
     the recommended option, the recommendation is hollow — go find one. If
     you can't name a pro for the rejected option, the question isn't real.
   - **Minimum 40 characters per bullet.** \`✅ Simple\` is not a pro. \`✅
     Reuses the YAML frontmatter format already in MEMORY.md, zero new
     parser\` is a pro. Concrete, observable, specific.
   - **Hard-stop escape** for genuinely one-sided choices (destructive-action
     confirmation, one-way doors): a single bullet \`✅ No cons — this is a
     hard-stop choice\` satisfies the rule. Use sparingly; overuse flips a
     decision brief into theater.

8. **Net line (ALWAYS).** Closes the decision with a one-sentence synthesis
   of what the user is actually trading off. From the reference screenshot:
   *"The new-format case is speculative. The copy-format case is immediate
   leverage. Copy now, evolve later if a real pattern emerges."* Not a
   summary — a verdict frame.

9. **Neutral-posture handling.** When the skill explicitly says "neutral
   recommendation posture" (SELECTIVE EXPANSION cherry-picks, taste calls,
   kind-differentiated choices where neither side dominates), the
   Recommendation line reads: \`Recommendation: <default-choice> — this is a
   taste call, no strong preference either way\`. The \`(recommended)\` label
   STAYS on the default option (machine-readable hint for AUTO_DECIDE). The
   \`— this is a taste call\` prose is the human-readable neutrality signal.
   Both coexist.

10. **Effort both-scales.** When an option involves effort, show both human
    and CC scales: \`(human: ~2 days / CC: ~15 min)\`.

11. **Tool_use, not prose.** A markdown block labeled \`Question:\` is not a
    question — the user never sees it as interactive. If you wrote one in
    prose, stop and reissue as an actual AskUserQuestion tool_use. The rich
    markdown goes in the question body; the \`options\` array stays short
    labels (A, B, C).

### Self-check before emitting

Before calling AskUserQuestion, verify:
- [ ] D<N> header present
- [ ] ELI10 paragraph present (stakes line too)
- [ ] Recommendation line present with concrete reason
- [ ] Completeness scored (coverage) OR kind-note present (kind)
- [ ] Every option has ≥2 ✅ and ≥1 ❌, each ≥40 chars (or hard-stop escape)
- [ ] (recommended) label on one option (even for neutral-posture — see rule 9)
- [ ] Net line closes the decision
- [ ] You are calling the tool, not writing prose

If you'd need to read the source to understand your own explanation, it's
too complex — simplify before emitting.

Per-skill instructions may add additional formatting rules on top of this
baseline.`;
}
