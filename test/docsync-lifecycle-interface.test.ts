import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fixtureDocs } from './helpers/docsync-fixture';
import { docsCommandAllowed, docsNativeInterface, docsPreambleCommands, docsToolFailures } from './helpers/docsync-observer';
import { docsCapsCommand } from './helpers/docsync-interface';
import { parseNDJSON, type SkillTestResult } from './helpers/session-runner';

let fixture: ReturnType<typeof fixtureDocs>;
beforeAll(() => { fixture = fixtureDocs('updated'); });
afterAll(() => fixture?.clean());

function lifecycleCommands() {
  return [...docsNativeInterface(fixture).matchAll(/```bash\n([^`]+)\n```/g)].map(match => match[1]);
}

test('fixture lifecycle guidance exposes owned skill paths and literal commands', () => {
  const guidance = docsNativeInterface(fixture);
  const skills = fixture.skills.split(path.sep).join('/');
  expect(guidance).toContain(`${skills}/document-release/SKILL.md`);
  const [start, end] = lifecycleCommands();
  expect(lifecycleCommands()).toHaveLength(2);
  expect(start).toBe(`GSTACK_SESSION_KIND=spawned ${skills}/bin/gstack-skill-start --skill document-release --model claude`);
  expect(end).toBe(`${skills}/bin/gstack-skill-end --skill document-release --outcome OUTCOME --session-id SESSION_ID_VALUE --tel-start TEL_START_VALUE --used-browse no`);
  expect(docsCommandAllowed(start, fixture)).toBe(true);
  for (const command of [start, end]) expect(command).not.toMatch(/[\n\r~$\\|<>;]/);
  expect(docsCommandAllowed(start.replaceAll('/', '\\'), fixture)).toBe(false);
  const source = fs.readFileSync(path.join(import.meta.dir, '../bin/gstack-skill-start'), 'utf8');
  expect(source).toContain('if [ -z "$PARENT_PID" ]; then');
  expect(start).not.toContain('--parent-pid');
});

test.each(['success', 'error', 'abort', 'unknown'])('same-session literal end accepts outcome %s without wrappers', outcome => {
  const end = lifecycleCommands()[1].replace('OUTCOME', outcome).replace('SESSION_ID_VALUE', '123-1790299423-control').replace('TEL_START_VALUE', '1790299423');
  expect(docsCommandAllowed(end, fixture)).toBe(true);
  const result = { toolCalls: [{ tool: 'Bash', input: { command: end }, output: '' }] } as SkillTestResult;
  expect(docsToolFailures(result, fixture)).toEqual([]);
});

test('start --help is a read with or without the spawned prefix; anything else after the prefix still names document-release', () => {
  const start = `${fixture.skills.split(path.sep).join('/')}/bin/gstack-skill-start`;
  expect(docsCommandAllowed(`GSTACK_SESSION_KIND=spawned ${start} --help`, fixture)).toBe(true);
  expect(docsCommandAllowed(`${start} --help`, fixture)).toBe(true);
  expect(docsCommandAllowed(`GSTACK_SESSION_KIND=spawned ${start} --help --skill qa`, fixture)).toBe(false);
  expect(docsCommandAllowed(`GSTACK_SESSION_KIND=spawned ${start} --skill qa --model claude`, fixture)).toBe(false);
  expect(docsCommandAllowed(`GSTACK_SESSION_KIND=spawned /tmp/gstack-skill-start --help`, fixture)).toBe(false);
});

test('historical misplaced spawned prefix remains rejected while corrected preamble stays supported', () => {
  const [original, spawned] = docsPreambleCommands(fixture);
  // The pre-#2763 wrapper put a misplaced prefix on its _SS assignment.
  const historical = '_SS="$HOME/.claude/skills/gstack/bin/gstack-skill-start"\n[ -x "$_SS" ] || _SS=".claude/skills/gstack/bin/gstack-skill-start"\n"$_SS" --skill "document-release" --model "claude" --parent-pid "$PPID"';
  expect(docsCommandAllowed(`GSTACK_SESSION_KIND=spawned ${historical}`, fixture)).toBe(false);
  expect(original).toMatch(/^\S+\/gstack-skill-start --skill "document-release" --model "claude"$/);
  expect(spawned).toBe(`GSTACK_SESSION_KIND=spawned ${original}`);
  expect(docsCommandAllowed(spawned, fixture)).toBe(true);
  expect(docsCommandAllowed(original, fixture)).toBe(true);
});

test.each([
  ['missing preamble heading', '## Other section\n\n```bash\n"$_SS" --skill "document-release" --model "claude" --parent-pid "$PPID"\n```\n'],
  ['missing preamble code fence', '## Preamble (run first)\n\nNo executable preamble is present.\n'],
  ['unrelated fenced code', '## Preamble (run first)\n\n```text\nnot shell\n```\n\n```bash\necho not the preamble\n```\n'],
  ['malformed Bash block', '## Preamble (run first)\n\n```bash\necho unrelated command\n```\n'],
])('malformed source with %s grants no generated-shell exception', (label, content) => {
  const file = path.join(fixture.skills, 'document-release/SKILL.md');
  const original = fs.readFileSync(file, 'utf8');
  try {
    fs.writeFileSync(file, content);
    expect(docsPreambleCommands(fixture), label).toEqual([]);
    expect(docsCommandAllowed('git status --porcelain', fixture)).toBe(true);
    expect(docsCommandAllowed('bun arbitrary.ts', fixture)).toBe(false);
    expect(docsCommandAllowed('git status && node attack.js', fixture)).toBe(false);
  } finally {
    fs.writeFileSync(file, original);
  }
});

test('appending shell to the preamble block invalidates the exact generated command', () => {
  const file = path.join(fixture.skills, 'document-release/SKILL.md');
  const original = fs.readFileSync(file, 'utf8');
  const [command] = docsPreambleCommands(fixture);
  try {
    fs.writeFileSync(file, `## Preamble (run first)\n\n\`\`\`bash\n${command}\necho unauthorized\n\`\`\`\n`);
    expect(docsPreambleCommands(fixture)).toEqual([]);
    expect(docsCommandAllowed(command, fixture)).toBe(false);
    expect(docsCommandAllowed('git status --porcelain', fixture)).toBe(true);
  } finally {
    fs.writeFileSync(file, original);
  }
});

test.each([
  '~/.claude/skills/gstack/bin/gstack-skill-end --skill "document-release" --outcome success \\\n  --session-id "176-1790299423-4e0464a5" --tel-start "1790299423" --used-browse no \\\n  --error-message "" --failed-step "" 2>/dev/null || true',
  '~/.claude/skills/gstack/bin/gstack-skill-end --skill "document-release" --outcome success --session-id "933-1790299569-1f0c2bb1" --tel-start "1790299569" --used-browse no --error-message "" --failed-step "" 2>/dev/null || true',
])('historical end wrapper remains rejected: %s', command => {
  expect(docsCommandAllowed(command, fixture)).toBe(false);
  const result = { toolCalls: [{ tool: 'Bash', input: { command }, output: 'SKILL_END: recorded outcome=success' }] } as SkillTestResult;
  expect(docsToolFailures(result, fixture)).toContain('command outside declared docs observation interface');
});

test('lifecycle instructions neither widen command authority nor grant mutation approvals', () => {
  expect(docsNativeInterface(fixture)).toContain('The only additional scripts are none');
  expect(docsNativeInterface(fixture, ['/owned/publish.ts'])).toContain('The only additional scripts are /owned/publish.ts');
  for (const suffix of [' 2>/dev/null', ' || true', ' && git status', '\ntrue', ' $EXTRA']) {
    expect(docsCommandAllowed(lifecycleCommands()[0] + suffix, fixture)).toBe(false);
  }
  expect(docsCommandAllowed('bun arbitrary.ts', fixture)).toBe(false);
});

test('Git guidance uses the existing working directory; --git-dir and --work-tree stay unauthorized', () => {
  const guidance = docsNativeInterface(fixture);
  expect(guidance).toContain(fixture.repo);
  for (const command of ['git status', 'git diff --cached', 'git merge-base main HEAD', 'git rev-parse HEAD']) {
    expect(guidance).toContain(command);
    expect(docsCommandAllowed(command, fixture)).toBe(true);
  }
  for (const command of [`git --git-dir ${fixture.repo}/.git status`, `git --work-tree ${fixture.repo} status`]) {
    expect(docsCommandAllowed(command, fixture)).toBe(false);
  }
});

describe('stored docsync observer commands', () => {
  const stored = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/docsync-observer-commands.json'), 'utf8')) as
    { known_good: string[]; known_good_posix: string[]; known_bad: string[] };
  const fill = (command: string) => command.replaceAll('{repo}', fixture.repo).replaceAll('{other}', path.dirname(fixture.repo))
    .replaceAll('{home}', fixture.home);
  test.each(stored.known_good)('harmless read form is accepted: %s', command => {
    expect(docsCommandAllowed(fill(command), fixture)).toBe(true);
  });
  test.skipIf(process.platform === 'win32').each(stored.known_good_posix)('shared read-only grammar form is accepted: %s', command => {
    expect(docsCommandAllowed(fill(command), fixture)).toBe(true);
  });
  test.each(stored.known_bad)('known-bad form stays rejected: %s', command => {
    expect(docsCommandAllowed(fill(command), fixture)).toBe(false);
  });
  test('harmless wrappers never extend to lifecycle commands', () => {
    for (const command of lifecycleCommands()) {
      for (const suffix of [' 2>/dev/null', ' || true']) expect(docsCommandAllowed(command + suffix, fixture)).toBe(false);
      expect(docsCommandAllowed(`cd ${fixture.repo} && ${command}`, fixture)).toBe(false);
    }
  });
});

describe.skipIf(process.platform === 'win32')('candidate call at a missing binary path (exit 127)', () => {
  const captured = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/docsync-candidate-not-found-public.json'), 'utf8')) as
    { calls: SkillTestResult['toolCalls'] };
  let current: ReturnType<typeof fixtureDocs>;
  let publish: string;
  let missing: string;
  beforeAll(() => {
    current = fixtureDocs('current');
    publish = path.join(current.home, 'fixture-publish.ts');
    missing = path.join(current.home, 'missing-shard');
  });
  afterAll(() => current?.clean());
  const fill = (text: string) => text.replaceAll('{shard}', missing).replaceAll('{home}', current.home);
  const replay = (calls = captured.calls) => ({ toolCalls: calls.map(call => ({ tool: call.tool, output: fill(call.output),
    input: Object.fromEntries(Object.entries(call.input).map(([key, value]) => [key, typeof value === 'string' ? fill(value) : value])) })) }) as SkillTestResult;
  const wrong = () => captured.calls.findIndex(call => call.output.startsWith('Exit code 127'));
  const retry = () => wrong() + 1;
  const failures = (result: SkillTestResult) => docsToolFailures(result, current, [publish], true);
  const pair = (wrongOutput: string, retryOutput = '{}', wrongCommand = captured.calls[wrong()].input.command) => replay([
    { tool: 'Bash', input: { command: wrongCommand }, output: wrongOutput },
    { tool: 'Bash', input: { command: captured.calls[retry()].input.command }, output: retryOutput },
  ]);
  const notFound = (binary: string) => `Exit code 127\n(eval):1: no such file or directory: ${binary}`;
  const wrongBinary = () => fill(captured.calls[wrong()].input.command.split(' ')[0]);

  test('captured run 39223031058 ship-docsync-current passes; its wrong-path call alone is outside the interface', () => {
    const result = replay();
    expect(result.toolCalls[retry()].input.command).toBe(result.toolCalls[wrong()].input.command.replace(wrongBinary(),
      `${current.skills}/bin/gstack-docs-candidate`));
    expect(docsCommandAllowed(result.toolCalls[wrong()].input.command, current, [publish])).toBe(false);
    expect(failures(result)).toEqual([]);
  });

  test('the native exit-127 tool result reaches the observer as the recorded output', () => {
    const command = fill(captured.calls[wrong()].input.command);
    const parsed = parseNDJSON([
      { type: 'assistant', parent_tool_use_id: 'child', message: { content: [{ type: 'tool_use', id: 'wrong', name: 'Bash', input: { command } }] } },
      { type: 'user', parent_tool_use_id: 'child', message: { content: [{ type: 'tool_result', tool_use_id: 'wrong', content: notFound(wrongBinary()), is_error: true }] },
        tool_use_result: `Error: ${notFound(wrongBinary())}` },
    ].map(event => JSON.stringify(event)));
    expect(parsed.toolCalls[0].output).toBe(notFound(wrongBinary()));
  });

  test('a 127 with no later run of the same command at the declared path still fails', () => {
    const calls = captured.calls.filter((_, index) => index !== retry());
    expect(failures(replay(calls))).toContain('command outside declared docs observation interface');
    const before = [captured.calls[retry()], ...calls];
    expect(failures(replay(before))).toContain('command outside declared docs observation interface');
    expect(failures(pair(notFound(wrongBinary()), 'Exit code 1\nboom'))).toContain('command outside declared docs observation interface');
    const otherArgs = captured.calls[wrong()].input.command.replace('ship2-docs-a1.json', 'other.json');
    expect(failures(pair(notFound(wrongBinary()), '{}', otherArgs))).toContain('command outside declared docs observation interface');
  });

  test('any other exit or shell message outside the declared path still fails', () => {
    expect(failures(pair(notFound(wrongBinary())))).toEqual([]);
    for (const output of [`Exit code 126\n(eval):1: permission denied: ${wrongBinary()}`, 'Exit code 1\nerror', '',
      `Exit code 127\n(eval):1: command not found: ${wrongBinary()}`, notFound(wrongBinary()) + '\nextra',
      notFound(path.join(missing, 'other/gstack-docs-candidate'))]) {
      expect(failures(pair(output)), output).toContain('command outside declared docs observation interface');
    }
  });

  test('a wrong-path binary that exists still fails, whether it ran or claims 127', () => {
    fs.mkdirSync(path.dirname(wrongBinary()), { recursive: true });
    fs.writeFileSync(wrongBinary(), 'candidate stand-in\n');
    try {
      for (const output of ['{}', notFound(wrongBinary())]) {
        expect(failures(pair(output)), output).toContain('command outside declared docs observation interface');
      }
    } finally { fs.rmSync(missing, { recursive: true, force: true }); }
  });

  // Gate 40323989742 slice 3 (ship-docsync-store): the parent read the usage at the
  // declared path, mistyped the shard-rooted path on a second --help (exit 127), and
  // went straight on to compare at the declared path. A help probe reads nothing the
  // agent still has to recover, so the declared --help may precede the slip.
  describe('captured run 40323989742 ship-docsync-store: a mistyped --help after the declared usage was read', () => {
    const store = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/docsync-help-not-found-public.json'), 'utf8')) as
      { calls: SkillTestResult['toolCalls'] };
    const storeFailures = (calls: SkillTestResult['toolCalls']) => docsToolFailures(replay(calls), current, [publish], true);
    const slip = () => store.calls.findIndex(call => call.output.startsWith('Exit code 127'));
    const declaredHelp = () => store.calls.findIndex(call => /gstack-docs-candidate --help$/.test(call.input.command ?? '') && call.output.startsWith('usage'));

    test('the capture passes; the mistyped --help alone is outside the interface', () => {
      expect(slip()).toBeGreaterThan(declaredHelp());
      expect(fill(store.calls[slip()].input.command)).toBe(`${missing}/.claude/skills/gstack/bin/gstack-docs-candidate --help`);
      expect(docsCommandAllowed(fill(store.calls[slip()].input.command), current, [publish])).toBe(false);
      expect(storeFailures(store.calls)).toEqual([]);
    });

    test('without any declared --help run, or with a failed one, the slip still fails', () => {
      expect(storeFailures(store.calls.filter((_, index) => index !== declaredHelp()))).toContain('command outside declared docs observation interface');
      const failed = store.calls.map((call, index) => index === declaredHelp() ? { ...call, output: 'Exit code 1\nboom' } : call);
      expect(storeFailures(failed)).toContain('command outside declared docs observation interface');
    });

    test('an earlier declared run excuses only --help, never snapshot or compare', () => {
      const compare = store.calls.findIndex(call => / compare /.test(call.input.command ?? '') && !call.output.startsWith('Exit code'));
      const wrongCompare = { tool: 'Bash', input: { command: store.calls[compare].input.command.replace('{home}/.claude', '{shard}/.claude') },
        output: notFound('{shard}/.claude/skills/gstack/bin/gstack-docs-candidate') };
      expect(storeFailures([...store.calls, wrongCompare])).toContain('command outside declared docs observation interface');
      expect(storeFailures([...store.calls.slice(0, compare), wrongCompare, ...store.calls.slice(compare)])).toEqual([]);
    });
  });

  test('only a candidate binary at an absolute literal path qualifies', () => {
    const declared = current.skills.split(path.sep).join('/');
    const skillEnd = `${missing}/.claude/skills/gstack/bin/gstack-skill-start --help`;
    expect(failures(replay([{ tool: 'Bash', input: { command: skillEnd }, output: notFound(skillEnd.split(' ')[0]) },
      { tool: 'Bash', input: { command: `${declared}/bin/gstack-skill-start --help` }, output: 'usage' }]))).toContain('command outside declared docs observation interface');
    const relative = 'missing/gstack-docs-candidate --help';
    expect(failures(replay([{ tool: 'Bash', input: { command: relative }, output: notFound('missing/gstack-docs-candidate') },
      { tool: 'Bash', input: { command: `${declared}/bin/gstack-docs-candidate --help` }, output: 'usage' }]))).toContain('command outside declared docs observation interface');
  });
});

// Screen 40749421675 slice 13 (ship-docsync-stale-after, red on its call 16, green on the in-run rerun): the parent typed the
// cap gate at the shard root ({shard}/.claude/..., exit 127), then ran it at the declared path, the slip the candidate excuses.
describe.skipIf(process.platform === 'win32')('captured run 40749421675 ship-docsync-stale-after: the cap gate typed at the shard root', () => {
  const captured = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/docsync-ship-receipt-not-found-public.json'), 'utf8')) as
    { calls: SkillTestResult['toolCalls'] };
  const actor = path.join(import.meta.dir, 'helpers/docsync-fault-actor.ts');
  let current: ReturnType<typeof fixtureDocs>;
  let missing: string;
  beforeAll(() => {
    current = fixtureDocs('current');
    missing = path.join(current.home, 'missing-shard');
  });
  afterAll(() => current?.clean());
  const fill = (text: string) => text.replaceAll('{shard}', missing).replaceAll('{home}', current.home).replaceAll('{actor}', actor);
  const failures = (calls: SkillTestResult['toolCalls']) => docsToolFailures({ toolCalls: calls.map(call => ({ tool: call.tool, output: fill(call.output),
    input: Object.fromEntries(Object.entries(call.input).map(([key, value]) => [key, typeof value === 'string' ? fill(value) : value])) })) } as SkillTestResult,
  current, [actor]);
  const slip = () => captured.calls.findIndex(call => call.output.startsWith('Exit code 127'));
  const declared = () => captured.calls.findIndex(call => call.input.command === '{home}/.claude/skills/gstack/bin/gstack-ship-receipt docs-caps --base main');
  const notFound = (binary: string) => `Exit code 127\n(eval):1: no such file or directory: ${binary}`;
  const outside = 'command outside declared docs observation interface';

  test('the capture passes; the mistyped cap gate alone is outside the interface', () => {
    expect(declared()).toBe(slip() + 1);
    expect(fill(captured.calls[slip()].input.command)).toBe(`${missing}/.claude/skills/gstack/bin/gstack-ship-receipt docs-caps --base main`);
    expect(fill(captured.calls[declared()].input.command)).toBe(docsCapsCommand(current.skills.split(path.sep).join('/')));
    expect(docsCommandAllowed(fill(captured.calls[slip()].input.command), current, [actor])).toBe(false);
    expect(failures(captured.calls)).toEqual([]);
  });

  test('without a later successful declared cap gate the slip still fails', () => {
    const rest = captured.calls.filter((_, index) => index !== declared());
    expect(failures(rest)).toContain(outside);
    expect(failures([captured.calls[declared()], ...rest])).toContain(outside);
    expect(failures(captured.calls.map((call, index) => index === declared() ? { ...call, output: 'Exit code 1\nboom' } : call))).toContain(outside);
  });

  test('another subcommand, another shell message or a binary that exists at the wrong path still fails', () => {
    const wrong = captured.calls[slip()];
    const json = (call: SkillTestResult['toolCalls'][number]) => ({ ...call, input: { command: `${call.input.command} --json` } });
    expect(failures(captured.calls.map((call, index) => index === slip() || index === declared() ? json(call) : call))).toEqual([outside, outside]);
    for (const output of [`Exit code 127\n(eval):1: command not found: {shard}/.claude/skills/gstack/bin/gstack-ship-receipt`, 'Exit code 1\nerror',
      notFound('{shard}/.claude/skills/gstack/bin/gstack-docs-candidate'), `${wrong.output}\nextra`])
      expect(failures(captured.calls.map((call, index) => index === slip() ? { ...call, output } : call)), output).toContain(outside);
    const binary = fill(wrong.input.command.split(' ')[0]);
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, 'cap gate stand-in\n');
    try {
      expect(failures(captured.calls)).toContain(outside);
    } finally { fs.rmSync(missing, { recursive: true, force: true }); }
  });
});
