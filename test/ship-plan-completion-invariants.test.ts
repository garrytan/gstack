import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { generatePlanCompletionAuditReview, generatePlanCompletionAuditShip, generatePlanCompletionGateShip, generatePlanVerificationExec } from '../scripts/resolvers/plan-gates';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { expectMentions } from './helpers/prompt-structure';

const SHIP_DIR = path.join(__dirname, '..', 'ship');

describe('authored ship-only plan verification handoff', () => {
  const ctx = { skillName: 'ship', tmplPath: 'ship/SKILL.md.tmpl', host: 'claude' as const, paths: HOST_PATHS.claude };
  test('local execution-only checks remain required in Step 8.1/9 outside implementation counts', () => {
    const audit = generatePlanCompletionAuditShip(ctx);
    const extraction = audit.slice(audit.indexOf('### Actionable Item Extraction'), audit.indexOf('### Verification Mode')).replace(/\s+/g, ' ');
    expect(extraction).toMatch(/execution-only verification/i);
    expect(extraction).toContain('Step 8.1/9');
    expect(extraction).toMatch(/outside implementation counts/i);
    expect(extraction).toMatch(/never DONE from static inspection/);
    expectMentions(extraction, [['do not', 'checks', 'waive']], 'extraction');
    expect(fs.readFileSync(path.join(SHIP_DIR, 'sections/plan-completion.md.tmpl'), 'utf8')).toContain('exactly these seven fields');
    const gate = generatePlanCompletionGateShip(ctx);
    expect(gate).toContain('Any NOT DONE items');
    expect(gate).toMatch(/per-item confirmation/i);
  });
  test('review-mode extraction retains its existing categories and has no ship-only routing', () => {
    const audit = generatePlanCompletionAuditReview({ ...ctx, skillName: 'review' });
    expect(audit).toContain('**Test requirements:**');
    expect(audit).not.toMatch(/execution-only verification/i);
    expect(audit).not.toContain('Step 8.1/9');
    expect(audit).toContain('EXTERNAL-STATE');
  });
  test('preparation hands every explicit check to the report-only execution owner before Fix-First', () => {
    const text = generatePlanVerificationExec(ctx).replace(/\s+/g, ' ');
    expect(text).toContain('Collect now; execute in Step 9');
    expectMentions(text, [['do not', 'invoke', 'entire']], 'text');
    for (const heading of ['Verification', 'Test plan', 'Testing', 'How to test', 'Manual testing']) {
      expect(text).toContain(`\`${heading}\``);
    }
    expect(text).toContain('Step 8.2');
    expect(text).toContain('Handoff to Step 9.2.1');
    expect(text).toMatch(/before Fix-First/);
    expect(text).toMatch(/never silently waive/i);
    expect(text).toMatch(/noninteractive runs return blocked/i);
    expect(text).toContain('VERIFY_RESULT=pass only if all selected items pass, skipped only if none exist, otherwise fail');
    expect(text).toContain('`## Verification Results`');
    expect(text.indexOf('Collect now')).toBeLessThan(text.indexOf('Handoff to Step 9.2.1'));
    expect(text.indexOf('Handoff to Step 9.2.1')).toBeLessThan(text.indexOf('After execution'));
  });
  test('the authored parent validates all seven fields and settles failed children before fallback', () => {
    const audit = fs.readFileSync(path.join(SHIP_DIR, 'sections/plan-completion.md.tmpl'), 'utf8');
    const parent = audit.slice(audit.indexOf('**Parent processing:**')).replace(/\s+/g, ' ');
    expect(parent).toMatch(/valid LAST-line JSON, use the audit-failure fallback/i);
    expect(parent).toContain('exactly the seven declared fields');
    expect(parent).toContain('classification sum equals `total_items`');
    expect(parent).toContain('a string `summary`');
    expectMentions(parent, [['no', 'no-plan/no-actionable', 'reports']], 'parent');
    expect(parent).toContain('~10 minutes');
    expectMentions(parent, [['stop', 'confirm', 'stopped']], 'parent');
    expect(parent).toMatch(/never race a late result/i);
    expectMentions(parent, [['stop', 'recommended/default', 'audit']], 'parent');
    const contract = audit.split('\n').find(line => line.startsWith('{"total_items":N,'))!;
    expect(Object.keys(JSON.parse(contract.replace(/:N([,}])/g, ':0$1'))).sort())
      .toEqual(['total_items', 'done', 'changed', 'partial', 'not_done', 'unverifiable', 'summary'].sort());
    expect(generatePlanCompletionGateShip(ctx)).toContain('Only PARTIAL items (no NOT DONE, no UNVERIFIABLE)');
    expect(generatePlanCompletionGateShip(ctx)).toMatch(/not blocking/i);
  });
});

// Carved (v2 plan T9): the Plan Completion gate moved into sections/plan-completion.md.
// Read the skeleton + sections union so these invariants follow the content.
function readShipUnion(): string {
  let t = fs.readFileSync(path.join(SHIP_DIR, 'SKILL.md'), 'utf8');
  const secDir = path.join(SHIP_DIR, 'sections');
  if (fs.existsSync(secDir)) {
    for (const f of fs.readdirSync(secDir).sort()) {
      if (f.endsWith('.md')) t += '\n' + fs.readFileSync(path.join(secDir, f), 'utf8');
    }
  }
  return t;
}

describe('ship/SKILL.md — Plan Completion gate invariants', () => {
  const skill = readShipUnion();

  test('Path concreteness rule: filesystem-pathed items must be test -f checked', () => {
    expect(skill).toContain('**Path concreteness rule.**');
    expect(skill).toMatch(/concrete filesystem path/);
    expect(skill).toMatch(/classified DONE or NOT DONE based on `\[ -f/);
  });

  test('Validator detection: project package.json validate-* scripts are auto-run', () => {
    expect(skill).toContain('**Validator detection.**');
    expect(skill).toMatch(/package\.json/);
    expect(skill).toMatch(/validate-\*/);
  });

  test('Per-item UNVERIFIABLE confirmation: blanket-confirm is forbidden', () => {
    expect(skill).toMatch(/per-item confirmation/i);
    expectMentions(skill, [['do not', 'askuserquestion', 'blanket-confirm']], 'skill');
  });

  test('Subagent failure: fail-closed, not silent fail-open', () => {
    // The audit-failure fallback still forbids a silent fail-open (meaning, not the old incident ID).
    const fallback = skill.slice(skill.indexOf('**Audit-failure fallback:**'), skill.indexOf('**Audit-failure fallback:**') + 800);
    expect(fallback).toMatch(/fail[- ]open/i);
    expectMentions(skill, [['stop', 'audit']], 'skill');
  });

  test('parent rejects audit errors and malformed counts instead of treating them as no plan', () => {
    const audit = fs.readFileSync(path.join(SHIP_DIR, 'sections/plan-completion.md'), 'utf8');
    expect(audit.indexOf('**Parent processing:**')).toBeGreaterThan(-1);
    expect(audit.indexOf('**Parent processing:**')).toBeLessThan(audit.indexOf('**Audit-failure fallback:**'));
    const parent = audit.slice(audit.indexOf('**Parent processing:**'), audit.indexOf('**Audit-failure fallback:**')).replace(/\s+/g, ' ');
    expect(parent).toContain('seven declared fields');
    expect(parent).toMatch(/audit-failure fallback/i);
  });

  test('successful plan audits use the declared seven-field contract without an error field', () => {
    const audit = fs.readFileSync(path.join(SHIP_DIR, 'sections/plan-completion.md'), 'utf8');
    const line = audit.split('\n').find(line => line.startsWith('{"total_items":N,'));
    expect(line).toBeDefined();
    const contract = JSON.parse(line!.replace(/:N([,}])/g, ':0$1'));
    expect(Object.keys(contract).sort()).toEqual(['total_items', 'done', 'changed', 'partial', 'not_done', 'unverifiable', 'summary'].sort());
    expect(contract).not.toHaveProperty('error');
    expect(audit).toContain('exactly these seven fields on the LAST LINE');
    expect(audit).not.toContain('A non-null `error`');
  });

  test('CONTENT-SHAPE dispatch invokes validator before falling back to UNVERIFIABLE', () => {
    expect(skill).toMatch(/CONTENT-SHAPE in another repo.*validator/s);
    expect(skill).toMatch(/passing validator promotes the item from UNVERIFIABLE to DONE/);
  });

  test('approved deferrals reach Step 14 without duplicating earlier P0 entries', () => {
    const entry = fs.readFileSync(path.join(SHIP_DIR, 'SKILL.md'), 'utf8');
    const todos = entry.slice(entry.indexOf('## Step 14:'), entry.indexOf('## Step 15:'));
    expect(todos).toContain('Add approved deferrals');
    expect(todos).toMatch(/Step 2[^\n]+P1/);
    expect(todos).toMatch(/Step 8[^\n]+P1[^\n]+plan/);
    expect(todos).toMatch(/Step 5[^\n]+P0[^\n]+deduplicate/);
    expect(todos.indexOf('Add approved deferrals')).toBeLessThan(todos.indexOf('Detect completed TODOs'));
  });

  test('CHANGELOG uses the normal workflow without checkpoint context or squash prerequisites', () => {
    const changelog = fs.readFileSync(path.join(SHIP_DIR, 'sections/changelog.md'), 'utf8');
    expect(changelog).toContain('**Write the CHANGELOG entry**');
    expect(changelog).not.toMatch(/WIP:|gstack-context|checkpoint|squash|Step 15\.0/);
  });

  test('live evidence recovery distinguishes bookkeeping failure from stale inputs', () => {
    const entry = fs.readFileSync(path.join(SHIP_DIR, 'SKILL.md'), 'utf8');
    const gate = entry.slice(entry.indexOf('## Step 16:'), entry.indexOf('## Step 17:'));
    const text = gate.replace(/\s+/g, ' ');
    expect(text).toContain('STALE/MISSING');
    expect(text).toContain('| Only receipt storage/readback failed |');
    expect(text).toContain('**ledger unavailable**, never FRESH');
    const storage = text.slice(text.indexOf('| Only receipt storage/readback failed |')).split('|')[2];
    expect(storage).not.toContain('gstack-evidence run');
    expect(storage).toMatch(/without that proof, use STALE\/MISSING/i);
    expect(text).toMatch(/\*\*New, changed or unwaived test failure:\*\* stop publication\. Run Steps 5–15/i);
    expectMentions(text, [['only', 'pre-existing', 'verified']], 'text');
    expect(text).toMatch(/make evidence STALE/);
  });

  test('ship contract precedes base detection and fresh remote facts precede distribution decisions', () => {
    const entry = fs.readFileSync(path.join(SHIP_DIR, 'SKILL.md'), 'utf8');
    expect(entry.indexOf('# Ship:')).toBeLessThan(entry.indexOf('## Step 0:'));
    const preflight = entry.slice(entry.indexOf('## Step 1:'), entry.indexOf('## Step 2:'));
    expect(preflight).toContain('git fetch origin <base>');
    expect(preflight).toMatch(/fetch fails[^\n]+\bstop\b/i);
    expect(entry).not.toContain('auto-generate and commit, or flag');
    expect(entry).toContain('Step 15 commits those tests');
  });

  test('bisectable commits proceed directly to verification without rewriting existing history', () => {
    const entry = fs.readFileSync(path.join(SHIP_DIR, 'SKILL.md'), 'utf8');
    const commit = entry.slice(entry.indexOf('## Step 15:'), entry.indexOf('## Step 16:'));
    expect(commit).toMatch(/bisectable commits/i);
    expect(commit).toContain('continue to Step 16');
    expectMentions(commit, [['never', 'create', 'commit']], 'commit');
    expect(commit).not.toMatch(/checkpoint|WIP|squash|git rebase|git reset/);
    expect(entry).not.toMatch(/Step 15\.[012]/);
  });

  test('a rejected push stops publication and routes changed content back through verification', () => {
    const entry = fs.readFileSync(path.join(SHIP_DIR, 'SKILL.md'), 'utf8');
    const push = entry.slice(entry.indexOf('## Step 17:'), entry.indexOf('## Step 20:'));
    const recovery = push.replace(/\s+/g, ' ');
    expect(push).toMatch(/push fails[^\n]+\bstop\b/i);
    expect(recovery).toContain('**Non-fast-forward push:**');
    expectMentions(recovery, [['before', 'returning', 'steps']], 'recovery');
    expect(recovery).toMatch(/never rewrite history/i);
    expect(recovery).toContain('**Authentication, hook or network failure:**');
    expect(push).toMatch(/never force.push/i);
    expect(push).toMatch(/only a successful push/i);
  });
});

test('push idempotency requires the live remote SHA and fails closed on transport errors', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-push-state-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0) throw new Error(r.stderr || String(r.error));
  };
  try {
    git('init', '-b', 'feature');
    fs.writeFileSync(path.join(cwd, 'app'), 'base\n');
    git('add', 'app'); git('commit', '-m', 'base');
    const remote = path.join(cwd, '.git/remote.git');
    git('init', '--bare', remote); git('remote', 'add', 'origin', remote);
    const source = fs.readFileSync(path.join(SHIP_DIR, 'SKILL.md.tmpl'), 'utf8');
    const block = source.slice(source.indexOf('**Idempotency check:** Check if the branch'))
      .match(/```bash\n([\s\S]*?)\n```/)![1].replaceAll('<branch-name>', 'feature');
    const inspect = () => {
      const r = spawnSync('bash', ['-c', block], { cwd, env, encoding: 'utf8', timeout: 30_000 });
      if (r.error) throw new Error(`idempotency check did not run: ${r.error.message}; stderr: ${r.stderr}`);
      return r;
    };
    expect(inspect().stdout).toContain('PUSH_NEEDED');
    git('push', '-u', 'origin', 'feature');
    expect(inspect().stdout).toContain('ALREADY_PUSHED');
    fs.appendFileSync(path.join(cwd, 'app'), 'new\n'); git('commit', '-am', 'new');
    expect(inspect().stdout).toContain('PUSH_NEEDED');
    git('push', 'origin', 'feature');
    fs.renameSync(remote, remote + '-offline');
    const unavailable = inspect();
    expect(unavailable.status).toBe(1);
    expect(unavailable.stdout).not.toContain('ALREADY_PUSHED');
    expect(unavailable.stdout).toContain('BLOCKED');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}, 120_000);

// F1 (#2768, #2800): the Plan Completion Audit used to fall back to "the newest
// plan file from the last day" and to any plan naming the repo, so a branch
// with no plan was audited against an unrelated one, and repo-committed
// docs/designs/ was never searched. The rendered discovery block now binds
// explicitly, lists docs/designs/ candidates, and never auto-picks.
describe('F1: plan binding, docs/designs candidates, exact not-run line', () => {
  const ROOT = path.join(__dirname, '..');
  const NOT_RUN = 'Plan completion audit: not run (no plan is bound to this branch and no docs/designs/ file matches). Fix: add "Plan: <path>" to the PR body, or run /autoplan.';
  const sections = {
    ship: path.join(ROOT, 'ship', 'sections', 'plan-completion.md'),
    review: path.join(ROOT, 'review', 'sections', 'plan-completion.md'),
  };

  function discovery(file: string): string {
    const md = fs.readFileSync(file, 'utf8');
    return md.slice(md.indexOf('### Plan File Discovery')).match(/```bash\n([\s\S]*?)```/)![1]
      .replaceAll('~/.claude/skills/gstack', ROOT).replaceAll('<base>', 'main');
  }

  function fixture(opts: { design?: boolean; prBody?: string }) {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-bind-')));
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const env = { ...process.env, HOME: tmp, GSTACK_HOME: path.join(tmp, '.gstack'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as Record<string, string>;
    delete env.GSTACK_STATE_ROOT; delete env.GSTACK_PROJECT_SLUG;
    const git = (...a: string[]) => spawnSync('git', a, { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
    git('init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(repo, 'docs', 'designs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs', 'designs', 'OLD_FEATURE.md'), '# an older, unrelated design\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-qb', 'feat-pricing');
    fs.writeFileSync(path.join(repo, 'src.ts'), 'x\n');
    if (opts.design) fs.writeFileSync(path.join(repo, 'docs', 'designs', 'PRICING.md'), '# pricing plan\n');
    git('add', '-A'); git('commit', '-qm', 'work');
    // An unrelated plan-mode file from today, naming neither branch nor feature.
    fs.mkdirSync(path.join(tmp, '.claude', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'plans', 'recent-unrelated.md'), '# refactor the billing page for repo\n');
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    if (opts.prBody !== undefined) fs.writeFileSync(path.join(tmp, 'pr-body.txt'), opts.prBody);
    fs.writeFileSync(path.join(bin, 'gh'), opts.prBody === undefined ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\ncat '${path.join(tmp, 'pr-body.txt')}'\n`, { mode: 0o755 });
    env.PATH = `${bin}:${process.env.PATH}`;
    return { tmp, repo, env };
  }

  function run(which: 'ship' | 'review', f: ReturnType<typeof fixture>) {
    return spawnSync('bash', ['-c', discovery(sections[which])], { cwd: f.repo, env: f.env, encoding: 'utf8', timeout: 30_000 });
  }

  for (const which of ['ship', 'review'] as const) {
    test(`${which}: a docs/designs file changed on this branch is a candidate; an unrelated recent plan is not`, () => {
      const f = fixture({ design: true });
      try {
        const out = run(which, f).stdout;
        expect(out).toContain(`PLAN_CANDIDATE: ${path.join(f.repo, 'docs', 'designs', 'PRICING.md')}`);
        expect(out).not.toContain('OLD_FEATURE.md');
        expect(out).not.toContain('recent-unrelated.md');
        expect(out).not.toContain('PLAN_FILE:');
      } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
    });

    test(`${which}: nothing bound and nothing matching yields no plan at all`, () => {
      const f = fixture({});
      try {
        const out = run(which, f).stdout;
        expect(out).not.toContain('PLAN_CANDIDATE:');
        expect(out).not.toContain('PLAN_FILE:');
        expect(out).not.toContain('recent-unrelated.md');
      } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
    });

    test(`${which}: a "Plan:" line in the PR body is printed as the binding`, () => {
      const f = fixture({ prBody: 'Summary\n\nPlan: `docs/designs/PRICING.md`\n' });
      try {
        expect(run(which, f).stdout).toContain('PLAN_BINDING: docs/designs/PRICING.md');
      } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
    });

    test(`${which}: binding precedence and the exact not-run line`, () => {
      const md = fs.readFileSync(sections[which], 'utf8');
      const text = md.slice(md.indexOf('### Plan File Discovery')).replace(/\s+/g, ' ');
      expect(text).toContain(NOT_RUN);
      const order = ['Conversation context (primary)', 'PR body binding', 'Content-based search (fallback)', 'No binding and no chosen candidate'];
      const at = order.map(o => text.indexOf(o));
      expect(at.every(i => i >= 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
      expect(text).toMatch(/never pick one silently/i);
      expect(text).toContain('No plan: skip the audit');
    });
  }

  test('ship binds the plan in the parent before dispatch; the child never searches', () => {
    const md = fs.readFileSync(sections.ship, 'utf8');
    expect(md.indexOf('### Plan File Discovery')).toBeLessThan(md.indexOf('````text'));
    const child = md.slice(md.indexOf('````text'), md.lastIndexOf('````'));
    expect(child).not.toContain('### Plan File Discovery');
    expectMentions(child, [['do not', 'another', 'search']], 'child');
    expect(md).toMatch(/not-run line, skip dispatch/);
  });
});
