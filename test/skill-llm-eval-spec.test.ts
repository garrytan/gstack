/**
 * /spec LLM-judge eval (periodic, paid).
 *
 * Asserts: when /spec runs against a fixture vague request, the agent
 * produces a spec body that scores >= 8/10 against an LLM judge using
 * the contributor's 14 Quality Standards as the rubric.
 *
 * Cost: ~$0.15/run. Periodic — runs weekly via cron or on demand via
 *       `EVALS=1 EVALS_TIER=periodic bun run test:evals`.
 *
 * TODO (v1.1): expand fixture set to cover bug / feature / refactor / audit
 * framings + project-level prompts (no concrete file mapping, exercises the
 * Phase 3 fallback path).
 */

import { describe, test } from 'bun:test';

const evalsEnabled = !!process.env.EVALS;
const describeEval = evalsEnabled ? describe : describe.skip;

describeEval('/spec LLM-judge eval (periodic)', () => {
  // test.todo, not expect(true): the placeholder reported PASS on every
  // run while asserting nothing — a lying green with a 300s budget. The
  // file stays as the periodic-tier selector surface for spec/ changes.
  //
  // Expected v1.1 implementation:
  //   1. Pick fixture prompt from test/fixtures/spec/vague-bug.md
  //   2. Spawn `claude -p` with /spec loaded, send the prompt + role-play
  //      five Phase 1 answers (from test/fixtures/spec/vague-bug-answers.json)
  //   3. Capture final spec body
  //   4. Dispatch to Claude judge with prompt encoding the 14 Quality
  //      Standards from spec/SKILL.md.tmpl
  //   5. Assert numeric score >= 8
  test.todo('spec body scores >= 8/10 against 14-standard rubric on fixture request');
});
