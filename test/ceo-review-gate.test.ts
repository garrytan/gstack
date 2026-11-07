/**
 * ceo-review-gate (GST-1461): with the ceo_review_gate switch on, a session
 * (or a subagent) that loaded /plan-ceo-review cannot end its final turn until
 * the review's output file, modified after the load, has a Findings or Top
 * risks heading followed by a numbered list of ranked risks (1. ...) with at
 * least one real item. Blocks are capped at 3 per run, then the stop goes
 * through with an exhausted marker. Every decision is a GSTACK_GATE marker in
 * the hook log, the session record and the hook's output; errors fail open.
 * Native Stop and SubagentStop payloads against a throwaway git repo.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { rankedRisksGap } from '../lib/ceo-review-gate';
import { ROOT, hookEnv, result, runHook, say, skillsDir, tmpDir, tool, user } from './helpers/skill-contract-fixture';

const HOOK = path.join(ROOT, 'hosts', 'claude', 'hooks', 'ceo-review-gate.ts');
const PLAN = '# Plan: faster checkout\n\nShip one-click checkout.\n';
const RANKED = `${PLAN}\n## Findings\n\n1. Payment retries can double-charge when the provider times out (critical).\n2. No rollback path for the new schema.\n`;
const LOAD_TIME = '2026-11-02T00:00:00.000Z';

let state = '', skills = '', repo = '', work = '';
beforeEach(() => {
  state = tmpDir('gstack-cgate-state-');
  work = tmpDir('gstack-cgate-work-');
  repo = tmpDir('gstack-cgate-repo-');
  skills = skillsDir([]);
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n');
  git('add', '-A');
  commit('seed');
});
afterEach(() => {
  for (const d of [state, skills, repo, work]) fs.rmSync(d, { recursive: true, force: true });
});

function git(...args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
const commit = (msg: string) => git('-c', 'user.name=Gate fixture', '-c', 'user.email=fixture@gstack.test', 'commit', '-q', '-m', msg);
const put = (file: string, body: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); return file; };
const planFile = () => path.join(repo, 'plan.md');
/** A sidechain (subagent) record, as Claude Code writes it to agent-<id>.jsonl. */
const side = (line: string) => line.replace('"isSidechain":false', '"isSidechain":true');

const LOADED = [user('review my plan'), tool('s1', 'Skill', { skill: 'plan-ceo-review' }), result('s1', 'Launching skill: plan-ceo-review')];
const READ_PLAN = () => [tool('r1', 'Read', { file_path: planFile() }), result('r1', PLAN)];
const wrote = (file: string, id = 'w1') => [tool(id, 'Write', { file_path: file, content: '...' }), result(id, `File created successfully at: ${file}`)];
const DONE = say('Review complete.');

function transcript(lines: string[], name = 'transcript.jsonl'): string {
  const file = path.join(work, name);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}
const baseEnv = (env: Record<string, string> = {}) => hookEnv(state, skills, { GSTACK_CEO_REVIEW_GATE: 'on', GSTACK_CEO_REVIEW_OUTPUT: '', ...env });
function stop(lines: string[], extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const payload = { session_id: 'sess-1', transcript_path: transcript(lines), cwd: repo, hook_event_name: 'Stop', stop_hook_active: false, ...extra };
  return runHook(HOOK, JSON.stringify(payload), baseEnv(env));
}
function subagentStop(main: string[], agent: string[], agentId = 'a1b2c3', extra: Record<string, unknown> = {}) {
  const payload = {
    session_id: 'sess-1', transcript_path: transcript(main), cwd: repo, hook_event_name: 'SubagentStop', stop_hook_active: false,
    agent_id: agentId, agent_transcript_path: transcript(agent.map(side), `agent-${agentId}.jsonl`), ...extra,
  };
  return runHook(HOOK, JSON.stringify(payload), baseEnv());
}
const json = (stdout: string) => (stdout.trim() ? JSON.parse(stdout) : null);
const log = () => {
  const f = path.join(state, 'hooks', 'ceo-review-gate.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};
const record = () => JSON.parse(fs.readFileSync(path.join(state, 'skill-gates', 'sess-1', 'record.json'), 'utf8'));
const runs = () => Object.values(record().hooks['ceo-review-gate'].runs) as Array<Record<string, any>>;

describe('Stop is blocked until the output file ranks the top risks', () => {
  test('no output file: blocked with the marker first, the exact ask in the body, fired in systemMessage', () => {
    put(planFile(), PLAN);
    git('add', 'plan.md');
    commit('plan');
    const out = json(stop([...LOADED, ...READ_PLAN(), DONE]).stdout);
    expect(out.decision).toBe('block');
    const [first, ...body] = out.reason.split('\n');
    expect(first).toBe('GSTACK_GATE ceo-review-gate blocked session=sess-1 skill=plan-ceo-review via=stop files=none n=1');
    expect(body.join('\n')).toContain(`a '## Findings' section ranking the top risks as a numbered list (1. most severe ...) in the review's output file: ${planFile()}`);
    expect(out.reason).not.toMatch(/ceo_review_gate|GSTACK_CEO_REVIEW_GATE|gstack-config|--no-ceo/);
    expect(out.systemMessage).toMatch(/^GSTACK_GATE ceo-review-gate fired session=sess-1 skill=plan-ceo-review on=Stop$/m);
    expect(log().match(/ event=fired /g)?.length).toBe(1);
    expect(log()).toMatch(/event=blocked skill=plan-ceo-review via=stop files=none n=1/);
    expect(runs()[0]).toMatchObject({ skill: 'plan-ceo-review', blocked: 1 });
  });

  test('a written file without a Findings heading is blocked and named as the place to write', () => {
    put(planFile(), PLAN);
    const out = json(stop([...LOADED, ...wrote(planFile()), DONE]).stdout);
    expect(out.decision).toBe('block');
    expect(out.reason.split('\n')[0]).toBe('GSTACK_GATE ceo-review-gate blocked session=sess-1 skill=plan-ceo-review via=stop files=plan.md n=1');
    expect(out.reason).toContain(`in the review's output file: ${planFile()}`);
  });

  test('an unranked bullet list under Findings is blocked', () => {
    put(planFile(), `${PLAN}\n## Findings\n\n- Payment retries can double-charge.\n- No rollback path.\n`);
    expect(json(stop([...LOADED, ...wrote(planFile()), DONE]).stdout).decision).toBe('block');
  });

  test('a numbered list of placeholders, or one that does not start at 1, is blocked', () => {
    put(planFile(), `${PLAN}\n## Findings\n\n1. [most severe risk]\n2. TBD\n`);
    expect(json(stop([...LOADED, ...wrote(planFile()), DONE]).stdout).decision).toBe('block');
    put(planFile(), `${PLAN}\n## Top risks\n\n2. Payment retries can double-charge.\n`);
    expect(json(stop([...LOADED, ...wrote(planFile()), DONE]).stdout).decision).toBe('block');
  });

  test('a ranked list after the Findings section ends, under another heading, does not count', () => {
    put(planFile(), `${PLAN}\n## Findings\n\nSee below.\n\n## Next steps\n\n1. Ship it.\n`);
    expect(json(stop([...LOADED, ...wrote(planFile()), DONE]).stdout).decision).toBe('block');
  });

  test('a skill file read after the plan is never named as the place to write, and a write into a skills tree does not release', () => {
    put(planFile(), PLAN);
    git('add', 'plan.md');
    commit('plan');
    const sections = put(path.join(work, '.claude', 'skills', 'gstack', 'plan-ceo-review', 'sections', 'review-sections.md'), RANKED);
    const lines = [...LOADED, ...READ_PLAN(), tool('r2', 'Read', { file_path: sections }), result('r2', '# Review sections'), DONE];
    const out = json(stop(lines).stdout);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain(`in the review's output file: ${planFile()}`);
    expect(out.reason).not.toContain(sections);
    const after = json(stop([...lines.slice(0, -1), ...wrote(sections, 'w2'), DONE]).stdout);
    expect(after.decision).toBe('block');
    expect(after.reason).toContain(`in the review's output file: ${planFile()}`);
  });

  test('a repo skills/ file holding a sample Findings list does not release the gate', () => {
    put(path.join(repo, 'skills', 'example', 'review-sections.md'), RANKED);
    expect(json(stop([...LOADED, DONE]).stdout).decision).toBe('block');
  });

  test('a project that itself sits under a skills/ folder still has its written review found', () => {
    const project = path.join(work, 'skills', 'app');
    const file = put(path.join(project, 'review.md'), RANKED);
    const payload = { session_id: 'sess-1', transcript_path: transcript([...LOADED, ...wrote(file), DONE]), cwd: project, hook_event_name: 'Stop', stop_hook_active: false };
    expect(json(runHook(HOOK, JSON.stringify(payload), baseEnv()).stdout).decision).toBeUndefined();
  });

  test('a candidate whose mtime predates the load is blocked even with a ranked list', () => {
    put(planFile(), RANKED);
    const before = new Date(Date.parse(LOAD_TIME) - 60_000);
    fs.utimesSync(planFile(), before, before);
    const out = json(stop([...LOADED, ...wrote(planFile()), DONE]).stdout);
    expect(out.decision).toBe('block');
    expect(out.reason.split('\n')[0]).toContain('files=plan.md');
  });
});

describe('released when a candidate is met', () => {
  test('met via a Write target: released file=<basename> rides systemMessage with fired, and later stops are silent', () => {
    const file = put(path.join(work, 'plans', 'review.md'), RANKED);
    const lines = [...LOADED, ...wrote(file), DONE];
    const out = json(stop(lines).stdout);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toMatch(/^GSTACK_GATE ceo-review-gate fired session=sess-1 skill=plan-ceo-review on=Stop$/m);
    expect(out.systemMessage).toMatch(/^GSTACK_GATE ceo-review-gate released session=sess-1 skill=plan-ceo-review file=review\.md blocked=0$/m);
    expect(runs()[0].released_at).toBeString();
    expect(runs()[0].file).toBe('review.md');
    expect(stop(lines).stdout).toBe('');
    expect(log().match(/ event=released /g)?.length).toBe(1);
  });

  test('met via an untracked repo .md written through Bash (no Write in the transcript); an ignored file does not count', () => {
    put(path.join(repo, 'ignored', 'review.md'), RANKED);
    const lines = [...LOADED, tool('b1', 'Bash', { command: "cat >> docs/ceo-review.md <<'EOF'\n...\nEOF" }), result('b1', ''), DONE];
    expect(json(stop(lines).stdout).decision).toBe('block');
    put(path.join(repo, 'docs', 'ceo-review.md'), '# Review\n\n### Top risks (ranked)\n\n1) **Double charge** on provider timeout.\n');
    const out = json(stop(lines, { stop_hook_active: true }).stdout);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toMatch(/released session=sess-1 skill=plan-ceo-review file=ceo-review\.md blocked=1$/m);
  });

  test('met via a tracked repo .md modified after the load', () => {
    put(planFile(), PLAN);
    git('add', 'plan.md');
    commit('plan');
    fs.appendFileSync(planFile(), '\n## Findings\n\n1. Double charge on provider timeout.\n');
    expect(json(stop([...LOADED, ...READ_PLAN(), DONE]).stdout).systemMessage).toContain('released session=sess-1 skill=plan-ceo-review file=plan.md');
  });

  test('met via GSTACK_CEO_REVIEW_OUTPUT, which is also the place the block names', () => {
    const file = path.join(work, 'out', 'ceo.md');
    const blocked = json(stop([...LOADED, DONE], {}, { GSTACK_CEO_REVIEW_OUTPUT: file }).stdout);
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toContain(`in the review's output file: ${file}`);
    put(file, RANKED);
    const out = json(stop([...LOADED, DONE], {}, { GSTACK_CEO_REVIEW_OUTPUT: file }).stdout);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toContain('released session=sess-1 skill=plan-ceo-review file=ceo.md');
  });

  test('met via a ceo-plans file under the state root project dir', () => {
    put(path.join(state, 'projects', 'ceo-fixture', 'ceo-plans', '2026-11-05-checkout.md'), RANKED);
    const out = json(stop([...LOADED, DONE], {}, { GSTACK_PROJECT_SLUG: 'ceo-fixture' }).stdout);
    expect(out.systemMessage).toContain('released session=sess-1 skill=plan-ceo-review file=2026-11-05-checkout.md');
  });
});

describe('final turns only', () => {
  test('an interactive stop that asks the user a question is not blocked; headless counts as final', () => {
    const ask = say('I found two directions. Which mode do you want: expansion or hold?');
    expect(stop([...LOADED, ask]).stdout).toBe('');
    expect(log()).toBe('');
    expect(json(stop([...LOADED, ask], {}, { GSTACK_HEADLESS: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }).stdout).decision).toBe('block');
  });

  test('last_assistant_message counts as the final text when the file does not hold it yet', () => {
    expect(stop([...LOADED], { last_assistant_message: 'Which mode do you want: expansion or hold?' }).stdout).toBe('');
  });

  test('a Stop that fires before the CLI flushes the turn waits for the final message: a review written outside the repo is released, not held', async () => {
    const plan = put(path.join(work, 'plans', 'checkout.md'), RANKED);
    const file = transcript(LOADED);
    const payload = { session_id: 'sess-1', transcript_path: file, cwd: repo, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Review complete.' };
    const proc = Bun.spawn([process.execPath, ...bunIsolationArgs(), HOOK], { stdin: new Blob([JSON.stringify(payload)]), env: baseEnv(), stdout: 'pipe', timeout: 20_000 });
    await Bun.sleep(300);
    fs.appendFileSync(file, `${[...wrote(plan), DONE].join('\n')}\n`);
    const out = json(await new Response(proc.stdout).text());
    expect(await proc.exited).toBe(0);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toMatch(/^GSTACK_GATE ceo-review-gate released session=sess-1 skill=plan-ceo-review file=checkout.md blocked=0$/m);
  });

  test('a Stop that fires before the CLI flushes the load itself still judges the run once the final message lands', async () => {
    const file = transcript([user('review my plan')]);
    const payload = { session_id: 'sess-1', transcript_path: file, cwd: repo, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Review complete.' };
    const proc = Bun.spawn([process.execPath, ...bunIsolationArgs(), HOOK], { stdin: new Blob([JSON.stringify(payload)]), env: baseEnv(), stdout: 'pipe', timeout: 20_000 });
    await Bun.sleep(300);
    fs.appendFileSync(file, `${[...LOADED.slice(1), DONE].join('\n')}\n`);
    const out = json(await new Response(proc.stdout).text());
    expect(await proc.exited).toBe(0);
    expect(out?.decision).toBe('block');
    expect(out.reason.split('\n')[0]).toBe('GSTACK_GATE ceo-review-gate blocked session=sess-1 skill=plan-ceo-review via=stop files=none n=1');
  });

  test('no /plan-ceo-review load, or the switch off: no output and no log', () => {
    expect(stop([user('hi'), DONE]).stdout).toBe('');
    expect(stop([...LOADED, DONE], {}, { GSTACK_CEO_REVIEW_GATE: 'off' }).stdout).toBe('');
    expect(log()).toBe('');
  });

  test('a fresh load starts a new run with its own count', () => {
    stop([...LOADED, DONE]);
    const again = [...LOADED, DONE, user('again'), tool('s2', 'Skill', { skill: 'plan-ceo-review' }), result('s2', 'Launching skill: plan-ceo-review'), DONE];
    expect(json(stop(again).stdout).reason.split('\n')[0]).toEndWith('n=1');
    expect(runs()).toHaveLength(2);
  });
});

describe('the cap: three blocks, then exhausted and allowed', () => {
  test('blocks n=1..3 (stop_hook_active does not skip the check), the fourth stop is allowed with exhausted', () => {
    const lines = [...LOADED, DONE];
    for (const n of [1, 2, 3]) {
      const out = json(stop(lines, { stop_hook_active: n > 1 }).stdout);
      expect(out.decision).toBe('block');
      expect(out.reason.split('\n')[0]).toEndWith(`n=${n}`);
    }
    const fourth = json(stop(lines, { stop_hook_active: true }).stdout);
    expect(fourth.decision).toBeUndefined();
    expect(fourth.systemMessage).toMatch(/^GSTACK_GATE ceo-review-gate exhausted session=sess-1 skill=plan-ceo-review blocked=3$/m);
    expect(runs()[0].exhausted_at).toBeString();
    expect(stop(lines, { stop_hook_active: true }).stdout).toBe('');
    expect(log().match(/ event=blocked /g)?.length).toBe(3);
    expect(log().match(/ event=exhausted /g)?.length).toBe(1);
  });
});

describe('SubagentStop gates only a subagent that loaded /plan-ceo-review', () => {
  test('an unrelated subagent finishing is never blocked, even when the main session loaded the skill', () => {
    const r = subagentStop([...LOADED], [user('find the checkout files'), tool('g1', 'Glob', { pattern: 'src/*.ts' }), result('g1', ''), say('Found them.')]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(log()).toBe('');
  });

  test('a CEO review subagent is blocked, then released once it writes the ranked list', () => {
    const file = path.join(work, 'agent-review.md');
    const agent = [user('Run a CEO review of the plan'), tool('s9', 'Skill', { skill: 'plan-ceo-review' }), result('s9', 'Launching skill: plan-ceo-review'), say('Done reviewing.')];
    const first = json(subagentStop([user('kick off a review')], agent).stdout);
    expect(first.decision).toBe('block');
    expect(first.reason.split('\n')[0]).toBe('GSTACK_GATE ceo-review-gate blocked session=sess-1 skill=plan-ceo-review via=stop files=none n=1');
    expect(first.systemMessage).toContain('fired session=sess-1 skill=plan-ceo-review on=SubagentStop');
    put(file, RANKED);
    const done = json(subagentStop([user('kick off a review')], [...agent.slice(0, 3), ...wrote(file, 'w9'), say('Done reviewing.')], 'a1b2c3', { stop_hook_active: true }).stdout);
    expect(done.decision).toBeUndefined();
    expect(done.systemMessage).toContain('released session=sess-1 skill=plan-ceo-review file=agent-review.md blocked=1');
    expect(runs()[0].agent).toBe('agent-a1b2c3');
  });

  test('a SubagentStop with no agent transcript path stays silent', () => {
    const payload = { session_id: 'sess-1', transcript_path: transcript([...LOADED, DONE]), cwd: repo, hook_event_name: 'SubagentStop', stop_hook_active: false };
    expect(runHook(HOOK, JSON.stringify(payload), baseEnv()).stdout).toBe('');
  });
});

describe('errors fail open with an error marker', () => {
  test('a payload that is not JSON: exit 0, no decision, error marker on stderr and in the log', () => {
    const r = runHook(HOOK, 'not json', baseEnv());
    expect(r.code).toBe(0);
    expect(json(r.stdout).decision).toBeUndefined();
    expect(r.stderr).toMatch(/^GSTACK_GATE ceo-review-gate error session=unknown code=GATE_BAD_PAYLOAD why=/);
    expect(json(r.stdout).systemMessage).toMatch(/^GSTACK_GATE ceo-review-gate error session=unknown code=GATE_BAD_PAYLOAD/);
    expect(log()).toContain('event=error');
  });

  test('an unreadable transcript: GATE_TRANSCRIPT in systemMessage and the record, the stop goes through', () => {
    const r = runHook(HOOK, JSON.stringify({ session_id: 'sess-1', transcript_path: path.join(work, 'missing.jsonl'), cwd: repo, hook_event_name: 'Stop' }), baseEnv());
    expect(r.code).toBe(0);
    const out = json(r.stdout);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toMatch(/^GSTACK_GATE ceo-review-gate error session=sess-1 code=GATE_TRANSCRIPT why=/);
    expect(record().hooks['ceo-review-gate'].errors[0].code).toBe('GATE_TRANSCRIPT');
  });

  test('a hook past its deadline fails open with GATE_TIMEOUT', () => {
    const r = stop([...LOADED, DONE], {}, { GSTACK_SKILL_GATE_DEADLINE_MS: '1' });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('"block"');
    expect(log()).toMatch(/event=error code=GATE_TIMEOUT why="timed out after 1 ms"/);
  });

  test('a corrupt session record: GATE_STATE, no block', () => {
    put(path.join(state, 'skill-gates', 'sess-1', 'record.json'), '{not json');
    const out = json(stop([...LOADED, DONE]).stdout);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toMatch(/code=GATE_STATE/);
  });
});

describe('rankedRisksGap reads the markdown, not a code sample of it', () => {
  test('names each gap, and a ranked list under a nested subheading still counts', () => {
    expect(rankedRisksGap(PLAN)).toBe('no Findings or Top risks heading');
    expect(rankedRisksGap(`${PLAN}\n## Top risks\n\n- a bullet\n`)).toBe('no numbered list starting at 1 under its Findings or Top risks heading');
    expect(rankedRisksGap(`${PLAN}\n## Findings\n\n1. TBD\n`)).toBe('its numbered list holds only placeholders');
    expect(rankedRisksGap(RANKED)).toBeNull();
    expect(rankedRisksGap(`${PLAN}\n## Findings\n\n### Payments\n\n1. Retries can double-charge.\n`)).toBeNull();
  });

  test('a Findings heading and list inside a fenced block do not count', () => {
    const fenced = `${PLAN}\n\`\`\`md\n## Findings\n\n1. Example risk.\n\`\`\`\n`;
    expect(rankedRisksGap(fenced)).toBe('no Findings or Top risks heading');
  });
});
