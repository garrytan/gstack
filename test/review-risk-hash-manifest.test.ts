/**
 * A hash or pin manifest (each line a hex digest and a path, as sha256sum writes) names files; it does not spend, authenticate
 * or hold secrets (HARN-64: a preregistration's pins.sha256 listed a path whose words read as money, and the plan printed the
 * full five-reader panel). Its lines are skipped by the risk classes; a manifest with any other line is classified as before.
 */
import { describe, expect, test } from 'bun:test';
import { matchRisk } from '../lib/review-risk';

const H = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const pins = ['docs/benchmarks/run/results/spend-ledger.json', 'docs/benchmarks/run/billing/charge-plan.yaml', 'docs/benchmarks/run/auth/session-keys.md'];
const classes = (p: string, lines: string[]) => [...matchRisk({ codePaths: [p], added: { [p]: lines }, scopeAuth: true }).keys()];

describe('hash and pin manifests carry no risk class by their lines (HARN-64)', () => {
  // Value: protects=a pins.sha256 of digests and paths plans at its own depth, not the risk panel; fails_when=a money, auth or
  //   secret word inside a pinned path makes the manifest a risk file; seam=matchRisk; no_claim=the manifest's own path tokens
  test('digest-and-path lines (sha256sum text and binary forms, md5 to sha512) name no risk', () => {
    const lines = pins.map((p, i) => `${H(i)}  ${p}`);
    expect(classes('docs/benchmarks/run/pins.sha256', lines)).toEqual([]);
    expect(classes('docs/benchmarks/run/pins.sha256', [`${H(1)} *${pins[0]}`, `${H(2).slice(0, 32)}  ${pins[1]}`, `${H(3).repeat(2)}  ${pins[2]}`])).toEqual([]);
  });

  // Value: protects=a manifest-shaped file that carries anything else is still read line by line (negative control); fails_when=
  //   one digest line exempts a file that also spends, or a code or prose line hides behind digests; seam=matchRisk
  test('a manifest with a code or prose line is classified as before', () => {
    const lines = pins.map((p, i) => `${H(i)}  ${p}`);
    expect(classes('docs/benchmarks/run/pins.sha256', [...lines, 'const spend_cap_usd = 5;'])).toEqual(['money']);
    expect(classes('docs/benchmarks/run/pins.sha256', [...lines, '# the charge for each billing run is capped at $5'])).toContain('money');
    expect(classes('docs/benchmarks/run/pins.sha256', [`${H(1)}  ${pins[0]}  # spend_cap_usd = 5`])).not.toEqual([]);
    expect(classes('src/pay.ts', ['const spend_cap_usd = 5;'])).toEqual(['money']);
    expect(classes('docs/benchmarks/run/pins.sha256', [...lines, `${H(4)}  run(process.argv[2]);`])).not.toEqual([]);
    expect(classes('docs/benchmarks/run/pins.sha256', [...lines, `${H(5)}  OPENAI_API_KEY=sk-proj-${'Ab3'.repeat(12)}`])).not.toEqual([]);
    expect(classes('docs/benchmarks/run/pins.sha256', [...lines, `${H(6)}  home/runner/.netrc`])).toContain('secret');
  });
});
