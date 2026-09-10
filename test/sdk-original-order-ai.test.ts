import { describe, expect, test } from 'bun:test';
import { hasStaleFillRaceFinding } from './helpers/ceo-section-loading-fixture';
import captured from './fixtures/sdk-original-order-ai.json';

const compact = () => `### Findings registry\n\n${captured.finding}\n\n${captured.heading}\n\`\`\`\n${captured.trace}\n\`\`\``;
const rejects = (changes: Array<[string, string]>) => {
  for (const [before, after] of changes) {
    expect(compact()).toContain(before);
    expect(hasStaleFillRaceFinding(compact().replace(before, after))).toBe(false);
  }
};

describe('asserted original order beside an amended cache schedule', () => {
  test('exact completed report and its owned finding/schedule show the original late-fill violation', () => {
    expect(hasStaleFillRaceFinding(captured.report)).toBe(true);
    expect(hasStaleFillRaceFinding(compact())).toBe(true);
  });

  test('amended behavior or the original caller allowance cannot replace the original stale-fill evidence', () => {
    const original = 'Original sketch, order A: fill V1 at 6 after delete at 4 -> R2 reads V1 for <=30 s  VIOLATION';
    rejects([
      [original, ''], [original, 'Not ' + original], [original, '> ' + original],
      [original, '"' + original + '"'], [original, 'If ' + original],
      [original, original.replace('VIOLATION', 'PERMITTED')],
      [original, original.replace('R2 reads', 'R1 reads')],
      [original, original.replace('fill V1', 'skip fill V1')],
      [original, original.replace('after delete at 4', 'before delete at 4')],
    ]);
  });

  test('reader, writer, cache key, versions and completion order must all refer to the same execution', () => {
    rejects([
      ['inflight[k]', 'inflight[foreign]'], ['R1 (began before W)', 'R1 (began after W)'],
      ['DB write commits V2', 'DB write commits V1'], ['DB returns V1', 'DB returns V2'],
      ['resume: invalidate(E1), delete', 'resume: invalidate(E9), delete'],
      ['settles -> W complete', 'settles -> W pending'],
      ['resume: E1.stale -> skip fill', 'resume: E9.stale -> skip fill'],
      ['7 | R2 begins:', '4.5 | R2 begins:'], ['R2 reads V1 for', 'R2 reads V2 for'],
      ['fill V1 at 6 after delete at 4', 'fill V1 at 3 after delete at 4'],
      ['cache[k]', 'cache[foreign]'],
    ]);
  });

  test('the current finding owns the trace and must independently assert the invariant violation', () => {
    rejects([
      ['schedule (F1,', 'schedule (F2,'], ['| F1 | CRITICAL |', '| F2 | CRITICAL |'],
      ['| F1 | CRITICAL |', '| F1 | LOW |'],
      ['Schedule in Section 4 shows', 'A hypothetical Schedule in Section 4 shows'],
      ['filled after `cache.delete`', 'filled before `cache.delete`'],
      ['every read begun after that write completes must observe the committed version', 'earlier values are accepted for later readers'],
    ]);
    expect(hasStaleFillRaceFinding(compact().replace(captured.finding, captured.finding + '\n' + captured.finding))).toBe(false);
  });

  test('source and hypothetical framing cannot supply the assertion', () => {
    for (const prefix of ['An unproven hypothesis.', 'Historical example only.', 'The following is a hypothetical example.']) {
      expect(hasStaleFillRaceFinding(prefix + '\n' + compact())).toBe(false);
      expect(hasStaleFillRaceFinding(compact().replace(captured.heading, prefix + '\n' + captured.heading))).toBe(false);
    }
    expect(hasStaleFillRaceFinding(compact().split('\n').map(line => '> ' + line).join('\n'))).toBe(false);
    expect(hasStaleFillRaceFinding('````text\n' + compact() + '\n````')).toBe(false);
    expect(hasStaleFillRaceFinding(compact().replace('### Findings registry', '### Quoted source'))).toBe(false);
  });

  test('same-finding direct and quoted withdrawals remain authoritative inside or after the trace', () => {
    for (const withdrawal of ['F1 is withdrawn.', 'F1 is rejected.', 'The original schedule is impossible.', 'There is no stale-fill race.', 'Rejected: "There is no stale-fill race."']) {
      expect(hasStaleFillRaceFinding(compact() + '\n\n' + withdrawal)).toBe(false);
      expect(hasStaleFillRaceFinding(compact().replace(captured.trace, captured.trace + '\n' + withdrawal))).toBe(false);
      expect(hasStaleFillRaceFinding(compact().replace('Ordering tests, both orders + late joiner + sentinel variant', withdrawal))).toBe(false);
    }
    expect(hasStaleFillRaceFinding(compact().replace('Readers that began before the write may still see the old snapshot (permitted by contract)', 'Later readers may see old snapshots; this stale-fill behavior is accepted.'))).toBe(false);
  });

  test('unrelated sections and consistently renamed identities do not change valid evidence', () => {
    expect(hasStaleFillRaceFinding('### Prior example\nHistorical example only.\n\n### Current review\n' + compact())).toBe(true);
    expect(hasStaleFillRaceFinding(compact() + '\n\n### Other finding\nF2 is rejected.')).toBe(true);
    const renamed = compact().replaceAll('R1', 'R7').replaceAll('R2', 'R8').replaceAll('R3', 'R9')
      .replaceAll('V1', 'oldSnapshot').replaceAll('V2', 'newSnapshot').replaceAll('E1', 'pendingA').replaceAll('E2', 'pendingB')
      .replaceAll('[k]', '[profileKey]').replace(/\bW\b/g, 'W2');
    expect(hasStaleFillRaceFinding(renamed)).toBe(true);
  });

  test('owning source headings and same-finding assessments survive intervening structure', () => {
    for (const heading of ['## Hypothetical example', '## Quoted source', '## Historical example only']) {
      expect(hasStaleFillRaceFinding(heading + '\n' + compact())).toBe(false);
    }
    expect(hasStaleFillRaceFinding(compact().replace(captured.heading,
      'F1 is rejected.\n\nUnrelated diagram:\n```\nA -> B\n```\n\n' + captured.heading))).toBe(false);
    expect(hasStaleFillRaceFinding(compact() + '\n\n### Assessment of F1\nF1 is rejected.')).toBe(false);
  });
});

const retry = () => `## Findings Registry\n\n${captured.retry.finding}\n\n${captured.retry.heading}\n\`\`\`\n${captured.retry.trace}\n\`\`\``;
describe('version-labelled original prose with its owned schedule', () => {
  test('the exact retry and compact evidence require the original sequence, not amended prevention', () => {
    expect(hasStaleFillRaceFinding(captured.retry.report)).toBe(true);
    expect(hasStaleFillRaceFinding(retry())).toBe(true);
  });

  test('each version and shared key must agree, with write completion before the later reader', () => {
    for (const [before, after] of [
      ['DB returns v1', 'DB returns v2'], ['write commits v2 and', 'write commits v1 and'],
      ['read then fills v1;', 'read then fills v2;'], ['every later read gets v1', 'every later read gets v2'],
      ['write commits v2 and', 'write commits v3 and'], ['writeGen[key]', 'writeGen[foreign]'],
      ['cache[key]', 'cache[foreign]'], ['R2 (read, began after W)', 'R2 (read, began before W)'],
      ['delete (no-op), return', 'delete (no-op), pending'], ['DB SELECT -> v1', 'DB SELECT -> v2'],
      ['DB UPDATE commits v2', 'DB UPDATE commits v3'], ['promise resolves, set(v1)', 'promise resolves, set(v2)'],
      ['get -> v1  VIOLATION', 'get -> v2  VIOLATION'], ['6 sketch', '3 sketch'],
      ['3                                                     DB UPDATE commits v2', '3                       DB UPDATE commits v2'],
    ]) {
      expect(retry()).toContain(before);
      expect(hasStaleFillRaceFinding(retry().replace(before, after))).toBe(false);
    }
    expect(hasStaleFillRaceFinding(retry().replace(captured.retry.trace, captured.retry.trace.split('\n').filter(line => !/\b[456] sketch\b/.test(line)).join('\n')))).toBe(false);
  });

  test('conditional, quoted, obsolete or withdrawn evidence cannot become a current finding', () => {
    for (const prefix of ['An unproven hypothesis.', 'Historical example only.', 'The following is a hypothetical example.']) {
      expect(hasStaleFillRaceFinding(prefix + '\n' + retry())).toBe(false);
      expect(hasStaleFillRaceFinding(retry().replace('Late fill after write.', prefix + ' Late fill after write.'))).toBe(false);
    }
    for (const heading of ['## Hypothetical example', '## Quoted source', '## Historical example only']) {
      expect(hasStaleFillRaceFinding(heading + '\n' + retry().replace('## Findings Registry', '### Findings Registry'))).toBe(false);
    }
    for (const withdrawal of ['F1 is rejected.', 'S1 is withdrawn.', 'The original schedule is impossible.', 'There is no stale-fill race.', 'Rejected: "There is no stale-fill race."']) {
      expect(hasStaleFillRaceFinding(retry() + '\n\n' + withdrawal)).toBe(false);
      expect(hasStaleFillRaceFinding(retry() + '\n\n### Assessment of F1\n' + withdrawal)).toBe(false);
      expect(hasStaleFillRaceFinding(retry().replace(' S2 join stale flight', withdrawal + '\n S2 join stale flight'))).toBe(false);
    }
    for (const withdrawal of ['S1 is withdrawn.', 'F1 is rejected.']) {
      expect(hasStaleFillRaceFinding(retry().replace(captured.retry.trace, captured.retry.trace + '\n' + withdrawal))).toBe(false);
    }
    expect(hasStaleFillRaceFinding(retry().split('\n').map(line => '> ' + line).join('\n'))).toBe(false);
    expect(hasStaleFillRaceFinding('````\n' + retry() + '\n````')).toBe(false);
    expect(hasStaleFillRaceFinding(retry().replace('Late fill after write.', 'If a late fill happens after write.'))).toBe(false);
  });

  test('consistent versions and independent later findings remain valid', () => {
    expect(hasStaleFillRaceFinding(retry().replaceAll('v1', 'v7').replaceAll('v2', 'v8').replaceAll('[key]', '[profileKey]').replaceAll('key#1', 'profileKey#1'))).toBe(true);
    expect(hasStaleFillRaceFinding('## Prior example\nHistorical only.\n\n## Current review\n' + retry().replace('## Findings Registry', '### Findings Registry'))).toBe(true);
    expect(hasStaleFillRaceFinding(retry() + '\n\n### Other finding\nF9 is rejected.')).toBe(true);
  });
});
