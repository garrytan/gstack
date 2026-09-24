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

  test('CHANGELOG consumes WIP context before the later squash export', () => {
    const changelog = fs.readFileSync(path.join(SHIP_DIR, 'sections/changelog.md'), 'utf8');
    const entry = fs.readFileSync(path.join(SHIP_DIR, 'SKILL.md'), 'utf8');
    const readAt = changelog.indexOf('git log origin/<base>..HEAD --grep="^WIP:" --format="%H%n%B"');
    expect(readAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeLessThan(changelog.indexOf('**Write the CHANGELOG entry**'));
    const squash = entry.slice(entry.indexOf('### Step 15.0:'), entry.indexOf('### Step 15.1:'));
    expect(squash).not.toContain('This file becomes input to the CHANGELOG entry');
    expect(squash).toContain('Step 13 already read');
  });

  test('live evidence recovery distinguishes bookkeeping failure from stale inputs', () => {
    const entry = fs.readFileSync(path.join(SHIP_DIR, 'SKILL.md'), 'utf8');
    const gate = entry.slice(entry.indexOf('## Step 16:'), entry.indexOf('## Step 17:'));
    expect(gate).toContain('content, command, or age mismatch');
    expect(gate).toContain('ledger alone cannot record or verify');
    expect(gate).toContain('unchanged final content');
    expect(gate).toMatch(/exact command,\s+exit, and log/);
    expect(gate).toContain('never label the ledger FRESH');
    expect(gate).toContain('Do not rerun green suites solely for bookkeeping');
    expect(gate).toContain('a failed RUN does');
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

  test('WIP consolidation runs on committed content and refuses merge or published-history rewrites', () => {
    const entry = fs.readFileSync(path.join(SHIP_DIR, 'SKILL.md'), 'utf8');
    const prepare = entry.slice(entry.indexOf('### Step 15.0:'), entry.indexOf('### Step 15.1:'));
    const consolidate = entry.slice(entry.indexOf('### Step 15.2:'), entry.indexOf('## Step 16:'));
    expect(prepare).toContain('checkpoint_mode');
    expect(prepare).not.toContain('git rebase -i');
    expect(consolidate).toContain('git fetch origin');
    expect(consolidate).toMatch(/merge commits[\s\S]+published commits[\s\S]+preserve/);
    expect(consolidate).toMatch(/clean working\s+tree/);
    expect(consolidate).toContain('ORIGINAL_TREE');
    expect(consolidate).toContain('git rebase --abort');
    expect(consolidate).not.toContain('git reset --soft');
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

for (const mode of ['linear', 'merge', 'published', 'dirty'] as const) {
  test(`WIP shell protocol handles ${mode} history without altering reviewed content`, () => {
    // Exercise Git's shell-command editor boundary even on non-Windows hosts.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ship wip safety-'));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 5000 });
      if (r.status !== 0) throw new Error(r.stderr || String(r.error));
      return r.stdout.trim();
    };
    try {
      git('init', '-b', 'main');
      fs.writeFileSync(path.join(cwd, 'app'), 'base\n');
      git('add', 'app'); git('commit', '-m', 'base');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      git('switch', '-c', 'feature');
      for (const text of ['first', 'second']) {
        fs.writeFileSync(path.join(cwd, 'app'), text + '\n');
        git('commit', '-am', `WIP: ${text}`);
      }
      if (mode === 'merge') {
        git('switch', 'main');
        fs.writeFileSync(path.join(cwd, 'upstream'), 'merged base\n');
        git('add', 'upstream'); git('commit', '-m', 'base moved');
        git('update-ref', 'refs/remotes/origin/main', 'HEAD');
        git('switch', 'feature'); git('merge', 'main', '--no-edit');
      }
      if (mode === 'published') git('update-ref', 'refs/remotes/origin/feature', 'HEAD');
      if (mode === 'dirty') fs.appendFileSync(path.join(cwd, 'app'), 'uncommitted\n');
      const originalHead = git('rev-parse', 'HEAD');
      const originalTree = git('rev-parse', 'HEAD^{tree}');
      // Plain interactive rebase omits merge entries; the protocol must refuse
      // that range before a syntactically valid todo can flatten its history.
      const commits = git('rev-list', '--reverse', '--no-merges', 'origin/main..HEAD').split('\n');
      const todo = path.join(cwd, '.git/prepared-todo');
      fs.writeFileSync(todo, commits.map((sha, i) => `${i ? 'fixup' : 'reword'} ${sha}`).join('\n') + '\n');
      const editor = path.join(cwd, '.git/reword-editor');
      fs.writeFileSync(editor, '#!/bin/sh\nprintf "feat: logical change\\n" > "$1"\n', { mode: 0o755 });
      const source = fs.readFileSync(path.join(SHIP_DIR, 'SKILL.md.tmpl'), 'utf8');
      const snippet = source.match(/```bash\n(export WIP_TODO=[\s\S]*?)\n```/)![1]
        .replace('<absolute path to prepared todo>', todo).replaceAll('origin/<base>', 'origin/main');
      const result = spawnSync('bash', ['-c', snippet], {
        // GIT_EDITOR is a shell command; raw Windows paths lose their backslashes.
        cwd, env: { ...env, WIP_EDITOR: 'sh .git/reword-editor' }, encoding: 'utf8', timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(mode === 'linear' ? 0 : 1);
      expect(git('rev-parse', 'HEAD^{tree}')).toBe(originalTree);
      if (mode === 'linear') {
        expect(git('rev-list', '--count', 'origin/main..HEAD')).toBe('1');
        expect(git('log', '-1', '--format=%s')).toBe('feat: logical change');
      } else expect(git('rev-parse', 'HEAD')).toBe(originalHead);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
}

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
