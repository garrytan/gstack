/** Seed the review target before the first model turn, in a caller-owned,
 * fresh private directory. Never reuse an operator project or its git state.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** These cases review a supplied plan. Decline only the initial, explicit
 * Office Hours prerequisite pair; every other question keeps the driver default. */
export function pickSuppliedCeoPlanStart({ options }: { options: Array<{ index: number; label: string }> }): number {
  const choices = options.map(option => ({ ...option, label: option.label.trim()
    .replace(/^[A-D][).]\s+/, '').replace(/\s*\(Recommended\)\s*$/i, '').trim() }));
  const run = choices.filter(option => /^Run \/office-hours(?: now)?$/i.test(option.label));
  const skip = choices.filter(option => /^Skip(?:\s*[—–-]\s*standard review|\s*\(standard review without design doc context\))?$/i.test(option.label));
  return choices.length === 2 && run.length === 1 && skip.length === 1 ? skip[0]!.index : 1;
}

/** Mode fixtures already have a review target. These two observed prerequisite
 * offers explicitly continue that review; no other Office Hours mention does. */
export function pickSuppliedCeoModeStart({ question, options }: {
  question: string; options: Array<{ index: number; label: string }>;
}): number {
  if (!/^D[1-9]\d* — (?:Run \/office-hours before this review|No design doc found: run \/office-hours before the review)\?$/i.test(question.split(/\r?\n/, 1)[0]!)) return 1;
  const choices = options.map(option => ({ ...option, label: option.label.trim()
    .replace(/^[A-D][).]\s+/, '').replace(/\s*\(Recommended\)\s*$/i, '').trim() }));
  if (choices.length !== 2 || choices.some((option, i) => option.index !== i + 1)
    || choices.filter(option => /^Run \/office-hours (?:first|now)$/i.test(option.label)).length !== 1
    || choices.filter(option => /^Skip — (?:standard review|proceed with review)$/i.test(option.label)).length !== 1) return 1;
  return pickSuppliedCeoPlanStart({ options: choices.map(option => ({ ...option,
    label: option.label.replace(/ first$/i, ' now').replace(/proceed with review$/i, 'standard review'),
  })) });
}

export function seedCeoFindingProject(projectDir: string, plan: string, design?: string): void {
  seedPlanReviewProject(projectDir, plan, 'plan-ceo-review', design);
}

/** The five-finding review gets a small existing handler boundary, not an
 * implementation or regression coverage for its proposed PaymentService. */
export function seedCeoPaymentProject(projectDir: string, plan: string): void {
  seedCeoFindingProject(projectDir, plan);
  const fixture = path.resolve(import.meta.dir, '../fixtures/ceo-existing-payment');
  const files = [['README.md', 'README.md'], ['platform.ts', 'src/platform.ts'],
    ['existing-invoice-handler.ts', 'src/existing-invoice-handler.ts'],
    ['application.ts', 'src/application.ts'], ['application-services.ts', 'src/application-services.ts'],
    ['schema.sql', 'schema.sql'], ['contract.test.ts.fixture', 'contract.test.ts']];
  fs.mkdirSync(path.join(projectDir, 'src'));
  for (const [source, target] of files) {
    fs.copyFileSync(path.join(fixture, source!), path.join(projectDir, target!));
  }
  const git = (args: string[]) => execFileSync('git', args, { cwd: projectDir, stdio: 'pipe', timeout: 10_000 });
  git(['add', ...files.map(([, target]) => target!)]);
  git(['-c', 'user.name=Finding fixture', '-c', 'user.email=fixture@gstack.test', 'commit', '-m', 'Seed existing invoice integration']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
}

/** Materialized documentation for the revised synthetic DX baseline. The SDK
 * implementation is deliberately absent; this does not run or install it. */
export function seedDevexReviewProject(projectDir: string, plan: string): void {
  seedPlanReviewProject(projectDir, plan, 'plan-devex-review');
  const fixture = path.resolve(import.meta.dir, '../fixtures/devex-existing-sdk');
  const files = ['README.md', 'docs/getting-started.md', 'docs/feedback.md', 'docs/reference-v1.md'];
  fs.mkdirSync(path.join(projectDir, 'docs'));
  for (const file of files) fs.copyFileSync(path.join(fixture, file), path.join(projectDir, file));
  const git = (args: string[]) => execFileSync('git', args, { cwd: projectDir, stdio: 'pipe', timeout: 10_000 });
  git(['add', ...files]);
  git(['-c', 'user.name=Finding fixture', '-c', 'user.email=fixture@gstack.test', 'commit', '-m', 'Seed synthetic SDK documentation']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
}

export function seedPlanReviewProject(projectDir: string, plan: string, skill: 'plan-ceo-review' | 'plan-eng-review' | 'plan-design-review' | 'plan-devex-review', design?: string): void {
  if (!fs.lstatSync(projectDir).isDirectory() || fs.readdirSync(projectDir).length !== 0) {
    throw new Error('Plan review fixture requires a fresh private directory');
  }
  fs.writeFileSync(path.join(projectDir, 'review-input.md'), plan, { flag: 'wx' });
  if (design !== undefined) fs.writeFileSync(path.join(projectDir, 'DESIGN.md'), design, { flag: 'wx' });
  fs.writeFileSync(path.join(projectDir, 'README.md'), `# ${skill} fixture\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), [
    `# ${skill}`, '',
    'The requested review target is the plan in `review-input.md`. Read it before',
    'choosing review scope. Follow its instruction for the output plan path.',
    'This repository contains the review input; its branch diff is not the plan.', '',
    '## Skill routing', '',
    `- For the primary review request, review the supplied plan with /${skill}.`,
    '- Delegated independent critics follow their assigned read-only critique and',
    '  return findings to the parent. Start an interactive skill only when the delegated task explicitly requests that workflow.', '',
  ].join('\n'), { flag: 'wx' });
  const git = (args: string[]) => execFileSync('git', args, { cwd: projectDir, stdio: 'pipe', timeout: 10_000 });
  git(['init', '-b', 'main']);
  git(['add', 'README.md', 'CLAUDE.md', 'review-input.md', ...(design === undefined ? [] : ['DESIGN.md'])]);
  git(['-c', 'user.name=Finding fixture', '-c', 'user.email=fixture@gstack.test', 'commit', '-m', 'Seed review input']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
}
