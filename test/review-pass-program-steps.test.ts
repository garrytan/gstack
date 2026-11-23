/**
 * The Capy pass program's later steps: ids, budget notes, extras, fix-checks, repeat and scoped passes.
 * Split from test/review-pass.test.ts; shared fixtures live in test/helpers/review-pass-harness.ts.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withWorkspace } from '../lib/review-brief';
import { PARENT_ONLY_QA, type Manifest } from '../lib/review-pass';
import { ROOT, BIN, spec, manifest, repo, host, runPass, bin } from './helpers/review-pass-harness';

/**
 * GST-3562 A: the planner plans a fix-check only for a grant answering the stop after a round-2 fix-check (GEVA-223), until a
 * later release removes it. Commit a fix, record the owner's grant at that stop head, and return the plan flags of that stop.
 */
function legacyGrantFlags(dir: string, env: NodeJS.ProcessEnv): string[] {
  const sh = (c: string) => spawnSync('bash', ['-c', c], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
  const rangeBase = sh('git rev-parse HEAD').stdout.trim();
  expect(sh('echo "export const fix = 1;" >> src/a.ts && git commit -qam fix').status).toBe(0);
  const stopHead = sh('git rev-parse HEAD').stdout.trim();
  env.GSTACK_APPROVALS_MIRROR = '0';
  delete env.GSTACK_APPROVALS_DIR;
  const a = spawnSync(path.join(BIN, 'gstack-approvals'), ['add', '--ask', `Owner grant: one scoped fix-check after round 2 (review_loop_grant ${stopHead.slice(0, 12)})`, '--words', 'do it', '--by', 'GStack Minder', '--scope', 'this /ship invocation', '--json'], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
  expect(a.status, a.stderr).toBe(0);
  return ['--pass', '1', '--last', 'fix-check', '--fix-checks', '1', '--fixed-blocking', '--adversarial-ran', '--range-base', rangeBase, '--grant', JSON.parse(a.stdout).added[0]];
}

describe('Capy pass program (fake host, real bins)', () => {
  test('Step 11 notes its own growth from its first dispatch, not from the pass\'s starting reading', async () => {
    const { dir, env } = repo();
    const rec = path.join(dir, '.state/rec.md');
    fs.mkdirSync(path.dirname(rec), { recursive: true });
    expect(spawnSync('bash', ['-c', 'gstack-ship-budget start --record "$1" --mode observe --reading 1000 --credits 1', '_', rec], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 }).status).toBe(0);
    const h = host(dir, env, { pollsToFinish: 3 });
    const get = h.tools.thread.get;
    let last = 0;
    h.tools.thread.get = async () => { const r = await get(); last = r.cost.tokens; return r; };
    const out = path.join(dir, '.state/run/p1');
    const base = { base: 'main', out, pass: 'x17p1', planFlags: ['--depth-floor', 'full'], record: rec, jam: 'jam_test' };
    expect(await runPass(h, { ...base, step: '9' })).toContain('NEXT: judge (Phase 4)');
    const models = { 'outside-voice': { model_id: 'openai/gpt-6.1-sol' }, 'adversarial-native': { model_id: 'anthropic/claude-opus-5-5', reasoning_mode: 'high' } };
    const res = await runPass(h, { ...base, step: '11', stage: 'voices', models });
    const m = JSON.parse(fs.readFileSync(path.join(out, 'pass-manifest.json'), 'utf8'));
    expect(m.before_voices.tokens).toBeGreaterThan(m.before.tokens);
    const note = res.split('\n').find(l => l.startsWith('NOTE: '))!;
    expect(Number(note.match(/readers_tokens=(\d+)/)![1])).toBe(last - m.before_voices.tokens);
  }, 240_000);

  test('effort=medium readers run the lane model at medium reasoning; without laneModel or models the pass stops before creating any', async () => {
    const { dir, env } = repo();
    const h = host(dir, env);
    const base = { base: 'main', out: path.join(dir, '.state/run/p1'), pass: 'x11p1', planFlags: ['--depth-floor', 'full'] };
    expect(await runPass(h, { ...base, laneModel: undefined })).toMatch(/STOP: specialist\S* runs at effort=medium, which needs input.laneModel/);
    expect(h.creates).toHaveLength(0);
    expect(await runPass(h, base)).toContain('NEXT: judge (Phase 4)');
    const m = JSON.parse(fs.readFileSync(path.join(base.out, 'pass-manifest.json'), 'utf8')) as Manifest;
    for (const r of m.readers.filter(x => x.stage !== 'voices')) {
      const want = r.effort === 'medium' ? { model_id: 'anthropic/claude-opus-5-5', reasoning_mode: 'medium' } : undefined;
      expect(h.creates.find(c => c.title === r.title)!.model).toEqual(want);
    }
    expect(m.readers.some(r => r.effort === 'medium')).toBe(true);
  }, 180_000);

  // Value: protects=once Phase 2 starts the run's parts, the pass program carries the next phase's section parts in the room its own return leaves, so Phase 4 needs no read call of its own, and it never adds them to a run that did not start them; fails_when=the pass returns parts without a started run, overruns 32 KB, puts them after its NEXT line, or repeats a part a poll return already carried;
  //   why_new=GSTA-167 calls plan C5 in code; seam=none; no_claim=how much room real reader outputs leave
  test('a started run gets the next parts inside each poll and the finished pass, once each and before NEXT', async () => {
    const { dir, env } = repo();
    const out = path.join(dir, '.state/run/p1');
    const h = host(dir, env, { pollsToFinish: 30 });
    const input = { base: 'main', out, pass: 'x12p1', planFlags: ['--depth-floor', 'full'] };
    expect(await runPass(h, input)).not.toContain('PART: ');
    fs.mkdirSync(path.join(dir, '.state/run/parts'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.state/run/parts/state.json'), JSON.stringify({ returned: ['review-9', 'review-9.1', 'review-red-team', 'review-9.2.1'] }));
    const ids: string[] = [];
    let res = '';
    for (let i = 0; i < 8 && !res.includes('NEXT: judge'); i++) {
      res = await runPass(h, input);
      expect(res.length).toBeLessThanOrEqual(32000);
      const got = [...res.matchAll(/^PART: (\S+) /gm)].map(m => m[1]!);
      if (got.length) expect(res.lastIndexOf('PART_END: ')).toBeLessThan(res.lastIndexOf('\nNEXT: '));
      ids.push(...got);
    }
    expect(res).toContain('NEXT: judge (Phase 4)');
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('plan-8.1-8.2');
  }, 240_000);

  // Value: protects=the loader's input is filled as SKILL.md reads it: extras as JSON, the checkout named by cwd, and a reader whose summary lands a tick after its done status is collected, not stopped; fails_when=extras must be a file path (replay C2-34: BRIEF_RENDER_FAILED [object Object]), the bins run in the jam's directory instead of the checkout (C2-34: a wrapper launch file), or a done reader without its summary yet stops the pass (C2-34: "finished with no output", one extra call);
  //   why_new=replay C2-34 (GSTA-193) on PR 2; seam=none; no_claim=the host's status timing beyond one late summary
  test('extras as JSON, the checkout as cwd, and a late summary all run through without a STOP', async () => {
    const { dir, env } = repo();
    const out = path.join(dir, '.state/run/p1');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'plan.prompt.md'), 'Plan completion brief');
    const h = host(dir, env, { lateSummary: true });
    const res = await runPass(h, { base: 'main', out, pass: 'x13p1', cwd: dir, planFlags: ['--depth-floor', 'full'],
      extras: [{ name: 'plan', prompt_file: path.join(out, 'plan.prompt.md'), model: { model_id: 'anthropic/claude-haiku-5-5', reasoning_mode: 'low' } }] });
    expect(res).not.toContain('STOP:');
    expect(res).toContain('NEXT: judge (Phase 4)');
    expect(h.creates.find(c => c.title === 'ship x13p1 audit/plan')!.prompt).toBe(withWorkspace('Plan completion brief', fs.realpathSync(dir)));
  }, 180_000);

  // Value: protects=Step 9.2.1's probes stay the parent's, as its section says, so QA coverage is never a subagent's refusal; fails_when=the
  //   pass program dispatches a QA extra (C4-36, C5-36: the QA reader refused both passes, "parent-only", and the parent ran the probes after it);
  //   why_new=extras took any prompt (GST-450); seam=the pass program; no_claim=the parent's probes themselves (DRIVER Phase 4)
  test('a QA extra, by name or by its section\'s parent-only brief, stops the pass before any reader is created', async () => {
    const section = fs.readFileSync(path.join(ROOT, 'ship/sections/review-army.md'), 'utf8');
    expect(section).toContain(PARENT_ONLY_QA);
    const brief = section.slice(section.indexOf('### Step 9.2.1'), section.indexOf('### Step 9.3'));
    for (const [name, text] of [['qa', 'QA brief'], ['exploratory', brief]] as const) {
      const { dir, env } = repo();
      const out = path.join(dir, '.state/run/p1');
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, name + '.prompt.md'), text);
      const h = host(dir, env);
      const res = await runPass(h, { base: 'main', out, pass: 'x14p1', planFlags: ['--depth-floor', 'full'],
        extras: [{ name, prompt_file: path.join(out, name + '.prompt.md'), model: { model_id: 'anthropic/claude-haiku-5-5', reasoning_mode: 'low' } }] });
      expect([name, res.includes('STOP:'), res.includes("Step 9.2.1 is the parent's report-only discovery"), h.creates.length]).toEqual([name, true, true, 0]);
    }
  }, 240_000);

  test('decision 3.5 runs in the program: one fix-check reader whose prompt is the render CLI brief byte for byte, sent and collected', async () => {
    const { dir, env } = repo();
    const out = path.join(dir, '.state/run/fc');
    const files = path.join(dir, '.state/fc');
    fs.mkdirSync(files, { recursive: true });
    const fc: Record<string, string> = {};
    for (const [k, v] of [['fix_list', '1. src/a.ts: guard v80\n'], ['hunks', 'diff --git a/src/a.ts b/src/a.ts\n+export const v81 = 81;\n'], ['tests', 'bun test: 3 pass, 0 fail\n'], ['callers', 'none\n']]) { fc[k] = path.join(files, k + '.txt'); fs.writeFileSync(fc[k]!, v!); }
    const planFlags = legacyGrantFlags(dir, env);
    const missing = await runPass(host(dir, env), { base: 'main', out: path.join(dir, '.state/run/fc0'), pass: 'x19fc0', planFlags });
    expect(missing).toContain('STOP: gstack-review-dispatch pass exited');
    expect(missing).toContain('the plan dispatches a fix-check: pass needs --fix-list, --hunks and --tests');
    const h = host(dir, env);
    const res = await runPass(h, { base: 'main', out, pass: 'x19fc', planFlags, fixCheck: fc, logStart: ['review-fix-check'] });
    expect(res).toMatch(/REVIEW_LOG_START: review-fix-check token=\S+/);
    expect(res).toContain('NEXT: judge (Phase 4)');
    expect(h.creates.map(c => c.title)).toEqual(['ship x19fc fix-check']);
    const cli = bin(dir, env, ['render', '--role', 'fix-check', '--out', path.join(dir, '.state/cli'), '--fix-list', fc.fix_list!, '--hunks', fc.hunks!, '--tests', fc.tests!, '--callers', fc.callers!]);
    expect(cli.status).toBe(0);
    expect(h.creates[0]!.prompt).toBe(fs.readFileSync(path.join(dir, '.state/cli/fix-check.prompt.md'), 'utf8'));
    expect(h.creates[0]!.prompt).toContain('You are the fix-check reviewer');
    const v = bin(dir, env, ['verify', '--ledger', path.join(out, 'review-ledger.jsonl')]).stdout;
    expect(v).toMatch(/^BRIEF fix-check MATCH rendered=(\w+) sent=\1$/m);
    expect(v).toMatch(/^OUTPUT fix-check MATCH /m);
  }, 240_000);

  // Value: protects=decision 3.5's fix-check takes a review-fix-check start token even when the parent passes the Capy skill's
  //   logStart ["review"], so its row is never a pass and a review_loop_exception can follow it; fails_when=the fix-check pass logs a
  //   review start; why_new=ggstack#52 (GST-1031): a scoped fix-check logged as review counted as a second pass; seam=the pass program;
  //   no_claim=what the parent writes in the row
  test('a fix-check pass given logStart ["review"] takes the review-fix-check start', async () => {
    const { dir, env } = repo();
    const files = path.join(dir, '.state/fc');
    fs.mkdirSync(files, { recursive: true });
    const fc: Record<string, string> = {};
    for (const [k, v] of [['fix_list', '1. src/a.ts: guard v80\n'], ['hunks', 'diff --git a/src/a.ts b/src/a.ts\n+export const v81 = 81;\n'], ['tests', 'bun test: 3 pass, 0 fail\n']]) { fc[k] = path.join(files, k + '.txt'); fs.writeFileSync(fc[k]!, v!); }
    const res = await runPass(host(dir, env), { base: 'main', out: path.join(dir, '.state/run/fcr'), pass: 'x52fc', planFlags: legacyGrantFlags(dir, env), fixCheck: fc, logStart: ['review'] });
    expect(res).toMatch(/REVIEW_LOG_START: review-fix-check token=\S+/);
    expect(res).not.toMatch(/REVIEW_LOG_START: review token=/);
  }, 240_000);

  test('Step 11 records one start per row it logs, even when two rows share a skill (native and outside adversarial-review)', async () => {
    const { dir, env } = repo();
    const out = path.join(dir, '.state/run/p1');
    const h = host(dir, env);
    const base = { base: 'main', out, pass: 'x20p1', planFlags: ['--depth-floor', 'full'] };
    expect(await runPass(h, base)).toContain('NEXT: judge (Phase 4)');
    const models = { 'outside-voice': { model_id: 'openai/gpt-6.1-sol' }, 'adversarial-native': { model_id: 'anthropic/claude-opus-5-5', reasoning_mode: 'high' } };
    const res = await runPass(h, { ...base, stage: 'voices', models, logStart: ['adversarial-review', 'adversarial-review'] });
    const starts = res.split('\n').filter(l => l.startsWith('REVIEW_LOG_START: adversarial-review'));
    expect(starts.length).toBe(2);
    expect(new Set(starts.map(l => l.split('token=')[1])).size).toBe(2);
    const m = JSON.parse(fs.readFileSync(path.join(out, 'pass-manifest.json'), 'utf8'));
    expect(Object.keys(m.log_starts).sort()).toEqual(['voices:adversarial-review', 'voices:adversarial-review#2']);
    const again = await runPass(h, { ...base, stage: 'voices', models, logStart: ['adversarial-review', 'adversarial-review'] });
    expect(again).not.toContain('REVIEW_LOG_START:');
  }, 240_000);

  test('a repeat pass reads the range: diffBase reaches the specialists and the Red Team, byte for byte the render CLI at that base', async () => {
    const { dir, env } = repo();
    const sh = (c: string) => spawnSync('bash', ['-c', c], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
    const rangeBase = sh('git rev-parse HEAD').stdout.trim();
    expect(sh('echo "export const fix = 1;" >> src/a.ts && git commit -qam fix').status).toBe(0);
    const out = path.join(dir, '.state/run/p2');
    const h = host(dir, env);
    expect(await runPass(h, { base: 'main', out, pass: 'x21p2', diffBase: rangeBase, planFlags: ['--depth-floor', 'full'] })).toContain('NEXT: judge (Phase 4)');
    const m = JSON.parse(fs.readFileSync(path.join(out, 'pass-manifest.json'), 'utf8'));
    expect(m.diff_base).toBe(rangeBase);
    const spec = m.readers.find((r: { role?: string }) => r.role === 'specialist-batched');
    const cli = bin(dir, env, ['render', '--role', 'specialist-batched', '--out', path.join(dir, '.state/cli'), '--diff-base', rangeBase, '--checklists', spec.checklists.join(','), '--stack', m.stack, '--test-fw', m.test_fw]);
    expect(cli.status, cli.stderr).toBe(0);
    expect(h.creates.find(c => c.title === 'ship x21p2 specialist-batched')!.prompt).toBe(fs.readFileSync(path.join(dir, '.state/cli/specialist-batched.prompt.md'), 'utf8'));
    expect(h.creates.find(c => c.title === 'ship x21p2 red-team')!.prompt).toContain('DIFF_BASE=' + rangeBase);
  }, 240_000);

  // Value: protects=the pass program dispatches the owner's granted fix-check from the plan, as decision 3.5 runs any fix-check, instead of PASS: none; fails_when=a recorded grant still prints PASS: none next=stop and the lane renders, sends and collects the fix-check by hand (C6-36 after-opus-grant);
  //   why_new=GST-967; seam=the pass program; no_claim=the fix-check reviewer's verdict
  test('GST-967: a recorded grant after the round-2 fix-check runs its one scoped fix-check through the program (GST-3562 A: a grant after a round-2 full pass buys none)', async () => {
    const { dir, env } = repo();
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
    const add = spawnSync(path.join(BIN, 'gstack-approvals'), ['add', '--ask', `Owner grant: one scoped fix-check after round 2 (review_loop_grant ${head.slice(0, 12)})`, '--words', 'one scoped fix-check after round 2', '--by', 'GStack Minder', '--scope', 'this /ship invocation', '--json'], { cwd: dir, env: { ...env, GSTACK_APPROVALS_MIRROR: '0' }, encoding: 'utf8', timeout: 60_000 });
    expect(add.status, add.stderr).toBe(0);
    const id = JSON.parse(add.stdout).added[0] as string;
    const files = path.join(dir, '.state/gfc');
    fs.mkdirSync(files, { recursive: true });
    const fc: Record<string, string> = {};
    for (const [k, v] of [['fix_list', '1. src/a.ts: guard v80\n'], ['hunks', 'diff --git a/src/a.ts b/src/a.ts\n+export const v81 = 81;\n'], ['tests', 'bun test: 3 pass, 0 fail\n'], ['callers', 'none\n']]) { fc[k] = path.join(files, k + '.txt'); fs.writeFileSync(fc[k]!, v!); }
    const h = host(dir, env);
    const res = await runPass(h, { base: 'main', out: path.join(dir, '.state/run/gfc'), pass: 'x30gfc', planFlags: ['--pass', '1', '--last', 'fix-check', '--fix-checks', '1', '--fixed-blocking', '--range-base', head, '--grant', id], fixCheck: fc, logStart: ['review-fix-check'] });
    expect(res).not.toContain('PASS: none');
    expect(res).toContain(`NEXT: fix-check (the owner's grant ${id}`);
    expect(h.creates.map(c => c.title)).toEqual(['ship x30gfc fix-check']);
    expect(res).toContain('NEXT: judge (Phase 4)');
  }, 240_000);

  // Value: protects=the Capy pass program runs a scoped repeat with no fix-check files, dispatches its Red Team and leaves the fix-check to Step 3.5 as GST-619 does on the CLI; fails_when=the program stops a scoped plan for missing files or creates a fix-check reader in the scoped manifest;
  //   why_new=#3670 Step 11 (adversarial 1, red team 1), re-scoped to GST-619's model in the merge of main; seam=none; no_claim=the Step 3.5 fix-check itself
  test('a scoped repeat runs without fixCheck files and leaves its fix-check to Step 3.5 (GST-619)', async () => {
    const { dir, env } = repo();
    const sh = (c: string) => spawnSync('bash', ['-c', c], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
    const rangeBase = sh('git rev-parse HEAD').stdout.trim();
    expect(sh('echo "export const fix = 1;" >> src/a.ts && git commit -qam fix').status).toBe(0);
    const planFlags = ['--pass', '1', '--last', 'full', '--fixed-blocking', '--pass1-depth', 'standard', '--range-base', rangeBase];
    const h = host(dir, env);
    const res = await runPass(h, { base: 'main', out: path.join(dir, '.state/run/s1'), pass: 'x22s1', diffBase: rangeBase, planFlags });
    expect(res).toContain('next=scoped');
    expect(res).not.toContain('STOP:');
    expect(res).toContain('FIX_CHECK: planned');
    expect(h.creates.map(c => c.title)).not.toContain('ship x22s1 fix-check');
    expect(h.creates.map(c => c.title)).toContain('ship x22s1 red-team');
  }, 240_000);

  // Value: protects=a scoped pass run through the Capy program as the driver now says, with no diffBase, gives the pending Step 11 voices the merge base and only the Red Team the fix range (GST-619); fails_when=the program sends a scoped pass a base of its own or the voices read the range before Step 11 ran;
  //   why_new=#3670 merge fix-check (row 454); the driver test "a scoped repeat pass passes no diffBase" is the failing-first half; seam=none; no_claim=an explicit --diff-base, which GST-619 lets win
  test('a scoped pass run as the driver says keeps the merge base for the Step 11 voices; only the Red Team reads the fix range', async () => {
    const { dir, env } = repo();
    const sh = (c: string) => spawnSync('bash', ['-c', c], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
    const mergeBase = sh('git merge-base main HEAD').stdout.trim();
    const rangeBase = sh('git rev-parse HEAD').stdout.trim();
    expect(sh('echo "export const fix = 2;" >> src/a.ts && git commit -qam fix').status).toBe(0);
    const out = path.join(dir, '.state/run/s2');
    const planFlags = ['--pass', '1', '--last', 'full', '--fixed-blocking', '--pass1-depth', 'standard', '--range-base', rangeBase];
    const res = await runPass(host(dir, env), { base: 'main', out, pass: 'x22s2', planFlags });
    expect(res).toContain('next=scoped');
    const m = JSON.parse(fs.readFileSync(path.join(out, 'pass-manifest.json'), 'utf8')) as { diff_base: string; readers: { role?: string; stage: string; diff_base?: string }[] };
    expect(m.diff_base).toBe(mergeBase);
    expect(m.readers.find(r => r.role === 'red-team')!.diff_base).toBe(rangeBase);
    const voices = m.readers.filter(r => r.stage === 'voices');
    expect(voices.length).toBeGreaterThan(0);
    for (const v of voices) expect(v.diff_base ?? m.diff_base).toBe(mergeBase);
  }, 240_000);

  // Value: protects=the program's final NEXT line survives a return that its reader outputs push to the 32 KB cap, and a pass whose out is not <run dir>/<pass dir> says it skipped the parts; fails_when=finish() cuts the tail line, the room ignores the parts trailer, or parts are skipped without a line;
  //   why_new=#3670 Step 11 (outside voice 2, adversarial 2 and 6); seam=none; no_claim=what the parent does with a capped return
  test('a near-cap return still ends with its NEXT line, and an odd out prints PARTS: skipped', async () => {
    const { dir, env } = repo();
    const out = path.join(dir, '.state/run/p1');
    fs.mkdirSync(path.join(dir, '.state/run/parts'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.state/run/parts/state.json'), JSON.stringify({ returned: [] }));
    const big = host(dir, env, { output: () => 'x'.repeat(15_900) + '\nNO FINDINGS' });
    const res = await runPass(big, { base: 'main', out, pass: 'x23p1', planFlags: ['--depth-floor', 'full'] });
    expect(res.length).toBeLessThanOrEqual(32000);
    expect(res.trimEnd().split('\n').at(-1)).toBe('NEXT: judge (Phase 4)');
    const odd = await runPass(host(dir, env), { base: 'main', out: path.join(dir, '.state/run/deep/p1'), pass: 'x23p2', planFlags: ['--depth-floor', 'full'] });
    expect(odd).toMatch(/^PARTS: skipped \(/m);
    expect(odd.trimEnd().split('\n').at(-1)).toBe('NEXT: judge (Phase 4)');
  }, 240_000);

  test('a plan with no reviewer pass dispatches nothing and passes NEXT through', async () => {
    const { dir, env } = repo();
    const h = host(dir, env);
    const res = await runPass(h, { base: 'main', out: path.join(dir, '.state/run/p2'), pass: 'x9p2', planFlags: ['--pass', '1', '--last', 'full'] });
    expect(res).toContain('PASS: none next=');
    expect(h.creates).toHaveLength(0);
  }, 120_000);
});
