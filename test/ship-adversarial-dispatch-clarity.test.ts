import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_HOST_CONFIGS } from '../hosts/index';
import { generateAdversarialStep } from '../scripts/resolvers/outside-voice-steps';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { between, compact, expectAbsent, expectMentions, expectTokens } from './helpers/prompt-structure';

const root = join(import.meta.dir, '..');
const ctxFor = (skillName: string, host: string): TemplateContext =>
  ({ skillName, host, tmplPath: `${skillName}/SKILL.md.tmpl`, paths: HOST_PATHS[host] } as TemplateContext);

// Paid gate run 40815828320 (ship/SKILL.md workflow judge, clarity 3, actionability 3): samples 1 and 3 found
// ship Step 11's header running the native pass only on `DISPATCH: adversarial-native` and the outside voice
// only on `DISPATCH: outside-voice`, while every CODEX_MODE branch kept a "required" native pass that "STILL
// runs" and the outside challenge ran "whenever" CODEX_MODE was ready. These retired phrases are pinned for that
// eval; /review keeps them because its native pass always runs.
const NATIVE_ALWAYS = [/STILL runs/, /required \S+(?: \(in-host\))? adversarial pass/i, /Retain the required native pass/,
  /retain the native pass/i, /Keep the required native pass/, /runs whenever/, /always runs/, /Required native review incomplete/];

test('ship Step 11 lets the review plan alone decide which adversarial voices run, on every host', () => {
  // Value: protects=ship Step 11 has one dispatch rule (the plan's DISPATCH lines); fails_when=a CODEX_MODE
  // branch, heading or decision makes the native pass unconditional or runs the outside voice off-plan;
  // why_new=outside-voice-preflight pins only the /review-style retain wording; seam=none
  const header = compact(readFileSync(join(root, 'ship/sections/adversarial.md.tmpl'), 'utf8').split('{{ADVERSARIAL_STEP}}')[0]!);
  expectTokens(header, ['`DISPATCH: adversarial-native`', '`DISPATCH: outside-voice`', '`ADVERSARIAL: skipped (review plan)`'], 'ship header');
  expectMentions(header, [['plan', 'decides', 'voices'], ['native', 'only', 'adversarial-native'], ['outside', 'only', 'outside-voice', 'preflight']], 'ship header');
  for (const { name } of ALL_HOST_CONFIGS) {
    const step = generateAdversarialStep(ctxFor('ship', name));
    expectAbsent(step, NATIVE_ALWAYS, `ship ${name}`);
    expect(step.match(/^### .*adversarial subagent .*$/m)?.[0], name).toContain('(on `DISPATCH: adversarial-native`)');
    expect(step.match(/^### .*adversarial challenge .*$/m)?.[0], name).toContain('on `DISPATCH: outside-voice`');
    expect(between(step, /^### .*structured review/m, 'Prepare a structured review prompt'), name).toContain('`DISPATCH: outside-voice`');
    expect(compact(between(step, '### Finish the adversarial phase')), name).toContain('1. **Dispatched native review incomplete:**');
  }
});

test('/review keeps its always-on native adversarial pass on every host', () => {
  for (const { name } of ALL_HOST_CONFIGS) {
    const step = generateAdversarialStep(ctxFor('review', name));
    expectAbsent(step, ['DISPATCH:'], `review ${name}`);
    expectTokens(step, ['adversarial subagent (always runs)', 'adversarial challenge (runs whenever'], `review ${name}`);
    expect(step.match(/Retain the required native pass without duplicating it/g), name).toHaveLength(2);
  }
});

test('ship Greptile fixes return through the saved work list, not an inline loop', () => {
  // Value: protects=Greptile fix approvals re-enter Step 9 through control-flow rule 2; fails_when=Step 10
  // restores its own "run Step 9, then return here" loop beside the saved list (run 40815828320 sample 2); seam=none
  const after = compact(between(readFileSync(join(root, 'ship/sections/greptile.md.tmpl'), 'utf8'), '**After triage:**', '---'));
  expectTokens(after, ['`9 → 10`', 'rule 2'], 'greptile after triage');
  expectAbsent(after, [/return here/i, /review\/fix loop/], 'greptile after triage');
});
