import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fixtureDocs } from './helpers/docsync-fixture';
import { docsCommandAllowed, docsNativeInterface, docsPreambleCommands, docsToolFailures } from './helpers/docsync-observer';
import type { SkillTestResult } from './helpers/session-runner';

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
    { known_good: string[]; known_bad: string[] };
  const fill = (command: string) => command.replaceAll('{repo}', fixture.repo).replaceAll('{other}', path.dirname(fixture.repo))
    .replaceAll('{home}', fixture.home);
  test.each(stored.known_good)('harmless read form is accepted: %s', command => {
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
