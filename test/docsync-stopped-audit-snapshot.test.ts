import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DOC_PATH, docsSnapshotArgv, fixtureDocs } from './helpers/docsync-fixture';
import { docsCommandAllowed, docsToolFailures } from './helpers/docsync-observer';
import { parseNDJSON, type SkillTestResult } from './helpers/session-runner';

// Release gate census 45091322954 (main 79f3052f) and both bisects (45045564572, 45092795048) went red on
// ship-docsync-recovery, -stale-before and -stale-after once /ship's docs steps named
// `snapshot --carry-stopped <the stopped audit's Prepare snapshot>` (#4693, #4703). These are the parent's two post
// snapshot commands from the stale-before rerun capture; <HOME> is the fixture home.
const CAPTURED_45091322954 = [
  '<HOME>/.claude/skills/gstack/bin/gstack-docs-candidate snapshot --out <HOME>/ship-docs-a2-post.json --audit-id ship-docs-a2 --mode edit --base 99d2eaf42c6e0e0da4f7da71760734a9f888b46f --select AGENTS.md --select CHANGELOG.md --select README.md --select TODOS.md --select VERSION --select app.ts --select handbook/reference/commands/widget.md.tmpl --select package.json --docs handbook --pre <HOME>/candidate-ship-docs-a2.json --carry-stopped <HOME>/candidate-ship-docs-a1.json',
  '<HOME>/.claude/skills/gstack/bin/gstack-docs-candidate snapshot --out <HOME>/ship-docs-a2-post.json --audit-id ship-docs-a2 --mode edit --base 99d2eaf42c6e0e0da4f7da71760734a9f888b46f --select AGENTS.md --select CHANGELOG.md --select README.md --select TODOS.md --select VERSION --select app.ts --select handbook/reference/commands/widget.md.tmpl --select package.json --docs handbook --run <HOME>/ship-invocation.md --pre <HOME>/candidate-ship-docs-a2.json --carry-stopped <HOME>/candidate-ship-docs-a1.json',
];

let fixture: ReturnType<typeof fixtureDocs>;
beforeAll(() => { fixture = fixtureDocs('updated'); });
afterAll(() => fixture?.clean());

function bashResult(command: string): SkillTestResult {
  const parsed = parseNDJSON([
    { type: 'assistant', parent_tool_use_id: null, message: { content: [
      { type: 'tool_use', id: 'docs-command', name: 'Bash', input: { command, timeout: 10000 } },
    ] } },
    { type: 'user', parent_tool_use_id: null, message: { content: [
      { type: 'tool_result', tool_use_id: 'docs-command', content: '', is_error: false },
    ] }, tool_use_result: { stdout: '', stderr: '', interrupted: false, isImage: false } },
  ].map(event => JSON.stringify(event)));
  return { toolCalls: parsed.toolCalls, transcript: parsed.transcript, browseErrors: [], exitReason: 'success', duration: 0, output: '',
    costEstimate: { inputChars: 0, outputChars: 0, estimatedTokens: 0, estimatedCost: 0, turnsUsed: 0 }, model: '', firstResponseMs: 0, maxInterTurnMs: 0 };
}

function snapshot(argv: string[]): { status: number | null; stderr: string } {
  const run = spawnSync(argv[0]!, argv.slice(1), { cwd: fixture.repo, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return { status: run.status, stderr: run.stderr };
}

test('the captured --carry-stopped post snapshots are inside the declared interface', () => {
  for (const captured of CAPTURED_45091322954) {
    const command = captured.replaceAll('<HOME>', fixture.home);
    expect(docsCommandAllowed(command, fixture), command).toBe(true);
    expect(docsToolFailures(bashResult(command), fixture)).toEqual([]);
  }
});

test('--carry-stopped still takes only a private .json under the fixture home', () => {
  const head = CAPTURED_45091322954[1]!.replaceAll('<HOME>', fixture.home).replace(/ --carry-stopped \S+$/, '');
  for (const value of ['candidate-ship-docs-a1.json', path.join(fixture.repo, 'a1.json'), path.join(fixture.home, 'a1.md'),
    path.join(fixture.skills, 'a1.json'), '/etc/a1.json']) {
    expect(docsCommandAllowed(`${head} --carry-stopped ${value}`, fixture), value).toBe(false);
  }
  expect(docsCommandAllowed(`${head} --carry-stopped`, fixture)).toBe(false);
  expect(docsCommandAllowed(`${head} --carry-stopped ${fixture.home}/a1.json --carry-stopper ${fixture.home}/a1.json`, fixture)).toBe(false);
});

test('the fixture Prepare snapshot names the run, so a re-audit can carry a stopped audit as /ship says', () => {
  const at = (name: string) => path.join(fixture.home, name);
  const prepare = (id: string) => docsSnapshotArgv(fixture, id, at(`candidate-${id}.json`));
  expect(prepare('a').slice(-2)).toEqual(['--run', fixture.invocation]);
  const post = (argv: string[], id: string, extra: string[]) =>
    [...argv.map(arg => arg === at(`candidate-${id}.json`) ? at(`${id}-post.json`) : arg), ...extra];

  expect(snapshot(prepare('ship-docs-a1')).status).toBe(0);
  fs.appendFileSync(path.join(fixture.repo, DOC_PATH), '\nEdited by an audit that stopped before its post snapshot.\n');
  expect(snapshot(prepare('ship-docs-a2')).status).toBe(0);
  const carried = snapshot(post(prepare('ship-docs-a2'), 'ship-docs-a2', ['--pre', at('candidate-ship-docs-a2.json'), '--carry-stopped', at('candidate-ship-docs-a1.json')]));
  expect(carried).toEqual({ status: 0, stderr: '' });
  const record = JSON.parse(fs.readFileSync(at('ship-docs-a2-post.json'), 'utf8'));
  expect(record.earlier.map((e: { audit_id: string }) => e.audit_id)).toEqual(['ship-docs-a1']);
  expect(Object.keys(record.earlier[0].edited)).toEqual([DOC_PATH]);

  const unnamed = (id: string) => prepare(id).slice(0, -2);
  expect(snapshot(unnamed('ship-docs-b1')).status).toBe(0);
  expect(snapshot(unnamed('ship-docs-b2')).status).toBe(0);
  const extra = ['--pre', at('candidate-ship-docs-b2.json'), '--carry-stopped', at('candidate-ship-docs-b1.json')];
  expect(snapshot(post(unnamed('ship-docs-b2'), 'ship-docs-b2', extra)).stderr).toContain('--carry-stopped needs --pre and --run');
  expect(snapshot(post(unnamed('ship-docs-b2'), 'ship-docs-b2', ['--run', fixture.invocation, ...extra])).stderr)
    .toContain("is not this audit's Prepare snapshot (its audit id, HEAD or run differs)");
});
