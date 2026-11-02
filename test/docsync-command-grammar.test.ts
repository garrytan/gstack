import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DOC_PATH, fixtureDocs, gitAt, repoSnapshot } from './helpers/docsync-fixture';
import { docsCommandAllowed, docsCompletedRead, docsNativeInterface, docsSessionOptions, docsToolFailures, docsWriteFailures } from './helpers/docsync-observer';
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
  for (const denied of ['git check-ignore -v .qa-state; git add .qa-state', 'git check-ignore -v .qa-state > out.txt']) {
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
  for (const rejected of ['git ls-tree -r HEAD > tree.txt', 'git ls-tree -r HEAD | tee tree.txt', 'git -c core.pager=less ls-tree HEAD']) {
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
  'git rev-parse `pwd`', 'git rev-parse ${HEAD}', 'git rev-parse HEAD; git add app.ts',
  'git rev-parse HEAD && git commit -m changed', 'git rev-parse HEAD | sh',
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
  for (const command of ['git status 2>&1 > out.txt', 'ls 2>&1 | sh', `bun ${path.join(fixture.home, 'publish.ts')} 2>&1`, 'ls 2>out.txt']) {
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
  // A1: the parent points children at the saved interface instead of retyping it into their prompts.
  const interfaceFile = path.join(fixture.home, 'fixture-interface.md');
  expect(options.prompt).toContain(`saved at ${interfaceFile}: each child prompt tells the child to Read that file first`);
  expect(options.prompt).not.toContain('include this interface in child prompts');
  const saved = fs.readFileSync(interfaceFile, 'utf8');
  expect(saved.startsWith('Fixture observation interface')).toBe(true);
  expect(options.prompt.endsWith(saved.trimEnd())).toBe(true);
  expect(fs.statSync(interfaceFile).mode & 0o777).toBe(0o600);
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

test('the installed docs-candidate helper is admitted only with a private .json record, or for its own --help', () => {
  const helper = path.join(fixture.skills, 'bin/gstack-docs-candidate');
  const record = path.join(fixture.home, 'audit-1-candidate.json');
  for (const command of [
    `${helper} snapshot --out ${record} --audit-id audit-1 --mode edit --base main --docs handbook`,
    `${helper} snapshot --out ${record} --audit-id audit-1 --mode read-only --base main --select app.ts --docs handbook`,
    `${helper} compare ${record}`,
    `${helper} --help`,
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
    `${helper} --help snapshot`,
    `${helper} --version`,
    `~/.claude/skills/gstack/bin/gstack-docs-candidate compare ${record}`,
  ]) expect(docsCommandAllowed(command, fixture), command).toBe(false);
  expect(docsNativeInterface(fixture)).toContain(`${fixture.skills.split(path.sep).join('/')}/bin/gstack-docs-candidate snapshot`);
  expect(docsNativeInterface(fixture)).toContain('compare <that .json> and --help commands');
});

// Train gate 39904966815 and GSTA-63's focused run joined the candidate's --help onto a line of reads; v1.91.185.0 moved the
// own-call rule into the sentence naming --help and the slip came back four times (JOINED_READ_LINES below). The --help only
// prints usage, so it now joins a line of reads like a Git read; every other own-call command stays alone.
test('a candidate --help joined to reads is a read, and the interface names it as the one exception to the own-call rule', () => {
  const skills = fixture.skills.split(path.sep).join('/');
  const candidate = `${skills}/bin/gstack-docs-candidate`;
  const joined = `git diff; git diff --cached; cat options.ts; ls -la handbook handbook/reference handbook/reference/commands; ${candidate} --help`;
  expect(docsCommandAllowed(joined, fixture)).toBe(true);
  for (const command of [`${candidate} --help`, `${candidate} --help 2>&1`, `git status; ${candidate} snapshot --help`, `${candidate} compare --help 2>/dev/null; git log --oneline -3`,
    `${candidate} --help | head -20`]) expect(docsCommandAllowed(command, fixture), command).toBe(true);
  const record = path.join(fixture.home, 'c.json');
  for (const command of [
    `git status; ${candidate} snapshot --out ${record} --audit-id a --mode edit --base main`, `git status; ${candidate} compare ${record}`,
    `${candidate} --help; git add app.ts`, `${candidate} --help > ${path.join(fixture.home, 'usage.md')}`, `${candidate} --help | sh`,
    `echo x | ${candidate} --help`, `git status | ${candidate} --help`, `cd ${fixture.repo} && ${candidate} --help`, `git status; ${candidate} --help snapshot`,
    `git status; ${candidate} --version`, `git status; ${candidate} -h`, `git status; ${candidate} --help --exec rm`,
    `git status; ~/.claude/skills/gstack/bin/gstack-docs-candidate --help`, `git status; ${path.join(path.dirname(fixture.home), 'bin/gstack-docs-candidate')} --help`,
    `git status; ${skills}/bin/gstack-skill-start --help`, `git status; ${skills}/bin/gstack-skill-end --help`,
  ]) expect(docsCommandAllowed(command, fixture), command).toBe(false);
  const sentence = docsNativeInterface(fixture).split(/(?<=\.)\s+(?=[A-Z])/).find(part => part.includes('gstack-docs-candidate snapshot'));
  expect(sentence).toContain('as its own Bash call, with nothing joined before or after it');
  expect(sentence).not.toContain('a --help is no exception');
  expect(docsNativeInterface(fixture)).toContain(`So may the installed ${candidate} --help, alone or after snapshot or compare, because it only prints usage (the one exception)`);
});

// Five red ship-docsync parents, each red only on 'command outside declared docs observation interface', and each with exactly
// one refused line (every other Bash call of the five captures replays clean): four joined the candidate's --help onto a line of
// reads, and gate 40643690306 put `git tag` in one. {home} is the fixture home; the sha is the capture file's sha256 prefix.
const JOINED_READ_LINES: Array<[source: string, scenario: 'current' | 'store', line: string]> = [
  ['screen 40558235014 slice 5 @ 70cedc3d, capture c73fb9d0b1b0', 'current',
    'git diff main HEAD; cat personal-note.txt; ls -la; find handbook; {home}/.claude/skills/gstack/bin/gstack-docs-candidate --help'],
  ['gate 40600731931 slice 4 @ 5fef38a5, capture 606503d8b78a', 'store',
    'cat handbook/reference/commands/widget.md.tmpl; echo ---; cat CHANGELOG.md TODOS.md VERSION package.json AGENTS.md; echo ---; cat personal-note.txt; echo ---; find handbook; {home}/.claude/skills/gstack/bin/gstack-docs-candidate --help'],
  ['screen 40627127462 slice 5 @ 76a155d4, capture 67fa4dea377a', 'current',
    'git diff main...HEAD; cat handbook/reference/commands/widget.md.tmpl; ls -la handbook handbook/reference handbook/reference/commands; cat personal-note.txt | head -3; {home}/.claude/skills/gstack/bin/gstack-docs-candidate --help'],
  ['screen 40627127462 rerun 1 @ 76a155d4, capture 53d06fea1a89', 'current',
    'git diff main HEAD; git rev-parse origin/main; {home}/.claude/skills/gstack/bin/gstack-docs-candidate --help 2>&1'],
  ['gate 40643690306 slice 4 @ c188a78c, capture 6ac1902bd83f', 'store',
    'git rev-parse HEAD origin/main; git merge-base main HEAD; git tag; cat {home}/fixture-interface.md | head -5; ls {home}'],
];

test.each(JOINED_READ_LINES)('captured joined read line from %s is a declared read', (_source, scenario, line) => {
  const owned = fixtureDocs(scenario);
  try {
    const command = line.replaceAll('{home}', owned.home);
    const publish = path.join(owned.home, 'fixture-publish.ts');
    expect(docsCommandAllowed(command, owned, [publish])).toBe(true);
    expect(docsToolFailures(nativeResult(command, 'usage: gstack-docs-candidate snapshot ...'), owned, [publish], true)).toEqual([]);
    expect(docsCommandAllowed(`${command}; git add app.ts`, owned, [publish])).toBe(false);
  } finally { owned.clean(); }
});

test('operand-free tag listings are reads, and every tag write stays refused', () => {
  for (const listing of ['git tag', 'git tag -l', 'git tag --list', 'git status; git tag; git log --oneline -3'])
    expect(docsCommandAllowed(listing, fixture), listing).toBe(true);
  for (const write of ['git tag v1', 'git tag -a v1 -m release', 'git tag -d v1', 'git tag -f v1 HEAD~1', 'git tag -s v1', 'git tag -v v1', 'git tag -l "v*"',
    'git tag --contains HEAD', 'git tag -n', 'git tag --sort=-v:refname', 'git tag -l v1', 'git tag; git tag v2', 'git tag | sh'])
    expect(docsCommandAllowed(write, fixture), write).toBe(false);
  expect(docsNativeInterface(fixture)).toContain('tag listings with no operand and only -l/--list');
});

test('the installed lifecycle helpers are admitted for their own --help, which starts nothing', () => {
  const skills = fixture.skills.split(path.sep).join('/');
  for (const helper of ['gstack-skill-start', 'gstack-skill-end']) {
    expect(docsCommandAllowed(`${skills}/bin/${helper} --help`, fixture)).toBe(true);
    for (const command of [
      `${skills}/bin/${helper} --help --skill review`,
      `${skills}/bin/${helper} --skill review`,
      `${skills}/bin/${helper} -h`,
      `${skills}/bin/${helper} --help; ${skills}/bin/${helper} --skill document-release`,
      `~/.claude/skills/gstack/bin/${helper} --help`,
    ]) expect(docsCommandAllowed(command, fixture), command).toBe(false);
  }
  expect(docsNativeInterface(fixture)).toContain('or their own --help');
});

// PR gate run 38969924945 (ship-docsync-store) went red only on `gstack-skill-start --help`.
test('every Bash command of the captured ship-docsync-store run is inside the interface', () => {
  const capture = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/docsync-store-38969924945-bash.json'), 'utf8'));
  const commands: string[] = capture.commands.map((command: string) => command.replaceAll('<HOME>', fixture.home));
  for (const file of ['docs-audit-20261016T2140Z-1-documentation.md', 'ship-report.md']) fs.writeFileSync(path.join(fixture.home, file), '');
  const publish = path.join(fixture.home, 'fixture-publish.ts');
  expect(commands).toHaveLength(54);
  expect(commands.filter(command => !docsCommandAllowed(command, fixture, [publish]))).toEqual([]);
});

// PR gate run 38990111230 (ship-docsync-stale-after, head 6c07d85c82d17bda81860cd0d78616de3dc14cc2) went red only on
// `gstack-docs-candidate snapshot --help` (bash#8), which the helper rejected as an unknown argument. Every Bash
// command of the parent, in order; <HOME> is the fixture home and <ACTOR> the fault actor.
const STALE_AFTER_38990111230 = [
  '<HOME>/.claude/skills/gstack/bin/gstack-docs-candidate compare <HOME>/candidate-ship-docs-a1.json',
  'bun <ACTOR> inspect <HOME>/actor-state.json',
  'sha256sum <HOME>/.claude/skills/gstack/document-release/SKILL.md <HOME>/.claude/skills/gstack/document-release/sections/audit-scope.md <HOME>/.claude/skills/gstack/document-release/sections/release-body.md',
  'bun <ACTOR> prepare <HOME>/actor-state.json audit_id=ship-docs-a2',
  'bun <ACTOR> dispatch <HOME>/actor-state.json audit_id=ship-docs-a2 candidate=<HOME>/candidate-ship-docs-a2.json prompt=<HOME>/prompt-ship-docs-a2.md run_in_background=false',
  'bun <ACTOR> inspect <HOME>/actor-state.json',
  '<HOME>/.claude/skills/gstack/bin/gstack-docs-candidate compare <HOME>/candidate-ship-docs-a2.json',
  '<HOME>/.claude/skills/gstack/bin/gstack-docs-candidate snapshot --help',
  '<HOME>/.claude/skills/gstack/bin/gstack-docs-candidate snapshot --out <HOME>/ship-docs-a2-post.json --audit-id ship-docs-a2 --mode edit --base 21cebf26714abdfc6b80267507b88a4df6e933a8 --docs handbook --select AGENTS.md --select CHANGELOG.md --select README.md --select TODOS.md --select VERSION --select app.ts --select handbook/reference/commands/widget.md.tmpl --select package.json',
  'bun <ACTOR> inspect <HOME>/actor-state.json',
  'bun <ACTOR> publish <HOME>/actor-state.json audit_id=ship-docs-a2 report=<HOME>/ship-report.md',
];

test('every Bash command of the captured ship-docsync-stale-after run is inside the fault interface', () => {
  const actor = path.join(import.meta.dir, 'helpers/docsync-fault-actor.ts');
  const commands = STALE_AFTER_38990111230.map(command => command.replaceAll('<HOME>', fixture.home).replaceAll('<ACTOR>', actor));
  expect(commands).toHaveLength(11);
  expect(commands.filter(command => !docsCommandAllowed(command, fixture, [actor]))).toEqual([]);
});

test('subcommand --help is admitted alone and runs without effect; with any other argument it stays outside the interface', () => {
  const helper = path.join(fixture.skills, 'bin/gstack-docs-candidate');
  const record = path.join(fixture.home, 'help-probe.json');
  const before = repoSnapshot(fixture.repo);
  for (const sub of ['snapshot', 'compare']) {
    expect(docsCommandAllowed(`${helper} ${sub} --help`, fixture)).toBe(true);
    const run = spawnSync(helper, [sub, '--help'], { cwd: fixture.repo, encoding: 'utf8', timeout: 20_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('usage: gstack-docs-candidate snapshot --out <candidate.json>');
  }
  for (const command of [
    `${helper} snapshot --help --out ${record}`,
    `${helper} compare --help ${record}`,
    `${helper} snapshot --out ${record} --help`,
    `${helper} snapshot -h`,
    `${helper} compare -h`,
    `${helper} snapshot --help --out ${path.join(fixture.repo, 'inside.json')}`,
    `${helper} snapshot --out ${path.join(fixture.repo, 'inside.json')} --audit-id a --mode edit --base main`,
    `${helper} snapshot --help; ${helper} compare ${record}`,
  ]) expect(docsCommandAllowed(command, fixture), command).toBe(false);
  expect(fs.existsSync(record)).toBe(false);
  expect(repoSnapshot(fixture.repo)).toEqual(before);
});

// PR gate run 39153452209 (ship-docsync-store, head a844821583d664e3dea279fff12b935865e92f52) went red only on the
// document-release child's `git describe --tags --always` (bash#24). Every Bash command of the parent and its child,
// in order; <HOME> is the fixture home.
const STORE_39153452209 = [
  'git status',
  'git rev-parse HEAD',
  'git ls-files',
  '<HOME>/.claude/skills/gstack/bin/gstack-docs-candidate --help',
  'git diff --cached',
  'git diff',
  'git branch --show-current',
  'git log --oneline',
  'git check-ignore -v .qa-state',
  'ls -la <HOME>',
  '<HOME>/.claude/skills/gstack/bin/gstack-skill-start --help',
  'git ls-files -z --cached --others --exclude-standard',
  'git show HEAD:handbook/reference/commands/widget.md.tmpl',
  'ls -la <HOME>/state',
  'git hash-object README.md handbook/reference/commands/widget.md.tmpl options.ts app.ts personal-note.txt',
  'git log --oneline --decorate --all',
  '<HOME>/.claude/skills/gstack/bin/gstack-docs-candidate snapshot --out <HOME>/ship-docs-20261018-c0048c5-a1.json --audit-id ship-docs-20261018-c0048c5-a1 --mode read-only --base c0048c54c542cf0ba46b7587cf7fea1b519c75e4 --select app.ts --select README.md --select options.ts --docs handbook --docs README.md --docs AGENTS.md --docs CHANGELOG.md --docs TODOS.md',
  'GSTACK_SESSION_KIND=spawned <HOME>/.claude/skills/gstack/bin/gstack-skill-start --skill document-release --model claude',
  'git status',
  'git log --oneline',
  'git diff c0048c54c542cf0ba46b7587cf7fea1b519c75e4 HEAD --stat',
  'git diff --cached',
  'git diff',
  'git ls-files --cached --others --exclude-standard',
  'git hash-object README.md options.ts app.ts personal-note.txt',
  'git describe --tags --always',
  '<HOME>/.claude/skills/gstack/bin/gstack-skill-end --skill document-release --outcome success --session-id 878-1792348356-d8b277ad --tel-start 1792348356 --used-browse no',
  '<HOME>/.claude/skills/gstack/bin/gstack-docs-candidate compare <HOME>/ship-docs-20261018-c0048c5-a1.json',
  'git status',
  'git rev-parse HEAD',
  'git hash-object README.md handbook/reference/commands/widget.md.tmpl options.ts app.ts personal-note.txt AGENTS.md CHANGELOG.md TODOS.md VERSION package.json',
  'ls -la <HOME>',
  'ls -la <HOME>/repo',
  'cat <HOME>/ship-docs-20261018-c0048c5-a1-documentation.md >> <HOME>/ship-report.md',
  'git status',
  'ls -la <HOME>',
];

test('every Bash command of the captured run 39153452209 ship-docsync-store is inside the interface', () => {
  const commands = STORE_39153452209.map(command => command.replaceAll('<HOME>', fixture.home));
  for (const file of ['ship-docs-20261018-c0048c5-a1-documentation.md', 'ship-report.md']) fs.writeFileSync(path.join(fixture.home, file), '');
  expect(commands).toHaveLength(36);
  expect(commands).toContain('git describe --tags --always');
  expect(commands.filter(command => !docsCommandAllowed(command, fixture))).toEqual([]);
  expect(docsToolFailures(nativeResult('git describe --tags --always', 'c0048c5', 'docs-dispatch'), fixture, [], true)).toEqual([]);
});

const DESCRIBE_READS = ['git describe', 'git describe --tags', 'git describe --always', 'git describe --abbrev=7',
  'git describe --exact-match', 'git describe HEAD', "git describe --tags --always --abbrev=12 'HEAD^{}'",
  'git describe --exact-match --tags main', 'git describe --always main', 'git describe --tags --always 2>/dev/null'];
const DESCRIBE_REFUSED = ['git describe --dirty', 'git describe --dirty=-modified', 'git describe --always --dirty',
  'git describe --broken', 'git describe --broken=-broken', 'git describe --contains HEAD', 'git describe --all',
  'git describe --abbrev', 'git describe --abbrev=x', 'git describe HEAD main', 'git describe -- HEAD',
  'git describe --tags > tag.md', 'git describe --tags; git tag v9', 'git describe --tags && git tag v9'];

test('read-only git describe forms are declared and leave the index and repository unchanged', () => {
  expect(docsNativeInterface(fixture)).toContain('describe with only --tags, --always, --abbrev=<n> or --exact-match and at most one revision');
  const own = fixtureDocs('store');
  try {
    gitAt(own.repo, 'tag', '-a', 'v0.1.0', '-m', 'fixture release', 'HEAD');
    const stale = new Date(Date.now() - 3600_000);
    fs.utimesSync(path.join(own.repo, 'AGENTS.md'), stale, stale);
    const index = () => fs.readFileSync(path.join(own.repo, '.git/index')).toString('base64');
    const before = { repo: repoSnapshot(own.repo), index: index() };
    for (const command of DESCRIBE_READS) {
      expect(docsCommandAllowed(command, own), command).toBe(true);
      expect(docsToolFailures(nativeResult(command), own, [], true), command).toEqual([]);
      const run = spawnSync('bash', ['-c', command], { cwd: own.repo, encoding: 'utf8', timeout: 10000 });
      expect(run.status, `${command}: ${run.stderr}`).toBe(0);
      expect({ repo: repoSnapshot(own.repo), index: index() }, command).toEqual(before);
    }
  } finally {
    own.clean();
  }
});

test('describe forms that refresh the index or fall outside the declared set, and Git writes, stay outside the interface', () => {
  for (const command of [...DESCRIBE_REFUSED, 'git tag v9 HEAD', 'git update-index --refresh', 'git notes add -m x HEAD']) {
    expect(docsCommandAllowed(command, fixture), command).toBe(false);
    expect(docsToolFailures(nativeResult(command, 'successful tool acknowledgment', 'docs-dispatch'), fixture, [], true), command)
      .toEqual(['command outside declared docs observation interface']);
  }
  const own = fixtureDocs('store');
  try {
    const stale = new Date(Date.now() - 3600_000);
    fs.utimesSync(path.join(own.repo, 'AGENTS.md'), stale, stale);
    const index = () => fs.readFileSync(path.join(own.repo, '.git/index')).toString('base64');
    const before = index();
    const run = spawnSync('git', ['describe', '--always', '--dirty'], { cwd: own.repo, encoding: 'utf8', timeout: 10000 });
    expect(run.status, run.stderr).toBe(0);
    expect(index()).not.toBe(before);
  } finally {
    own.clean();
  }
});


// ship-docsync-current on Opus 5.5: run 39347827595 (PR #3300 @ ca215b0) went red only on the parent's joined Git read,
// and run 39344306426 (PR #3312 @ c895ab9) only on the child's loop that printed each selected file under a header.
// Both are pure reads; each still runs as declared and leaves the repository unchanged.
const CURRENT_COMPOSED_READS = [
  'cat personal-note.txt; echo ---; git diff main HEAD',
  'for f in AGENTS.md README.md CHANGELOG.md TODOS.md VERSION app.ts package.json handbook/reference/commands/widget.md.tmpl personal-note.txt; do echo "=== $f"; cat $f; done',
  'git status --porcelain && git diff --cached | head -5',
  'for doc in README.md AGENTS.md; do git log --oneline -- $doc; done',
  'for f in app.ts; do echo "== ${f}"; cat "$f" 2>/dev/null; done',
  // Focused Opus trial after the first repair (2026-10-20): a loop joined to a find.
  'for f in AGENTS.md README.md CHANGELOG.md TODOS.md VERSION app.ts package.json handbook/reference/commands/widget.md.tmpl; do echo "== $f"; cat $f; done; find <HOME>/repo -name .gstack -not -path "*/.git/*"',
  'git status; for f in README.md AGENTS.md; do cat $f; done && git rev-parse HEAD',
  // Round-1 focused trial and the round-2 ship-docsync-completion trial: NUL-separated paths shown one per line.
  "git ls-files -z --cached --others --exclude-standard | tr '\\0' '\\n'",
  "git status --porcelain=v1 --ignored; git rev-parse HEAD; git merge-base main HEAD; git branch --show-current; git ls-files -z --cached --others --exclude-standard | tr '\\0' '\\n'",
];

test('captured composed reads of ship-docsync-current are declared and leave the repository unchanged (39347827595, 39344306426)', () => {
  const own = fixtureDocs('current');
  try {
    expect(docsNativeInterface(own)).toContain('The Git reads above may join such a line too');
    expect(docsNativeInterface(own)).toContain('A for loop over literal words');
    const before = repoSnapshot(own.repo);
    for (const command of CURRENT_COMPOSED_READS.map(line => line.replaceAll('<HOME>', own.home))) {
      expect(docsCommandAllowed(command, own), command).toBe(true);
      expect(docsToolFailures(nativeResult(command, 'output', 'docs-dispatch'), own, [], true), command).toEqual([]);
      const run = spawnSync('bash', ['-c', command], { cwd: own.repo, encoding: 'utf8', timeout: 10000 });
      expect(run.status, `${command}: ${run.stderr}`).toBe(0);
    }
    expect(repoSnapshot(own.repo)).toEqual(before);
    const doc = path.join(own.repo, DOC_PATH);
    const source = fs.readFileSync(doc, 'utf8');
    const credited = (command: string) => docsCompletedRead(nativeResult(command, source), doc, own);
    expect(credited(`cat ${DOC_PATH}; git status`)).toBe(true);
    expect(credited(`git status; cat ${DOC_PATH} | head`)).toBe(false);
    // The focused trial's child read the document only inside its loop.
    const loop = `for f in personal-note.txt README.md ${DOC_PATH} app.ts; do echo "=== $f"; cat $f; done`;
    const looped = spawnSync('bash', ['-c', loop], { cwd: own.repo, encoding: 'utf8', timeout: 10000 }).stdout;
    expect(docsCompletedRead(nativeResult(loop, looped), doc, own)).toBe(true);
    expect(docsCompletedRead(nativeResult(`for f in ${DOC_PATH}; do cat $f | head -1; done`, source), doc, own)).toBe(false);
    expect(docsCompletedRead(nativeResult(`for f in ${DOC_PATH}; do cat $f; cat $HOME; done`, source), doc, own)).toBe(false);
  } finally {
    own.clean();
  }
});

// Run 39338691964 (PR #3308 @ 8da34e2) keeps failing on purpose: the child's stray assignment, and the parent's reads
// of agents' session transcripts in the Claude config dir (now named off-limits in the interface). Joined Git reads
// and loops grant no write, bypass option, pipe sink, cd, glob, variable or denied path.
test.each([
  'for_none=1; cat AGENTS.md README.md',
  'find <HOME>/cc/projects -type f',
  'grep -o SESSION_KIND <HOME>/cc/projects/session/subagents/agent-a.jsonl',
  'cat README.md; git add app.ts', 'git diff; git commit -m changed', 'ls && git -c core.pager=less show HEAD',
  'ls; git -C /tmp status', 'cat app.ts | git hash-object -w --stdin', 'cat app.ts | git hash-object --stdin',
  'cd .. && git status; ls', 'cd handbook; git status', 'git diff > out.md; ls', 'ls; git diff --output=out.md',
  'git status & ls', 'git status; rm app.ts', 'git log | sh', 'git log | tee log.md', 'git status; cat <HOME>/cc/.claude.json',
  'git status; git remote get-url origin', "ls; git show 'HEAD", 'git status; ls $HOME',
  'for f in README.md; do cat $f > out.md; done', 'for f in app.ts; do rm $f; done', 'for f in $(ls); do cat $f; done',
  'for f in *; do cat $f; done', 'for f in c*/.claude.json; do cat "$f"; done', 'for PATH in /tmp; do cat README.md; done',
  'for f in README.md; do cat $f; cat $HOME; done', 'for f in README.md; do cat $f; done; rm app.ts',
  'for f in README.md; do cat $f; done > out.md', 'for f in "README.md"; do cat $f; done', 'for f in ../../outside; do cat $f; done',
  'for f in ../cc/.claude.json; do cat $f; done', 'for f in app.ts; do git add $f; done', 'for f in a b; do for g in c; do cat $g; done; done',
  'for f in README.md; do cat $f; done &', 'for f in {README,AGENTS}.md; do cat $f; done', 'for f in ~/x; do cat $f; done',
  'ls; for f in README.md; do cat $f; done > out.md', 'for f in README.md; do cat $f; done; for g in app.ts; do rm $g; done',
  'ls; for f in README.md; do cat $f; done | sh', 'cd ..; for f in README.md; do git status; done', 'for f in README.md; do cat $f && done',
  "git ls-files -z | tr '\\0' '\\n' | sh", "git ls-files -z | tr '\\0' '\\n' > files.md", 'tr a b', "git ls-files | tr '$x' y",
])('composed reads stay closed to writes and bypasses: %s', command => {
  const line = command.replaceAll('<HOME>', fixture.home);
  expect(docsCommandAllowed(line, fixture), line).toBe(false);
  expect(docsToolFailures(nativeResult(line, 'successful tool acknowledgment', 'docs-dispatch'), fixture, [], true))
    .toEqual(['command outside declared docs observation interface']);
});

test('the docs interface names the Claude config dir and private actor state as unreadable', () => {
  const guidance = docsNativeInterface(fixture);
  expect(guidance).toContain(`off ${fixture.env.CLAUDE_CONFIG_DIR} except its settings.json`);
  expect(guidance).toContain("every agent's session transcript");
  expect(guidance).toContain('judge a child only by the output it returns');
  expect(guidance).toContain('Every read stays off actor-state.json');
});

// /ship Step 14.5's continue path (PR 2 of the convergence lane) runs three own-tree housekeeping commands and writes
// the receipt's docs record inside the repository. The closed interface declares exactly those, byte for byte with the
// generated section, and nothing adjacent: a reworded exclude line, a bare rm, another receipt subcommand or another
// write under .gstack/ stay outside it (gate: ship-docsync-completion/current red twice at 775d9804 before they were declared).
test('Step 14.5 housekeeping commands and the docs record are declared exactly as the generated section writes them', () => {
  const { DOCS_AUDIT_RECORD, DOCS_AUDIT_RECORD_PATHS, DOCS_AUDIT_RESET, DOCS_TMP_EXCLUDE, docsCapsCommand } = require('./helpers/docsync-interface') as typeof import('./helpers/docsync-interface');
  const section = fs.readFileSync(path.resolve(import.meta.dir, '..', 'ship/sections/documentation.md'), 'utf8');
  expect(section).toContain(DOCS_TMP_EXCLUDE);
  expect(section).toContain(DOCS_AUDIT_RESET);
  expect(section).toContain('gstack-ship-receipt docs-caps --base <base>');
  const skills = fixture.skills.split(path.sep).join('/');
  const caps = docsCapsCommand(skills);
  const interfaceText = docsNativeInterface(fixture);
  for (const command of [DOCS_TMP_EXCLUDE, DOCS_AUDIT_RESET, caps, docsCapsCommand('~/.claude/skills/gstack')]) {
    if (command === caps) expect(interfaceText).toContain(command);
    expect(docsCommandAllowed(command, fixture)).toBe(true);
    expect(docsToolFailures(nativeResult(command, 'DOCS_CAP: none declared'), fixture, [], true)).toEqual([]);
  }
  for (const command of [DOCS_TMP_EXCLUDE.replace("'/.gstack/tmp/'", "'/.gstack/'"), `${DOCS_TMP_EXCLUDE}; git add -A`, 'rm -f .gstack/tmp', 'rm -rf .gstack/tmp/docs-audit.json',
    `${skills}/bin/gstack-ship-receipt docs-caps --base feature/docs`, '~/.claude/skills/other/bin/gstack-ship-receipt docs-caps --base main', `${skills}/bin/gstack-ship-receipt write --docs @${DOCS_AUDIT_RECORD}`, `${skills}/bin/gstack-ship-receipt docs-caps --base main --json`]) {
    expect(docsCommandAllowed(command, fixture)).toBe(false);
  }
  const write = (file: string): SkillTestResult => {
    const parsed = parseNDJSON([
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'docs-write', name: 'Write', input: { file_path: file, content: '{"status":"current","scope":"handbook"}' } }] } },
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'docs-write', content: 'ok', is_error: false }] } },
    ].map(event => JSON.stringify(event)));
    return { ...parsed, exitReason: 'success' } as unknown as SkillTestResult;
  };
  expect(docsToolFailures(write(path.join(fixture.repo, DOCS_AUDIT_RECORD)), fixture, [], false)).toEqual([]);
  expect(docsToolFailures(write(path.join(fixture.repo, DOCS_AUDIT_RECORD)), fixture, [], true)).toEqual([]);
  expect(docsToolFailures(write(path.join(fixture.repo, DOC_PATH)), fixture, [], true)).toEqual(['read-only docs write attempt']);
  // The kernel observer sees the exclude file and the record's directories in every scenario that runs the Entry, the fault cases'
  // unseeded first attempts included, so the shared list is permitted without each caller naming it; anything else under .git or .gstack is not.
  const observed = (paths: string[]) => ({ complete: true, failures: [], events: paths.map(p => ({ path: p, mask: 0x2, cookie: 0, at: 0 })), changed: paths, before: {}, after: {}, limits: [] });
  expect(docsWriteFailures(observed(['.qa-state/.observer-check', ...DOCS_AUDIT_RECORD_PATHS]), [])).toEqual([]);
  expect(docsWriteFailures(observed(['.git/info/attributes']), [])).toEqual(['forbidden docs write: .git/info/attributes']);
  expect(docsWriteFailures(observed(['.gstack/tmp/review-loop.json']), [DOC_PATH])).toEqual(['forbidden docs write: .gstack/tmp/review-loop.json']);
  // The Write tool lands the record through `<record>.tmp.<pid>.<12 hex>` + rename (gate: both lifecycle cases red at 0230fc2 on exactly
  // that sibling). The sibling is admitted only as the cookie-paired source of a move onto the record that leaves nothing behind.
  const temp = `${DOCS_AUDIT_RECORD}.tmp.564.6161e6c7f0b7`;
  const moved = (edits: { path: string; mask: number; cookie?: number }[], after: Record<string, string> = {}) => ({
    complete: true, failures: [], events: edits.map((e, at) => ({ path: e.path, mask: e.mask, cookie: e.cookie ?? 0, at })), changed: Object.keys(after), before: {}, after, limits: [],
  });
  const landing = [{ path: temp, mask: 0x100 }, { path: temp, mask: 0x2 }, { path: temp, mask: 0x8 }, { path: temp, mask: 0x40, cookie: 7 }, { path: DOCS_AUDIT_RECORD, mask: 0x80, cookie: 7 }];
  expect(docsWriteFailures(moved(landing), [])).toEqual([]);
  expect(docsWriteFailures(moved(landing.slice(1)), [])).toEqual([]);
  expect(docsWriteFailures(moved(landing, { [temp]: '0:' + 'a'.repeat(64) }), [])).toEqual([`forbidden docs write: ${temp}`]);
  expect(docsWriteFailures(moved(landing.slice(0, 3)), [])).toEqual([`forbidden docs write: ${temp}`]);
  expect(docsWriteFailures(moved([...landing.slice(0, 4), { path: '.gstack/tmp/other.json', mask: 0x80, cookie: 7 }]), [])).toEqual([`forbidden docs write: ${temp}`, 'forbidden docs write: .gstack/tmp/other.json']);
  expect(docsWriteFailures(moved([...landing.slice(0, 3), { path: temp, mask: 0x40, cookie: 7 }, { path: DOCS_AUDIT_RECORD, mask: 0x80, cookie: 7 }, { path: temp, mask: 0x100 }]), [])).toEqual([`forbidden docs write: ${temp}`]);
  expect(docsWriteFailures(moved([{ path: `${DOC_PATH}.tmp.564.6161e6c7f0b7`, mask: 0x40, cookie: 9 }, { path: DOCS_AUDIT_RECORD, mask: 0x80, cookie: 9 }]), [])).toEqual([`forbidden docs write: ${DOC_PATH}.tmp.564.6161e6c7f0b7`]);
  expect(docsToolFailures(write(path.join(fixture.repo, '.gstack/tmp/review-loop.json')), fixture, [], false)).toEqual(['non-document product write attempt', 'write outside docs fixture authority']);
  expect(docsToolFailures(write(path.join(fixture.repo, '.gstack/ship-policy.json')), fixture, [], false)).toEqual(['non-document product write attempt', 'write outside docs fixture authority']);
  expect(gitAt(fixture.repo, 'rev-parse', '--verify', 'origin/main')).toBe(gitAt(fixture.repo, 'rev-parse', '--verify', 'main'));
  // The declared gate must run from the fixture install: bin/gstack-ship-receipt imports ../lib/*, so the install carries lib/ too.
  const gate = spawnSync('bun', ['--no-env-file', '--config=/dev/null', path.join(fixture.skills, 'bin/gstack-ship-receipt'), 'docs-caps', '--base', 'main'],
    { cwd: fixture.repo, encoding: 'utf8', env: { ...process.env, ...fixture.env, HOME: fixture.home }, timeout: 60_000 });
  expect(gate.stderr).toBe('');
  expect(gate.stdout.trim()).toBe('DOCS_CAP: none declared');
  expect(gate.status).toBe(0);
});

// Gates 40458489644 and 40477638211 (ship-docsync-store, both red on the fourth call, both green on the in-run rerun): each
// parent oriented with one line of reads that ended in `git branch -a`, and the grammar admitted only `branch --show-current`.
// A branch listing reads refs, so every operand-free listing form is a Git read; an operand or any other option still writes.
test.skipIf(process.platform === 'win32')('the captured store orientations with git branch -a replay clean, and branch writes stay refused', () => {
  const store = fixtureDocs('store');
  try {
    const captured = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/docsync-branch-listing-public.json'), 'utf8')) as
      { runs: Array<{ sourceRun: string; calls: SkillTestResult['toolCalls'] }> };
    const publish = path.join(store.home, 'fixture-publish.ts');
    const fill = (text: string) => text.replaceAll('{home}', store.home).replaceAll('{shard}', path.dirname(path.dirname(store.home)));
    expect(captured.runs).toHaveLength(2);
    for (const run of captured.runs) {
      const replayed = run.calls.map(call => ({ ...call, input: Object.fromEntries(Object.entries(call.input).map(([key, value]) =>
        [key, typeof value === 'string' ? fill(value) : value])), output: fill(call.output) }));
      const orientation = replayed.find(call => /;\s*git branch -a(?:;|$)/.test(String(call.input?.command ?? '')));
      expect(orientation, run.sourceRun).toBeDefined();
      expect(docsToolFailures({ toolCalls: replayed, exitReason: 'success' } as SkillTestResult, store, [publish], true), run.sourceRun).toEqual([]);
      const narrowed = String(orientation!.input.command).replace(/git branch -a/, 'git branch --show-current');
      expect(docsCommandAllowed(narrowed, store, [publish])).toBe(true);
    }
    for (const listing of ['git branch', 'git branch -a', 'git branch -avv', 'git branch -r', 'git branch --list', 'git branch --all --no-color', 'git status; git branch -a; git log --oneline -3'])
      expect(docsCommandAllowed(listing, store, [publish]), listing).toBe(true);
    for (const write of ['git branch feature', 'git branch -d feature', 'git branch -D feature', 'git branch -m old new', 'git branch -M main', 'git branch -f main HEAD~1',
      'git branch --set-upstream-to=origin/main', 'git branch -u origin/main', 'git branch -c a b', 'git branch --edit-description', 'git branch --list "feat*"',
      'git branch --contains HEAD', 'git branch -ad feature', 'git branch -a; rm -rf handbook'])
      expect(docsCommandAllowed(write, store, [publish]), write).toBe(false);
    expect(docsNativeInterface(store, [publish], false, true)).toContain('branch listings with no operand and only --show-current, -a/--all, -r/--remotes, -v/--verbose, -l/--list, --no-color or --no-abbrev (no --merged, --sort, --format or --contains)');
  } finally { store.clean(); }
});

// Screens 40822033640 and 40815828320 and gate 40809051510 (ship-docsync-current, -completion and -store, each green on the
// in-run rerun): each parent joined `cat <installed gstack-docs-candidate> --help 2>&1 | head -N` to a line of reads. GNU cat
// printed its own usage and read nothing; a BSD cat would read the operand, which stays checked as a read either way.
test.skipIf(process.platform === 'win32')('the captured lines joining a read command\'s --help replay clean, and --help grants nothing else', () => {
  const captured = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/docsync-read-help-public.json'), 'utf8')) as
    { runs: Array<{ sourceRun: string; scenario: 'current' | 'updated' | 'store'; calls: SkillTestResult['toolCalls'] }> };
  expect(captured.runs.map(run => run.scenario)).toEqual(['current', 'updated', 'store']);
  for (const run of captured.runs) {
    const fixture = fixtureDocs(run.scenario);
    try {
      const publish = path.join(fixture.home, 'fixture-publish.ts');
      const fill = (text: string) => text.replaceAll('{home}', fixture.home).replaceAll('{shard}', path.dirname(path.dirname(fixture.home)));
      const replayed = run.calls.map(call => ({ ...call, input: Object.fromEntries(Object.entries(call.input).map(([key, value]) =>
        [key, typeof value === 'string' ? fill(value) : value])), output: fill(call.output) }));
      const joined = replayed.filter(call => /; cat \S+\/bin\/gstack-docs-candidate --help 2>&1 \| head -\d+(?:;|$)/.test(String(call.input?.command ?? '')));
      expect(joined, run.sourceRun).toHaveLength(1);
      expect(docsToolFailures({ toolCalls: replayed, exitReason: 'success' } as SkillTestResult, fixture, [publish], run.scenario !== 'updated'), run.sourceRun).toEqual([]);
    } finally { fixture.clean(); }
  }
  const fixture = fixtureDocs('current');
  try {
    const publish = path.join(fixture.home, 'fixture-publish.ts');
    const candidate = path.join(fixture.skills, 'bin/gstack-docs-candidate');
    for (const line of [`git status; cat ${candidate} --help 2>&1 | head -5`, 'cat README.md --help', 'git status; cat README.md --help', 'ls handbook --help; git status', 'git status; cat --help 2>&1 | head -5'])
      expect(docsCommandAllowed(line, fixture, [publish]), line).toBe(true);
    for (const line of ['git status; cat /etc/hostname --help | head -5', 'git status; cat README.md --help > out.txt', 'git status; echo x | cat README.md --help',
      `git status; cat ${path.join(fixture.home, 'actor-state.json')} --help`, 'cd handbook; git status; cat README.md --help', 'git status; cat README.md --help; rm -rf handbook',
      'git status; cat README.md --help $(pwd)', 'git status; tee out.txt --help', 'git status; find . --help -delete'])
      expect(docsCommandAllowed(line, fixture, [publish]), line).toBe(false);
  } finally { fixture.clean(); }
});
