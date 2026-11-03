/**
 * The screen verdict names every red case, rule cases included, from the
 * run's real artifacts. Run 41662815506 (#3947's screen) is a correct RED:
 * seven rule cases failed twice under rule 16, and ship-docsync-stale-after
 * failed once and passed on its rerun. Before this fix the verdict line named
 * only the flaky case, so the RED read as if the rerun-pass case caused it.
 * Fixtures: test/fixtures/screen-verdict-41662815506 holds the run's
 * gate-binding.json and its collector-outcomes.json minus the per-file list.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { screenVerdict, verdictLines } from '../lib/ship-queue-screen';
import type { QueueContext } from '../lib/ship-queue';

const RUN = 41662815506;
const SLUG = 'garrytan/gstack';
const FIXTURE = path.join(import.meta.dir, 'fixtures', 'screen-verdict-41662815506');
const realBinding = () => JSON.parse(fs.readFileSync(path.join(FIXTURE, 'gate-binding.json'), 'utf8'));
const realOutcomes = () => JSON.parse(fs.readFileSync(path.join(FIXTURE, 'collector-outcomes.json'), 'utf8'));
const TWICE = ['browse-basic', 'browse-snapshot', 'diagram-triplet', 'qa-quick', 'skillmd-no-local-binary', 'skillmd-outside-git', 'skillmd-setup-discovery'];

function ctxFor(conclusion: string, binding: unknown, outcomes: unknown): QueueContext {
  const files: Record<string, Record<string, unknown>> = {
    'paid-plan': { 'manifest.json': { entries: [{ status: 'planned' }] } },
    'gate-binding-a1': { 'gate-binding.json': binding },
    'report-verdict-a1': { 'paid-report/collector-outcomes.json': outcomes },
  };
  const artifacts = Object.keys(files).map(name => ({ name, expired: false }));
  return {
    repoRoot: '/nonexistent', base: 'main',
    gh: (args) => {
      if (args[0] === 'run' && args[1] === 'view') return { ok: true, out: JSON.stringify({ databaseId: RUN, status: 'completed', conclusion }) };
      if (args[0] === 'api') return { ok: true, out: JSON.stringify({ artifacts: args[1]!.includes('name=paid-plan') ? artifacts.filter(a => a.name === 'paid-plan') : artifacts }) };
      if (args[0] === 'run' && args[1] === 'download') {
        const name = args[args.indexOf('-n') + 1]!;
        const dir = args[args.indexOf('-D') + 1]!;
        if (!files[name]) return { ok: false, out: '', err: 'no artifact' };
        for (const [rel, body] of Object.entries(files[name]!)) {
          fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
          fs.writeFileSync(path.join(dir, rel), JSON.stringify(body));
        }
        return { ok: true, out: '' };
      }
      return { ok: false, out: '', err: `unexpected gh ${args.join(' ')}` };
    },
  };
}

describe('screen verdict from run 41662815506', () => {
  test('a rule case that failed twice is named red; the rerun-pass case is only flaky', () => {
    // Value: protects=SCREEN_VERDICT and QUEUE_SCREEN_RED name the rule reds; fails_when=red names come from behavior/judge panels only; why_new=the train fixture models reds as judge panels; seam=none; no_claim=gh is a stub serving the run's downloaded artifacts
    const read = screenVerdict(ctxFor('failure', realBinding(), realOutcomes()), SLUG, RUN);
    expect(read.kind).toBe('red');
    if (read.kind !== 'red') return;
    expect(read.red).toEqual(TWICE);
    expect(read.flaky).toEqual(['ship-docsync-stale-after']);
    const lines = verdictLines('3947', RUN, read);
    expect(lines[0]).toBe(`SCREEN_VERDICT: #3947 run ${RUN} RED red=${TWICE.join(',')} flaky=ship-docsync-stale-after (verdict RED, reconcile exit 1, run concluded failure, flaky 1)`);
    expect(lines.slice(1)).toEqual([expect.stringMatching(/^FLAKY: ⚑ ship-docsync-stale-after {2}rule {2}FLAKY: failed in attempt 1/)]);
  });

  test('negative control: with only the rerun-pass case left, the run reads GREEN with its FLAKY line', () => {
    const outcomes = { ...realOutcomes(), failures: [] };
    const read = screenVerdict(ctxFor('success', { ...realBinding(), verdict: 'GREEN', reconcile_exit: 0 }, outcomes), SLUG, RUN);
    expect(read.kind).toBe('green');
    if (read.kind !== 'green') return;
    expect(read.flaky).toEqual(['ship-docsync-stale-after']);
    expect(verdictLines('3947', RUN, read)).toEqual([
      `SCREEN_VERDICT: #3947 run ${RUN} GREEN flaky=ship-docsync-stale-after (verdict GREEN, reconcile exit 0, run concluded success, flaky 1)`,
      `FLAKY: ${realOutcomes().flakyLines[0]}`,
    ]);
  });

  test('a red that never reran (INFRA, harness, unattributed shard) is still named red', () => {
    const outcomes = { ...realOutcomes(), failures: [
      '✗ infra-case  rule  FAIL  infra — runner lost  [slice 3, attempt 1]',
      '✗ test/skill-e2e-x.test.ts  rule shard NOT REPORTED  [slice 4, attempt 1]',
    ] };
    const read = screenVerdict(ctxFor('failure', realBinding(), outcomes), SLUG, RUN);
    expect(read.kind).toBe('red');
    if (read.kind === 'red') expect(read.red).toEqual(['infra-case', 'test/skill-e2e-x.test.ts']);
  });

  test('a quarantined or passing split panel line is not named red', () => {
    const outcomes = { ...realOutcomes(), failures: [
      '◌ quiet-case  behavior (quarantined)  FAIL 1/3 (✓✗✗)  [t1@slice 2, attempt 1]',
      '⚠ split-case  behavior  PASS 2/3 (✓✓✗)  [t1@slice 2, attempt 1]',
    ] };
    const read = screenVerdict(ctxFor('failure', realBinding(), outcomes), SLUG, RUN);
    expect(read.kind).toBe('red');
    if (read.kind === 'red') expect(read.red).toEqual([]);
  });
});
