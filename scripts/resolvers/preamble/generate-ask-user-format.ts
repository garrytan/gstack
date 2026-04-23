import type { TemplateContext } from '../types';

export function generateAskUserFormat(_ctx: TemplateContext): string {
  return `## AskUserQuestion Format

**ALWAYS follow this structure for every AskUserQuestion call. All four elements are non-skippable. If you find yourself about to skip any of them, stop and back up.**

1. **Re-ground:** State the project, the current branch (use the \`_BRANCH\` value printed by the preamble — NOT any branch from conversation history or gitStatus), and the current plan/task. (1-2 sentences)
2. **Simplify (ELI10, ALWAYS):** Explain what's happening in plain English a smart 16-year-old could follow. Concrete examples and analogies, not function names or internal jargon. Say what it DOES, not what it's called. State the stakes: what breaks if we pick wrong. This is NOT optional verbosity and it is NOT preamble — the user is about to make a decision and needs context. Even if you'd normally stay terse, emit the ELI10 paragraph. The user will ask for it anyway; do it the first time.
3. **Recommend (ALWAYS):** Every question ends with \`RECOMMENDATION: Choose [X] because [one-line reason]\` on its own line. Never omit it. Never collapse it into the options list. Required for every AskUserQuestion, regardless of whether the options are coverage-differentiated or different-in-kind.
4. **Score completeness (when meaningful):** When options differ in coverage (e.g. full test coverage vs happy path vs shortcut, complete error handling vs partial), score each with \`Completeness: N/10\` on its own line. Calibration: 10 = complete (all edge cases, full coverage), 7 = happy path only, 3 = shortcut. Flag any option ≤5 where a higher-completeness option exists. When options differ in kind (picking a review posture, picking an architectural approach, cherry-pick Add/Defer/Skip, choosing between two different kinds of systems), the completeness axis doesn't apply — skip \`Completeness: N/10\` entirely and write one line: \`Note: options differ in kind, not coverage — no completeness score.\` Do not fabricate filler scores.
5. **Options:** Lettered options: \`A) ... B) ... C) ...\` — when an option involves effort, show both scales: \`(human: ~X / CC: ~Y)\`

Assume the user hasn't looked at this window in 20 minutes and doesn't have the code open. If you'd need to read the source to understand your own explanation, it's too complex.

Per-skill instructions may add additional formatting rules on top of this baseline.`;
}

