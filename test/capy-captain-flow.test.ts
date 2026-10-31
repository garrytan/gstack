/**
 * The Capy Captain flow end to end on the simulated Capy host, through the
 * CLIs only: an autoplan run on a plan with the four brief sections reaches
 * its gate and prints the Capy RELAY line; the Captain brief carries the
 * gate's rec_hash; a relayed `rec` answered with that hash approves; the
 * approval record imports the owner's exact words once; and its ## Approvals
 * table is mirrored to GSTACK_APPROVALS_DIR. The negative control: the same
 * run without GSTACK_CAPY prints no RELAY line.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ROOT, resultOf } from './helpers/autoplan-run-fixture';
import { capyRunner, phaseVia, writePlan } from './helpers/autoplan-capy';

const r = capyRunner();
afterAll(() => r.cleanup());

const PLAN = `# Retry backoff for the webhook worker

## ELI5

A failed webhook now waits longer before each retry, so the partner stops dropping them.

## Before → after

Before: a failed webhook retries every second until it is dropped. After: retries back off from 500 ms to 30 s.

## Why it matters

Bursty retries hit the partner's rate limit and drop about 2% of deliveries.

## What caused this work

Issue #41: "webhooks vanish under load".

## Big decisions

1. Exponential backoff with jitter rather than a fixed delay. Would flip if the partner publishes a retry-after header.

## Implementation plan

Add exponential backoff to the webhook worker's retry loop in lib/worker.ts: base 500 ms, factor 2, cap 30 s, jitter 10%.
Persist the attempt count on the job row so a restarted worker resumes the schedule. Tests cover the cap, the jitter bounds and the resume path.

## Review record
`;

const bin = (name: string, args: string[], extra: Record<string, string> = {}, cwd = ROOT) =>
  spawnSync('bun', [path.join(ROOT, 'bin', name), ...args], { cwd, env: { ...r.env, ...extra }, encoding: 'utf8', timeout: 120_000 });

describe('Capy Captain flow', () => {
  test('gate → RELAY line → Captain brief with rec_hash → relayed answer → approval record and mirror', () => {
    const dir = path.join(r.host.base, 'captain');
    const plan = writePlan(dir, PLAN);
    const out = path.join(dir, 'run');
    expect(r.ap(['next', '--out', out, '--plan', plan, '--no-ui', '--no-dx']).status).toBe(0);
    phaseVia(r, out, 'ceo');
    const eng = phaseVia(r, out, 'eng');
    const gateOut = eng.outside.stdout + eng.next.stdout;
    expect(gateOut).toContain('status=gate_pending');
    expect(gateOut).toContain(`RELAY: gstack-owner-brief render --captain --out ${out} `);

    const brief = bin('gstack-owner-brief', ['render', '--captain', '--out', out, '--json']);
    expect(brief.status, brief.stderr).toBe(0);
    const j = JSON.parse(brief.stdout);
    expect(j.missing).toEqual([]);
    expect(j.brief).toStartWith('**Decision needed:** approve the plan "Retry backoff for the webhook worker".');
    for (const h of ['### Before → after', '### Why it matters', '### What caused this work', '### Big decisions', '### What we need from you']) expect(j.brief).toContain(h);

    const answer = r.ap(['answer', '--out', out, '--gate-rev', String(j.gate_rev), '--reply', 'rec', '--rec-hash', j.rec_hash, '--by', 'agent:GSTA-1', '--owner-reply', 'rec']);
    expect(answer.status, answer.stderr + answer.stdout).toBe(0);
    expect(answer.stdout).toMatch(/^APPROVED: gate_rev=1/m);

    const repo = path.join(r.host.base, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    spawnSync('git', ['init', '-q', '-b', 'fix/backoff'], { cwd: repo, timeout: 30_000 });
    const mirror = path.join(r.host.base, 'drive-approvals');
    const env = { GSTACK_APPROVALS_DIR: mirror, GSTACK_PROJECT_SLUG: 'acme-worker' };
    const imp = bin('gstack-approvals', ['import', '--autoplan', out, '--by', 'Garry'], env, repo);
    expect(imp.status, imp.stderr).toBe(0);
    expect(imp.stdout).toMatch(/^APPROVAL_IMPORTED: n=1 skipped=0 /);
    expect(bin('gstack-approvals', ['import', '--autoplan', out, '--by', 'Garry'], env, repo).stdout).toMatch(/^APPROVAL_IMPORTED: n=0 skipped=1 /);
    const table = bin('gstack-approvals', ['render'], env, repo).stdout;
    expect(table).toContain('Approve the plan "Retry backoff for the webhook worker"');
    expect(table).toContain('“rec” (Garry, relayed by agent:GSTA-1) | approved |');
    expect(fs.readdirSync(path.join(mirror, 'acme-worker')).length).toBe(1);
  });

  test('without GSTACK_CAPY the gate prints no RELAY line', () => {
    const dir = path.join(r.host.base, 'plain');
    const plan = writePlan(dir, PLAN);
    const out = path.join(dir, 'run');
    expect(r.ap(['next', '--out', out, '--plan', plan, '--no-ui', '--no-dx']).status).toBe(0);
    phaseVia(r, out, 'ceo');
    expect(r.ap(['next', '--out', out]).status).toBe(0);
    for (const voice of ['native', 'outside']) expect(r.review(path.join(out, `eng-${voice}-prompt.md`)).status).toBe(0);
    const run = JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8'));
    const submit = (voice: string, model: string) => r.ap(['submit', '--out', out, '--phase', 'eng', '--voice', voice, '--result', resultOf(out, 'eng', voice as 'native' | 'outside'), '--model', model, '--attempt', run.phases.eng[voice].attempt, '--runner', 'host-subagent'], { GSTACK_CAPY: '' });
    expect(submit('native', 'anthropic/claude-opus-5-5').status).toBe(0);
    const last = submit('outside', 'openai/gpt-6.1-sol');
    expect(last.stdout).toContain('status=gate_pending');
    expect(last.stdout).toMatch(/^GATE: gate_rev=1 /m);
    expect(last.stdout).not.toContain('RELAY: gstack-owner-brief');
  });
});
