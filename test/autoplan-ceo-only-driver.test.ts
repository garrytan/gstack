/**
 * GST-537 PR 2: `gstack-autoplan next --ceo-only`, the driver twin of
 * `/autoplan --ceo-only`. The run opens only the CEO phase, ends
 * status=reviewed with ceo-review.md and auto_kept decision rows, never writes
 * a gate or approves, keeps its artifacts schema-valid, and the verbs that need
 * a gate refuse it with a coded line. The flag is command-line only.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { importAutoplan } from '../lib/approval-record';
import { ROOT, SMALL_PLAN, attemptsOf, autoplan, env, journal, readRun, resultOf, review, runPhase, startSmallRun } from './helpers/autoplan-run-fixture';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-ceo-only-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
const dir = (name: string) => path.join(TMP, name);
const rows = (file: string) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

describe('next --ceo-only runs the CEO phase alone and ends reviewed', () => {
  const out = startSmallRun(dir('reviewed'), ['--ceo-only']);
  const phase = runPhase(out, 'ceo');
  const run = readRun(out);

  test('init records the mode and skips every other phase', () => {
    expect(run.ceo_only).toBe(true);
    expect(run.phase_order).toEqual(['ceo']);
    expect(run.required_phases).toEqual(['ceo']);
    for (const p of ['design', 'eng', 'dx']) expect(run.phases[p].skipped).toBe('ceo-only run');
    expect(journal(out).find(r => r.event === 'init').ceo_only).toBe(true);
  });

  test('closing CEO ends status=reviewed with the report, and no gate', () => {
    expect(phase.outside.status).toBe(0);
    expect(phase.outside.stdout).toContain('REVIEWED: ceo-only');
    expect(phase.outside.stdout.trimEnd().split('\n').at(-1)).toBe(`GSTACK_RESULT: skill=autoplan status=reviewed run=${out}`);
    expect(phase.outside.stdout).not.toContain('GATE:');
    expect(run.status).toBe('reviewed');
    expect(run.gate_rev).toBeUndefined();
    expect(fs.existsSync(path.join(out, 'gate.json'))).toBe(false);
    expect(journal(out).some(r => r.event === 'gate_written')).toBe(false);
  });

  test('ceo-review.md has the shared report sections and is hashed in run.json', () => {
    const report = fs.readFileSync(path.join(out, 'ceo-review.md'), 'utf8');
    expect(report.split('\n')[0]).toBe('# CEO-only review: Retry backoff for the webhook worker');
    expect(report).toContain('Not approved.');
    for (const h of ['## User challenges (direction kept)', '## Scope added', '## Conservative choices', '## Findings', '## Decision Audit Trail']) expect(report).toContain(h);
    expect(report).toContain('Docs link the quickstart');
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(out, 'ceo-review.md'))).digest('hex');
    expect(run.artifacts['ceo-review.md']).toEqual({ path: 'ceo-review.md', sha256: sha });
  });

  test('decision rows are auto, auto_kept, the direction kept and unanswered; tasks name no p1', () => {
    const decisions = rows(path.join(out, 'decisions.jsonl'));
    expect(decisions.length).toBeGreaterThan(0);
    for (const d of decisions) {
      expect(d.kind).toBe('auto');
      expect(d.status).toBe('auto_kept');
      expect(d.chosen).toBe('a');
      expect(d.answered_at).toBeUndefined();
      expect(d.id.endsWith('-p1')).toBe(false);
    }
    const tasks = rows(path.join(out, 'tasks.jsonl'));
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) { expect(t.blocked_by).toEqual([]); expect(t.status).not.toBe('blocked_on_decision'); }
  });

  test('the artifact set validates and the plan is untouched', () => {
    const v = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-artifact'), 'validate', path.join(out, 'run.json')], { cwd: ROOT, env: env(), encoding: 'utf8', timeout: 60_000 });
    expect(v.stdout).toContain('ARTIFACT_VALID: ');
    expect(v.stdout).toContain('status=reviewed');
    expect(v.status).toBe(0);
    expect(fs.readFileSync(path.join(dir('reviewed'), 'plan.md'), 'utf8')).toBe(SMALL_PLAN);
  });

  test('a later next or resume keeps reviewed and writes no gate', () => {
    const next = autoplan(['next', '--out', out]);
    expect(next.status).toBe(0);
    expect(next.stdout).toContain('status=reviewed');
    const resume = autoplan(['resume', '--out', out]);
    expect(resume.status).toBe(0);
    expect(resume.stdout).toContain('status=reviewed');
    expect(fs.existsSync(path.join(out, 'gate.json'))).toBe(false);
  });

  test('answer, recommend and revise refuse CEO_ONLY_NO_GATE', () => {
    const plan = path.join(dir('reviewed'), 'plan.md');
    for (const args of [['answer', '--gate-rev', '1', '--reply', 'rec', '--by', 'human'], ['answer', '--reply', 'rec', '--by', 'human'],
      ['recommend', '--gate-rev', '1', '--item', 'd1', '--option', 'b', '--basis', 'x'], ['revise', '--plan', plan]]) {
      const r = autoplan([args[0]!, '--out', out, ...args.slice(1)]);
      expect(r.status, args.join(' ')).toBe(3);
      expect(r.stderr).toContain('(CEO_ONLY_NO_GATE)');
    }
    expect(readRun(out).status).toBe('reviewed');
  });

  test('approvals import refuses a CEO-only run and an unreadable one', () => {
    expect(importAutoplan(out, 'main')).toMatchObject({ code: 'CEO_ONLY_NO_GATE' });
    const bad = dir('bad-run');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'decisions.jsonl'), '');
    fs.writeFileSync(path.join(bad, 'run.json'), '{not json');
    expect(importAutoplan(bad, 'main')).toMatchObject({ code: 'ARTIFACT_INVALID_JSON' });
  });
});

describe('a budget-stopped CEO-only run recovers the way a full run does', () => {
  const stopped = (name: string, extra: Record<string, string> = {}) => {
    fs.mkdirSync(dir(name), { recursive: true });
    fs.writeFileSync(path.join(dir(name), 'plan.md'), SMALL_PLAN);
    const out = path.join(dir(name), 'run');
    const first = autoplan(['next', '--out', out, '--plan', path.join(dir(name), 'plan.md'), '--no-ui', '--ceo-only', '--spend-cap', '1', '--estimate-usd', '5'], { env: env(extra) });
    expect(first.status).toBe(3);
    expect(first.stderr).toContain('(SPEND_CAP_EXCEEDED)');
    expect(readRun(out).status).toBe('incomplete');
    return out;
  };

  test('budget then resume lifts the stop, and the run ends reviewed', () => {
    const out = stopped('stopped-budget');
    const budget = autoplan(['budget', '--out', out, '--spend-cap', '50', '--by', 'human']);
    expect(budget.status, budget.stderr).toBe(0);
    expect(autoplan(['resume', '--out', out]).stdout).toContain('STOP_LIFTED');
    runPhase(out, 'ceo');
    expect(readRun(out).status).toBe('reviewed');
    expect(fs.existsSync(path.join(out, 'ceo-review.md'))).toBe(true);
  });

  test('close --deferred finishes it reviewed, with the report and no gate', () => {
    const out = stopped('stopped-close');
    const close = autoplan(['close', '--out', out, '--phase', 'ceo', '--deferred', 'out of budget', '--by', 'human']);
    expect(close.status, close.stderr).toBe(0);
    expect(close.stdout).toContain('REVIEWED: ceo-only');
    expect(close.stdout.trimEnd().split('\n').at(-1)).toBe(`GSTACK_RESULT: skill=autoplan status=reviewed run=${out}`);
    expect(fs.existsSync(path.join(out, 'ceo-review.md'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'gate.json'))).toBe(false);
  });
});

describe('reviewed is a status at rest for checkpoints', () => {
  test('resume on a reviewed run publishes a reviewed generation', () => {
    const root = path.join(dir('ckpt'), 'drive');
    const out = startSmallRun(dir('ckpt'), ['--ceo-only']);
    runPhase(out, 'ceo');
    expect(readRun(out).status).toBe('reviewed');
    const resumed = autoplan(['resume', '--out', out], { env: env({ GSTACK_AUTOPLAN_CHECKPOINT_DIR: root }) });
    expect(resumed.stderr).toContain('status=reviewed');
    const current = JSON.parse(fs.readFileSync(path.join(root, readRun(out).run, 'current.json'), 'utf8'));
    expect(current.status).toBe('reviewed');
  });
});

describe('--ceo-only is a command-line flag for one run', () => {
  const plan = (name: string, text = SMALL_PLAN) => { fs.mkdirSync(dir(name), { recursive: true }); const f = path.join(dir(name), 'plan.md'); fs.writeFileSync(f, text); return f; };

  test('a phase-adding flag beside it refuses before anything is written', () => {
    for (const flag of ['--ui', '--developer-tool', '--agent-primary']) {
      const out = path.join(dir(`conflict${flag}`), 'run');
      const r = autoplan(['next', '--out', out, '--plan', plan(`conflict${flag}`), '--ceo-only', flag]);
      expect(r.status, flag).toBe(3);
      expect(r.stderr).toContain('(CEO_ONLY_CONFLICT)');
      expect(fs.existsSync(path.join(out, 'run.json'))).toBe(false);
    }
  });

  test('a scope marker naming it refuses, with or without the flag', () => {
    const marked = plan('marker', `<!-- gstack-autoplan-scope: --no-ui --ceo-only -->\n${SMALL_PLAN}`);
    for (const extra of [[], ['--ceo-only']]) {
      const r = autoplan(['next', '--out', path.join(dir('marker'), `run${extra.length}`), '--plan', marked, ...extra]);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('(CEO_ONLY_CONFLICT)');
    }
  });

  test('a scope marker that adds a phase conflicts with the flag', () => {
    for (const token of ['--ui', '--developer-tool', '--agent-primary']) {
      const marked = plan(`marker${token}`, `<!-- gstack-autoplan-scope: ${token} -->
${SMALL_PLAN}`);
      const out = path.join(dir(`marker${token}`), 'run');
      const r = autoplan(['next', '--out', out, '--plan', marked, '--ceo-only']);
      expect(r.status, token).toBe(3);
      expect(r.stderr).toContain('(CEO_ONLY_CONFLICT)');
      expect(fs.existsSync(path.join(out, 'run.json'))).toBe(false);
    }
  });

  test('a directory that holds a full run refuses it after init', () => {
    const out = startSmallRun(dir('full'));
    const r = autoplan(['next', '--out', out, '--ceo-only']);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('(CEO_ONLY_AFTER_INIT)');
    expect(readRun(out).ceo_only).toBeUndefined();
    expect(readRun(out).phase_order).toContain('eng');
  });
});

describe('the CEO-only finish records no answer nobody gave and writes only its own report', () => {
  test('a Critical left open by close --deferred stays undecided: no chosen option, listed as needing the owner', () => {
    const out = startSmallRun(dir('blocker'), ['--ceo-only']);
    const r = review(path.join(out, 'ceo-native-prompt.md'), { FIXTURE_FINDINGS: JSON.stringify([{ severity: 'Critical', title: 'Retries can double-charge', fix: 'idempotency key' }]) });
    expect(r.status, r.stderr).toBe(0);
    const ids = attemptsOf(out, 'ceo');
    const bound = autoplan(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', resultOf(out, 'ceo', 'native'), '--model', 'anthropic/claude-opus-5-5', '--attempt', ids.native, '--runner', 'host-subagent']);
    expect(bound.status, bound.stderr).toBe(0);
    const close = autoplan(['close', '--out', out, '--phase', 'ceo', '--deferred', 'owner stop', '--by', 'human']);
    expect(close.status, close.stderr).toBe(0);
    expect(close.stdout).toContain('REVIEWED: ceo-only');
    const blocker = rows(path.join(out, 'decisions.jsonl')).find(d => d.title.includes('Retries can double-charge'));
    expect(blocker).toMatchObject({ kind: 'auto', status: 'auto_kept', chosen: null, default_if_unanswered: null });
    const report = fs.readFileSync(path.join(out, 'ceo-review.md'), 'utf8');
    expect(report).not.toContain('you accept the risk');
    expect(report).toMatch(/Retries can double-charge.*left open for the owner/);
  });

  test('a plan at the report path refuses before anything is written', () => {
    const out = path.join(dir('collide'), 'run');
    fs.mkdirSync(out, { recursive: true });
    const plan = path.join(out, 'ceo-review.md');
    fs.writeFileSync(plan, SMALL_PLAN);
    const r = autoplan(['next', '--out', out, '--plan', plan, '--no-ui', '--ceo-only']);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('(CEO_ONLY_CONFLICT)');
    expect(fs.existsSync(path.join(out, 'run.json'))).toBe(false);
    expect(fs.readFileSync(plan, 'utf8')).toBe(SMALL_PLAN);
  });

  test('a symlink at the report path is replaced, never written through', () => {
    const out = startSmallRun(dir('symlink'), ['--ceo-only']);
    const victim = path.join(dir('symlink'), 'victim.txt');
    fs.writeFileSync(victim, 'keep me');
    fs.symlinkSync(victim, path.join(out, 'ceo-review.md'));
    runPhase(out, 'ceo');
    expect(readRun(out).status).toBe('reviewed');
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep me');
    expect(fs.lstatSync(path.join(out, 'ceo-review.md')).isSymbolicLink()).toBe(false);
  });
});

