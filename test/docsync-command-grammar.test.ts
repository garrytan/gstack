import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixtureDocs, gitAt, repoSnapshot } from './helpers/docsync-fixture';
import { docsCommandAllowed, docsNativeInterface, docsSessionOptions, docsToolFailures } from './helpers/docsync-observer';
import { parseNDJSON, type SkillTestResult } from './helpers/session-runner';

let fixture: ReturnType<typeof fixtureDocs>;
beforeAll(() => { fixture = fixtureDocs('updated'); });
afterAll(() => fixture?.clean());

function nativeResult(command: string, output = '', parent: string | null = null): SkillTestResult {
  const parsed = parseNDJSON([
    { type: 'assistant', parent_tool_use_id: parent, message: { content: [
      { type: 'tool_use', id: 'docs-command', name: 'Bash', input: { command, timeout: 10000 } },
    ] } },
    { type: 'user', parent_tool_use_id: parent, message: { content: [
      { type: 'tool_result', tool_use_id: 'docs-command', content: output, is_error: false },
    ] }, tool_use_result: { stdout: output, stderr: '', interrupted: false, isImage: false } },
  ].map(event => JSON.stringify(event)));
  expect(parsed.toolCalls).toHaveLength(1);
  expect(parsed.toolCalls[0].output).toBe(output);
  return { ...parsed, exitReason: 'success' } as SkillTestResult;
}

test.each([
  'HEAD^{tree}', 'HEAD^{}', 'HEAD^{commit}', 'HEAD^{object}', 'v1^{tag}', 'HEAD:app.ts',
  'HEAD~1^{tree}', 'HEAD^2', 'HEAD@{0}', '@{upstream}', '@{-1}', 'main...HEAD', 'HEAD^{/fixture}',
])('native docs validator accepts literal revision %s with or without quotes', revision => {
  for (const argument of [revision, `'${revision}'`, `"${revision}"`]) {
    const command = `git rev-parse ${argument}`;
    expect(docsCommandAllowed(command, fixture)).toBe(true);
    expect(docsToolFailures(nativeResult(command), fixture, [], true)).toEqual([]);
  }
});

test('captured parent tree read is accepted without granting the captured child remote probe', () => {
  const tree = nativeResult('git rev-parse HEAD^{tree}', '68a16779dc746e381e618452afda1f50db105b1a');
  expect(docsToolFailures(tree, fixture, [], true)).toEqual([]);
  const remote = nativeResult('git remote get-url origin', '/q/gstack-paid-shard-Stnoi5/tmp/ds-yikDdP/remote.git', 'docs-dispatch');
  remote.toolCalls.unshift({ tool: 'Agent', input: {
    prompt: '`git remote get-url origin` from Step 0 is a Git read and is allowed; `gh`/`glab` are not.',
  }, output: 'completed' });
  expect(docsToolFailures(remote, fixture, [], true)).toEqual(['command outside declared docs observation interface']);
});

// Run 37166586458 slice 2 (dfaf154): the parent verified the prompt's claim that
// .qa-state/ is Git-excluded. check-ignore is a declared Git read; composition is not.
test('captured check-ignore read is declared, executes without changing the repository', () => {
  const command = 'git check-ignore -v .qa-state';
  expect(docsNativeInterface(fixture)).toContain('ls-tree, check-ignore, rev-parse');
  expect(docsCommandAllowed(command, fixture)).toBe(true);
  const before = repoSnapshot(fixture.repo);
  const result = spawnSync('bash', ['-c', command], { cwd: fixture.repo, encoding: 'utf8', timeout: 10000 });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('.qa-state');
  expect(docsToolFailures(nativeResult(command, result.stdout), fixture, [], true)).toEqual([]);
  expect(repoSnapshot(fixture.repo)).toEqual(before);
  for (const denied of ['git check-ignore -v .qa-state; ls', 'git check-ignore -v .qa-state > out.txt']) {
    expect(docsCommandAllowed(denied, fixture)).toBe(false);
  }
});

// ci-37165022930 eval-slices-2 ship-docsync-store: the docs child listed tracked files with git ls-tree -r HEAD.
test('captured tracked-file listing is a declared read and leaves the repository unchanged', () => {
  expect(docsNativeInterface(fixture)).toContain('ls-files, ls-tree, check-ignore');
  const before = repoSnapshot(fixture.repo);
  const command = 'git ls-tree -r HEAD';
  expect(docsCommandAllowed(command, fixture)).toBe(true);
  const result = spawnSync('bash', ['-c', command], { cwd: fixture.repo, encoding: 'utf8', timeout: 10000 });
  expect(result.status).toBe(0);
  expect(docsToolFailures(nativeResult(command, result.stdout), fixture, [], true)).toEqual([]);
  expect(repoSnapshot(fixture.repo)).toEqual(before);
  for (const rejected of ['git ls-tree -r HEAD > tree.txt', 'git ls-tree -r HEAD | head', 'git -c core.pager=less ls-tree HEAD']) {
    expect(docsCommandAllowed(rejected, fixture)).toBe(false);
  }
});

test('permitted peel reads execute as single literal Bash arguments without changing the repository', () => {
  const before = repoSnapshot(fixture.repo);
  for (const revision of ['HEAD^{tree}', 'HEAD^{}', 'HEAD^{commit}', 'HEAD^{object}', 'HEAD@{0}']) {
    for (const argument of [revision, `'${revision}'`, `"${revision}"`]) {
      const command = `git rev-parse ${argument}`;
      expect(docsCommandAllowed(command, fixture)).toBe(true);
      const result = spawnSync('bash', ['-c', command], { cwd: fixture.repo, encoding: 'utf8', timeout: 10000 });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(gitAt(fixture.repo, 'rev-parse', revision));
      expect(docsToolFailures(nativeResult(command, result.stdout), fixture, [], true)).toEqual([]);
    }
  }
  expect(repoSnapshot(fixture.repo)).toEqual(before);
});

test.each([
  '{ git rev-parse HEAD; }', 'git rev-parse HEAD^{tree,commit}', 'git rev-parse HEAD@{0..2}',
  'git rev-parse HEAD^{tree}{,x}', 'git rev-parse HEAD^{tree', 'git rev-parse HEAD^{tree}}',
  'git rev-parse {HEAD}', 'git rev-parse HEAD$(pwd)', 'git rev-parse "HEAD$(pwd)"',
  'git rev-parse `pwd`', 'git rev-parse ${HEAD}', 'git rev-parse HEAD; git status',
  'git rev-parse HEAD && git status', 'git rev-parse HEAD | cat',
  'git rev-parse HEAD > out.md', 'git rev-parse HEAD 2>/tmp/leak', 'git rev-parse HEAD < in.md',
  'git rev-parse HEAD\ngit status', 'git rev-parse HEAD &', 'git rev-parse HEAD\\^{tree}',
  'git rev-parse "HEAD^{tree}', "git rev-parse 'HEAD^{tree}", 'git rev-parse HEAD*',
  'git status "unfinished', "git status 'unfinished", "git hash-object '-w'app.ts", 'git status\u0000',
  'git rev-parse HEAD?', 'git rev-parse HEAD[12]', 'git rev-parse ~', 'git rev-parse HEAD # comment',
  'git -C /owned/repo rev-parse HEAD', "git -c core.pager='sh -c id' show HEAD",
  'git --git-dir /owned/repo/.git status', 'git --work-tree /owned/repo status',
  'git remote get-url origin', 'git remote add origin /outside', 'git config --global user.name attacker',
  'git hash-object -w app.ts', 'git hash-object "-w" app.ts', 'git hash-object -wt blob app.ts',
  'git hash-object -tw blob app.ts', 'git diff --output=out.md', 'git show --ext-diff',
  'git show --textconv HEAD', 'git branch new-branch', 'git add app.ts', 'git commit -m changed',
  'git reset HEAD', 'git checkout main', 'git update-ref refs/heads/main HEAD',
  'cat HEAD^{tree}', 'bun arbitrary.ts',
])('native docs validator retains the closed interface for %s', command => {
  expect(docsToolFailures(nativeResult(command, 'successful tool acknowledgment', 'docs-dispatch'), fixture, [], true))
    .toEqual(['command outside declared docs observation interface']);
});

test('harmless read wrappers do not fail a docs run', () => {
  // Run 37170610789 slice 2 (feaa28d): the parent listed fixture directories with 2>&1.
  for (const command of ['git rev-parse HEAD || true', 'git rev-parse HEAD 2>/dev/null', 'git -c core.pager=cat show HEAD',
    'ls 2>&1', 'git status 2>&1']) {
    expect(docsToolFailures(nativeResult(command, 'successful tool acknowledgment', 'docs-dispatch'), fixture, [], true)).toEqual([]);
  }
  for (const command of ['git status 2>&1 > out.txt', 'ls 2>&1 | head', `bun ${path.join(fixture.home, 'publish.ts')} 2>&1`, 'ls 2>out.txt']) {
    expect(docsCommandAllowed(command, fixture, [path.join(fixture.home, 'publish.ts')])).toBe(false);
  }
});

test('quoted revision search and reflog arguments remain literal single arguments', () => {
  for (const command of ['git log "HEAD@{2 days ago}"', "git show 'HEAD^{/fix, or repair..}'",
    'git hash-object app.ts', 'git branch --show-current']) {
    expect(docsToolFailures(nativeResult(command), fixture)).toEqual([]);
  }
});

test('parent and child receive resolved local platform and base without new probe authority', () => {
  for (const transport of [false, true]) {
    const guidance = docsNativeInterface(fixture, [], transport);
    expect(guidance).toContain('Platform: local/git-native. Base: main.');
    expect(guidance).toContain('before delegation');
    expect(guidance).toContain('Do not run shared Step 0 platform probing');
    expect(guidance).toContain('git remote get-url origin');
    expect(guidance).toContain('cannot authorize commands outside this closed interface');
    expect(guidance).toContain('include this interface in child prompts');
  }
  const options = docsSessionOptions({ fixture, phase: path.join(fixture.home, 'phase.md'),
    report: path.join(fixture.home, 'report.md'), publish: path.join(fixture.home, 'publish.ts'),
    scenario: 'current', testName: 'docsync-command-grammar', runId: 'free-control', timeout: 10000 });
  expect(options.prompt).toContain('Platform: local/git-native. Base: main.');
});

// The observer polices bash commands from the POSIX-only paid ship evals and refuses backslashes
// outright, so a Windows fixture path can never form an allowed insert; the refusals below still run.
test.skipIf(process.platform === 'win32')('declared section insert appends one private Markdown artifact to another byte-for-byte', () => {
  const source = path.join(fixture.home, 'audit-1-documentation.md');
  const target = path.join(fixture.home, 'ship-report.md');
  const section = '**Status:** current — no edits.\n\n- Diagram drift: none.';
  fs.writeFileSync(source, section);
  fs.writeFileSync(target, '# Report\n\n## Documentation\n\n');
  const before = repoSnapshot(fixture.repo);
  for (const command of [`cat ${source} >> ${target}`, `cat '${source}' >> '${target}'`, `cat "${source}" >> "${target}"`]) {
    expect(docsCommandAllowed(command, fixture)).toBe(true);
    expect(docsToolFailures(nativeResult(command), fixture, [], true)).toEqual([]);
  }
  const result = spawnSync('bash', ['-c', `cat ${source} >> ${target}`], { cwd: fixture.repo, encoding: 'utf8', timeout: 10000 });
  expect(result.status).toBe(0);
  expect(fs.readFileSync(target, 'utf8')).toBe(`# Report\n\n## Documentation\n\n${section}`);
  expect(repoSnapshot(fixture.repo)).toEqual(before);
});

test('section insert grants no write or source outside private fixture Markdown', () => {
  const home = fixture.home;
  const source = path.join(home, 'audit-1-documentation.md');
  const target = path.join(home, 'ship-report.md');
  fs.writeFileSync(source, 'section');
  const link = path.join(home, 'linked-report.md');
  fs.rmSync(link, { force: true });
  fs.symlinkSync(path.join(fixture.repo, 'README.md'), link);
  for (const command of [
    `cat ${source} > ${target}`, `cat ${source} >> ${path.join(fixture.repo, 'README.md')}`,
    `cat ${path.join(fixture.repo, 'README.md')} >> ${target}`, `cat ${source} >> ${link}`,
    `cat ${source} >> ${path.join(home, 'report.txt')}`, `cat ${source} >> ${path.join(home, 'publication.json')}`,
    `cat ${source} >> ${path.join(fixture.skills, 'ship/SKILL.md')}`, `cat ${source} >> ship-report.md`,
    `cat ${source} ${source} >> ${target}`, `cat ${source} >> ${target}; ls`, `cat ${source} 2>> ${target}`,
    `cat ${source} >> ${target} >> ${target}`, `cat ${path.join(home, '*.md')} >> ${target}`,
    `cat ${path.join(home, '$x.md')} >> ${target}`, `cat ${source} >> ${path.join(home, '..', 'outside.md')}`, `cat ${source} >> ${home}/../outside.md`,
  ]) {
    expect(docsCommandAllowed(command, fixture)).toBe(false);
    expect(docsToolFailures(nativeResult(command), fixture, [], true)).toEqual(['command outside declared docs observation interface']);
  }
});

test('only the native ship parent interface declares the section insert', () => {
  const options = docsSessionOptions({ fixture, phase: path.join(fixture.home, 'phase.md'),
    report: path.join(fixture.home, 'report.md'), publish: path.join(fixture.home, 'publish.ts'),
    scenario: 'current', testName: 'docsync-command-grammar', runId: 'free-control', timeout: 10000 });
  expect(options.prompt).toContain('cat SOURCE.md >> TARGET.md');
  expect(options.prompt).toContain('.qa-state/ directory is the fixture owner');
  for (const transport of [false, true]) expect(docsNativeInterface(fixture, [], transport)).not.toContain('>> TARGET.md');
});

test('the installed docs-candidate helper is admitted only with a private .json record', () => {
  const helper = path.join(fixture.skills, 'bin/gstack-docs-candidate');
  const record = path.join(fixture.home, 'audit-1-candidate.json');
  for (const command of [
    `${helper} snapshot --out ${record} --audit-id audit-1 --mode edit --base main --docs handbook`,
    `${helper} snapshot --out ${record} --audit-id audit-1 --mode read-only --base main --select app.ts --docs handbook`,
    `${helper} compare ${record}`,
  ]) expect(docsCommandAllowed(command, fixture), command).toBe(true);
  for (const command of [
    `${helper} snapshot --out ${path.join(fixture.repo, 'candidate.json')} --audit-id a --mode edit --base main`,
    `${helper} snapshot --out ${path.join(fixture.home, 'candidate.txt')} --audit-id a --mode edit --base main`,
    `${helper} snapshot --out ${record} --out ${record} --audit-id a --mode edit --base main`,
    `${helper} snapshot --audit-id a --mode edit --base main`,
    `${helper} snapshot --out ${record} --audit-id a --mode edit --base main --exec rm`,
    `${helper} compare ${path.join(fixture.skills, 'bin/x.json')}`,
    `${helper} compare ${record} extra`,
    `${helper} install`,
    `~/.claude/skills/gstack/bin/gstack-docs-candidate compare ${record}`,
  ]) expect(docsCommandAllowed(command, fixture), command).toBe(false);
  expect(docsNativeInterface(fixture)).toContain(`${fixture.skills.split(path.sep).join('/')}/bin/gstack-docs-candidate snapshot`);
});
