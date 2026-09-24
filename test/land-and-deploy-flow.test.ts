import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = join(import.meta.dir, '..');
const source = (name: string) => readFileSync(join(root, 'land-and-deploy', name), 'utf8');

describe('land-and-deploy decision ordering', () => {
  test('binds local evidence and merge approval to the selected PR head', () => {
    const main = source('SKILL.md.tmpl');
    const merge = source('sections/merge-and-deploy.md.tmpl');
    expect(main).toContain('headRefOid');
    expect(main).toContain('LOCAL_TARGET_MISMATCH');
    expect(main.indexOf('gstack-diff-scope')).toBeLessThan(main.indexOf('{{SECTION:readiness-gate}}'));
    expect(merge.match(/--match-head-commit "\$PR_HEAD"/g)).toHaveLength(2);
    expect(merge).toContain('invalidate the approval');
  });

  test('readback precedes the only direct fallback and includes queue membership', () => {
    const merge = source('sections/merge-and-deploy.md.tmpl');
    expect(merge).toContain('mergeQueueEntry { id state }');
    expect(merge.indexOf('gh api graphql')).toBeLessThan(merge.indexOf('gh pr merge "$MERGE_FLAG" --delete-branch'));
    expect(merge).not.toContain('Both fall through');
    expect(merge).not.toContain('never call `gh pr merge` a second time');
    expect(merge).toMatch(/never\s+replay a merge after MERGED/);
  });

  test('deploy and URL evidence take precedence over docs-only skipping', () => {
    const merge = source('sections/merge-and-deploy.md.tmpl');
    expect(merge).toContain('explicit verification URL or an actually triggered deployment takes precedence');
    expect(source('SKILL.md.tmpl')).not.toContain('| SCOPE_DOCS only | Already skipped');
    expect(merge).not.toContain('gstack-diff-scope');
  });

  test('true staging-first stops before merge instead of pretending production is held', () => {
    const readiness = source('sections/readiness-gate.md.tmpl');
    const merge = source('sections/merge-and-deploy.md.tmpl');
    expect(readiness).toContain('true staging-first');
    expect(readiness).toContain('production hold');
    expect(readiness).toContain('STOP before merge');
    expect(merge).toContain('production may already be live');
    expect(merge).not.toContain('production is untouched');
    expect(merge).not.toContain('Now deploying to production');
  });

  test('blockers and failed canary evidence cannot be approved into a pass', () => {
    expect(source('sections/readiness-gate.md.tmpl')).toContain('Do not offer A or C with blockers');
    const main = source('SKILL.md.tmpl');
    expect(main).not.toContain('Mark it as healthy');
    expect(main).toContain('DEGRADED');
    expect(main).not.toContain('Inline fix: <yes');
    expect(main).toContain('MERGED — NO DEPLOY NEEDED');
    expect(main).toContain('MERGED (UNVERIFIED)');
  });

  test('revert distinguishes merge parents and refuses an unknown rebase range', () => {
    const main = source('SKILL.md.tmpl');
    expect(main).toContain('git revert -m 1 "$MERGE_SHA" --no-edit');
    expect(main).toContain('exact landed commit range');
    expect(main).toContain('ROLLBACK PENDING');
    expect(main).not.toContain('git revert <merge-commit-sha> --no-edit');
  });
});

describe('land-and-deploy native readback dispatcher', () => {
  const shell = source('sections/merge-and-deploy.md.tmpl').match(/```bash\n(READBACK=[\s\S]*?)\n```/)?.[1];
  const head = 'a'.repeat(40);
  const pr = (extra = {}) => ({
    state: 'OPEN', headRefOid: head, baseRefName: 'main', mergeCommit: null,
    autoMergeRequest: null, mergeQueueEntry: null, ...extra,
  });
  const dispatch = (pullRequest: unknown, env: Record<string, string> = {}, errors?: unknown[]) => {
    expect(shell).toBeDefined();
    return spawnSync('bash', ['-c', `gh() { printf '%s\n' "$@" >&2; printf '%s' "$READBACK_FIXTURE"; return "${'${READBACK_EXIT:-0}'}"; }\n${shell}`], {
      encoding: 'utf8', timeout: 5000,
      env: {
        PATH: process.env.PATH, REPO: 'owner/project', PR_NUMBER: '42', PR_HEAD: head, BASE_BRANCH: 'main',
        MERGE_ATTEMPT: 'none', MERGE_EXIT: '0', MERGE_ERROR: '', WAITED: 'false',
        READBACK_FIXTURE: JSON.stringify({ data: { repository: { pullRequest } }, ...(errors ? { errors } : {}) }),
        ...env,
      },
    });
  };

  test('confirmed open without either request starts once', () => {
    const result = dispatch(pr());
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('START');
    expect(result.stderr).toContain('owner=owner');
    expect(result.stderr).toContain('name=project');
    expect(result.stderr).toContain('number=42');
  });

  for (const error of [
    'Auto-merge is not allowed for this repository',
    'Pull request is in clean status',
    'Pull request is in unstable status',
  ]) {
    test(`only an unsuccessful auto attempt permits direct fallback: ${error}`, () => {
      const env = { MERGE_ATTEMPT: 'auto', MERGE_EXIT: '1', MERGE_ERROR: error };
      expect(dispatch(pr(), env).stdout.trim()).toBe('DIRECT');
      expect(dispatch(pr(), { ...env, MERGE_ATTEMPT: 'direct' }).stdout.trim()).toBe('STOP');
      expect(dispatch(pr(), { ...env, MERGE_EXIT: '0' }).stdout.trim()).toBe('STOP');
    });
  }

  test('merged wins over the original cleanup error, without replay', () => {
    const result = dispatch(pr({ state: 'MERGED', mergeCommit: { oid: 'b'.repeat(40) } }), {
      MERGE_ATTEMPT: 'auto', MERGE_EXIT: '1', MERGE_ERROR: 'Pull request is in clean status',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('MERGED');
  });

  test('either auto request or queue entry waits even when auto request is null', () => {
    for (const active of [
      { autoMergeRequest: { enabledAt: '2026-09-24T00:00:00Z' } },
      { mergeQueueEntry: { id: 'queue-entry', state: 'QUEUED' } },
    ]) {
      expect(dispatch(pr(active), { MERGE_ATTEMPT: 'auto', MERGE_EXIT: '1', MERGE_ERROR: 'Pull request is in clean status' }).stdout.trim()).toBe('WAIT');
    }
  });

  test('removal after waiting never falls back or restarts the merge', () => {
    for (const attempt of ['none', 'auto', 'direct']) {
      expect(dispatch(pr(), { WAITED: 'true', MERGE_ATTEMPT: attempt, MERGE_EXIT: '1', MERGE_ERROR: 'Pull request is in clean status' }).stdout.trim()).toBe('STOP');
    }
  });

  test('a changed head invalidates approval even while queued', () => {
    expect(dispatch(pr({ headRefOid: 'c'.repeat(40), mergeQueueEntry: { id: 'q', state: 'QUEUED' } })).stdout.trim()).toBe('HEAD_CHANGED');
  });

  test('retargeting with the same head invalidates destination approval', () => {
    expect(dispatch(pr({ baseRefName: 'production' })).stdout.trim()).toBe('BASE_CHANGED');
  });

  test('unexpected externally merged revisions stop reconciliation without replay', () => {
    for (const changed of [{ headRefOid: 'c'.repeat(40) }, { baseRefName: 'production' }]) {
      expect(dispatch(pr({ state: 'MERGED', mergeCommit: { oid: 'b'.repeat(40) }, ...changed })).stdout.trim()).toBe('MERGED_CHANGED');
    }
  });

  test('permission failures and closed PRs stop rather than taking direct fallback', () => {
    expect(dispatch(pr(), { MERGE_ATTEMPT: 'auto', MERGE_EXIT: '1', MERGE_ERROR: 'permission denied' }).stdout.trim()).toBe('STOP');
    expect(dispatch(pr({ state: 'CLOSED' })).stdout.trim()).toBe('STOP');
  });

  test('missing queue fields, GraphQL errors and failed queries are unknown, not absence', () => {
    const missingQueue = pr();
    delete (missingQueue as Partial<typeof missingQueue>).mergeQueueEntry;
    for (const result of [
      dispatch(missingQueue), dispatch(null), dispatch(pr(), {}, [{ message: 'unsupported field' }]),
      dispatch(pr(), { READBACK_EXIT: '1' }), dispatch(pr(), { READBACK_FIXTURE: 'not JSON' }),
    ]) {
      expect(result.status).not.toBe(0);
      expect(result.stdout.trim()).toBe('');
    }
  });
});

describe('land-and-deploy rollback command fixtures', () => {
  test('the authored mainline revert removes only the PR side of a real merge', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'land-revert-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 });
      expect({ args, status: result.status, stderr: result.status ? result.stderr : '' }).toEqual({ args, status: 0, stderr: '' });
      return result.stdout.trim();
    };
    try {
      git('init', '-b', 'main');
      writeFileSync(join(cwd, 'base.txt'), 'base\n');
      git('add', '.');
      git('commit', '-m', 'seed rollback fixture');
      git('switch', '-c', 'feature');
      writeFileSync(join(cwd, 'feature.txt'), 'feature\n');
      git('add', '.');
      git('commit', '-m', 'fixture feature');
      git('switch', 'main');
      writeFileSync(join(cwd, 'independent.txt'), 'base change\n');
      git('add', '.');
      git('commit', '-m', 'independent base change');
      const baseTree = git('rev-parse', 'HEAD^{tree}');
      git('merge', '--no-ff', 'feature', '-m', 'fixture merge');
      const mergeSha = git('rev-parse', 'HEAD');
      const wrong = spawnSync('git', ['revert', mergeSha, '--no-edit'], { cwd, encoding: 'utf8', timeout: 5000 });
      expect(wrong.status).not.toBe(0);
      expect(wrong.stderr).toContain('no -m option');
      const command = source('SKILL.md.tmpl').match(/`(git revert -m 1 "\$MERGE_SHA" --no-edit)`/)?.[1];
      expect(command).toBeDefined();
      const repaired = spawnSync('bash', ['-c', command!], { cwd, encoding: 'utf8', timeout: 5000, env: { ...process.env, MERGE_SHA: mergeSha } });
      expect(repaired.status).toBe(0);
      expect(git('rev-parse', 'HEAD^{tree}')).toBe(baseTree);
      expect(readFileSync(join(cwd, 'independent.txt'), 'utf8')).toBe('base change\n');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('land-and-deploy selected target and CLI contracts', () => {
  test('evidence check and run consume the same exact project command', () => {
    const readiness = source('sections/readiness-gate.md.tmpl');
    expect(readiness).toContain('--expect-cmd "$TEST_COMMAND"');
    expect(readiness).toContain('gstack-evidence run --label tests -- "$TEST_COMMAND"');
    expect(readiness).not.toContain("run --label tests -- 'bun test");
  });

  test('rollback binds fresh evidence to production and staging unavailability follows choice A', () => {
    const main = source('SKILL.md.tmpl');
    expect(main).toContain('`ROLLBACK=true`, `TARGET=production`');
    expect(main).toContain('`DEPLOY_SHA=REVERT_SHA`, and reset production deployment/health');
    expect(main).toContain('Staging choice A returns to its production route');
    expect(main).toContain('C goes to Step 9 without claiming');
    expect(source('sections/first-run-validation.md.tmpl')).not.toMatch(/still be able to deploy|still deploy through GitHub/);
  });
  test('every post-selection PR call targets the pinned PR and repository', () => {
    const main = source('SKILL.md.tmpl');
    const sources = [main.slice(main.indexOf('PR_JSON=')), ...['first-run-validation', 'readiness-gate', 'merge-and-deploy'].map(name => source(`sections/${name}.md.tmpl`))];
    const calls = sources.flatMap(text => text.split('\n').filter(line => /gh pr (view|checks|merge) /.test(line)));
    expect(calls.length).toBeGreaterThan(5);
    for (const call of calls.filter(line => !line.includes('does not expose'))) {
      expect(call).toContain('"$PR_NUMBER"');
      expect(call).toContain('--repo "$REPO"');
    }
  });

  test('checks use native fields and missing queries do not count as no required checks', () => {
    const text = [source('SKILL.md.tmpl'), source('sections/first-run-validation.md.tmpl'), source('sections/readiness-gate.md.tmpl')].join('\n');
    for (const line of text.split('\n').filter(line => line.includes('gh pr checks') && line.includes('--json'))) {
      const fields = line.match(/--json ([a-zA-Z,]+)/)![1].split(',');
      expect(fields.every(field => ['bucket', 'completedAt', 'description', 'event', 'link', 'name', 'startedAt', 'state', 'workflow'].includes(field))).toBe(true);
    }
    expect(text).toContain('Auth/network/schema');
    expect(text).toContain('never "no required checks"');
  });

  test('local head, branch, and worktree mismatches fail closed without checkout', () => {
    const shell = source('SKILL.md.tmpl').match(/```bash\n(LOCAL_HEAD=[\s\S]*?)\n```/)?.[1].split('git fetch')[0];
    expect(shell).toBeDefined();
    const fakeGit = `git() { case "$1" in rev-parse) printf '%s' "$TEST_HEAD";; branch) printf '%s' "$TEST_BRANCH";; status) printf '%s' "$TEST_STATUS";; *) return 99;; esac; }`;
    for (const [extra, expected] of [
      [{}, 0], [{ TEST_HEAD: 'other-sha' }, 1], [{ TEST_BRANCH: 'other-branch' }, 1], [{ TEST_STATUS: ' M app.ts' }, 1],
    ] as const) {
      const result = spawnSync('bash', ['-c', `${fakeGit}\n${shell}`], {
        encoding: 'utf8', timeout: 5000,
        env: { PATH: process.env.PATH, TEST_HEAD: 'approved', PR_HEAD: 'approved', TEST_BRANCH: 'feature', HEAD_BRANCH: 'feature', TEST_STATUS: '', ...extra },
      });
      expect(result.status).toBe(expected);
      expect(result.stdout.trim()).toBe(expected ? 'LOCAL_TARGET_MISMATCH' : '');
    }
  });
});
