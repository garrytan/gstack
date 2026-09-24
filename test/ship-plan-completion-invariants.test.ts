import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

const SHIP_DIR = path.join(__dirname, '..', 'ship');

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

describe('ship/SKILL.md — Plan Completion gate invariants (VAS-449 remediation)', () => {
  const skill = readShipUnion();

  test('Path concreteness rule: filesystem-pathed items must be test -f checked', () => {
    expect(skill).toContain('**Path concreteness rule.**');
    expect(skill).toMatch(/concrete filesystem path/);
    expect(skill).toMatch(/MUST be classified DONE or NOT DONE based on `\[ -f/);
  });

  test('Validator detection: project package.json validate-* scripts are auto-run', () => {
    expect(skill).toContain('**Validator detection.**');
    expect(skill).toMatch(/package\.json/);
    expect(skill).toMatch(/validate-\*/);
  });

  test('Per-item UNVERIFIABLE confirmation: blanket-confirm is forbidden', () => {
    expect(skill).toContain('**Per-item confirmation is mandatory.**');
    expect(skill).toMatch(/Do NOT use a single AskUserQuestion to blanket-confirm/);
    expect(skill).toMatch(/VAS-449/);
  });

  test('Subagent failure: fail-closed, not silent fail-open', () => {
    expect(skill).not.toMatch(/Never block \/ship on subagent failure\.\s*$/m);
    expect(skill).toMatch(/Silent fail-open is the failure shape that VAS-449 surfaced/);
    expect(skill).toMatch(/Stop and fix the audit/);
  });

  test('parent rejects audit errors and malformed counts instead of treating them as no plan', () => {
    const audit = fs.readFileSync(path.join(SHIP_DIR, 'sections/plan-completion.md'), 'utf8');
    const parent = audit.slice(audit.indexOf('**Parent processing:**'), audit.indexOf('**If the subagent fails'));
    expect(parent).toContain('non-null `error`');
    expect(parent).toContain('nonnegative integer');
    expect(parent).toContain('count sum');
    expect(parent).toContain('audit-failure fallback');
    expect(parent).toContain('Valid no-plan/no-actionable-item reports retain zero counts');
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
    expect(todos).toMatch(/unpersisted[^\n]+Step 19/);
  });

  test('CHANGELOG uses the normal workflow without checkpoint context or squash prerequisites', () => {
    const changelog = fs.readFileSync(path.join(SHIP_DIR, 'sections/changelog.md'), 'utf8');
    expect(changelog).toContain('**Write the CHANGELOG entry**');
    expect(changelog).not.toMatch(/WIP:|gstack-context|checkpoint|squash|Step 15\.0/);
  });

  test('live evidence recovery distinguishes bookkeeping failure from stale inputs', () => {
    const entry = fs.readFileSync(path.join(SHIP_DIR, 'SKILL.md'), 'utf8');
    const gate = entry.slice(entry.indexOf('## Step 16:'), entry.indexOf('## Step 17:'));
    expect(gate).toContain('Content, command or age mismatch, or no passing live evidence');
    expect(gate).toContain('Ledger read/write failure only');
    expect(gate).toContain('unchanged final content');
    expect(gate).toMatch(/exact command and permitted age, cite its exit,\s+timestamp and log/);
    expect(gate).toMatch(/never\s+ledger FRESH/);
    expect(gate).toMatch(/Do not rerun green suites solely because the ledger cannot save\s+or read its record/);
    expect(gate).toContain('required live RUN must pass');
    expect(gate).toMatch(/TODO edits and generated tests are content\s+changes, not ledger-only bookkeeping/);
    expect(gate).toContain('If unchanged content cannot be confirmed, STOP');
  });

  test('ship contract precedes base detection and fresh remote facts precede distribution decisions', () => {
    const entry = fs.readFileSync(path.join(SHIP_DIR, 'SKILL.md'), 'utf8');
    expect(entry.indexOf('# Ship:')).toBeLessThan(entry.indexOf('## Step 0:'));
    const preflight = entry.slice(entry.indexOf('## Step 1:'), entry.indexOf('## Step 2:'));
    expect(preflight).toContain('git fetch origin <base>');
    expect(preflight).toMatch(/fetch fails[^\n]+STOP/);
    expect(entry).not.toContain('auto-generate and commit, or flag');
    expect(entry).toContain('commit with Step 15');
  });

  test('bisectable commits proceed directly to verification without rewriting existing history', () => {
    const entry = fs.readFileSync(path.join(SHIP_DIR, 'SKILL.md'), 'utf8');
    const commit = entry.slice(entry.indexOf('## Step 15:'), entry.indexOf('## Step 16:'));
    expect(commit).toContain('Create small, logical commits for `git bisect`');
    expect(commit).toContain('If all changes are already committed, continue to Step 16');
    expect(commit).toContain('never create an empty commit');
    expect(commit).toContain('Each commit must work independently');
    expect(commit).not.toMatch(/checkpoint|WIP|squash|git rebase|git reset/);
    expect(entry).not.toMatch(/Step 15\.[012]/);
  });

  test('a rejected push stops publication and routes changed content back through verification', () => {
    const entry = fs.readFileSync(path.join(SHIP_DIR, 'SKILL.md'), 'utf8');
    const push = entry.slice(entry.indexOf('## Step 17:'), entry.indexOf('## Step 20:'));
    expect(push).toMatch(/push fails[^\n]+STOP/);
    expect(push).toContain('Step 5');
    expect(push).toContain('Step 16');
    expect(push).toMatch(/never force.push/i);
    expect(push).toContain('Only a successful push');
  });
});

test('push idempotency requires the live remote SHA and fails closed on transport errors', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-push-state-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 5000 });
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
    const inspect = () => spawnSync('bash', ['-c', block], { cwd, env, encoding: 'utf8', timeout: 5000 });
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
});
