/**
 * Merge trains for any repository (GSTA-157 PR 2): a base policy whose train block declares gates gates every
 * prefix T0..Tk on train-prefix/<nonce>/t<i> refs, classifies each prefix, attributes the first red prefix after a
 * green one, and lands slots through train land (direct at the pin, or update). Unit tests cover the pure pieces;
 * the rest run hermetic fixture repos with a bare origin and the train gh shim, wrapped here for run and job reads,
 * reruns, branch protection and merges. Command gates run through a fake ubi-runner (GSTACK_TRAIN_UBI_RUNNER) with
 * UBI_REAP=0, so nothing here reaches a cloud API.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { TRAIN_GATES_KEY_VERSION, validatePolicy } from '../lib/ship-policy';
import { baseRedAdmission, classifyPrefixes, classifyWorkflowRun, commandReservation, concurrencyKeyed, gatedChain, parseTestRecord } from '../lib/ship-queue-train-gate';
import { pushMatchesPrefix, workflowFacts } from '../lib/ship-queue-train-init';
import type { TrainSlot } from '../lib/ship-queue-train-record';
import { BASE_POLICY, cleanup } from './helpers/restamp-fixture';
import { line, nonceOf, openPr, queue, readyReceipt, repoKey, shippedBody, trainFixture, trainJson, TRAIN_POLICY, type TrainFixture } from './helpers/ship-queue-train-fixture';
import { runBin } from './helpers/restamp-fixture';

const WORKFLOWS_GATE = { kind: 'workflows', workflows: ['ci.yml'], required_jobs: ['ci.yml/test', 'ci.yml/lint'] };
const GENERIC = { gates: [WORKFLOWS_GATE], land: { merge_method: 'squash', required_checks: ['test'] }, max_size: 5, fill_hours: 3 };
const policyWith = (train: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ ...BASE_POLICY, queue_mode: 'claim-at-open', release_tool: null, release_outputs: [], train, min_gstack_version: TRAIN_GATES_KEY_VERSION, ...extra });
const fixtures: TrainFixture[] = [];
afterEach(() => { while (fixtures.length) cleanup(fixtures.pop()!.repo); });

/** Wrap the train gh shim with what generic trains read: run and job facts (per prefix plan), reruns, protection, merges and green checks by default. */
function wrap(fx: TrainFixture): void {
  const dir = path.join(fx.repo.root, 'gh-generic-wrap');
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(fx.repo.root, 'gh-train-shim', 'shim.js');
  fs.writeFileSync(path.join(dir, 'gh'), [
    '#!/usr/bin/env node',
    "const fs=require('fs');const cp=require('child_process');const D=process.env.GENERIC_WRAP_DATA;const a=process.argv.slice(2);",
    "const d=JSON.parse(fs.readFileSync(D,'utf8'));const save=()=>fs.writeFileSync(D,JSON.stringify(d));const out=v=>{d.log.push({cmd:a.slice(0,2).join(' '),args:a});save();console.log(JSON.stringify(v));process.exit(0)};",
    "const g=(...x)=>cp.execFileSync('git',['--git-dir',d.origin,...x],{encoding:'utf8',timeout:30000}).trim();",
    "const rev=r=>{try{return g('rev-parse','--verify','--quiet',r)}catch{return ''}};",
    "const plan=r=>(d.plan||{})[String(r.headBranch).split('/').pop()]||'green';",
    "const red=(r,n)=>plan(r)==='red'||(plan(r)==='flaky'&&n<2);",
    "const run=/^repos\\/[^/]+\\/[^/]+\\/actions\\/runs\\/(\\d+)$/.exec(a[1]||'');",
    "if(a[0]==='api'&&run){const r=d.runs.find(x=>String(x.databaseId)===run[1]);if(!r){console.error('HTTP 404');process.exit(1)}const n=r.run_attempt||1;out({status:r.status,conclusion:r.status!=='completed'?null:red(r,n)?'failure':'success',head_sha:r.headSha,event:r.event,run_attempt:n})}",
    "const jobs=/actions\\/runs\\/(\\d+)\\/attempts\\/(\\d+)\\/jobs/.exec(a[1]||'');",
    "if(a[0]==='api'&&jobs){const r=d.runs.find(x=>String(x.databaseId)===jobs[1]);const n=Number(jobs[2]);const names=d.jobNames||['test','lint'];",
    "  const list=names.map(name=>({name,conclusion:name==='test'&&red(r,n)?'failure':'success'}));out({total_count:list.length,jobs:n>1?list.filter(j=>j.name==='test'):list})}",
    "if(a[0]==='run'&&a[1]==='rerun'){const r=d.runs.find(x=>String(x.databaseId)===a[2]);r.run_attempt=(r.run_attempt||1)+1;d.log.push({cmd:'run rerun',args:a});save();process.exit(0)}",
    "if(a[0]==='api'&&/branches\\/main\\/protection\\/required_status_checks/.test(a[1]||'')){d.log.push({cmd:'api protection',args:a});save();if(!d.protection||d.protection==='404'){console.error(d.protection==='404'?'gh: Not Found (HTTP 404)':'gh: Branch not protected (HTTP 404)');process.exit(1)}console.log(JSON.stringify(d.protection));process.exit(0)}",
    "if(a[0]==='pr'&&a[1]==='list'){out(Object.entries(d.prs).filter(([,p])=>p.state==='OPEN').map(([n,p])=>({number:Number(n),headRefOid:p.headRefOid})))}",
    "if(a[0]==='api'&&/^repos\\/[^/{]+\\/[^/{]+$/.test(a[1]||'')){out(d.repoSettings||{allow_squash_merge:true,allow_merge_commit:true,allow_rebase_merge:false})}",
    "if(a[0]==='pr'&&a[1]==='view'&&d.prs[a[2]]){const p=d.prs[a[2]];const h=rev('refs/heads/'+p.headRefName);if(h)p.headRefOid=h;out(p)}",
    "if(a[0]==='pr'&&a[1]==='merge'){const p=d.prs[a[2]];const want=a[a.indexOf('--match-head-commit')+1];d.log.push({cmd:'pr merge',args:a});if(rev('refs/heads/'+p.headRefName)!==want){save();console.error('Head branch was modified');process.exit(1)}",
    "  const before=rev('main');const tree=g('merge-tree','--write-tree',before,want).split('\\n')[0];g('update-ref','refs/heads/main',g('commit-tree',tree,'-p',before,'-m','squash #'+a[2]));p.state='MERGED';save();process.exit(0)}",
    "const paged=/commits\\/([0-9a-f]+)\\/(check-runs|status)\\?.*page=(\\d+)/.exec(a[1]||'');",
    "if(a[0]==='api'&&paged&&!(d.ci||{})[paged[1]]){const list=paged[2]==='check-runs'?[{name:'test',status:'completed',conclusion:'success',id:1,completed_at:'2026-10-26T00:00:00Z'}]:[];const key=paged[2]==='check-runs'?'check_runs':'statuses';console.log(JSON.stringify(paged[3]==='1'?{total_count:list.length,state:'success',[key]:list}:{total_count:list.length,[key]:[]}));process.exit(0)}",
    "const r=cp.spawnSync('node',[" + JSON.stringify(shim) + ",D,...a],{stdio:'inherit',timeout:120000});process.exit(r.status??1);",
    '',
  ].join('\n'), { mode: 0o755 });
  fx.env.PATH = dir + ':' + fx.env.PATH;
  (fx.env as Record<string, string>).GENERIC_WRAP_DATA = fx.dataFile;
}

/** A fake ubi-runner: runs the remote command locally in --src, logs the forwarded names, reports left=0. */
function fakeUbi(fx: TrainFixture): string {
  const file = path.join(fx.repo.root, 'fake-ubi-runner.sh');
  const log = path.join(fx.repo.root, 'fake-ubi.log');
  fs.writeFileSync(file, [
    '#!/usr/bin/env bash',
    'set -u',
    '[ "$1" = run ] || exit 2; shift',
    'src=""; pass=""',
    'while [ "$#" -gt 0 ]; do case "$1" in --src) src="$2"; shift 2;; --pass) pass="$pass $2"; shift 2;; --) shift; break;; *) exit 2;; esac; done',
    'printf "run size=%s timeout=%s reap=%s pass=%s\\n" "$UBI_SIZE" "$UBI_RUN_TIMEOUT" "${UBI_REAP:-}" "$pass" >> ' + JSON.stringify(log),
    'cd "$src" || exit 2',
    'bash -c "$1"; code=$?',
    'echo "UBICLOUD: left=0"',
    'exit $code',
    '',
  ].join('\n'), { mode: 0o755 });
  Object.assign(fx.env, { GSTACK_TRAIN_UBI_RUNNER: file, UBI_OWNER: 'gsta157test', UBI_REAP: '0' });
  return log;
}

function genericTrain(train: Record<string, unknown> = GENERIC, extra: Record<string, unknown> = {}) {
  const fx = trainFixture(policyWith(train, extra), 'gstack-train-generic-'); fixtures.push(fx); wrap(fx);
  const pins: string[] = [];
  for (const pr of ['1', '2']) {
    const head = openPr(fx, pr, { changelog: false });
    fx.repo.git('push', '-q', 'origin', head + ':refs/heads/pr-' + pr);
    readyReceipt(fx, pr, head);
    pins.push(pr + '@' + head);
  }
  return { fx, pins: pins.join(',') };
}

const slot = (pr: string, extra: Partial<TrainSlot> = {}): TrainSlot => ({ pr, head: pr.repeat(40).slice(0, 40), ready_at: '2026-10-18T08:00:00.000Z', screen: { choice: 'no-screen', policy: null, nonce: null, run: null, merge_sha: null }, ...extra } as TrainSlot);
const P = (outcome: string, red: string[] = []) => ({ outcome: outcome as never, red });

describe('generic train policy', () => {
  const errs = (raw: Record<string, unknown>) => validatePolicy(raw, { gstackVersion: TRAIN_GATES_KEY_VERSION }).map(e => e.path + ': ' + e.message);
  test('gstack\'s own policy file parses unchanged as the gstack-evals kind', () => {
    const own = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', '.gstack', 'ship-policy.json'), 'utf8'));
    expect(validatePolicy(own)).toEqual([]);
    expect(own.train.gate_workflow).toBe('evals.yml');
    expect(own.train.gates).toBeUndefined();
  });
  test('history merge-only constrains only a train that declares land: a gstack-evals train without it still validates', () => {
    expect(validatePolicy({ ...TRAIN_POLICY, history: 'merge-only' })).toEqual([]);
    expect(errs(policyWith({ ...GENERIC, land: { merge_method: 'squash' } }, { history: 'merge-only' })).join('\n')).toContain('history merge-only allows only the merge method');
  });
  test('a train with gates validates, and needs min_gstack_version at the gates key version', () => {
    expect(errs(policyWith(GENERIC))).toEqual([]);
    expect(errs(policyWith(GENERIC, { min_gstack_version: '1.91.336.0' })).join('\n')).toContain('gates and land were introduced in gstack ' + TRAIN_GATES_KEY_VERSION);
  });
  test('gate and land shapes are checked strictly', () => {
    const bad = (train: Record<string, unknown>, extra: Record<string, unknown> = {}) => errs(policyWith({ ...GENERIC, ...train }, extra)).join('\n');
    expect(bad({ gate_workflow: 'evals.yml' })).toContain('train.gate_workflow: belongs to the gstack-evals gate');
    expect(bad({ land: undefined })).toMatch(/train\.land/);
    expect(bad({ gates: [{ ...WORKFLOWS_GATE, required_jobs: ['test'] }] })).toMatch(/required_jobs/);
    expect(bad({ gates: [{ ...WORKFLOWS_GATE, required_jobs: ['other.yml/test'] }] })).toMatch(/required_jobs/);
    expect(bad({ gates: [{ kind: 'command', command: 'bun test', timeout_sec: 30, spend_cap_usd: 2 }] })).toMatch(/timeout_sec/);
    expect(bad({ gates: [{ kind: 'command', command: 'bun test', timeout_sec: 600, spend_cap_usd: 101 }] })).toMatch(/spend_cap_usd/);
    expect(bad({ gates: [{ kind: 'command', command: 'bun test', timeout_sec: 600, spend_cap_usd: 2, pass_env: ['UBICLOUD_API_KEY'] }] })).toMatch(/pass_env/);
    expect(bad({ gates: [] })).toContain('train.gates: must be a list of 1-4 gates');
    expect(bad({ max_size: 6 })).toContain('train.max_size');
    expect(bad({ land: { merge_method: 'octopus' } })).toMatch(/merge_method/);
    expect(bad({}, { history: 'merge-only' })).toContain('history merge-only allows only the merge method');
  });
});

describe('prefix verdicts', () => {
  const slots = [slot('1'), slot('2'), slot('3')];
  test('green, attributed, red on main, unattributed, incomplete and pending', () => {
    expect(classifyPrefixes([P('GREEN'), P('GREEN'), P('GREEN'), P('GREEN')], slots)).toEqual({ kind: 'green', landable: 3, culprit: null });
    expect(classifyPrefixes([P('GREEN'), P('GREEN'), P('RED', ['x']), P('RED', ['x'])], slots)).toEqual({ kind: 'attributed', landable: 1, culprit: '2' });
    expect(classifyPrefixes([P('GREEN'), P('RED', ['x']), P('RED', ['x']), P('RED', ['x'])], slots)).toEqual({ kind: 'attributed', landable: 0, culprit: '1' });
    expect(classifyPrefixes([P('RED', ['x']), P('GREEN'), P('GREEN'), P('GREEN')], slots)).toMatchObject({ kind: 'red-on-main', landable: 0 });
    expect(classifyPrefixes([P('GREEN'), P('RED', ['x']), P('GREEN'), P('GREEN')], slots)).toMatchObject({ kind: 'unattributed', landable: 0 });
    expect(classifyPrefixes([P('GREEN'), P('GREEN'), P('INCOMPLETE'), P('RED')], slots)).toMatchObject({ kind: 'incomplete', landable: 0 });
    expect(classifyPrefixes([P('GREEN'), P('PENDING'), P('GREEN'), P('GREEN')], slots)).toEqual({ kind: 'pending' });
  });
  test('FIXES_BASE_RED allows T0 red on exactly its cases and nothing else', () => {
    const fixer = [slot('1', { fixes_base_red: ['ci.yml/test'] }), slot('2', { base_red: { cases: ['ci.yml/test'], fixer: '1', base: 'a'.repeat(40), expires_at: '2026-10-19T00:00:00Z' } })];
    expect(classifyPrefixes([P('RED', ['ci.yml/test']), P('GREEN'), P('GREEN')], fixer)).toMatchObject({ kind: 'green', landable: 2 });
    expect(classifyPrefixes([P('RED', ['ci.yml/test', 'ci.yml/lint']), P('GREEN'), P('GREEN')], fixer)).toMatchObject({ kind: 'red-on-main' });
    expect(classifyPrefixes([P('RED', ['ci.yml/test']), P('RED', ['ci.yml/test']), P('RED', ['ci.yml/test'])], fixer)).toMatchObject({ kind: 'attributed', culprit: '1', landable: 0 });
  });
  test('one workflow run is GREEN only at the prefix head, from the nonce dispatch, with every required job', () => {
    const run = { status: 'completed', conclusion: 'success', head_sha: 'h'.repeat(40), event: 'workflow_dispatch', run_attempt: 1 };
    const jobs = [{ name: 'test', conclusion: 'success' }, { name: 'lint', conclusion: 'success' }];
    const base = { run, head: 'h'.repeat(40), workflow: 'ci.yml', jobs, required: ['test', 'lint'] };
    expect(classifyWorkflowRun(base).outcome).toBe('GREEN');
    expect(classifyWorkflowRun({ ...base, run: { ...run, event: 'push' } }).outcome).toBe('INCOMPLETE');
    expect(classifyWorkflowRun({ ...base, head: 'g'.repeat(40) }).outcome).toBe('INCOMPLETE');
    expect(classifyWorkflowRun({ ...base, jobs: [jobs[0]!] }).detail).toContain('required job ci.yml/lint is missing');
    expect(classifyWorkflowRun({ ...base, jobs: [jobs[0]!, { name: 'lint', conclusion: 'skipped' }] }).outcome).toBe('INCOMPLETE');
    expect(classifyWorkflowRun({ ...base, run: { ...run, conclusion: 'failure' }, jobs: [{ name: 'test', conclusion: 'failure' }, jobs[1]!] })).toMatchObject({ outcome: 'RED', red: ['ci.yml/test'] });
    expect(classifyWorkflowRun({ ...base, record: { executed: 0, failed: [] } }).detail).toContain('no executed test');
    expect(classifyWorkflowRun({ ...base, record: null }).detail).toContain('record artifact is missing');
    expect(classifyWorkflowRun({ ...base, run: { ...run, status: 'in_progress', conclusion: null } }).outcome).toBe('PENDING');
  });
  test('test records: JUnit and JSON, skips not counted', () => {
    const xml = '<testsuite><testcase classname="a" name="ok"/><testcase classname="a" name="bad"><failure/></testcase><testcase name="s"><skipped/></testcase></testsuite>';
    expect(parseTestRecord([{ name: 'r.xml', text: xml }])).toEqual({ executed: 2, failed: ['a.bad'] });
    expect(parseTestRecord([{ name: 'r.json', text: JSON.stringify({ tests: [{ id: 'x', status: 'pass' }, { id: 'y', status: 'fail' }, { id: 'z', status: 'skip' }] }) }])).toEqual({ executed: 2, failed: ['y'] });
    expect(parseTestRecord([{ name: 'r.txt', text: '' }])).toBeNull();
  });
  test('gated refs and the command price', () => {
    const prefixes = [0, 1, 2].map(index => ({ index, commit: String(index).repeat(40), tree: 't'.repeat(40) }));
    expect(gatedChain('n1', prefixes as never).map(p => p.ref)).toEqual(['train-prefix/n1/t0', 'train-prefix/n1/t1', 'train-prefix/n1/t2']);
    expect(gatedChain('n1', prefixes as never, [{ commit: 's'.repeat(40), tree: 'u'.repeat(40) }, { commit: 'r'.repeat(40), tree: 'v'.repeat(40) }]).map(p => p.ref)).toEqual(['train-prefix/n1/t0', 'train-prefix/n1/s1', 'train-prefix/n1/s2']);
    expect(commandReservation({ kind: 'command', command: 'x', timeout_sec: 60, spend_cap_usd: 1 })).toBe(0.1);
    expect(commandReservation({ kind: 'command', command: 'x', timeout_sec: 1800, spend_cap_usd: 1 })).toBe(0.34);
  });
});

describe('base-red admission', () => {
  const cond = (fixer: string, expires = '2099-01-01T00:00:00Z') => ({ base_red: { cases: ['ci.yml/test'], fixer, base: 'a'.repeat(40), expires_at: expires } });
  test('the fixer moves to slot 1; its conditional PRs ride behind it', () => {
    const r = baseRedAdmission([slot('5', cond('7')), slot('7', { fixes_base_red: ['ci.yml/test'] })], true, false);
    expect('slots' in r && r.slots.map(s => s.pr)).toEqual(['7', '5']);
  });
  test('refusals: a gstack-evals train, an explicit order away from slot 1, two fixers, no fixer, a conditional fixer, an expired condition', () => {
    const code = (r: ReturnType<typeof baseRedAdmission>) => ('code' in r ? r.code + ' ' + r.message : 'admitted');
    expect(code(baseRedAdmission([slot('7', { fixes_base_red: ['x'] })], false, false))).toMatch(/^QUEUE_TRAIN_BASE_RED .*gstack-evals train gates only its tip/);
    expect(code(baseRedAdmission([slot('5', cond('7')), slot('7', { fixes_base_red: ['x'] })], true, true))).toMatch(/--order seats it at slot 2/);
    expect(code(baseRedAdmission([slot('7', { fixes_base_red: ['x'] }), slot('8', { fixes_base_red: ['y'] })], true, false))).toMatch(/one train carries one fixer/);
    expect(code(baseRedAdmission([slot('1'), slot('5', cond('7'))], true, false))).toMatch(/conditional on fixer #7, which is not in this train/);
    expect(code(baseRedAdmission([slot('7', { fixes_base_red: ['x'], ...cond('7') })], true, false))).toMatch(/a fixer's own head must be green/);
    expect(code(baseRedAdmission([slot('7', { fixes_base_red: ['x'] }), slot('5', cond('7', '2026-01-01T00:00:00Z'))], true, false))).toMatch(/expired/);
    expect(code(baseRedAdmission([slot('7', { fixes_base_red: ['x'] }), slot('5', cond('7', 'not a date'))], true, false))).toMatch(/expired/);
    expect(code(baseRedAdmission([slot('1'), slot('2')], false, false))).toBe('admitted');
  });
});

describe('train init: workflow facts', () => {
  test('push triggers that match train-prefix/ refs, and keyed concurrency', () => {
    expect(pushMatchesPrefix('on:\n  push:\n  pull_request:\n')).toBe(true);
    expect(pushMatchesPrefix('on: [push, pull_request]\n')).toBe(true);
    expect(pushMatchesPrefix('on:\n  push:\n    branches: [main]\n')).toBe(false);
    expect(pushMatchesPrefix("on:\n  push:\n    branches:\n      - '**'\n")).toBe(true);
    expect(pushMatchesPrefix("on:\n  push:\n    branches-ignore: ['train-prefix/**']\n")).toBe(false);
    expect(pushMatchesPrefix('on:\n  pull_request:\n  workflow_dispatch:\n')).toBe(false);
    expect(concurrencyKeyed('concurrency:\n  group: ci-${{ github.ref }}\n')).toBe(true);
    expect(concurrencyKeyed('concurrency: ci\n')).toBe(false);
    expect(concurrencyKeyed('concurrency:\n  group: ci-${{ github.head_ref }}\n')).toBe(false);
    expect(concurrencyKeyed('concurrency:\n  group: ci-${{ github.head_ref || github.run_id }}\n')).toBe(true);
  });
  test('jobs (with matrix names), nonce input and run-name', () => {
    const yaml = [
      'name: CI', 'on:', '  workflow_dispatch:', '    inputs:', "      nonce: { required: false, type: string }",
      "run-name: ${{ inputs.nonce && format('{0} [eval-bg {1}]', github.workflow, inputs.nonce) || github.workflow }}",
      'concurrency:', '  group: ${{ github.workflow }}-${{ github.ref }}',
      'jobs:', '  test:', '    name: unit tests', '    strategy:', '      matrix:', '        os: [a, b]', '  lint:', '    runs-on: x', '',
    ].join('\n');
    const w = workflowFacts('ci.yml', yaml);
    expect(w).toMatchObject({ name: 'CI', nonce: true, runName: true, keyed: true, pushMatchesPrefix: false });
    expect(w.jobs).toEqual([{ id: 'test', name: 'unit tests', matrix: true }, { id: 'lint', name: 'lint', matrix: false }]);
  });
});

describe('generic trains end to end (fixture repos)', () => {
  test('workflows gate: every prefix dispatched by nonce, GREEN, then land direct at each pin (no strict protection)', () => {
    const { fx, pins } = genericTrain();
    const built = queue(fx, ['train', 'build', '--prs', pins]);
    expect(built.status, built.err + built.out).toBe(EXIT.ok);
    const nonce = nonceOf(built.out);
    const t = trainJson(fx, nonce);
    expect(t.gated.map((p: any) => p.ref)).toEqual([0, 1, 2].map(i => 'train-prefix/' + nonce + '/t' + i));
    expect(t.branch).toBe('train-prefix/' + nonce + '/t2');
    const sent = fx.read().log.filter(l => l.cmd === 'workflow run');
    expect(sent.map(l => l.ref)).toEqual(t.gated.map((p: any) => p.ref));
    expect(sent.every(l => (l.workflow as string) === 'ci.yml' && /^gate\./.test((l.inputs as any).nonce))).toBe(true);
    expect(fx.read().log.some(l => l.cmd === 'workflow run' && (l.workflow as string) === 'evals.yml')).toBe(false);
    const verdict = queue(fx, ['train', 'verdict', '--train', nonce]);
    expect(verdict.status, verdict.err).toBe(EXIT.ok);
    expect(line(verdict.out, 'VERDICT:')).toBe('VERDICT: GREEN train ' + nonce + ' landable=2/2');
    expect(line(verdict.out, 'NEXT:')).toBe('NEXT: gstack-ship-queue train land --train ' + nonce + ' --pr 1');
    const one = queue(fx, ['train', 'land', '--train', nonce, '--pr', '1', '--no-wait']);
    expect(one.status, one.err + one.out).toBe(EXIT.ok);
    expect(one.out).toMatch(/^MODE: direct /m);
    const origin = (...x: string[]) => fx.repo.git('--git-dir', fx.repo.origin, ...x);
    expect(origin('rev-parse', 'main^{tree}')).toBe(t.gated[1].tree);
    const two = queue(fx, ['train', 'land', '--train', nonce, '--pr', '2', '--no-wait']);
    expect(two.status, two.err + two.out).toBe(EXIT.ok);
    expect(origin('rev-parse', 'main^{tree}')).toBe(t.gated[2].tree);
    expect(trainJson(fx, nonce)).toMatchObject({ state: 'merged', landing: { 1: { mode: 'direct', update: null }, 2: { mode: 'direct' } } });
    const merges = fx.read().log.filter(l => l.cmd === 'pr merge').map(l => (l.args as string[]).join(' '));
    expect(merges[0]).toMatch(/^pr merge 1 --squash --match-head-commit [0-9a-f]{40}$/);
  }, 300_000);

  test('strict protection forces update; a rebase method refuses it; a fork head is refused', () => {
    const { fx, pins } = genericTrain();
    fx.write(d => { (d as any).protection = { strict: true, contexts: ['test'] }; });
    const nonce = nonceOf(queue(fx, ['train', 'build', '--prs', pins]).out);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const pushed = queue(fx, ['train', 'land', '--train', nonce, '--pr', '1', '--no-wait']);
    expect(pushed.out, pushed.err).toMatch(/^MODE: update \(branch protection requires branches to be up to date\)/m);
    expect(pushed.out).not.toContain('LABEL: evals-no-debounce');
    const rec = trainJson(fx, nonce);
    expect(rec.landing['1']).toMatchObject({ mode: 'update', update: expect.stringMatching(/^[0-9a-f]{40}$/) });
    const merged = queue(fx, ['train', 'land', '--train', nonce, '--pr', '1', '--no-wait']);
    expect(merged.status, merged.err + merged.out).toBe(EXIT.ok);
    expect(fx.repo.git('--git-dir', fx.repo.origin, 'rev-parse', 'main^{tree}')).toBe(rec.gated[1].tree);

    const hidden = genericTrain();
    hidden.fx.write(d => { (d as any).protection = '404'; });
    const n4 = nonceOf(queue(hidden.fx, ['train', 'build', '--prs', hidden.pins]).out);
    queue(hidden.fx, ['train', 'verdict', '--train', n4]);
    const unreadable = queue(hidden.fx, ['train', 'land', '--train', n4, '--pr', '1', '--no-wait']);
    expect(unreadable.out, unreadable.err).toMatch(/^MODE: update \(branch protection could not be read/m);

    const rebase = genericTrain({ ...GENERIC, land: { merge_method: 'rebase', required_checks: ['test'] } });
    rebase.fx.write(d => { (d as any).protection = { strict: true, contexts: ['test'] }; });
    const n2 = nonceOf(queue(rebase.fx, ['train', 'build', '--prs', rebase.pins]).out);
    queue(rebase.fx, ['train', 'verdict', '--train', n2]);
    const refused = queue(rebase.fx, ['train', 'land', '--train', n2, '--pr', '1', '--no-wait']);
    expect(refused.err).toContain('(QUEUE_TRAIN_LAND_METHOD)');
    expect(rebase.fx.read().log.some(l => l.cmd === 'pr merge')).toBe(false);
    const loose = genericTrain({ ...GENERIC, land: { merge_method: 'rebase', required_checks: ['test'] } });
    const n5 = nonceOf(queue(loose.fx, ['train', 'build', '--prs', loose.pins]).out);
    queue(loose.fx, ['train', 'verdict', '--train', n5]);
    const replay = queue(loose.fx, ['train', 'land', '--train', n5, '--pr', '1', '--no-wait']);
    expect(replay.err, replay.out).toContain('(QUEUE_TRAIN_LAND_METHOD)');
    expect(replay.err).toContain('a rebase replays the pin');
    expect(loose.fx.read().log.some(l => l.cmd === 'pr merge')).toBe(false);

    const fork = genericTrain();
    const n3 = nonceOf(queue(fork.fx, ['train', 'build', '--prs', fork.pins]).out);
    queue(fork.fx, ['train', 'verdict', '--train', n3]);
    fork.fx.write(d => { (d.prs['1'] as any).isCrossRepository = true; });
    expect(queue(fork.fx, ['train', 'land', '--train', n3, '--pr', '1', '--no-wait']).err).toContain('(QUEUE_TRAIN_UNTRUSTED)');
  }, 300_000);

  test('a red prefix after a green one names its slot; the earlier slot may land; the culprit is refused; bisect is refused', () => {
    const { fx, pins } = genericTrain();
    fx.write(d => { (d as any).plan = { t2: 'red' }; });
    const nonce = nonceOf(queue(fx, ['train', 'build', '--prs', pins]).out);
    const first = queue(fx, ['train', 'verdict', '--train', nonce]);
    expect(first.status).toBe(EXIT.refused);
    expect(first.err).toContain('(QUEUE_TRAIN_PENDING)');
    expect(fx.read().log.filter(l => l.cmd === 'run rerun')).toHaveLength(1);
    const v = queue(fx, ['train', 'verdict', '--train', nonce]);
    expect(v.err).toContain('(QUEUE_TRAIN_RED)');
    expect(line(v.out, 'VERDICT:')).toBe('VERDICT: ATTRIBUTED train ' + nonce + ' landable=1/2 culprit=#2');
    expect(line(v.out, 'PREFIX: T2')).toContain('red=ci.yml/test');
    expect(queue(fx, ['train', 'prune', '--train', nonce]).out).toContain('#1 landable, not merged');
    expect(fx.repo.git('--git-dir', fx.repo.origin, 'rev-parse', '--verify', '--quiet', 'refs/heads/' + trainJson(fx, nonce).branch)).toMatch(/^[0-9a-f]{40}$/);
    expect(queue(fx, ['train', 'land', '--train', nonce, '--pr', '2', '--no-wait']).err).toContain('(QUEUE_GATE_MISSING)');
    expect(queue(fx, ['train', 'land', '--train', nonce, '--pr', '1', '--no-wait']).status).toBe(EXIT.ok);
    expect(queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '5']).err).toContain('(QUEUE_TRAIN_REBUILD_REFUSED)');
  }, 300_000);

  test('a red that passes on the one rerun is GREEN with a FLAKY line; T0 red is red on main', () => {
    const { fx, pins } = genericTrain();
    fx.write(d => { (d as any).plan = { t1: 'flaky' }; });
    const nonce = nonceOf(queue(fx, ['train', 'build', '--prs', pins]).out);
    queue(fx, ['train', 'verdict', '--train', nonce]);
    const v = queue(fx, ['train', 'verdict', '--train', nonce]);
    expect(v.status, v.err).toBe(EXIT.ok);
    expect(line(v.out, 'FLAKY: T1')).toContain('ci.yml/test');
    expect(trainJson(fx, nonce).verdict).toMatchObject({ kind: 'green', landable: 2 });

    const main = genericTrain();
    main.fx.write(d => { (d as any).plan = { t0: 'red', t1: 'red', t2: 'red' }; });
    const n2 = nonceOf(queue(main.fx, ['train', 'build', '--prs', main.pins]).out);
    queue(main.fx, ['train', 'verdict', '--train', n2]);
    const red = queue(main.fx, ['train', 'verdict', '--train', n2]);
    expect(red.err).toContain('(QUEUE_TRAIN_RED_ON_MAIN)');
    expect(line(red.out, 'NEXT:')).toMatch(/^NEXT: fix forward on main first/);
  }, 300_000);

  test('command gate: a clean checkout on the (fake) VM per prefix, tree checked, UBI_REAP=0 forwarded, culprit named; the spend cap refuses', () => {
    const gate = { kind: 'command', command: 'test ! -f pr-2.txt', timeout_sec: 60, spend_cap_usd: 1, pass_env: ['FIXTURE_TOKEN'] };
    const { fx, pins } = genericTrain({ ...GENERIC, gates: [gate] });
    const log = fakeUbi(fx);
    const built = queue(fx, ['train', 'build', '--prs', pins]);
    expect(built.status, built.err + built.out).toBe(EXIT.ok);
    const ran = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(ran.length).toBe(4);
    expect(ran.every(l => l === 'run size=standard-16 timeout=60 reap=0 pass= FIXTURE_TOKEN')).toBe(true);
    const nonce = nonceOf(built.out);
    const v = queue(fx, ['train', 'verdict', '--train', nonce]);
    expect(line(v.out, 'VERDICT:')).toBe('VERDICT: ATTRIBUTED train ' + nonce + ' landable=1/2 culprit=#2');
    expect(line(v.out, 'PREFIX: T2')).toContain('red twice');

    const capped = genericTrain({ ...GENERIC, gates: [{ ...gate, command: 'true', spend_cap_usd: 0.25 }] });
    fakeUbi(capped.fx);
    const refused = queue(capped.fx, ['train', 'build', '--prs', capped.pins]);
    expect(refused.err).toContain('(QUEUE_TRAIN_SPEND_CAP)');
    expect(refused.err).toContain('on T2 reserves $0.10');

    const owner = genericTrain({ ...GENERIC, gates: [gate] });
    fakeUbi(owner.fx);
    const noOwner = queue(owner.fx, ['train', 'build', '--prs', owner.pins], { UBI_OWNER: '' });
    expect(noOwner.err).toContain('UBI_OWNER is not set');
  }, 300_000);

  test('base-red: a conditional READY without its fixer at slot 1 never seats; ready --base-red needs --no-screen', () => {
    const { fx, pins } = genericTrain();
    const head2 = pins.split(',')[1]!.split('@')[1]!;
    const file = path.join(fx.state, 'ship-queue', 'ready', repoKey(fx), '2-' + head2 + '.json');
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...r, base_red: { cases: ['ci.yml/test'], fixer: '9', base: r.base_sha, expires_at: '2026-10-19T00:00:00Z' } }));
    const refused = queue(fx, ['train', 'build', '--prs', pins]);
    expect(refused.err).toContain('(QUEUE_TRAIN_BASE_RED)');
    expect(refused.err).toContain('conditional on fixer #9');
    expect(fx.read().log.some(l => l.cmd === 'workflow run')).toBe(false);

    const evals = trainFixture(undefined, 'gstack-train-generic-'); fixtures.push(evals);
    const usage = queue(evals, ['ready', '--pr', '1', '--base-red', '--fixer', '7']);
    expect(usage.status).toBe(EXIT.usage);
    expect(usage.err).toContain('a base-red READY is --no-screen');
  }, 300_000);
});

const readyFile = (fx: TrainFixture, pr: string, head: string) => path.join(fx.state, 'ship-queue', 'ready', repoKey(fx), pr + '-' + head + '.json');
const patchReady = (fx: TrainFixture, pr: string, head: string, extra: Record<string, unknown>) => {
  const file = readyFile(fx, pr, head);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...extra }));
};
const RECEIPT_RED = (base: string) => ({ cases: ['ci.yml/test'], files: ['test/a.test.ts'], base, lane: 'gsta157', expires_at: '2026-10-19T00:00:00Z' });

describe('base-red READYs and their train', () => {
  test('ready --base-red writes a conditional READY only for a paused receipt at the current base; a gstack-evals train refuses it', () => {
    const fx = trainFixture(policyWith(GENERIC), 'gstack-train-generic-'); fixtures.push(fx); wrap(fx);
    const head = openPr(fx, '5', { changelog: false });
    const base = fx.repo.git('rev-parse', 'origin/main');
    const plain = queue(fx, ['ready', '--pr', '5', '--no-screen', '--base-red', '--fixer', '7']);
    expect(plain.err).toContain('(SHIP_BASE_RED_FIXER)');
    fx.write(d => { (d.prs['5'] as any).body = shippedBody('5', head, { base_red: RECEIPT_RED('f'.repeat(40)) } as never); });
    const moved = queue(fx, ['ready', '--pr', '5', '--no-screen', '--base-red', '--fixer', '7']);
    expect(moved.err).toMatch(/a base move reclassifies, never trusts.*\(SHIP_BASE_RED_FIXER\)/);
    fx.write(d => { (d.prs['5'] as any).body = shippedBody('5', head, { base_red: RECEIPT_RED(base) } as never); });
    const ok = queue(fx, ['ready', '--pr', '5', '--no-screen', '--base-red', '--fixer', '7']);
    expect(ok.status, ok.err + ok.out).toBe(EXIT.ok);
    expect(ok.out).toContain('READY #5 ' + head + ' CONDITIONAL');
    expect(line(ok.out, 'BASE_RED:')).toContain('fixer=#7');
    expect(JSON.parse(fs.readFileSync(readyFile(fx, '5', head), 'utf8')).base_red).toEqual({ cases: ['ci.yml/test'], fixer: '7', base, expires_at: '2026-10-19T00:00:00Z' });

    const evals = trainFixture(undefined, 'gstack-train-generic-'); fixtures.push(evals);
    openPr(evals, '5', { changelog: false });
    expect(queue(evals, ['ready', '--pr', '5', '--no-screen', '--base-red', '--fixer', '7']).err).toContain('(QUEUE_BASE_RED_NO_TRAIN)');
  }, 300_000);

  test('a fixer at slot 1 lets T0 be red on exactly its cases; the conditional slot lands only through an update commit; watch --land lands every landable slot', () => {
    const fx = trainFixture(policyWith(GENERIC), 'gstack-train-generic-'); fixtures.push(fx); wrap(fx);
    const base = fx.repo.git('rev-parse', 'origin/main');
    const h5 = openPr(fx, '5', { changelog: false });
    const h7 = openPr(fx, '7', { changelog: false });
    for (const [pr, h] of [['5', h5], ['7', h7]] as const) { fx.repo.git('push', '-q', 'origin', h + ':refs/heads/pr-' + pr); readyReceipt(fx, pr, h); }
    fx.write(d => { (d.prs['5'] as any).body = shippedBody('5', h5, { base_red: RECEIPT_RED(base) } as never); (d as any).plan = { t0: 'red' }; });
    patchReady(fx, '5', h5, { base_red: { cases: ['ci.yml/test'], fixer: '7', base, expires_at: '2026-10-19T00:00:00Z' } });
    patchReady(fx, '7', h7, { fixes_base_red: ['ci.yml/test'] });
    const built = queue(fx, ['train', 'build', '--prs', '5@' + h5 + ',7@' + h7]);
    expect(built.status, built.err + built.out).toBe(EXIT.ok);
    expect(line(built.out, 'ORDER:')).toMatch(/^ORDER: 1:#7\(unscreened\) 2:#5/);
    expect(line(built.out, 'BASE_RED:')).toContain('fixer #7 at slot 1');
    const nonce = nonceOf(built.out);
    const watched = queue(fx, ['train', 'watch', '--train', nonce, '--land', '--timeout', '120']);
    expect(watched.status, watched.err + watched.out).toBe(EXIT.ok);
    expect(watched.out).toContain('VERDICT: GREEN train ' + nonce + ' landable=2/2');
    expect(watched.out).toMatch(/^MODE: direct /m);
    expect(watched.out).toMatch(/^MODE: update \(a conditional \(base-red\) PR lands only through a commit/m);
    const t = trainJson(fx, nonce);
    expect(t.landing['7'].mode).toBe('direct');
    expect(t.landing['5'].mode).toBe('update');
    expect(t.state).toBe('merged');
    expect(fx.repo.git('--git-dir', fx.repo.origin, 'rev-parse', 'main^{tree}')).toBe(t.gated[2].tree);
  }, 300_000);
});

describe('train init and doctor', () => {
  const CI = (extra: string[] = []) => ['name: CI', 'on:', '  push:', '  pull_request:', ...extra, 'concurrency: ci', 'jobs:', '  test:', '    runs-on: x', '  lint:', '    runs-on: x', ''].join('\n');
  function initFixture(policy: Record<string, unknown>, workflow: string) {
    const fx = trainFixture(policy, 'gstack-train-init-'); fixtures.push(fx); wrap(fx);
    fs.mkdirSync(path.join(fx.repo.work, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(fx.repo.work, '.github', 'workflows', 'ci.yml'), workflow);
    fx.repo.git('add', '-A'); fx.repo.git('commit', '-q', '-m', 'ci'); fx.repo.git('push', '-q', 'origin', 'HEAD:main');
    fx.write(d => { (d as any).protection = { strict: false, contexts: ['test', 'lint', 'deploy/preview'] }; });
    return fx;
  }
  const PLAIN = { ...BASE_POLICY, queue_mode: 'claim-at-open', release_tool: null, release_outputs: [] };

  test('init maps required checks to workflow jobs, prints the block, the snippet and warnings, and writes nothing', () => {
    const fx = initFixture(PLAIN, CI());
    openPr(fx, '1', { changelog: false });
    const before = fx.repo.git('--git-dir', fx.repo.origin, 'rev-parse', 'main');
    const r = queue(fx, ['train', 'init']);
    expect(r.status, r.err + r.out).toBe(EXIT.ok);
    expect(r.out).toContain('"required_jobs": [');
    expect(r.out).toContain('"ci.yml/test"');
    expect(r.out).toContain('"min_gstack_version": "' + TRAIN_GATES_KEY_VERSION + '"');
    expect(line(r.out, 'UNMAPPED:')).toContain('"deploy/preview"');
    expect(r.out).toContain('WARN: ci.yml: a push trigger matches train-prefix/ refs');
    expect(r.out).toContain('WARN: ci.yml: a concurrency group not keyed by ref');
    expect(r.out).toContain('WARN: ci.yml: no workflow_dispatch input named nonce');
    expect(line(r.out, 'LAND_MODE:')).toMatch(/^LAND_MODE: direct /);
    expect(fx.repo.git('--git-dir', fx.repo.origin, 'rev-parse', 'main')).toBe(before);
    fx.write(d => { (d as any).protection = { strict: true, contexts: ['test'] }; });
    expect(line(queue(fx, ['train', 'init']).out, 'LAND_MODE:')).toMatch(/^LAND_MODE: update for every slot \(branch protection requires/);
  }, 300_000);

  test('init prices a command gate for a full train and one rerun; doctor flags a cap below a full train', () => {
    const fx = initFixture(PLAIN, CI());
    const r = queue(fx, ['train', 'init', '--command', 'bun test']);
    expect(r.status, r.err + r.out).toBe(EXIT.ok);
    expect(r.out).toContain('"spend_cap_usd": 3');
    expect(r.out).not.toContain('WARN: --spend-cap');
    expect(queue(fx, ['train', 'init', '--command', 'bun test', '--spend-cap', '1']).out).toContain('WARN: --spend-cap $1 is below $2.38');
    const low = initFixture(policyWith({ ...GENERIC, gates: [{ kind: 'command', command: 'bun test', timeout_sec: 1800, spend_cap_usd: 1 }] }), CI());
    expect(queue(low, ['train', 'doctor']).out).toContain('command gate cap $1 is below $2.04');
  }, 300_000);

  test('init refuses version-bumping PRs without changelog_fragments or stamp-at-merge, and recommends fragments either way', () => {
    const fx = initFixture(PLAIN, CI());
    openPr(fx, '2', { file: 'VERSION', text: '1.2.4.0\n', changelog: false });
    const refused = queue(fx, ['train', 'init']);
    expect(refused.err).toContain('(QUEUE_TRAIN_INIT_REFUSED)');
    expect(line(refused.out, 'VERSION_PRS:')).toContain('#2 bump the version');
    expect(line(refused.out, 'RECOMMEND:')).toContain('changelog_fragments');
    const stamps = initFixture({ ...PLAIN, queue_mode: 'stamp-at-merge', release_tool: 'node gen.js', release_outputs: ['generated/**'] }, CI());
    openPr(stamps, '2', { file: 'VERSION', text: '1.2.4.0\n', changelog: false });
    const ok = queue(stamps, ['train', 'init']);
    expect(ok.status, ok.err + ok.out).toBe(EXIT.ok);
    expect(line(ok.out, 'RECOMMEND:')).toContain('changelog_fragments');
  }, 300_000);

  test('doctor reports every finding on a live block, and none once the workflow follows the snippet and is green on main', () => {
    const fx = initFixture(policyWith(GENERIC), CI());
    const bad = queue(fx, ['train', 'doctor']);
    expect(bad.status).toBe(EXIT.fail);
    expect(bad.err).toContain('(QUEUE_TRAIN_DOCTOR_FINDINGS)');
    for (const f of ['no workflow_dispatch input named nonce', 'run-name does not name', 'not keyed by ref', 'push trigger matches train-prefix/', 'never green on main']) expect(bad.out).toContain(f);
    const good = [
      'name: CI', 'on:', '  push:', '    branches: [main]', '  pull_request:', '  workflow_dispatch:', '    inputs:', "      nonce: { description: 'n', required: false, type: string }",
      "run-name: ${{ inputs.nonce && format('{0} [eval-bg {1}]', github.workflow, inputs.nonce) || github.workflow }}",
      'concurrency:', "  group: ${{ github.workflow }}-${{ github.ref }}", 'jobs:', '  test:', '    runs-on: x', '  lint:', '    runs-on: x', '',
    ].join('\n');
    fs.writeFileSync(path.join(fx.repo.work, '.github', 'workflows', 'ci.yml'), good);
    fx.repo.git('checkout', '-q', 'main'); fx.repo.git('add', '-A'); fx.repo.git('commit', '-q', '-m', 'snippet'); fx.repo.git('push', '-q', 'origin', 'HEAD:main');
    fx.write(d => { d.runs.push({ databaseId: 9, workflow: 'ci.yml', headBranch: 'main', status: 'completed', conclusion: 'success', event: 'push' }); });
    const clean = queue(fx, ['train', 'doctor']);
    expect(clean.status, clean.err + clean.out).toBe(EXIT.ok);
    expect(clean.out).toContain('DOCTOR: no findings');
    void runBin;
  }, 300_000);
});

describe('a workflows gate and a command gate together (round-2 High 3)', () => {
  const mixed = (command: string) => ({ ...GENERIC, gates: [WORKFLOWS_GATE, { kind: 'command', command, timeout_sec: 60, spend_cap_usd: 1 }] });
  const run = (command: string, plan: Record<string, string> = {}) => {
    const { fx, pins } = genericTrain(mixed(command));
    const log = fakeUbi(fx);
    fx.write(d => { (d as any).plan = plan; });
    const built = queue(fx, ['train', 'build', '--prs', pins]);
    expect(built.status, built.err + built.out).toBe(EXIT.ok);
    const nonce = nonceOf(built.out);
    expect(fx.read().log.filter(l => l.cmd === 'workflow run')).toHaveLength(3);
    expect(fs.readFileSync(log, 'utf8').trim().split('\n').every(l => l.includes('reap=0'))).toBe(true);
    queue(fx, ['train', 'verdict', '--train', nonce]);
    return { fx, nonce, v: queue(fx, ['train', 'verdict', '--train', nonce]) };
  };
  test('both gates green on every prefix: GREEN', () => {
    const { fx, nonce, v } = run('true');
    expect(v.status, v.err + v.out).toBe(EXIT.ok);
    expect(line(v.out, 'VERDICT:')).toBe('VERDICT: GREEN train ' + nonce + ' landable=2/2');
    expect(line(v.out, 'PREFIX: T2')).toMatch(/ci\.yml: 2 required job\(s\) green; command: exit 0/);
    expect(trainJson(fx, nonce).verdict.kind).toBe('green');
  }, 300_000);
  test('the command gate red on T2 with the workflows gate green: T2 is red and #2 is the culprit', () => {
    const { nonce, v } = run('test ! -f pr-2.txt');
    expect(v.err).toContain('(QUEUE_TRAIN_RED)');
    expect(line(v.out, 'PREFIX: T2')).toMatch(/^PREFIX: T2 RED .* red=command:1 /);
    expect(line(v.out, 'PREFIX: T1')).toMatch(/^PREFIX: T1 GREEN /);
    expect(line(v.out, 'VERDICT:')).toBe('VERDICT: ATTRIBUTED train ' + nonce + ' landable=1/2 culprit=#2');
  }, 300_000);
  test('the workflows gate red on T2 with the command gate green: T2 is red the same way', () => {
    const { nonce, v } = run('true', { t2: 'red' });
    expect(line(v.out, 'PREFIX: T2')).toMatch(/^PREFIX: T2 RED .* red=ci\.yml\/test /);
    expect(line(v.out, 'VERDICT:')).toBe('VERDICT: ATTRIBUTED train ' + nonce + ' landable=1/2 culprit=#2');
  }, 300_000);
  test('the command gate INCOMPLETE (timed out) with the workflows gate green: never GREEN, nothing landable', () => {
    const { fx, nonce, v } = run('exit 124');
    expect(v.err).toContain('(QUEUE_TRAIN_INCOMPLETE)');
    expect(line(v.out, 'VERDICT:')).toBe('VERDICT: INCOMPLETE train ' + nonce + ' landable=0/2');
    expect(line(v.out, 'PREFIX: T0')).toMatch(/^PREFIX: T0 INCOMPLETE .*command: the command timed out/);
    expect(queue(fx, ['train', 'land', '--train', nonce, '--pr', '1', '--no-wait']).err).toContain('(QUEUE_GATE_MISSING)');
    const again = queue(fx, ['train', 'build', '--prs', trainJson(fx, nonce).slots.map((s: any) => s.pr + '@' + s.head).join(',')]);
    expect(nonceOf(again.out), again.err + again.out).not.toBe('');
    expect(nonceOf(again.out)).not.toBe(nonce);
  }, 300_000);
});

describe('review pass 1 voices: dispatch bound, lease, output tail, post-merge checks', () => {
  test('a workflow dispatch no run ever adopts is sent twice per prefix, then watch stops on QUEUE_TRAIN_DISPATCH_UNKNOWN', () => {
    const { fx, pins } = genericTrain();
    fx.write(d => { d.rules['ci.yml'] = { silent: true } as never; });
    const nonce = nonceOf(queue(fx, ['train', 'build', '--prs', pins]).out);
    const watched = queue(fx, ['train', 'watch', '--train', nonce, '--timeout', '120']);
    expect(watched.err, watched.out).toContain('(QUEUE_TRAIN_DISPATCH_UNKNOWN)');
    expect(watched.err).toContain('was sent twice under nonce');
    const sent = fx.read().log.filter(l => l.cmd === 'workflow run').map(l => (l.inputs as any).nonce);
    expect(sent.length).toBeLessThanOrEqual(6);
    for (const n of new Set(sent)) expect(sent.filter(x => x === n).length).toBeLessThanOrEqual(2);
  }, 300_000);

  test('a held lease refuses build and verdict with nothing sent; a dead holder\'s lease is taken over', () => {
    const { fx, pins } = genericTrain();
    const nonce = nonceOf(queue(fx, ['train', 'build', '--prs', pins]).out);
    const lock = path.join(fx.state, 'ship-queue', 'trains', nonce, 'gate.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname() }));
    const before = fx.read().log.length;
    for (const args of [['train', 'verdict', '--train', nonce], ['train', 'build', '--train', nonce]]) {
      const held = queue(fx, args);
      expect(held.err, held.out).toContain('(QUEUE_TRAIN_PENDING)');
      expect(held.err).toContain('holds ' + lock);
    }
    expect(fx.read().log.slice(before).some(l => l.cmd === 'workflow run' || l.cmd === 'run rerun')).toBe(false);
    fs.writeFileSync(lock, JSON.stringify({ pid: spawnSync('true', { timeout: 5000 }).pid, host: os.hostname() }));
    const v = queue(fx, ['train', 'verdict', '--train', nonce]);
    expect(v.status, v.err + v.out).toBe(EXIT.ok);
    expect(fs.existsSync(lock)).toBe(false);
  }, 300_000);

  test('a command that prints more than the 1 MB log tail keeps its tree line and is GREEN', () => {
    const gate = { kind: 'command', command: "yes x | head -c 1200000; echo; echo 'UBICLOUD: left=3'", timeout_sec: 60, spend_cap_usd: 1 };
    const { fx, pins } = genericTrain({ ...GENERIC, gates: [gate] });
    fakeUbi(fx);
    const nonce = nonceOf(queue(fx, ['train', 'build', '--prs', pins]).out);
    const v = queue(fx, ['train', 'verdict', '--train', nonce]);
    expect(line(v.out, 'VERDICT:'), v.err + v.out).toBe('VERDICT: GREEN train ' + nonce + ' landable=2/2');
  }, 300_000);

  test('post_merge_checks: verify --post-merge --checks waits for each named check; watch --land stops after the slot whose named check never ran', () => {
    const { fx, pins } = genericTrain({ ...GENERIC, gates: [{ ...WORKFLOWS_GATE, post_merge_checks: ['deploy'] }] });
    const sha = fx.repo.git('--git-dir', fx.repo.origin, 'rev-parse', 'main');
    const missing = queue(fx, ['verify', '--post-merge', sha, '--checks', 'deploy', '--timeout', '1']);
    expect(missing.err, missing.out).toContain('the post-merge checks the train gate names never ran');
    expect(queue(fx, ['verify', '--post-merge', sha, '--checks', 'test', '--timeout', '1']).status).toBe(EXIT.ok);
    const nonce = nonceOf(queue(fx, ['train', 'build', '--prs', pins]).out);
    const watched = queue(fx, ['train', 'watch', '--train', nonce, '--land', '--timeout', '20']);
    expect(watched.out, watched.err).toMatch(/^WATCH: verify --post-merge [0-9a-f]{40} \(QUEUE_TRAIN_PENDING\)/m);
    expect(fx.read().log.filter(l => l.cmd === 'pr merge')).toHaveLength(1);
    const merged = trainJson(fx, nonce).merged;
    expect(merged.map((m: any) => m.pr)).toEqual(['1']);
    const pending = queue(fx, ['train', 'land', '--train', nonce, '--pr', '2', '--no-wait']);
    expect(pending.err, pending.out).toContain('(QUEUE_TRAIN_PENDING)');
    expect(line(pending.out, 'NEXT:')).toContain('--checks "deploy" && gstack-ship-queue train land --train ' + nonce + ' --pr 2');
    fx.write(d => { d.ci[merged[0].sha] = [{ name: 'test', status: 'completed', conclusion: 'success', id: 1, completed_at: '2026-10-26T00:00:00Z' }, { name: 'deploy', status: 'completed', conclusion: 'failure', id: 2, completed_at: '2026-10-26T00:00:00Z' }]; });
    for (const args of [['train', 'land', '--train', nonce, '--pr', '2', '--no-wait'], ['train', 'watch', '--train', nonce, '--land', '--timeout', '20']]) {
      const red = queue(fx, args);
      expect(red.err, red.out).toContain('(QUEUE_POST_MERGE_RED)');
    }
    expect(fx.read().log.filter(l => l.cmd === 'pr merge')).toHaveLength(1);
  }, 300_000);
});

describe('a command run another process still owns (red-team #4)', () => {
  test('verdict and build wait while the owner is alive and read nothing; a dead owner\'s run is reconciled as interrupted', () => {
    const { fx, pins } = genericTrain({ ...GENERIC, gates: [{ kind: 'command', command: 'true', timeout_sec: 60, spend_cap_usd: 1 }] });
    fakeUbi(fx);
    const nonce = nonceOf(queue(fx, ['train', 'build', '--prs', pins]).out);
    const file = path.join(fx.state, 'ship-queue', 'trains', nonce, 'attempts', trainJson(fx, nonce).attempts[0] + '.json');
    const own = (pid: number) => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), state: 'dispatching', owner: { pid, host: os.hostname() } }));
    own(process.pid);
    for (const args of [['train', 'verdict', '--train', nonce], ['train', 'build', '--train', nonce]]) {
      const held = queue(fx, args);
      expect(held.err, held.out).toContain('(QUEUE_TRAIN_PENDING)');
      expect(held.err).toContain('still running under process ' + process.pid);
    }
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).state).toBe('dispatching');
    own(spawnSync('true', { timeout: 5000 }).pid!);
    const freed = queue(fx, ['train', 'verdict', '--train', nonce]);
    expect(freed.err + freed.out).not.toContain('still running under process');
    expect(line(freed.out, 'PREFIX: T0')).toContain('not dispatched');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).state).not.toBe('dispatching');
  }, 300_000);
});

describe('a pin whose own checks are red (round-2 High 2)', () => {
  test('direct is never taken: the slot lands through an update commit whose checks run on the gated tree', () => {
    const { fx, pins } = genericTrain();
    const pin1 = pins.split(',')[0]!.split('@')[1]!;
    fx.write(d => { d.ci[pin1] = [{ name: 'test', status: 'completed', conclusion: 'failure', id: 2, completed_at: '2026-10-26T00:00:00Z' }]; });
    const nonce = nonceOf(queue(fx, ['train', 'build', '--prs', pins]).out);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const pushed = queue(fx, ['train', 'land', '--train', nonce, '--pr', '1', '--no-wait']);
    expect(pushed.out, pushed.err).toMatch(/^MODE: update \(the pin's own checks are not green /m);
    expect(fx.read().log.some(l => l.cmd === 'pr merge')).toBe(false);
    const merged = queue(fx, ['train', 'land', '--train', nonce, '--pr', '1', '--no-wait']);
    expect(merged.status, merged.err + merged.out).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    expect(t.landing['1']).toMatchObject({ mode: 'update' });
    expect((fx.read().log.find(l => l.cmd === 'pr merge')!.args as string[]).at(-1)).toBe(t.landing['1'].update);
  }, 300_000);
});
