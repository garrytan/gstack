import { describe, expect, test } from 'bun:test';
import { devexSeedCoverage, type DevexSeededGap } from './helpers/devex-seed-coverage';
import fixture from './fixtures/dx-journey-field-at.json';
import historicalFixture from './fixtures/devex-seed-coverage-ad-v3.json';

const targets: Array<[number, DevexSeededGap]> = [[3, 'missing-quickstart'], [4, 'local-ci-gate'],
  [5, 'reversed-arguments'], [6, 'opaque-auth-error'], [7, 'breaking-upgrade']];
const fresh = () => structuredClone(fixture.transcript) as any;
function change(call: any, transform: (question: string) => string) {
  const q = call.questions[0], prior = q.question, answer = call.answers[prior];
  q.question = transform(prior); call.answers = { [q.question]: answer };
}
function rejected(index: number, gap: DevexSeededGap, mutate: (call: any) => void) {
  const transcript = fresh(); mutate(transcript.calls[index]);
  const result = devexSeedCoverage(transcript);
  expect(result.complete).toBe(false); expect(result.decisions[gap]).toEqual([]);
}

describe('DX journey metadata and owned signature declarations', () => {
  test('preserves the previously accepted legacy INSTALL/QUICKSTART direct question', () => {
    const transcript = { status: 'ready', calls: structuredClone(historicalFixture.attempts[1]!.calls), assistantMessages: [] } as any;
    expect(devexSeedCoverage(transcript).complete).toBe(true);
    expect(devexSeedCoverage(transcript).decisions['missing-quickstart']).toHaveLength(1);
  });

  test('each witnessed seed retains its own exact completed decision', () => {
    expect(fixture.provenance.paidOutcomesReclassified).toBe(false);
    expect(fixture.transcript.calls).toHaveLength(16);
    const result = devexSeedCoverage(fresh());
    expect(result).toMatchObject({ complete: true, missing: [], invalid: [], batched: [] });
    for (const [index, gap] of targets) {
      const call = fixture.transcript.calls[index]!;
      expect(result.decisions[gap]).toEqual([`${call.sessionId}:${call.toolUseId}`]);
    }
  });

  test.each(['DISCOVER', 'INSTALL', 'HELLO WORLD', 'REAL USAGE', 'DEBUG', 'UPGRADE'])('recognizes only the canonical %s stage vocabulary', stage => {
    const transcript = fresh(); change(transcript.calls[3], q => q.replace('Journey Stage: INSTALL.', `Journey Stage: ${stage}.`));
    expect(devexSeedCoverage(transcript).decisions['missing-quickstart']).toHaveLength(1);
  });

  test.each(targets)('stage %s keeps unsupported/missing metadata and quoted titles out of %s', (index, gap) => {
    for (const prefix of ['Journey Stage: OTHER.', 'Journey Stage: .', 'Journey Stage: INSTALL maybe.',
      'Journey Stage INSTALL.', 'Journey Stage: INSTALL:', 'Journey Stage: INSTALL. Source:']) {
      rejected(index, gap, call => change(call, q => q.replace(/Journey Stage: [A-Z ]+\./, prefix)));
    }
    rejected(index, gap, call => change(call, q => q.replace(/Journey Stage: [A-Z ]+\./, 'Journey Stage: OTHER.').replace('\n', '?\n')));
    for (const quote of ['"', '`', '> ']) rejected(index, gap, call => change(call, q => {
      const [first, ...rest] = q.split('\n');
      return first.replace(/^(D\d+ — )(.*)$/, `$1${quote}$2${quote === '> ' ? '' : quote}`) + '\n' + rest.join('\n');
    }));
    rejected(index, gap, call => change(call, q => q.replace(/(Journey Stage: [A-Z ]+\. )/, '$1If approved, ')));
  });

  test.each(targets)('current and offered-action withdrawal still removes %s / %s', (index, gap) => {
    for (const status of ['withdrawn', 'rejected', 'not current', 'no longer current']) for (const quote of ['', '"', "'"]) {
      rejected(index, gap, call => change(call, q => `${q}\nThis finding is ${quote}${status}${quote}.`));
      rejected(index, gap, call => { for (const option of call.questions[0].options) option.description += `\nThis option is ${quote}${status}${quote}.`; });
    }
    rejected(index, gap, call => change(call, q => q.replace('ELI10: ', 'Historical assessment.\nELI10: ')));
    rejected(index, gap, call => change(call, q => q.replace('ELI10: ', 'Hypothetical scenario.\nELI10: ')));
    rejected(index, gap, call => {
      const q = call.questions[0]; q.options = [{ label: 'Continue', description: 'No changes.' }, { label: 'Stop', description: 'End review.' }];
      call.answers = { [q.question]: 'Continue' };
    });
  });

  test('the unnamed signature statement requires its own file, definitions and explanation', () => {
    const changes = [
      (q: string) => q.replace('ELI10: docs/api.md', 'ELI10: docs/other.md'),
      (q: string) => q.replace('ELI10: docs/api.md documents', 'ELI10: docs/api.md previously documented'),
      (q: string) => q.replace('ELI10: docs/api.md documents', 'ELI10: Source: docs/api.md documents'),
      (q: string) => q.replace('ELI10: docs/api.md documents', 'ELI10: If approved, docs/api.md documents'),
      (q: string) => q.replace(/ELI10: ([^\n]+)/, 'ELI10: "$1"'),
      (q: string) => q.replace('run_batch(evaluator, dataset)', 'run_batch(dataset, evaluator)'),
      (q: string) => q.replace('Same two concepts, reversed positional order', 'Same two concepts, consistent positional order'),
      (q: string) => q + '\nThese signatures are now aligned.',
      (q: string) => q + '\nThere is no argument-order defect.',
      (q: string) => q + '\nThis finding applies only if approved.',
      (q: string) => q.replace('ELI10:', 'Earlier reviewer:\nELI10:'),
      (q: string) => q.replace('ELI10:', 'ELI10: The older API was confusing.\nELI10:'),
    ];
    for (const transform of changes) rejected(5, 'reversed-arguments', call => change(call, transform));
  });

  test('the same offered signature correction stays current and binds both arguments', () => {
    for (const description of ['Align something.', 'Only run_eval takes dataset and evaluator as keyword-only in the same order.',
      'Both functions take dataset and evaluator as keyword-only in the same order. Do not align these functions.',
      'Both functions take dataset and evaluator as keyword-only in the same order. Do not make either function keyword-only.',
      'Both functions take dataset and evaluator as keyword-only in the same order. This option applies if approved.',
      'Both functions take dataset and evaluator as keyword-only in the same order. This option is "withdrawn".']) {
      rejected(5, 'reversed-arguments', call => { call.questions[0].options[0].description = description; });
    }
    const transcript = fresh(); change(transcript.calls[5], q => q + '\nEarlier reviewer said "These signatures are now aligned."');
    transcript.calls[5].questions[0].options[0].description += '\nEarlier reviewer said "This option is withdrawn."';
    expect(devexSeedCoverage(transcript).decisions['reversed-arguments']).toHaveLength(1);
  });

  test.each(targets)('format normalization cannot manufacture completion for %s / %s', (index, gap) => {
    for (const mutate of [(c: any) => { c.answered = false; }, (c: any) => { c.failed = true; },
      (c: any) => { c.answeredAt = ''; }, (c: any) => { c.unansweredQuestionIndices = [0]; },
      (c: any) => { c.answers = {}; }, (c: any) => { c.questions[0].multiSelect = true; }]) {
      const transcript = fresh(); mutate(transcript.calls[index]); expect(devexSeedCoverage(transcript).complete).toBe(false);
    }
  });
});
