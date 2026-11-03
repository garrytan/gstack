/**
 * GSTA-258 L4 addendum: the collector raised the native reader's own verdict line to CRITICAL. On #3901 (pass 2, gstack 1.94
 * branch) "There are three low-severity findings, all FIXABLE, and none blocks." collected as a blocker beside the three
 * findings it summarizes, each of which already said "Severity: Low. Blocks: no". Excerpt of that captured output below.
 */
import { describe, expect, test } from 'bun:test';
import { parseFindings } from '../lib/review-ledger';

const CAPTURED_3901_P2 = [
  'REVIEWED_TREE: 7be72149fbd6d1b8e713c7c42ef4cd9ba6373e20 /workspace/gstack',
  '',
  'I found no blocking defects in this range. There are three low-severity findings, all FIXABLE, and none blocks.',
  '',
  '### Findings',
  '',
  '1. **The remote-gate route hint ignores `--no-ci-carry`** (`lib/pregate/checks/lanes.ts`, the `route` condition). The hint prints whenever `remote_gate_runs` is declared. FIXABLE. Severity: Low. Blocks: no.',
  '',
  'Recommendation: Ship as-is.',
].join('\n');

const labels = (out: string, reader = 'adversarial-native') => parseFindings(reader, out, true).map(f => f.label);

describe('native verdict line (collector severity inflation)', () => {
  test('the captured #3901 verdict line stays FIXABLE; the finding keeps its own Severity: Low', () => {
    expect(labels(CAPTURED_3901_P2)).toEqual(['FIXABLE', 'Low']);
  });

  test('negative controls: a line that says something blocks, names a file:line, or leads with FIXABLE is still CRITICAL', () => {
    expect(labels('Three findings are FIXABLE, and one blocks.')).toEqual(['CRITICAL']);
    expect(labels('The token leak in log.ts:3 is FIXABLE, and none of the others blocks.')).toEqual(['CRITICAL']);
    expect(labels('FIXABLE: none blocks the merge but the cache key drops the tree.')).toEqual(['CRITICAL']);
    expect(labels('- FIXABLE, and nothing blocks')).toEqual(['CRITICAL']);
  });

  test('a stated Blocks field on the line wins: Blocks: yes stays CRITICAL', () => {
    expect(labels('All FIXABLE, none blocks. Blocks: yes')).toEqual(['CRITICAL']);
  });
});
