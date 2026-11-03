/**
 * skill-contract-stop-hook (GST-1088, lane A): blocks once when a contract
 * skill ends without its outputs, fails open on every state error, and never
 * blocks an interactive session that pauses on a question. Fixture skills
 * carry the contract blocks; the real templates are lane B's.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_ERROR_DOC, stateErrorLine } from '../lib/skill-contract';
import {
  CONTRACT_HOOK, DEBUG_REPORT, INTERACTIVE_TURNS, J1_TRANSCRIPT, ROOT, hookEnv, result, runHook, say, skillsDir, slash, tmpDir, tool, user,
} from './helpers/skill-contract-fixture';

const PINNED = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'skill-contract', 'block-message.txt'), 'utf8').trimEnd();
const STATE_ERROR = /^gstack-skill-contract: SKILL_CONTRACT_STATE_ERROR .+: .+; stop allowed, miss not recorded \(see docs\/skill-routing-and-contracts\.md#state-error\)\n$/;

test('the state error line keeps its doc anchor (d9)', () => {
  expect(STATE_ERROR_DOC).toBe('docs/skill-routing-and-contracts.md#state-error');
  expect(`${stateErrorLine('/x/y.json', 'corrupt record (not JSON)')}\n`).toMatch(STATE_ERROR);
});

let state = '', skills = '', work = '';
beforeEach(() => {
  state = tmpDir('gstack-contract-state-');
  work = tmpDir('gstack-contract-work-');
  skills = skillsDir();
});
afterEach(() => {
  for (const d of [state, work, skills]) fs.rmSync(d, { recursive: true, force: true });
});

const transcript = (lines: string[], name = 'transcript.jsonl') => {
  const file = path.join(work, name);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
};
const payload = (file: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: 'sess-1', transcript_path: file, cwd: work, hook_event_name: 'Stop', stop_hook_active: false, ...extra });
const stop = (file: string, env: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  runHook(CONTRACT_HOOK, payload(file, extra), hookEnv(state, skills, { GSTACK_SKILL_CONTRACTS: 'on', ...env }));
const record = () => JSON.parse(fs.readFileSync(path.join(state, 'skill-contracts', 'sess-1.json'), 'utf8'));

describe('block once, with the pinned text', () => {
  test('J1: /investigate loaded, edited, answered with no status line -> blocked with the pinned message', () => {
    const r = stop(transcript(J1_TRANSCRIPT));
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    const out = JSON.parse(r.stdout);
    expect(Object.keys(out).sort()).toEqual(['decision', 'reason']);
    expect(out.decision).toBe('block');
    expect(out.reason).toBe(PINNED);
    expect(out.reason).not.toMatch(/skill_contracts|gstack-config|\boff\b/);
    const run = Object.values(record().runs)[0] as any;
    expect(run).toMatchObject({ skill: 'investigate', outcome: 'blocked', missing: ['debug-report', 'repro-after-fix'] });
    expect(fs.statSync(path.join(state, 'skill-contracts', 'sess-1.json')).mode & 0o777).toBe(0o600);
  });

  test('stop_hook_active with no block of ours this run: allowed, no record written', () => {
    const r = stop(transcript(J1_TRANSCRIPT), {}, { stop_hook_active: true });
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(fs.existsSync(path.join(state, 'skill-contracts'))).toBe(false);
  });

  test('a second unmet stop in the same run records a miss and allows (blocks once)', () => {
    const file = transcript(J1_TRANSCRIPT);
    expect(JSON.parse(stop(file).stdout).decision).toBe('block');
    fs.appendFileSync(file, `${user('thanks')}\n${say('You are welcome.')}\n`);
    const again = stop(file);
    expect(again).toEqual({ code: 0, stdout: '', stderr: '' });
    expect((Object.values(record().runs)[0] as any).outcome).toBe('miss');
  });

  test('fixed after the block: met_after_block, recorded on the stop_hook_active Stop Claude Code sends next', () => {
    const file = transcript(J1_TRANSCRIPT);
    stop(file);
    fs.appendFileSync(file, [tool('b9', 'Bash', { command: 'bun test test/auth.test.ts' }), result('b9', 'pass'), say(DEBUG_REPORT)].join('\n') + '\n');
    expect(stop(file, {}, { stop_hook_active: true }).stdout).toBe('');
    expect((Object.values(record().runs)[0] as any).outcome).toBe('met_after_block');
    fs.appendFileSync(file, [user('also fix the README typo'), tool('e8', 'Edit', { file_path: 'README.md', old_string: 'teh', new_string: 'the' }), result('e8', 'updated'), say('Fixed.')].join('\n') + '\n');
    expect(stop(file)).toEqual({ code: 0, stdout: '', stderr: '' });
    expect((Object.values(record().runs)[0] as any).outcome).toBe('met_after_block');
  });

  test('still unmet on the stop_hook_active Stop after our block: a miss, never a second block', () => {
    const file = transcript(J1_TRANSCRIPT);
    stop(file);
    fs.appendFileSync(file, `${say('Done.')}\n`);
    expect(stop(file, {}, { stop_hook_active: true })).toEqual({ code: 0, stdout: '', stderr: '' });
    expect((Object.values(record().runs)[0] as any).outcome).toBe('miss');
  });

  test('last_assistant_message supplies the final report the transcript file does not hold yet', () => {
    const file = transcript([...J1_TRANSCRIPT.slice(0, -1), tool('b9', 'Bash', { command: 'bun test' }), result('b9', 'pass')]);
    expect(stop(file, {}, { last_assistant_message: DEBUG_REPORT }).stdout).toBe('');
    expect((Object.values(record().runs)[0] as any).outcome).toBe('met');
  });

  test('an /investigate run that ends with Status: BLOCKED in its DEBUG REPORT is met, not blocked', () => {
    const file = transcript([...J1_TRANSCRIPT.slice(0, -1), say(DEBUG_REPORT.replace('Status:          DONE', 'Status:          BLOCKED'))]);
    expect(stop(file)).toEqual({ code: 0, stdout: '', stderr: '' });
    expect((Object.values(record().runs)[0] as any).outcome).toBe('met');
  });

  test('a met run stays met: a later unrelated edit turn in the same session is not blocked', () => {
    const file = transcript([...J1_TRANSCRIPT.slice(0, -1), tool('b9', 'Bash', { command: 'bun test' }), result('b9', 'pass'), say(DEBUG_REPORT)]);
    expect(stop(file).stdout).toBe('');
    fs.appendFileSync(file, [user('fix the typo in README'), tool('e7', 'Edit', { file_path: 'README.md', old_string: 'teh', new_string: 'the' }), result('e7', 'updated'), say('Fixed the typo.')].join('\n') + '\n');
    expect(stop(file)).toEqual({ code: 0, stdout: '', stderr: '' });
    expect((Object.values(record().runs)[0] as any).outcome).toBe('met');
  });

  test('a waiver read from the transcript satisfies the block but counts against follow', () => {
    const lines = [...J1_TRANSCRIPT.slice(0, -1),
      tool('w1', 'Bash', { command: 'gstack-skill-contract waive repro-after-fix --reason "no test runner in this repo"' }),
      result('w1', 'SKILL_CONTRACT_WAIVED repro-after-fix: no test runner in this repo'),
      say(DEBUG_REPORT)];
    expect(stop(transcript(lines)).stdout).toBe('');
    expect((Object.values(record().runs)[0] as any)).toMatchObject({ outcome: 'met_waived', waived: ['repro-after-fix'] });
  });
});

describe('never blocks the wrong turn', () => {
  test('a multi-turn interactive session that pauses on questions is never blocked', () => {
    const file = path.join(work, 'interactive.jsonl');
    for (const turn of INTERACTIVE_TURNS) {
      fs.appendFileSync(file, `${turn.join('\n')}\n`);
      expect(stop(file)).toEqual({ code: 0, stdout: '', stderr: '' });
    }
    expect((Object.values(record().runs)[0] as any).outcome).toBe('met');
  });

  test('the same mid-task question in a headless session is checked, and blocks', () => {
    const file = transcript([...INTERACTIVE_TURNS[0], ...INTERACTIVE_TURNS[1]]);
    expect(JSON.parse(stop(file, { GSTACK_HEADLESS: '1' }).stdout).decision).toBe('block');
  });

  test('Agent readers still running when Stop fires: allowed, nothing recorded', () => {
    const base = [slash('review'), say('Dispatching 2 specialists: Testing, Security. Skipped: Performance (scope not detected).')];
    const background = [...base, tool('a1', 'Agent', { description: 'Testing specialist', prompt: 'review', run_in_background: true }),
      result('a1', 'Async agent launched in the background.'), say('Waiting for the specialists to finish.')];
    const unanswered = [...base, tool('a2', 'Agent', { description: 'Security specialist', prompt: 'review' })];
    for (const lines of [background, unanswered]) {
      expect(stop(transcript(lines))).toEqual({ code: 0, stdout: '', stderr: '' });
    }
    expect(fs.existsSync(path.join(state, 'skill-contracts'))).toBe(false);
    expect(fs.readFileSync(path.join(state, 'hooks', 'skill-contract.log'), 'utf8')).toContain('event=agents-running');
  });

  test('no contract skill loaded: allowed', () => {
    const r = stop(transcript([slash('qa'), say('Done. STATUS: DONE')]));
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
  });
});

describe('fails open on state errors with one stderr line', () => {
  test('unwritable state root', () => {
    const blocker = path.join(work, 'state-is-a-file');
    fs.writeFileSync(blocker, 'x');
    const r = runHook(CONTRACT_HOOK, payload(transcript(J1_TRANSCRIPT)), hookEnv(blocker, skills, { GSTACK_SKILL_CONTRACTS: 'on' }));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(STATE_ERROR);
    expect(r.stderr).toContain('cannot write record');
  });

  test('corrupt record', () => {
    fs.mkdirSync(path.join(state, 'skill-contracts'), { recursive: true });
    fs.writeFileSync(path.join(state, 'skill-contracts', 'sess-1.json'), '{not json');
    const r = stop(transcript(J1_TRANSCRIPT));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(STATE_ERROR);
    expect(r.stderr).toContain('corrupt record');
  });

  test('missing transcript, bad stdin and an invalid contract', () => {
    const missing = stop(path.join(work, 'nope.jsonl'));
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toMatch(STATE_ERROR);
    const bad = runHook(CONTRACT_HOOK, '{oops', hookEnv(state, skills, { GSTACK_SKILL_CONTRACTS: 'on' }));
    expect(bad.code).toBe(0);
    expect(bad.stderr).toMatch(STATE_ERROR);
    const invalid = skillsDir([], { investigate: '---\nname: investigate\ncontract:\n  version: 2\n  items: []\n---\n' });
    const r = runHook(CONTRACT_HOOK, payload(transcript(J1_TRANSCRIPT)), hookEnv(state, invalid, { GSTACK_SKILL_CONTRACTS: 'on' }));
    fs.rmSync(invalid, { recursive: true, force: true });
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(STATE_ERROR);
    expect(r.stderr).toContain('contract version 2 is not supported');
  });

  test('unknown transcript shape fails open and bumps the canary', () => {
    const file = transcript(['{"kind":"something-else"}', '{"kind":"still-not-a-transcript"}']);
    const r = stop(file);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(STATE_ERROR);
    expect(r.stderr).toContain('unknown transcript shape');
    stop(file);
    expect(JSON.parse(fs.readFileSync(path.join(state, 'hooks', 'skill-contract.canary.json'), 'utf8')).count).toBe(2);
  });
});

describe('off switch', () => {
  test('default off, config off, and env off over config on: no output at all', () => {
    const file = transcript(J1_TRANSCRIPT);
    expect(runHook(CONTRACT_HOOK, payload(file), hookEnv(state, skills))).toEqual({ code: 0, stdout: '', stderr: '' });
    fs.writeFileSync(path.join(state, 'config.yaml'), 'skill_contracts: off\n');
    expect(runHook(CONTRACT_HOOK, payload(file), hookEnv(state, skills))).toEqual({ code: 0, stdout: '', stderr: '' });
    fs.writeFileSync(path.join(state, 'config.yaml'), 'skill_contracts: on\n');
    expect(runHook(CONTRACT_HOOK, payload(file), hookEnv(state, skills, { GSTACK_SKILL_CONTRACTS: 'off' }))).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(JSON.parse(runHook(CONTRACT_HOOK, payload(file), hookEnv(state, skills)).stdout).decision).toBe('block');
  });

  test('the bash shim exits 0 and passes the block through', () => {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const r = spawnSync('bash', [path.join(ROOT, 'hosts', 'claude', 'hooks', 'skill-contract-stop-hook')], {
      input: payload(transcript(J1_TRANSCRIPT)), env: hookEnv(state, skills, { GSTACK_SKILL_CONTRACTS: 'on' }), encoding: 'utf8', timeout: 20_000,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).reason).toBe(PINNED);
  });
});
