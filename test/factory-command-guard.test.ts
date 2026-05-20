import { describe, expect, test } from 'bun:test';
import { evaluateFactoryCommandSafety } from '../lib/factory-command-guard';
import type { CommandSafetyProfile } from '../lib/factory-core';

function guard(command: string, profile: CommandSafetyProfile = 'non-destructive-write') {
  return evaluateFactoryCommandSafety({
    command,
    profile,
    cwd: '/repo',
    workspaceRoot: '/repo',
    context: { workflowId: 'qa-fix', phaseId: 'qa-execution', runId: 'run-1' },
  });
}

describe('factory command guard', () => {
  test('allows safe read-only git inspection commands', () => {
    expect(guard('git status', 'read-only')).toMatchObject({ allowed: true, matchedRuleId: 'git-read' });
    expect(guard('git diff -- test/foo.test.ts', 'read-only')).toMatchObject({ allowed: true, matchedRuleId: 'git-read' });
  });

  test('allows direct safe project checks under non-destructive-write', () => {
    expect(guard('bun test test/factory-command-guard.test.ts')).toMatchObject({ allowed: true, matchedRuleId: 'project-check' });
    expect(guard('tsc --noEmit')).toMatchObject({ allowed: true, matchedRuleId: 'project-check' });
  });

  test('blocks write-producing project check flags', () => {
    expect(guard('bun test -u')).toMatchObject({ allowed: false, matchedRuleId: 'bun-test-mutation' });
    expect(guard('bun test --update-snapshots')).toMatchObject({ allowed: false, matchedRuleId: 'bun-test-mutation' });
    expect(guard('tsc --noEmit --generateTrace=trace-out')).toMatchObject({ allowed: false, matchedRuleId: 'tsc-output' });
    expect(guard('tsc --noEmit --generateCpuProfile=cpu.cpuprofile')).toMatchObject({ allowed: false, matchedRuleId: 'tsc-output' });
    expect(guard('tsc --noEmit --incremental')).toMatchObject({ allowed: false, matchedRuleId: 'tsc-output' });
    expect(guard('tsc -b --noEmit')).toMatchObject({ allowed: false, matchedRuleId: 'tsc-output' });
  });

  test('blocks rm -rf variants', () => {
    expect(guard('rm -rf dist')).toMatchObject({ allowed: false, matchedRuleId: 'rm-recursive-force' });
    expect(guard('rm -fr dist')).toMatchObject({ allowed: false, matchedRuleId: 'rm-recursive-force' });
    expect(guard('rm --recursive --force dist')).toMatchObject({ allowed: false, matchedRuleId: 'rm-recursive-force' });
    expect(guard('rm .git')).toMatchObject({ allowed: false, matchedRuleId: 'rm-recursive-force' });
  });

  test('blocks destructive or opaque find exec commands', () => {
    expect(guard('find . -name "*.tmp" -delete')).toMatchObject({ allowed: false, matchedRuleId: 'find-destructive' });
    expect(guard('find . -type f -exec rm {} ;')).toMatchObject({ allowed: false, matchedRuleId: 'shell-chaining' });
    expect(guard('find . -type f -exec rm {} +')).toMatchObject({ allowed: false, matchedRuleId: 'find-destructive' });
    expect(guard('find . -type f -exec touch pwned +', 'read-only')).toMatchObject({ allowed: false, matchedRuleId: 'find-destructive' });
    expect(guard('find . -fprint out.txt', 'read-only')).toMatchObject({ allowed: false, matchedRuleId: 'find-destructive' });
  });

  test('blocks destructive or mutating git commands', () => {
    expect(guard('git reset --hard')).toMatchObject({ allowed: false, matchedRuleId: 'git-reset-hard' });
    expect(guard('git clean -fd')).toMatchObject({ allowed: false, matchedRuleId: 'git-clean' });
    expect(guard('git push')).toMatchObject({ allowed: false, matchedRuleId: 'git-push-blocked' });
    expect(guard('git push --force')).toMatchObject({ allowed: false, matchedRuleId: 'git-push-blocked' });
    expect(guard('git tag v1.2.3')).toMatchObject({ allowed: false, matchedRuleId: 'git-tag-blocked' });
    expect(guard('git diff --output=patch.txt', 'read-only')).toMatchObject({ allowed: false, matchedRuleId: 'git-read-unsafe-flag' });
    expect(guard('git show --output=README.md HEAD', 'read-only')).toMatchObject({ allowed: false, matchedRuleId: 'git-read-unsafe-flag' });
    expect(guard('git diff --ext-diff', 'read-only')).toMatchObject({ allowed: false, matchedRuleId: 'git-read-unsafe-flag' });
    expect(guard('git log --textconv', 'read-only')).toMatchObject({ allowed: false, matchedRuleId: 'git-read-unsafe-flag' });
    expect(guard('git diff -S/foo/', 'read-only')).toMatchObject({ allowed: true, matchedRuleId: 'git-read' });
    expect(guard('git show HEAD:.env', 'read-only')).toMatchObject({ allowed: false, matchedRuleId: 'git-secret-path' });
    expect(guard('git show HEAD:env-master/prod.env', 'read-only')).toMatchObject({ allowed: false, matchedRuleId: 'git-secret-path' });
    expect(guard('git branch new-feature')).toMatchObject({ allowed: false, matchedRuleId: 'git-branch-mutation' });
    expect(guard('git branch -m old new')).toMatchObject({ allowed: false, matchedRuleId: 'git-branch-mutation' });
    expect(guard('git branch --set-upstream-to origin/main')).toMatchObject({ allowed: false, matchedRuleId: 'git-branch-mutation' });
    expect(guard('git add .')).toMatchObject({ allowed: false, matchedRuleId: 'git-add-bulk' });
    expect(guard('git add -A')).toMatchObject({ allowed: false, matchedRuleId: 'git-add-bulk' });
    expect(guard('git add -u')).toMatchObject({ allowed: false, matchedRuleId: 'git-add-bulk' });
    expect(guard('git add *')).toMatchObject({ allowed: false, matchedRuleId: 'git-add-bulk' });
    expect(guard('git add "*.ts"')).toMatchObject({ allowed: false, matchedRuleId: 'git-add-bulk' });
    expect(guard("git add ':(glob)**/*.ts'")).toMatchObject({ allowed: false, matchedRuleId: 'git-add-bulk' });
  });

  test('blocks publish deploy and release commands', () => {
    expect(guard('npm publish')).toMatchObject({ allowed: false, matchedRuleId: 'package-publish' });
    expect(guard('bun publish')).toMatchObject({ allowed: false, matchedRuleId: 'package-publish' });
    expect(guard('docker push repo/image')).toMatchObject({ allowed: false, matchedRuleId: 'docker-push' });
    expect(guard('kubectl apply -f k8s.yaml')).toMatchObject({ allowed: false, matchedRuleId: 'cluster-deploy' });
    expect(guard('terraform apply')).toMatchObject({ allowed: false, matchedRuleId: 'infra-mutation' });
    expect(guard('vercel deploy')).toMatchObject({ allowed: false, matchedRuleId: 'deploy-command' });
    expect(guard('gh release create v1.0.0')).toMatchObject({ allowed: false, matchedRuleId: 'release-command' });
  });

  test('blocks secret and env dumping', () => {
    expect(guard('env')).toMatchObject({ allowed: false, matchedRuleId: 'secret-dump' });
    expect(guard('printenv')).toMatchObject({ allowed: false, matchedRuleId: 'secret-dump' });
    expect(guard('export -p')).toMatchObject({ allowed: false, matchedRuleId: 'secret-dump' });
    expect(guard('cat .env')).toMatchObject({ allowed: false, matchedRuleId: 'secret-path' });
    expect(guard('cat .env.local')).toMatchObject({ allowed: false, matchedRuleId: 'secret-path' });
    expect(guard('grep foo .env.production')).toMatchObject({ allowed: false, matchedRuleId: 'secret-path' });
    expect(guard('cat .env*')).toMatchObject({ allowed: false, matchedRuleId: 'secret-path' });
    expect(guard('grep foo .env*')).toMatchObject({ allowed: false, matchedRuleId: 'secret-path' });
    expect(guard('rg DATABASE_URL .en*')).toMatchObject({ allowed: false, matchedRuleId: 'secret-path' });
    expect(guard('cat ~/.ssh/id_ed25519')).toMatchObject({ allowed: false, matchedRuleId: 'home-path' });
    expect(guard('rg API_KEY src')).toMatchObject({ allowed: false, matchedRuleId: 'secret-dump' });
  });

  test('blocks explicit executable paths that can bypass trusted command names', () => {
    expect(guard('./prettier --write src/file.ts')).toMatchObject({ allowed: false, matchedRuleId: 'untrusted-executable-path' });
    expect(guard('./git status')).toMatchObject({ allowed: false, matchedRuleId: 'untrusted-executable-path' });
    expect(guard('/tmp/rg foo src')).toMatchObject({ allowed: false, matchedRuleId: 'untrusted-executable-path' });
  });

  test('blocks opaque shell syntax and ambiguous command composition', () => {
    expect(guard('bun test && npm publish')).toMatchObject({ allowed: false, matchedRuleId: 'shell-chaining' });
    expect(guard('git status | cat')).toMatchObject({ allowed: false, matchedRuleId: 'shell-pipe' });
    expect(guard('echo $(printenv)')).toMatchObject({ allowed: false, matchedRuleId: 'shell-substitution' });
    expect(guard('prettier --write ..\\sibling\\file.ts')).toMatchObject({ allowed: false, matchedRuleId: 'shell-escape' });
    expect(guard('prettier --write C:\\tmp\\file.ts')).toMatchObject({ allowed: false, matchedRuleId: 'shell-escape' });
    expect(guard('bun test > out.log')).toMatchObject({ allowed: false, matchedRuleId: 'shell-redirection' });
  });

  test('does not treat ripgrep patterns as shell paths or pipes', () => {
    expect(guard('rg "foo|bar" src', 'read-only')).toMatchObject({ allowed: true, matchedRuleId: 'read-command' });
    expect(guard('rg -e../foo src', 'read-only')).toMatchObject({ allowed: true, matchedRuleId: 'read-command' });
    expect(guard('grep -fknown_hosts src/file.ts', 'read-only')).toMatchObject({ allowed: false, matchedRuleId: 'attached-short-option' });
    expect(guard('grep -fid_ed25519 src/file.ts', 'read-only')).toMatchObject({ allowed: false, matchedRuleId: 'attached-short-option' });
  });

  test('blocks ripgrep preprocessors that can execute commands', () => {
    expect(guard('rg --pre python --pre-glob "*.py" . src', 'read-only')).toMatchObject({ allowed: false, matchedRuleId: 'rg-preprocessor' });
    expect(guard('rg --pre=python foo src', 'read-only')).toMatchObject({ allowed: false, matchedRuleId: 'rg-preprocessor' });
  });

  test('blocks paths outside the workspace', () => {
    expect(guard('cat /etc/passwd')).toMatchObject({ allowed: false, matchedRuleId: 'outside-workspace-path' });
    expect(guard('prettier --write /tmp/file.ts')).toMatchObject({ allowed: false, matchedRuleId: 'outside-workspace-path' });
    expect(guard('tsc --noEmit --project=/tmp/tsconfig.json')).toMatchObject({ allowed: false, matchedRuleId: 'outside-workspace-path' });
    expect(guard('tsc --noEmit -p/tmp/tsconfig.json')).toMatchObject({ allowed: false, matchedRuleId: 'attached-short-option' });
    expect(guard('ls --directory=/etc', 'read-only')).toMatchObject({ allowed: false, matchedRuleId: 'outside-workspace-path' });
    expect(guard('prettier --write ../sibling/file.ts')).toMatchObject({ allowed: false, matchedRuleId: 'path-traversal' });
    expect(guard('eslint --fix ../sibling/file.ts')).toMatchObject({ allowed: false, matchedRuleId: 'path-traversal' });
    expect(guard('git add ../other-repo/file.ts')).toMatchObject({ allowed: false, matchedRuleId: 'path-traversal' });
    expect(guard('cat ../secrets.txt')).toMatchObject({ allowed: false, matchedRuleId: 'path-traversal' });
  });

  test('defaults unknown commands and uninspected package scripts to deny', () => {
    expect(guard('python scripts/fix.py')).toMatchObject({ allowed: false, matchedRuleId: 'non-destructive-default-deny' });
    expect(guard('npm run lint')).toMatchObject({ allowed: false, matchedRuleId: 'non-destructive-default-deny' });
    expect(guard('npm test')).toMatchObject({ allowed: false, matchedRuleId: 'non-destructive-default-deny' });
    expect(guard('pnpm typecheck')).toMatchObject({ allowed: false, matchedRuleId: 'non-destructive-default-deny' });
    expect(guard('yarn test')).toMatchObject({ allowed: false, matchedRuleId: 'non-destructive-default-deny' });
    expect(guard('bun run test')).toMatchObject({ allowed: false, matchedRuleId: 'non-destructive-default-deny' });
    expect(guard('bun test', 'read-only')).toMatchObject({ allowed: false, matchedRuleId: 'read-only-default-deny' });
  });

  test('release-action profile is unsupported in the G1 guard', () => {
    expect(guard('gh release create v1.0.0', 'release-action')).toMatchObject({ allowed: false, matchedRuleId: 'release-profile-unsupported' });
  });
});
