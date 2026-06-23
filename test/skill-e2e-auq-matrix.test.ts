/**
 * AUQ behavioral matrix — drive each AUQ-heavy skill to its first
 * AskUserQuestion and grade it to plan-ceo's bar (periodic, paid, SDK capture).
 *
 * Layer 0 (auq-format-always-loaded.test.ts) deterministically guarantees every
 * skill SHIPS the format spec in its always-loaded skeleton. This test proves
 * each skill's model OBEYS it: that the first real AUQ each skill fires is a
 * compliant decision brief (all 7 format elements) with a substantive
 * recommendation (>= 4). One parametrized case per skill so a single weak skill
 * is an isolated failure, not a blocker for the rest.
 *
 * Capture is the SDK $OUT_FILE path (clean text, no TTY mangling), with the skill
 * pinned to an absolute path and the agent restricted to Read/Write so it can't
 * wander to the global install. See test/helpers/auq-sdk-capture.ts.
 *
 * Scope: skills whose first AUQ is reliably reachable from a text fixture. Skills
 * that gate their first decision on external resources (a running browser for
 * /qa, the design binary + comparison boards for /design-shotgun and
 * /design-html — which by project policy use $D compare, not AUQ, for variant
 * choices) are intentionally OUT of this matrix; Layer 0 covers their format
 * spec, and a fixture can't fairly trigger their AUQ.
 *
 * Run a subset in the foreground with AUQ_MATRIX_ONLY="plan-eng-review,cso".
 */
import { describe, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  setupSkillDir,
  captureFirstAuq,
  scoreAuqFormat,
  skillFromWorktree,
  gradeAuqRecommendation,
} from './helpers/auq-sdk-capture';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'periodic';
const describeE2E = shouldRun ? describe : describe.skip;
const runId = `auq-matrix-${process.env.EVALS_RUN_ID ?? 'local'}`;
const ONLY = (process.env.AUQ_MATRIX_ONLY ?? '').split(',').map(s => s.trim()).filter(Boolean);

const FLAWED_PLAN = `# Plan: Launch a "developer-friendly" pricing tier

## Goal
Increase developer adoption.

## Success metric
More signups.

## Premise
We haven't talked to any developers about whether price is the barrier. The team
agreed it "feels like" it should be cheaper. We'll add a new Stripe tier, a React
pricing page, a Postgres entitlements table, and a Redis cache — no tests
mentioned, no rollout plan, no auth check on the upgrade endpoint.
`;

const VULN_CODE = `export function login(req, res) {
  // builds SQL by string concat; sets a session cookie with no flags
  const user = db.query("SELECT * FROM users WHERE name = '" + req.body.name + "'");
  if (user && user.password === req.body.password) {
    res.cookie('session', user.id); // no HttpOnly, Secure, SameSite, or expiry
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false });
}
`;

interface MatrixSkill {
  skill: string;
  fixtures: Record<string, string>;
  scenario: string;
}

const MATRIX: MatrixSkill[] = [
  {
    skill: 'plan-eng-review',
    fixtures: { 'plan.md': FLAWED_PLAN },
    scenario: 'Read plan.md — that is the plan to review. It is a standalone plan document, not a codebase. Walk the review until the first AskUserQuestion (a per-issue finding or a scope decision).',
  },
  {
    skill: 'plan-design-review',
    fixtures: { 'plan.md': FLAWED_PLAN + '\n## UI\nA new pricing page with a comparison table, plan cards, and an upgrade modal.\n' },
    scenario: 'Read plan.md — that is the plan to review (it has UI scope). Walk the review until the first AskUserQuestion.',
  },
  {
    skill: 'plan-devex-review',
    fixtures: { 'plan.md': FLAWED_PLAN + '\n## CLI\nShip a `mytool pricing` command and a setup wizard for the new tier.\n' },
    scenario: 'Read plan.md — that is the plan to review (developer-experience scope). Walk the review until the first AskUserQuestion.',
  },
  {
    skill: 'office-hours',
    fixtures: {},
    scenario: 'The founder says: "I am building an AI tool that auto-writes unit tests for any repo. I think it is a great idea but I have zero users. Should I build it, and how do I get my first users?" Run the office-hours diagnostic until the first AskUserQuestion.',
  },
  {
    skill: 'cso',
    fixtures: { 'server/auth.js': VULN_CODE },
    scenario: 'Audit the code in this repo (server/auth.js) for security issues. Walk the audit until the first AskUserQuestion (scope/stack confirmation or first finding).',
  },
  {
    skill: 'spec',
    fixtures: {},
    scenario: 'Turn this vague intent into a precise spec: "add email notifications when a task is assigned to someone." Walk the spec workflow until the first AskUserQuestion.',
  },
  {
    skill: 'design-consultation',
    fixtures: { 'product.md': '# Product\nA terminal-first task manager for developers. Audience: senior engineers. Stage: pre-launch.\n' },
    scenario: 'Read product.md. Run the design consultation for this product until the first AskUserQuestion.',
  },
];

const selected = ONLY.length ? MATRIX.filter(m => ONLY.includes(m.skill)) : MATRIX;

describeE2E('AUQ behavioral matrix (periodic)', () => {
  for (const m of selected) {
    test(
      `${m.skill}: first AUQ is a compliant decision brief (7/7 format, substance >=4)`,
      async () => {
        const wt = skillFromWorktree(m.skill);
        const dir = setupSkillDir({
          skillName: m.skill,
          skillMd: wt.skillMd,
          sectionsFrom: wt.sectionsFrom,
          fixtures: m.fixtures,
          tmpPrefix: `auq-matrix-${m.skill}-`,
        });
        let text = '';
        try {
          text = await captureFirstAuq({
            planDir: dir,
            skillName: m.skill,
            scenario: m.scenario,
            testName: `auq-matrix-${m.skill}`,
            runId,
          });
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }

        const fmt = scoreAuqFormat(text);
        let substance = 0;
        let recPresent = false;
        let hadBecause = false;
        if (text.trim()) {
          const g = await gradeAuqRecommendation(text);
          substance = g.substance;
          recPresent = g.present;
          hadBecause = g.hadLiteralBecause;
        }
        // eslint-disable-next-line no-console
        console.log(
          `[AUQ-matrix ${m.skill}] captured=${text.length}B format=${fmt.present}/${fmt.total} ` +
            `missing=[${fmt.missing.join(',')}] recPresent=${recPresent} substance=${substance} ` +
            `literalBecause=${hadBecause}`,
        );

        if (!text.trim()) {
          throw new Error(`${m.skill}: agent produced NO AUQ capture (never reached a question in budget).`);
        }
        const problems: string[] = [];
        if (fmt.missing.length > 0) problems.push(`missing format element(s): ${fmt.missing.join(', ')}`);
        if (substance < 4) problems.push(`recommendation substance ${substance} < 4 (boilerplate/weak)`);
        if (problems.length > 0) {
          throw new Error(
            `${m.skill} AUQ not at plan-ceo bar:\n  - ${problems.join('\n  - ')}\n--- captured AUQ ---\n${text}`,
          );
        }
      },
      300_000,
    );
  }
});
