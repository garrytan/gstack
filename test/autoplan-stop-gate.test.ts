/**
 * autoplan-stop-gate (GST-1666): with the autoplan_gate switch on, a session
 * that loaded /autoplan cannot end its final turn until every phase its scope
 * makes applicable has published its report (the "**Phase N complete.**" text
 * followed by the Bash no-op "true autoplan-published <phase>") and the Phase 4
 * Final Approval Gate is written. A --ceo-only run needs Phase 1 and its
 * GSTACK_RESULT end line instead. A stop that asks the user, or that waits on a
 * native reviewer still running, is never held; a run driven through the
 * gstack-autoplan runner is skipped. Blocks are capped at 3 per run, then the
 * stop goes through with an exhausted marker. Every decision is a GSTACK_GATE
 * marker in the hook log, the session record and the hook's output; errors
 * fail open. Native Stop payloads against throwaway transcripts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkRun } from '../lib/autoplan-stop-gate';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { parseTranscript, skillLoads } from '../lib/skill-contract';
import { ROOT, hookEnv, meta, result, runHook, say, skillsDir, slash, tmpDir, tool, user } from './helpers/skill-contract-fixture';

const HOOK = path.join(ROOT, 'hosts', 'claude', 'hooks', 'autoplan-stop-gate.ts');
const SKILLS = '/root/.claude/skills/gstack';
const SNAP = path.join(SKILLS, 'bin', 'gstack-autoplan-snapshot.ts');
const PLAN = '/work/repo/PLAN.md';
const NUMBER = { ceo: '1', design: '2', dx: '2.5', eng: '3' } as const;
type Phase = keyof typeof NUMBER;

let state = '', skills = '', work = '';
beforeEach(() => {
  state = tmpDir('gstack-apgate-state-');
  work = tmpDir('gstack-apgate-work-');
  skills = skillsDir([]);
});
afterEach(() => {
  for (const d of [state, skills, work]) fs.rmSync(d, { recursive: true, force: true });
});

const LOADED = [slash('autoplan', 'PLAN.md')];
const init = (scope: { uiRequired?: boolean; dxRequired?: boolean } = {}) => [
  tool('i1', 'Bash', { command: `bun "${SNAP}" init "${PLAN}" "${PLAN}" "/work/repo/.gstack/tmp/autoplan/restore.md"` }),
  result('i1', JSON.stringify({ sourcePlan: PLAN, activePlan: PLAN, scope: { activePlan: PLAN, uiRequired: false, dxRequired: false, ...scope } })),
];
const enter = (phase: Phase) => [
  tool(`e-${phase}`, 'Read', { file_path: `${SKILLS}/autoplan/sections/${phase}-phase.md` }),
  result(`e-${phase}`, '# phase driver'),
];
const report = (phase: Phase) => say(`**Phase ${NUMBER[phase]} complete.**\nOutside review: unavailable. Native subagent: completed: 3 issues.\nConsensus: N/A (voice coverage missing).\nPassing to the next phase.`);
const noop = (phase: Phase) => [tool(`p-${phase}`, 'Bash', { command: `true autoplan-published ${phase}` }), result(`p-${phase}`, '')];
const publish = (phase: Phase) => [report(phase), ...noop(phase)];
const phase = (p: Phase) => [...enter(p), ...publish(p)];
const GATE = [tool('g1', 'Bash', { command: '~/.claude/skills/gstack/bin/gstack-gate render "$_AP/gate.json"' }), result('g1', 'p1: approve as-is (recommended)')];
const DONE = say('The plan is reviewed and ready for your approval.');
const FULL = [...LOADED, ...init(), ...phase('ceo'), ...phase('eng'), ...GATE, DONE];

function transcript(lines: string[], name = 'transcript.jsonl'): string {
  const file = path.join(work, name);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}
const baseEnv = (env: Record<string, string> = {}) => hookEnv(state, skills, { GSTACK_AUTOPLAN_GATE: 'on', ...env });
function stop(lines: string[], extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const payload = { session_id: 'sess-1', transcript_path: transcript(lines), cwd: work, hook_event_name: 'Stop', stop_hook_active: false, ...extra };
  return runHook(HOOK, JSON.stringify(payload), baseEnv(env));
}
const json = (stdout: string) => (stdout.trim() ? JSON.parse(stdout) : null);
const log = () => {
  const f = path.join(state, 'hooks', 'autoplan-gate.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};
const record = () => JSON.parse(fs.readFileSync(path.join(state, 'skill-gates', 'sess-1', 'record.json'), 'utf8'));
const runs = () => Object.values(record().hooks['autoplan-gate'].runs) as Array<Record<string, any>>;
const check = (lines: string[]) => {
  const t = parseTranscript(`${lines.join('\n')}\n`);
  return checkRun(t, skillLoads(t).pop()!);
};

describe('checkRun reads what the run did', () => {
  test('a complete run: scope, every applicable phase published in order, the gate written', () => {
    expect(check(FULL)).toMatchObject({ mode: 'full', phases: ['ceo', 'eng'], entered: ['ceo', 'eng'], published: ['ceo', 'eng'], gate: true, missing: null, pendingAgents: [] });
  });

  test('scope decides the phases: UI and DX scope add Design and DX in order', () => {
    const c = check([...LOADED, ...init({ uiRequired: true, dxRequired: true }), ...phase('ceo'), ...phase('eng'), ...GATE, DONE]);
    expect(c.phases).toEqual(['ceo', 'design', 'dx', 'eng']);
    expect(c.missing).toBe('design');
  });

  test('"Phase 2.5 complete" publishes DX, never Design', () => {
    const lines = [...LOADED, ...init({ uiRequired: true, dxRequired: true }), ...phase('ceo'), report('dx'), ...noop('design'), ...noop('dx'), DONE];
    expect(check(lines).published).toEqual(['ceo']);
    expect(check([...LOADED, ...init({ dxRequired: true }), ...phase('ceo'), ...phase('dx'), DONE]).published).toEqual(['ceo', 'dx']);
  });

  test('a scope command result counts as scope too', () => {
    const scope = [tool('s1', 'Bash', { command: `bun "${SNAP}" scope "${PLAN}"` }), result('s1', JSON.stringify({ activePlan: PLAN, uiRequired: false, dxRequired: true }))];
    expect(check([...LOADED, ...scope, DONE]).phases).toEqual(['ceo', 'dx', 'eng']);
  });

  test('a no-op with no completion report before it, or a failed no-op, is not a publication', () => {
    expect(check([...LOADED, ...init(), ...enter('ceo'), ...noop('ceo'), DONE]).published).toEqual([]);
    const failed = [report('ceo'), tool('p-ceo', 'Bash', { command: 'true autoplan-published ceo' }), result('p-ceo', 'denied', true)];
    expect(check([...LOADED, ...init(), ...enter('ceo'), ...failed, DONE]).published).toEqual([]);
  });

  test('a second /autoplan load starts a new run: the earlier run\'s publications do not count', () => {
    const c = check([...FULL, user('again'), ...LOADED, ...init(), DONE]);
    expect(c.published).toEqual([]);
    expect(c.missing).toBe('ceo');
  });
});

describe('Stop is held until the run has published every applicable phase and written the gate', () => {
  test('a run that skips Eng is blocked with the marker first and the next step named', () => {
    const out = json(stop([...LOADED, ...init(), ...phase('ceo'), DONE]).stdout);
    expect(out.decision).toBe('block');
    const [first, ...body] = out.reason.split('\n');
    expect(first).toBe('GSTACK_GATE autoplan-gate blocked session=sess-1 skill=autoplan via=stop missing=eng published=ceo n=1');
    expect(body.join('\n')).toContain('Phase 3 (Eng) has not run');
    expect(body.join('\n')).toContain('autoplan/sections/eng-phase.md');
    expect(out.reason).not.toMatch(/autoplan_gate|GSTACK_AUTOPLAN_GATE|gstack-config|--no-autoplan/);
    expect(out.systemMessage).toMatch(/^GSTACK_GATE autoplan-gate fired session=sess-1 skill=autoplan on=Stop$/m);
    expect(log()).toMatch(/event=blocked skill=autoplan via=stop missing=eng published=ceo n=1/);
    expect(runs()[0]).toMatchObject({ skill: 'autoplan', blocked: 1, phases: ['ceo', 'eng'], published: ['ceo'] });
  });

  test('a phase that ran but never published its report is blocked at its close', () => {
    const out = json(stop([...LOADED, ...init(), ...enter('ceo'), say('CEO review done.'), DONE]).stdout);
    expect(out.decision).toBe('block');
    expect(out.reason.split('\n')[0]).toBe('GSTACK_GATE autoplan-gate blocked session=sess-1 skill=autoplan via=stop missing=ceo published=none n=1');
    expect(out.reason).toContain('Phase 1 (CEO) has not published its report');
    expect(out.reason).toContain('true autoplan-published ceo');
  });

  test('a run that never ran Phase 0 scope is blocked at scope', () => {
    const out = json(stop([...LOADED, say('Here is my review of the plan: it looks good.')]).stdout);
    expect(out.decision).toBe('block');
    expect(out.reason.split('\n')[0]).toBe('GSTACK_GATE autoplan-gate blocked session=sess-1 skill=autoplan via=stop missing=scope published=none n=1');
    expect(out.reason).toContain('Phase 0');
  });

  test('every phase published but no Final Approval Gate: blocked at the gate', () => {
    const out = json(stop([...LOADED, ...init(), ...phase('ceo'), ...phase('eng'), DONE]).stdout);
    expect(out.decision).toBe('block');
    expect(out.reason.split('\n')[0]).toBe('GSTACK_GATE autoplan-gate blocked session=sess-1 skill=autoplan via=stop missing=gate published=ceo,eng n=1');
    expect(out.reason).toContain('gate.json');
  });

  test('a gate.json written with the Write tool counts as the gate', () => {
    const wrote = [tool('w1', 'Write', { file_path: '/work/repo/.gstack/tmp/autoplan/run/gate.json', content: '{}' }), result('w1', 'File created successfully')];
    expect(json(stop([...LOADED, ...init(), ...phase('ceo'), ...phase('eng'), ...wrote, DONE]).stdout).decision).toBeUndefined();
  });

  test('a complete run is released, recorded with its phases, and a later stop does nothing', () => {
    const out = json(stop(FULL).stdout);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toMatch(/^GSTACK_GATE autoplan-gate fired session=sess-1 skill=autoplan on=Stop$/m);
    expect(out.systemMessage).toMatch(/^GSTACK_GATE autoplan-gate released session=sess-1 skill=autoplan phases=ceo,eng blocked=0$/m);
    expect(runs()[0]).toMatchObject({ skill: 'autoplan', blocked: 0, published: ['ceo', 'eng'] });
    expect(runs()[0].released_at).toBeString();
    expect(stop(FULL).stdout.trim()).toBe('');
  });

  test('blocked, then completed: released with the block count', () => {
    expect(json(stop([...LOADED, ...init(), ...phase('ceo'), DONE]).stdout).decision).toBe('block');
    const out = json(stop(FULL).stdout);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toBe('GSTACK_GATE autoplan-gate released session=sess-1 skill=autoplan phases=ceo,eng blocked=1');
  });

  test('three blocks, then the fourth stop goes through as exhausted', () => {
    const partial = [...LOADED, ...init(), ...phase('ceo'), DONE];
    for (let n = 1; n <= 3; n++) expect(json(stop(partial).stdout).reason.split('\n')[0]).toEndWith(`n=${n}`);
    const out = json(stop(partial).stdout);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toBe('GSTACK_GATE autoplan-gate exhausted session=sess-1 skill=autoplan missing=eng blocked=3');
    expect(stop(partial).stdout.trim()).toBe('');
  });
  test('a Stop that fires before the CLI flushes the turn waits for the final message instead of judging a stale transcript', async () => {
    const file = transcript(LOADED);
    const payload = { session_id: 'sess-1', transcript_path: file, cwd: work, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'The plan is reviewed and ready for your approval.' };
    const proc = Bun.spawn([process.execPath, ...bunIsolationArgs(), HOOK], { stdin: new Blob([JSON.stringify(payload)]), env: baseEnv(), stdout: 'pipe', timeout: 20_000 });
    await Bun.sleep(300);
    fs.appendFileSync(file, `${[...init(), ...phase('ceo'), ...phase('eng'), ...GATE, DONE].join('\n')}\n`);
    const out = json(await new Response(proc.stdout).text());
    expect(await proc.exited).toBe(0);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toMatch(/^GSTACK_GATE autoplan-gate released session=sess-1 skill=autoplan phases=ceo,eng blocked=0$/m);
  });
});

describe('what the gate never holds', () => {
  test('the switch off (the default): nothing', () => {
    const r = stop([...LOADED, DONE], {}, { GSTACK_AUTOPLAN_GATE: 'off' });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(fs.existsSync(path.join(state, 'skill-gates'))).toBe(false);
  });

  test('a session that never loaded /autoplan: nothing', () => {
    expect(stop([user('plan something'), DONE]).stdout.trim()).toBe('');
  });

  test('a stop that asks the user in an interactive session is not held', () => {
    expect(stop([...LOADED, ...init(), ...phase('ceo'), say('Phase 1 is done. Do you want me to continue to the Eng review?')]).stdout.trim()).toBe('');
  });

  test('a stop waiting on a native reviewer that is still running is not held; once it reports, the stop is', () => {
    const launched = [...LOADED, ...init(), ...enter('ceo'),
      tool('a1', 'Agent', { description: 'CEO review', prompt: 'review', run_in_background: true }), result('a1', 'Async agent launched. agentId: agent-77'),
      say('Waiting for agent-77.')];
    expect(stop(launched).stdout.trim()).toBe('');
    const reported = [...launched, meta('<task-notification>agent-77 completed</task-notification>'), say('The CEO review is in.')];
    expect(json(stop(reported).stdout).decision).toBe('block');
  });

  test('a run driven through the gstack-autoplan runner is skipped once, never blocked', () => {
    const runner = [...LOADED, tool('n1', 'Bash', { command: '~/.claude/skills/gstack/bin/gstack-autoplan next --out /tmp/ap --plan PLAN.md' }), result('n1', 'GSTACK_RESULT: skill=autoplan status=awaiting_result run=/tmp/ap'), DONE];
    const out = json(stop(runner).stdout);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toBe('GSTACK_GATE autoplan-gate skipped session=sess-1 skill=autoplan reason=runner');
    expect(stop(runner).stdout.trim()).toBe('');
  });

  test('a command that only mentions the runner (a docs search, an echo) is not runner mode', () => {
    for (const command of ['rg "gstack-autoplan next --out" docs/unattended.md', 'echo skipping gstack-autoplan next']) {
      expect(check([...LOADED, tool('n1', 'Bash', { command }), result('n1', ''), DONE])).toMatchObject({ mode: 'full', missing: 'scope' });
    }
    expect(check([...LOADED, tool('n1', 'Bash', { command: ". '/x/launch.env' && gstack-autoplan next --out /tmp/ap" }), result('n1', ''), DONE]).mode).toBe('runner');
  });

  test('a background reviewer whose launch failed is not pending: the stop is held', () => {
    const denied = [...LOADED, ...init(), ...enter('ceo'),
      tool('a1', 'Agent', { description: 'CEO review', prompt: 'review', run_in_background: true }), result('a1', 'Permission denied', true),
      say('The reviewer could not start.')];
    expect(check(denied).pendingAgents).toEqual([]);
    expect(json(stop(denied).stdout).decision).toBe('block');
  });

  test('an unreadable transcript fails open with an error marker', () => {
    const payload = { session_id: 'sess-1', transcript_path: path.join(work, 'missing.jsonl'), cwd: work, hook_event_name: 'Stop' };
    const r = runHook(HOOK, JSON.stringify(payload), baseEnv());
    expect(r.code).toBe(0);
    expect(json(r.stdout).decision).toBeUndefined();
    expect(json(r.stdout).systemMessage).toMatch(/^GSTACK_GATE autoplan-gate error session=sess-1 code=GATE_TRANSCRIPT /);
  });
});

describe('a --ceo-only run is checked at its own end line', () => {
  const CEO_ONLY = [slash('autoplan', 'PLAN.md --ceo-only')];
  const END = say('Phases 2, 2.5, 3 and 4 skipped (CEO-only run).\nGSTACK_RESULT: skill=autoplan status=reviewed run=/work/repo/.gstack/tmp/autoplan/run');

  test('Phase 1 published and the end line: released with phases=ceo', () => {
    const out = json(stop([...CEO_ONLY, ...init(), ...phase('ceo'), END]).stdout);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toMatch(/^GSTACK_GATE autoplan-gate released session=sess-1 skill=autoplan phases=ceo blocked=0$/m);
  });

  test('Phase 1 published without the end line: blocked at the end line', () => {
    const out = json(stop([...CEO_ONLY, ...init(), ...phase('ceo'), DONE]).stdout);
    expect(out.reason.split('\n')[0]).toBe('GSTACK_GATE autoplan-gate blocked session=sess-1 skill=autoplan via=stop missing=end published=ceo n=1');
    expect(out.reason).toContain('GSTACK_RESULT: skill=autoplan status=reviewed');
  });

  test('the end line without Phase 1 published: blocked at Phase 1', () => {
    expect(json(stop([...CEO_ONLY, ...init(), ...enter('ceo'), END]).stdout).reason.split('\n')[0]).toContain('missing=ceo');
  });

  test('--ceo-only in a Skill call\'s command or skill field, or in the prompt before a Read load, is a ceo-only run', () => {
    const rest = [...init(), ...phase('ceo'), END];
    for (const input of [{ command: 'autoplan --ceo-only' }, { skill: 'autoplan --ceo-only' }]) {
      expect(check([user('review my plan'), tool('s1', 'Skill', input), result('s1', 'loaded'), ...rest])).toMatchObject({ mode: 'ceo-only', missing: null });
    }
    const readLoad = [user('Run /autoplan PLAN.md --ceo-only'), tool('r1', 'Read', { file_path: `${SKILLS}/autoplan/SKILL.md` }), result('r1', '# autoplan'), ...rest];
    expect(check(readLoad)).toMatchObject({ mode: 'ceo-only', missing: null });
    expect(check([user('Run /autoplan PLAN.md'), ...readLoad.slice(1)])).toMatchObject({ mode: 'full', missing: 'eng' });
  });
});

describe('E2 replays (GST-1814): each phase publishes in order after its own report, and blocks before the first report never exhaust the run', () => {
  const DXRUN = [...LOADED, ...init({ dxRequired: true })];
  const WORKED = [...DXRUN, ...enter('ceo'), ...enter('dx'), ...enter('eng')];
  const noopAs = (p: Phase, id: string) => [tool(id, 'Bash', { command: `true autoplan-published ${p}` }), result(id, '')];
  function publishTry(lines: string[], p: Phase, id = `try-${p}`, env: Record<string, string> = {}) {
    const payload = { session_id: 'sess-1', transcript_path: transcript([...lines, tool(id, 'Bash', { command: `true autoplan-published ${p}` })]), cwd: work,
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command: `true autoplan-published ${p}` } };
    return runHook(HOOK, JSON.stringify(payload), baseEnv(env));
  }
  const denied = (r: { stdout: string }) => json(r.stdout)?.hookSpecificOutput;

  test('sequence 1: stops before any work never exhaust the budget, each names the CEO report as due, and report-less publishes are refused', () => {
    const idle = [...DXRUN, say('Starting the CEO review now.')];
    for (let n = 1; n <= 5; n++) {
      const out = json(stop(idle).stdout);
      expect(out.decision).toBe('block');
      expect(out.reason.split('\n')[0]).toBe(`GSTACK_GATE autoplan-gate blocked session=sess-1 skill=autoplan via=stop missing=ceo published=none n=${n}`);
      expect(out.reason.split('\n')[1]).toBe('Next due: the Phase 1 (CEO) report.');
    }
    expect(runs()[0].exhausted_at).toBeUndefined();
    for (const p of ['ceo', 'dx', 'eng'] as Phase[]) {
      const d = denied(publishTry(idle, p));
      expect(d).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
      expect(d.permissionDecisionReason).toContain('Next due: the Phase 1 (CEO) report.');
    }
    const bare = [...idle, ...noop('ceo'), ...noop('dx'), ...noop('eng'), DONE];
    const out = json(stop(bare).stdout);
    expect(out.reason.split('\n')[0]).toEndWith('missing=ceo published=none n=6');
    expect(out.reason).toContain('Not counted: true autoplan-published ceo (no report before it), true autoplan-published dx (no report before it), true autoplan-published eng (no report before it).');
  });

  test('sequence 1: once a report exists, three blocks at the same step exhaust it', () => {
    const partial = [...DXRUN, ...phase('ceo'), DONE];
    for (let n = 1; n <= 3; n++) expect(json(stop(partial).stdout).decision).toBe('block');
    expect(json(stop(partial).stdout).systemMessage).toBe('GSTACK_GATE autoplan-gate exhausted session=sess-1 skill=autoplan missing=dx blocked=3');
  });

  test('an exhausted run no longer refuses publishes', () => {
    const partial = [...DXRUN, ...phase('ceo'), DONE];
    const early = [...DXRUN, ...phase('ceo'), report('eng')];
    expect(denied(publishTry(early, 'eng'))?.permissionDecision).toBe('deny');
    for (let n = 1; n <= 3; n++) expect(json(stop(partial).stdout).decision).toBe('block');
    expect(json(stop(partial).stdout).systemMessage).toContain('autoplan-gate exhausted');
    expect(denied(publishTry(early, 'eng'))).toBeUndefined();
    expect(runs()[0].denied).toBe(1);
  });

  test('sequence 1: the 12-block ceiling ends a run that never reports', () => {
    const idle = [...DXRUN, DONE];
    for (let n = 1; n <= 12; n++) expect(json(stop(idle).stdout).decision).toBe('block');
    expect(json(stop(idle).stdout).systemMessage).toBe('GSTACK_GATE autoplan-gate exhausted session=sess-1 skill=autoplan missing=ceo blocked=12');
  });

  test('sequence 1: progress resets the per-step budget, so a run that advances each block is never exhausted mid-pipeline', () => {
    const steps = [[...DXRUN, ...phase('ceo'), DONE], [...DXRUN, ...phase('ceo'), ...phase('dx'), DONE], [...DXRUN, ...phase('ceo'), ...phase('dx'), ...phase('eng'), DONE]];
    for (const s of steps) for (let n = 0; n < 3; n++) expect(json(stop(s).stdout).decision).toBe('block');
    const out = json(stop([...DXRUN, ...phase('ceo'), ...phase('dx'), ...phase('eng'), ...GATE, DONE]).stdout);
    expect(out.systemMessage).toBe('GSTACK_GATE autoplan-gate released session=sess-1 skill=autoplan phases=ceo,dx,eng blocked=9');
  });

  test('sequence 2: Eng\'s report first is refused at publish, and back-filling CEO and DX does not make the early Eng count', () => {
    const d = denied(publishTry([...WORKED, report('eng')], 'eng'));
    expect(d.permissionDecision).toBe('deny');
    expect(d.permissionDecisionReason.split('\n').slice(0, 2)).toEqual(['GSTACK_GATE autoplan-gate blocked session=sess-1 skill=autoplan via=publish phase=eng why=out-of-order missing=ceo n=1', 'Next due: the Phase 1 (CEO) report.']);
    expect(d.permissionDecisionReason).toContain('Phase 3 (Eng) cannot publish before Phase 1 (CEO) and Phase 2.5 (DX)');
    expect(d.permissionDecisionReason).toContain('true autoplan-published ceo');
    const backfilled = [...WORKED, ...publish('eng'), ...publish('ceo'), ...publish('dx'), ...GATE, DONE];
    expect(check(backfilled)).toMatchObject({ published: ['ceo', 'dx'], missing: 'eng', uncounted: [{ phase: 'eng', why: 'out-of-order' }] });
    const out = json(stop(backfilled).stdout);
    expect(out.reason.split('\n')[0]).toBe('GSTACK_GATE autoplan-gate blocked session=sess-1 skill=autoplan via=stop missing=eng published=ceo,dx n=1');
    expect(out.reason.split('\n')[1]).toBe('Next due: the Phase 3 (Eng) report.');
    expect(out.reason).toContain('true autoplan-published eng (out of order: Phase 1 (CEO) was due)');
  });

  test('before scope is known, CEO publishes first and later phases follow in forward order', () => {
    const d = denied(publishTry([...LOADED, report('eng')], 'eng'));
    expect(d.permissionDecisionReason.split('\n').slice(0, 2)).toEqual(['GSTACK_GATE autoplan-gate blocked session=sess-1 skill=autoplan via=publish phase=eng why=out-of-order missing=ceo n=1', 'Next due: the Phase 1 (CEO) report.']);
    expect(d.permissionDecisionReason).toContain('Phase 3 (Eng) cannot publish before Phase 1 (CEO).');
    expect(check([...LOADED, ...publish('eng')])).toMatchObject({ phases: null, published: [], uncounted: [{ phase: 'eng', why: 'out-of-order', due: 'ceo' }] });
    expect(denied(publishTry([...LOADED, report('ceo')], 'ceo'))).toBeUndefined();
    expect(denied(publishTry([...LOADED, ...phase('ceo'), report('eng')], 'eng'))).toBeUndefined();
  });

  test('a report written after the publish call in the same message does not count for it', () => {
    const lines = [...DXRUN, ...enter('ceo'), tool('late', 'Bash', { command: 'true autoplan-published ceo' }), report('ceo')];
    const payload = { session_id: 'sess-1', transcript_path: transcript(lines), cwd: work, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'late', tool_input: { command: 'true autoplan-published ceo' } };
    const d = denied(runHook(HOOK, JSON.stringify(payload), baseEnv()));
    expect(d.permissionDecisionReason.split('\n')[0]).toBe('GSTACK_GATE autoplan-gate blocked session=sess-1 skill=autoplan via=publish phase=ceo why=no-report missing=ceo n=1');
  });

  test('sequence 3: publishes with no report are refused one by one, naming the report each one needs', () => {
    const d = denied(publishTry(WORKED, 'ceo'));
    expect(d.permissionDecision).toBe('deny');
    expect(d.permissionDecisionReason.split('\n')[1]).toBe('Next due: the Phase 1 (CEO) report.');
    expect(d.permissionDecisionReason).toContain('Phase 1 (CEO) cannot publish without its report');
    expect(d.permissionDecisionReason).toContain('**Phase 1 complete.**');
    const bare = [...WORKED, ...noop('ceo'), ...noop('dx'), ...noop('eng')];
    expect(check([...bare, DONE])).toMatchObject({ published: [], missing: 'ceo' });
    expect(denied(publishTry(bare, 'dx')).permissionDecisionReason.split('\n')[1]).toBe('Next due: the Phase 1 (CEO) report.');
    expect(publishTry([...bare, report('ceo')], 'ceo').stdout.trim()).toBe('');
    expect(log()).toMatch(/event=blocked skill=autoplan via=publish phase=ceo why=no-report missing=ceo n=1/);
    expect(runs()[0]).toMatchObject({ denied: 2, blocked: 0 });
  });

  test('negative control: a run that reports and publishes every phase in order is never refused and releases with zero blocks', () => {
    let lines = [...DXRUN];
    for (const p of ['ceo', 'dx', 'eng'] as Phase[]) {
      lines = [...lines, ...enter(p), report(p)];
      expect(publishTry(lines, p, `p-${p}`).stdout.trim()).toBe('');
      lines = [...lines, ...noop(p)];
    }
    const out = json(stop([...lines, ...GATE, DONE]).stdout);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toMatch(/^GSTACK_GATE autoplan-gate released session=sess-1 skill=autoplan phases=ceo,dx,eng blocked=0$/m);
    expect(runs()[0].denied ?? 0).toBe(0);
  });

  test('negative control: republishing an already published phase is allowed and changes nothing', () => {
    expect(publishTry([...LOADED, ...init(), ...phase('ceo')], 'ceo', 'again').stdout.trim()).toBe('');
    expect(check([...LOADED, ...init(), ...phase('ceo'), ...noopAs('ceo', 'again'), DONE])).toMatchObject({ published: ['ceo'], uncounted: [] });
  });

  test('the publish check never refuses with the switch off, outside /autoplan, for other commands, in runner mode or in a subagent', () => {
    const off = publishTry(WORKED, 'eng', 'x', { GSTACK_AUTOPLAN_GATE: 'off' });
    expect(off).toMatchObject({ code: 0, stdout: '' });
    expect(fs.existsSync(path.join(state, 'skill-gates'))).toBe(false);
    expect(publishTry([user('hi')], 'eng').stdout.trim()).toBe('');
    const other = { session_id: 'sess-1', transcript_path: transcript([...WORKED, tool('ls', 'Bash', { command: 'ls' })]), cwd: work, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'ls', tool_input: { command: 'ls' } };
    expect(runHook(HOOK, JSON.stringify(other), baseEnv()).stdout.trim()).toBe('');
    const runner = [...LOADED, tool('n1', 'Bash', { command: '~/.claude/skills/gstack/bin/gstack-autoplan next --out /tmp/ap' }), result('n1', 'ok')];
    expect(publishTry(runner, 'eng').stdout.trim()).toBe('');
    const sub = { session_id: 'sess-1', transcript_path: transcript(WORKED), cwd: work, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'sub', agent_id: 'agent-1', tool_input: { command: 'true autoplan-published eng' } };
    expect(runHook(HOOK, JSON.stringify(sub), baseEnv()).stdout.trim()).toBe('');
  });

  test('the PreToolUse shim hands only a publish no-op to the hook, and fails open without bun', () => {
    const shim = path.join(ROOT, 'hosts', 'claude', 'hooks', 'autoplan-stop-gate-publish');
    const run = (input: string, env: Record<string, string> = baseEnv()) => spawnSync(shim, [], { input, env, encoding: 'utf8', timeout: 20_000 });
    const noBun = { PATH: '/usr/bin:/bin' };
    const ls = run(JSON.stringify({ session_id: 'sess-1', transcript_path: '/nonexistent', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'ls', tool_input: { command: 'ls' } }), noBun);
    expect(ls).toMatchObject({ status: 0, stdout: '' });
    const withBun = { ...baseEnv(), PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}` };
    expect(run('{"tool_input":{"command":"ls"}}', withBun)).toMatchObject({ status: 0, stdout: '' });
    const payload = { session_id: 'sess-1', transcript_path: transcript([...WORKED, tool('s1', 'Bash', { command: 'true autoplan-published eng' })]), cwd: work, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 's1', tool_input: { command: 'true autoplan-published eng' } };
    const r = run(JSON.stringify(payload), withBun);
    expect(r.status).toBe(0);
    expect(json(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(run(JSON.stringify(payload), noBun)).toMatchObject({ status: 0, stdout: '' });
  });

  test('a publish whose own tool call never reaches the transcript is let through (fail open)', () => {
    const payload = { session_id: 'sess-1', transcript_path: transcript(WORKED), cwd: work, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'unseen', tool_input: { command: 'true autoplan-published eng' } };
    const r = runHook(HOOK, JSON.stringify(payload), baseEnv());
    expect(r.code).toBe(0);
    expect(json(r.stdout)?.hookSpecificOutput).toBeUndefined();
  });
});
