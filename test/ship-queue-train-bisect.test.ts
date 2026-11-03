// Split from test/ship-queue-train.test.ts (GSTA-151): dispatch recovery, train status, and the verdict, bisect and rebuild cases.
import { afterEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { cleanup } from './helpers/restamp-fixture';
import { coordinatorClone } from './helpers/ship-queue-fixture';
import { twoPrTrain } from './helpers/ship-queue-train-cases';
import {
  COMPLETE, FAIL, GREEN_GATE, PASS, RED_GATE, TRAIN_POLICY, dispatches, line, queue, trainFixture, trainJson,
  type Rule, type TrainFixture,
} from './helpers/ship-queue-train-fixture';

const fixtures: TrainFixture[] = [];
const make = (policy: Record<string, unknown> = TRAIN_POLICY) => { const f = trainFixture(policy); fixtures.push(f); return f; };
afterEach(() => { while (fixtures.length) cleanup(fixtures.pop()!.repo); });

const next = (out: string) => line(out, 'NEXT:');
const remoteRefs = (fx: TrainFixture) => fx.repo.git('ls-remote', 'origin');

describe('dispatch recovery and status', () => {
  test('a partial dispatch (gh failed after GitHub accepted it) is unknown, never re-dispatched, and train status finds the run by nonce', () => {
    const fx = make();
    const { r, nonce } = twoPrTrain(fx, { ...GREEN_GATE, failButCreate: true });
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toContain('(QUEUE_TRAIN_DISPATCH_UNKNOWN)');
    expect(next(r.out)).toBe(`NEXT: gstack-ship-queue train status --train ${nonce}`);
    expect(trainJson(fx, nonce).state).toBe('dispatch-unknown');
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).err).toContain('(QUEUE_TRAIN_DISPATCH_UNKNOWN)');
    expect(queue(fx, ['train', 'build', '--train', nonce]).err).toContain('(QUEUE_TRAIN_DISPATCH_UNKNOWN)');
    const status = queue(fx, ['train', 'status', '--train', nonce]);
    expect(status.status).toBe(EXIT.ok);
    expect(status.out).toMatch(new RegExp(`^ATTEMPT: a1 gate state=dispatched nonce=${nonce.replace(/\./g, '\\.')} run=101 `, 'm'));
    expect(trainJson(fx, nonce).state).toBe('gate-pending');
    expect(next(status.out)).toBe(`NEXT: gstack-ship-queue train verdict --train ${nonce}`);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    expect(dispatches(fx, 'evals.yml').length).toBe(1);
  }, 180_000);

  test('a dispatch that never started is marked absent by status; only then does build dispatch it again, under the same nonce', () => {
    const fx = make();
    const { r, nonce } = twoPrTrain(fx, { silent: true });
    expect(r.err).toContain('(QUEUE_TRAIN_DISPATCH_UNKNOWN)');
    const status = queue(fx, ['train', 'status', '--train', nonce]);
    expect(status.out).toContain('ATTEMPT: a1 gate state=absent');
    expect(next(status.out)).toBe(`NEXT: gstack-ship-queue train build --train ${nonce}`);
    fx.write(d => { d.rules['evals.yml'] = GREEN_GATE; });
    const again = queue(fx, ['train', 'build', '--train', nonce]);
    expect(again.status).toBe(EXIT.ok);
    expect(dispatches(fx, 'evals.yml').map(d => (d.inputs as any).nonce)).toEqual([nonce, nonce]);
    expect(trainJson(fx, nonce).attempts).toEqual(['a1', 'a2']);
  }, 180_000);

  test('train status on a clean state root rebuilds the records from refs/notes/gstack-trains and spends nothing', () => {
    const fx = make();
    const { nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const before = dispatches(fx).length;
    const clone = coordinatorClone(fx.repo);
    const fresh = path.join(fx.repo.root, 'fresh-state');
    const s = queue(fx, ['train', 'status', '--train', nonce], { GSTACK_STATE_ROOT: fresh }, clone);
    expect(s.status).toBe(EXIT.ok);
    expect(s.out).toMatch(/^NOTES: read 2 record\(s\), restored 2 /m);
    expect(s.out).toContain(`TRAIN: ${nonce} state=green`);
    expect(s.out).toContain('CHECK: gstack/full-gate on');
    expect(trainJson(fx, nonce, fresh)).toEqual(trainJson(fx, nonce));
    expect(dispatches(fx).length).toBe(before);
    const all = queue(fx, ['train', 'status'], { GSTACK_STATE_ROOT: fresh }, clone);
    expect(all.out).toContain(`NEXT(${nonce}): gstack-ship-queue verify --pr 1 --train ${nonce}`);
  }, 180_000);
});

describe('verdict, bisect, rebuild', () => {
  function redTrain(fx: TrainFixture, pattern: string) {
    const t = twoPrTrain(fx, RED_GATE);
    const v = queue(fx, ['train', 'verdict', '--train', t.nonce]);
    const prefixes = trainJson(fx, t.nonce).prefixes.map((p: any) => p.commit);
    fx.write(d => { d.rules['evals.yml'] = { bisect: { prefixes, patterns: { c1: pattern } } }; });
    return { ...t, v, prefixes };
  }

  test('a red train names its cases and a capped bisect; the bisect runs only the red cases on every prefix and attributes a monotone pattern; prune deletes the dropped train\'s branch', () => {
    const fx = make();
    const { h1, nonce, v, prefixes } = redTrain(fx, 'GGR');
    expect(v.status).toBe(EXIT.fail);
    expect(v.err).toContain(`train ${nonce} is red on c1`);
    expect(v.out).toContain('ATTEMPT: a1 gate run 101 RED red=c1 cost=$1.70');
    expect(next(v.out)).toBe(`NEXT: gstack-ship-queue train bisect --train ${nonce} --spend-cap 2.70`);
    const dry = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '2.70', '--dry-run']);
    expect(dry.out).toContain('BISECT: cases c1 prefixes T0,T1,T2 need results; $0.90 reserved per prefix; spent $0.00, cap $2.70');
    expect(dry.out).toContain('DRY-RUN: nothing dispatched');
    expect(dispatches(fx, 'evals.yml').length).toBe(1);
    const go = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '2.70']);
    expect(go.status).toBe(EXIT.ok);
    const sent = dispatches(fx, 'evals.yml').at(-1)!.inputs as any;
    expect(sent.cases).toBe('c1');
    expect(sent.prefix_shas).toBe(prefixes.join(','));
    expect(sent.expected_sha).toBe(prefixes[2]);
    expect(sent.nonce).toMatch(/^gate\.bisect-/);
    const done = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '2.70']);
    expect(done.status).toBe(EXIT.ok);
    expect(done.out).toContain('PATTERN: c1 T0=G T1=G T2=R');
    expect(done.out).toContain('BISECT: ATTRIBUTED #2');
    expect(next(done.out)).toBe(`NEXT: gstack-ship-queue train build --prs 1@${h1}`);
    expect(trainJson(fx, nonce).state).toBe('attributed');
    expect(queue(fx, ['train', 'prune', '--dry-run']).out).toContain(`WOULD-DELETE: train/${nonce} (attributed)`);
    expect(queue(fx, ['train', 'prune']).out).toContain(`DELETED: train/${nonce} (attributed)`);
    expect(remoteRefs(fx)).not.toContain(`refs/heads/train/${nonce}`);
    expect(queue(fx, ['train', 'prune']).out).toContain(`GONE: train/${nonce}`);
  }, 180_000);

  test('red on every prefix, T0 included, is RED_ON_MAIN; a non-monotone pattern is unattributed and earns no rebuild', () => {
    const main = make();
    const m = redTrain(main, 'RRR');
    queue(main, ['train', 'bisect', '--train', m.nonce, '--spend-cap', '5']);
    const onMain = queue(main, ['train', 'bisect', '--train', m.nonce, '--spend-cap', '5']);
    expect(onMain.status).toBe(EXIT.fail);
    expect(onMain.err).toContain('(QUEUE_TRAIN_RED_ON_MAIN)');
    expect(next(onMain.out)).toMatch(/^NEXT: fix forward on main first, then gstack-ship-queue train build --prs /);
    const fx = make();
    const n = redTrain(fx, 'GRG');
    queue(fx, ['train', 'bisect', '--train', n.nonce, '--spend-cap', '5']);
    const mixed = queue(fx, ['train', 'bisect', '--train', n.nonce, '--spend-cap', '5']);
    expect(mixed.status).toBe(EXIT.fail);
    expect(mixed.err).toContain('(QUEUE_TRAIN_UNATTRIBUTED)');
    expect(mixed.out).toContain('BISECT: UNATTRIBUTED (not monotone)');
    expect(next(mixed.out)).toMatch(/^NEXT: route the red cases to a repair lane \(GStack Minder\); once the repair merges: /);
    const refused = queue(fx, ['train', 'rebuild', '--train', n.nonce]);
    expect(refused.status).toBe(EXIT.refused);
    expect(refused.err).toMatch(/rebuild refused: the bisect was not all green \(c1=GRG\).*\(QUEUE_TRAIN_REBUILD_REFUSED\)/);
  }, 240_000);

  test('rebuild-once: refused without a bisect; an all-green bisect earns exactly one unchanged rebuild, both runs reported; a second red stays red', () => {
    const fx = make();
    const { nonce } = redTrain(fx, 'GGG');
    expect(queue(fx, ['train', 'rebuild', '--train', nonce]).err).toMatch(/rebuild refused: no bisect record.*\(QUEUE_TRAIN_REBUILD_REFUSED\)/);
    queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '5']);
    const green = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '5']);
    expect(green.out).toContain('BISECT: UNATTRIBUTED (all green)');
    expect(next(green.out)).toBe(`NEXT: gstack-ship-queue train rebuild --train ${nonce}`);
    fx.write(d => { d.rules['evals.yml'] = RED_GATE; });
    const rebuild = queue(fx, ['train', 'rebuild', '--train', nonce]);
    expect(rebuild.status).toBe(EXIT.ok);
    expect(dispatches(fx, 'evals.yml').at(-1)!.inputs).toMatchObject({ evals_all: 'true', nonce: `${nonce}.2` });
    const second = queue(fx, ['train', 'verdict', '--train', nonce]);
    expect(second.status).toBe(EXIT.fail);
    expect(second.out).toContain('ATTEMPT: a1 gate run 101 RED red=c1');
    expect(second.out).toMatch(/^ATTEMPT: a2 rebuild run \d+ RED red=c1/m);
    expect(next(second.out)).toMatch(/^NEXT: second red stays red: route c1 to a repair lane/);
    expect(queue(fx, ['train', 'rebuild', '--train', nonce]).err).toMatch(/rebuild refused: already rebuilt once/);
    expect(queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '5']).err).toContain('second red is not bisected again');
  }, 240_000);

  test('a capped bisect launches only what fits, keeps completed prefixes, and resumes without repeating one', () => {
    const fx = make();
    const { nonce, prefixes } = redTrain(fx, 'GGR');
    const none = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '0.5']);
    expect(none.status).toBe(EXIT.refused);
    expect(none.err).toContain('(QUEUE_TRAIN_BISECT_CAPPED)');
    expect(next(none.out)).toBe(`NEXT: gstack-ship-queue train bisect --train ${nonce} --spend-cap 2.70`);
    expect(dispatches(fx, 'evals.yml').length).toBe(1);
    const part = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '1.9']);
    expect(part.status).toBe(EXIT.refused);
    expect(part.err).toContain('(QUEUE_TRAIN_BISECT_CAPPED)');
    expect(part.out).toContain('BISECT: launch T0,T1; 1 prefix(es) wait for a higher cap');
    expect((dispatches(fx, 'evals.yml').at(-1)!.inputs as any).prefix_shas).toBe(prefixes.slice(0, 2).join(','));
    const resume = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '5']);
    expect(resume.status).toBe(EXIT.ok);
    expect((dispatches(fx, 'evals.yml').at(-1)!.inputs as any).prefix_shas).toBe(prefixes[2]);
    const done = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '5']);
    expect(done.out).toContain('BISECT: ATTRIBUTED #2');
    expect(done.out).toContain('BISECT: spent $1.50 of cap $5.00');
    expect(dispatches(fx, 'evals.yml').length).toBe(3);
  }, 240_000);

  test('a bisect refuses prefixes that are not ancestors of train/<nonce>', () => {
    const fx = make();
    const { nonce } = redTrain(fx, 'GGR');
    fx.repo.git('push', '-q', '-f', 'origin', `origin/main:refs/heads/train/${nonce}`);
    const r = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '5']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toMatch(/train\/\S+ is at [0-9a-f]{12}, not the recorded train head .*\(QUEUE_TRAIN_PREFIX_INVALID\)/);
    expect(dispatches(fx, 'evals.yml').length).toBe(1);
  }, 180_000);

  test('an INFRA/INCOMPLETE-only census is never green and earns one re-dispatch, reported beside the first run', () => {
    const fx = make();
    const infra: Rule = { conclusion: 'failure', record: { panels: [PASS('c1'), FAIL('c2', 'INFRA'), PASS('j1', 'judge')], census: { ...COMPLETE, killed_before_upload: 1 }, verdict: 'RED' } };
    const { nonce } = twoPrTrain(fx, infra);
    const v = queue(fx, ['train', 'verdict', '--train', nonce]);
    expect(v.status).toBe(EXIT.fail);
    expect(v.err).toMatch(/gate is incomplete: 1 slice killed before upload; c2 FAIL \(INFRA\).*\(QUEUE_TRAIN_INCOMPLETE\)/);
    expect(next(v.out)).toBe(`NEXT: gstack-ship-queue train rebuild --train ${nonce} --infra (the single re-dispatch EVAL_POLICY.infraRedispatch allows; report both runs)`);
    expect(queue(fx, ['train', 'rebuild', '--train', nonce]).err).toContain('rebuild refused: no bisect record');
    const again = queue(fx, ['train', 'rebuild', '--train', nonce, '--infra']);
    expect(again.status).toBe(EXIT.ok);
    const second = queue(fx, ['train', 'verdict', '--train', nonce]);
    expect(second.out).toMatch(/^ATTEMPT: a2 infra-redispatch run \d+ INCOMPLETE/m);
    expect(next(second.out)).toMatch(/^NEXT: diagnose run /);
    expect(queue(fx, ['train', 'rebuild', '--train', nonce, '--infra']).err).toMatch(/already re-dispatched once.*\(QUEUE_TRAIN_REBUILD_REFUSED\)/);
  }, 180_000);
});
