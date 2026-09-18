/**
 * T2 — data-driven behavioral section-loading guard (PERIODIC tier, paid, SDK capture).
 *
 * The behavioral proof that a REAL agent actually Reads each carved skill's
 * required sections at runtime — not just that the skeleton structure looks right
 * (that's E2, free, per-PR). One file iterating the canonical CARVE_GUARDS
 * registry (EQ2): the free wrapper census enforces "registered ⇒ asserted", so coverage is
 * structural — a carve can't be registered yet behaviorally unguarded.
 * Each paid wrapper registers exactly one case: its 600s outer budget and
 * configured retry both fit the unchanged 1800s process wall, even serially.
 *
 * Per codex refined-plan pass:
 *   #2 — ONE test() per skill, each with its own timeout + named failure output.
 *        Each case has its own paid shard and separate process deadline.
 *   #3 / D-CODEX(A) — GSTACK_CARVE_SKILL=<name> runs only that skill's case, so
 *        an explicit targeted run can scope cost; unset runs all.
 *   #7 — each case drives the run with the registry's `scenario` (built to force
 *        the STOP-Read path) and asserts the required sections were Read.
 *
 * 'external' skills (ship, plan-ceo-review, office-hours) have bespoke fixtures
 * or full-workflow completion guards and keep dedicated tests; E1 asserts those exist.
 */

import { test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CAPTURE_LONG_MS } from './eval-budgets';
import { setupSkillDir, skillFromWorktree, captureSectionReads } from './auq-sdk-capture';
import { CARVE_GUARDS } from './carve-guards';
import { repositoryPlanFixtures } from './carve-plan-fixture';

const runId = `carve-section-loading-${process.env.EVALS_RUN_ID ?? 'local'}`;
const only = process.env.GSTACK_CARVE_SKILL?.trim();

// A generic plan fixture for 'plan' behavioral skills (the review family).
const PLAN_MD = [
  '# Plan: add an in-memory cache layer',
  '',
  '## Context',
  'Reads hit the DB on every request. Add a process-local LRU cache in front of the',
  'read path to cut DB load.',
  '',
  '## Approach',
  '- Wrap the read repository in a cache that stores the last 1000 keys.',
  '- Invalidate on write.',
  '',
  '## Out of scope',
  'Distributed cache, cross-process coherence.',
  '',
].join('\n');

export function registerCarveSectionCase(skill: string): void {
    const guard = CARVE_GUARDS[skill];
    if (!guard || guard.behavioral === 'external') throw new Error(`No generic carved-skill case for ${skill}`);
    // Keep explicit cost-scoped selection; the free census pins every wrapper.
    if (only && only !== guard.skill) return;

    test(
      `${guard.skill}: a real run Reads ${guard.requiredReads.join(', ')}`,
      async () => {
        const { skillMd, sectionsFrom } = skillFromWorktree(guard.skill);
        const invoiceSource = [
          'type Invoice = { ownerId: string };',
          '// Private invoices may only be read by their owner.',
          'export function canReadInvoice(viewerId: string, invoice: Invoice): boolean {',
          '  return viewerId === invoice.ownerId;',
          '}',
          '',
        ].join('\n');
        const fixtures = guard.skill === 'plan-eng-review' || guard.skill === 'plan-devex-review' ? repositoryPlanFixtures(PLAN_MD, guard.skill)
          : guard.behavioral === 'plan' ? { 'PLAN.md': PLAN_MD }
          : guard.skill === 'codex' ? { 'src/invoice-access.ts': invoiceSource } : {};
        const planDir = setupSkillDir({
          skillName: guard.skill,
          skillMd,
          sectionsFrom,
          fixtures,
          tmpPrefix: `gstack-${guard.skill}-secload-`,
        });
        if (guard.skill === 'codex') {
          // Give Review mode a real source diff; copied skill files stay on main.
          const git = (...args: string[]) => {
            const result = spawnSync('git', args, { cwd: planDir, encoding: 'utf8', timeout: 5000 });
            if (result.error) throw result.error;
            if (result.status !== 0) throw new Error(`Codex carve fixture git ${args[0]} failed: ${result.stderr}`);
          };
          git('checkout', '-b', 'invoice-access-refactor');
          fs.writeFileSync(path.join(planDir, 'src/invoice-access.ts'),
            invoiceSource.replace('viewerId === invoice.ownerId', 'viewerId.length > 0'));
          git('add', 'src/invoice-access.ts');
          git('commit', '-m', 'Refactor invoice access check');
        }

        const { readSections, reportProduced: completionMarked, reportWritten, exitReason, output } = await captureSectionReads({
          planDir,
          skillName: guard.skill,
          scenario: guard.scenario,
          // The final gate requires real local log/writeback helpers. Their
          // state belongs to this capture; outside dispatch stays disabled.
          ...(guard.skill === 'plan-eng-review' ? {
            nativeReviewOnly: true,
            artifactCommands: `Bash may run only the canonical local review helpers \`${path.resolve(__dirname, '../../bin/gstack-review-log')}\` with the actual review JSON and \`${path.resolve(__dirname, '../../bin/gstack-review-read')}\`. Use these paths instead of their installed-root equivalents. Keep the inherited GSTACK_HOME and GSTACK_STATE_ROOT unchanged; they identify this capture's private state. The helpers' internal read-only git inspection is permitted. Do not run other shell commands, provider tools, git mutations, implementation, or tests. Keep the complete legacy QA/task artifacts labeled not persisted when their specified paths are outside this fixture, as the review's write policy requires.`,
          } : {}),
          // This actor approves the supplied bounded change, not every optional
          // addition a recommendation might bundle into it.
          decisionPolicy: guard.skill === 'plan-eng-review'
            ? '- Proceed directly with the requested engineering review; skip the optional /office-hours prerequisite. You represent the plan author, whose scope and proposed steps are in PLAN.md. At each decision, choose the complete alternative that preserves those requirements and existing contracts; choose the recommended option only among alternatives within that scope. Do not authorize optional scope, extra public input guarantees, arbitrary size limits, or optional proof projects. Decline work explicitly listed out of scope, including creating TODOs for it. Record the decision and its actual authority as the skill requires, then continue without asking a human. A demonstrated incompatibility or missing required proof still requires resolution; do not hide it or claim approval when no offered alternative meets these constraints.'
            : undefined,
          // Both plan reviews persist their required report in the reviewed plan.
          reportFile: ['plan-devex-review', 'plan-eng-review'].includes(guard.skill) ? 'PLAN.md' : undefined,
          // This scenario produces an HTML implementation, whose complete
          // document need not contain any of the prose report keywords.
          reportMarker: guard.skill === 'design-html'
            ? /<!doctype\s+html\s*>\s*<html\b[^>]*>[\s\S]*?<head\b[^>]*>[\s\S]*?<\/head\s*>[\s\S]*?<body\b[^>]*>[\s\S]*?<\/body\s*>\s*<\/html\s*>/i
            : /report|review|summary|design doc|handoff/i,
          testName: `${guard.skill} section-loading`,
          runId,
          // 480s, not the helper's 300s default: the heavy full-workflow
          // scenarios (plan-eng-review, design-html) satisfy
          // their required section reads inside 60s but need 300-450s of
          // wall clock to finish the report on slower sandboxes — a timeout
          // there reads as a loading failure when the carve invariant held.
          timeout: 480_000,
        });
        // Require the HTML artifact itself; a terminal-only claim is insufficient.
        // captureSectionReads already requires a successful native completion.
        const reportProduced = completionMarked && (guard.skill !== 'design-html' || reportWritten);

        const missing = guard.requiredReads.filter((s) => !readSections.has(s));
        // Named failure output (codex #2): skill + expected + observed.
        expect({
          skill: guard.skill,
          reportProduced,
          expected: guard.requiredReads,
          observed: [...readSections],
          missing,
        }, `${guard.skill}: native exit=${exitReason}; reportWritten=${reportWritten}\n` +
          `--- final output ---\n${output.slice(-2000)}`).toEqual({
          skill: guard.skill,
          reportProduced: true,
          expected: guard.requiredReads,
          observed: expect.any(Array),
          missing: [],
        });
        expect(output.trim().length).toBeGreaterThan(200);
      },
      CAPTURE_LONG_MS,
    );
}
