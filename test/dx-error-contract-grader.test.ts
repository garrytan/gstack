import { describe, expect, test } from 'bun:test';
import { DX_ERROR_COMPACT, DX_ERROR_ITEMS } from '../lib/dx-error-contract';
import { DX_ERROR_CONTRACT_PLAN, capFindings, gradeDxContractReview } from './fixtures/dx-error-contract-case';

const SHA = 'a'.repeat(64);
const fence = (rows: Array<Record<string, unknown>>) => [`INPUT: dx ${SHA}`, 'Review prose.', '```gstack-findings', ...rows.map(row => JSON.stringify(row)), '```'].join('\n');
const PASSING = [
  { id: 'F1', severity: 'Critical', title: 'CAP4:P1:redaction --debug prints the bearer token' },
  { id: 'F2', severity: 'Critical', title: 'CAP4:P1:channel push failure exits 0 and blocks on a y/N prompt' },
  { id: 'F3', severity: 'Critical', title: 'CAP4:P1:fix --force skips the overwrite confirmation' },
  { id: 'F4', severity: 'High', title: 'CAP6:P1:context network error is swallowed' },
  { id: 'F5', severity: 'High', title: 'CAP6:P5:fix migrate has no error handling' },
  { id: 'F6', severity: 'Medium', title: 'Getting started takes four steps' },
];

describe('dx-error-contract-review grader (free controls for the paid case)', () => {
  test('the fixture plan labels five paths and keeps the decoy complete', () => {
    for (const path of ['P1', 'P2', 'P3', 'P4', 'P5']) expect(DX_ERROR_CONTRACT_PLAN).toContain(`### Error path ${path} `);
    expect(DX_ERROR_CONTRACT_PLAN).toContain('## Implementation plan');
    expect(DX_ERROR_CONTRACT_PLAN).toContain('(PROJECT_NOT_FOUND); fix: run');
  });

  test('the grader keys on the title and severity shapes the product prompt asks for', () => {
    expect(DX_ERROR_COMPACT).toContain('as a Critical finding titled "CAP4:<path>:<item> <what fails>"');
    expect(DX_ERROR_COMPACT).toContain('as a High finding titled "CAP6:<path>:<item> <what fails>"');
    const rows = DX_ERROR_ITEMS.map((item, index) => ({ id: `F${index}`, severity: 'High', title: `CAP6:P1:${item} gap` }));
    expect(capFindings(fence(rows)).map(cap => cap.item)).toEqual([...DX_ERROR_ITEMS]);
  });

  test('a review meeting every bar passes', () => {
    const grade = gradeDxContractReview(fence(PASSING), SHA);
    expect(grade.reasons).toEqual([]);
    expect(grade.pass).toBe(true);
  });

  test('command-named paths map to their labels', () => {
    const rows = PASSING.map(row => ({ ...row, title: String(row.title).replace(':P1:', ':acmesync push:').replace(':P5:', ':acmesync migrate:') }));
    expect(gradeDxContractReview(fence(rows), SHA).pass).toBe(true);
  });

  test.each([
    ['decoy capped', [...PASSING, { id: 'F7', severity: 'High', title: 'CAP6:P2:trace no trace' }], 'P2 should not be capped'],
    ['remote API penalized for trace', [...PASSING, { id: 'F7', severity: 'High', title: 'CAP6:P3:trace no stack trace' }], 'P3 should not be capped'],
    ['usage error capped', [...PASSING, { id: 'F7', severity: 'High', title: 'CAP6:P4:context no versions' }], 'P4 should not be capped'],
    ['secret leak missed', PASSING.filter(row => row.id !== 'F1'), 'P1 missing CAP4:redaction'],
    ['unsafe fix missed', PASSING.filter(row => row.id !== 'F3'), 'P1 missing CAP4:fix'],
    ['context gap missed', PASSING.filter(row => row.id !== 'F4'), 'P1 missing a CAP finding on context'],
    ['silent path missed', PASSING.filter(row => row.id !== 'F5'), 'P5 (unspecified error handling) not capped'],
    ['malformed severity on a decoy row', [...PASSING, { id: 'F7', severity: 'Banana', title: 'Looks fine' }], 'result:'],
    ['CAP4 under-rated', PASSING.map(row => row.id === 'F2' ? { ...row, severity: 'High' } : row), 'CAP4 labelled High, want Critical'],
  ])('%s fails', (_name, rows, reason) => {
    const grade = gradeDxContractReview(fence(rows as Array<Record<string, unknown>>), SHA);
    expect(grade.pass).toBe(false);
    expect(grade.reasons.join('\n')).toContain(reason);
  });

  test('a review with no findings fence, or bound to another snapshot, fails', () => {
    const unfenced = gradeDxContractReview(`INPUT: dx ${SHA}\nLooks fine to me.`, SHA);
    expect(unfenced.pass).toBe(false);
    expect(unfenced.reasons.join('\n')).toContain('gstack-findings');
    const rebound = gradeDxContractReview(fence(PASSING), 'b'.repeat(64));
    expect(rebound.pass).toBe(false);
    expect(rebound.reasons[0]).toContain('result: receipt names');
  });
});
