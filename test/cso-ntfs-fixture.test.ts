import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPrecisionLossCandidate } from './helpers/cso-ntfs-fixture';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ntfs-fixture-'));
  roots.push(root);
  return { root, target: path.join(root, 'candidate.json') };
}

test('the actual candidate builder reaches a precision-losing generation in a fresh allocator model', () => {
  const { root, target } = fixture();
  const generations = new Map<number, bigint>();
  let reads = 0;
  let selectedIdentity: bigint | undefined;
  const inode = createPrecisionLossCandidate(target, 'owned candidate', file => {
    reads++;
    const slot = Number(path.basename(file).split('-').at(-1));
    const generation = (generations.get(slot) ?? 0n) + 1n;
    generations.set(slot, generation);
    const result = (generation << 48n) + BigInt(101 + slot);
    if (result > BigInt(Number.MAX_SAFE_INTEGER) && String(Number(result)) !== String(result)) {
      selectedIdentity = fs.lstatSync(file, { bigint: true }).ino;
    }
    return result;
  });
  expect(inode).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  expect(String(Number(inode))).not.toBe(String(inode));
  expect(reads).toBeLessThanOrEqual(1024);
  expect(fs.lstatSync(target, { bigint: true }).ino).toBe(selectedIdentity);
  expect(fs.readFileSync(target, 'utf8')).toBe('owned candidate');
  expect(fs.readdirSync(root)).toEqual(['candidate.json']);
});

test('an unavailable precision-losing ID fails at the original creation bound and leaves no candidate', () => {
  const { root, target } = fixture();
  for (const inode of [1n, 2n ** 54n]) {
    let reads = 0;
    expect(() => createPrecisionLossCandidate(target, 'owned candidate', () => { reads++; return inode; }))
      .toThrow('within 1024 file creations');
    expect(reads).toBe(1024);
    expect(fs.readdirSync(root)).toEqual([]);
  }
});

test('existing targets and candidate-inspection failures never overwrite unrelated fixture state', () => {
  const { root, target } = fixture();
  fs.writeFileSync(target, 'preserved');
  expect(() => createPrecisionLossCandidate(target, 'replacement')).toThrow('already exists');
  expect(fs.readFileSync(target, 'utf8')).toBe('preserved');
  const next = path.join(root, 'next.json');
  expect(() => createPrecisionLossCandidate(next, 'owned candidate', () => { throw new Error('inspection failed'); }))
    .toThrow('inspection failed');
  expect(fs.readdirSync(root)).toEqual(['candidate.json']);
});

test('a concurrent target and a linked parent are preserved rather than written through', () => {
  const { root, target } = fixture();
  expect(() => createPrecisionLossCandidate(target, 'replacement', () => {
    fs.writeFileSync(target, 'concurrent fixture');
    return (1n << 54n) + 1n;
  })).toThrow();
  expect(fs.readFileSync(target, 'utf8')).toBe('concurrent fixture');
  const owned = path.join(root, 'owned');
  const link = path.join(root, 'linked');
  fs.mkdirSync(owned);
  fs.symlinkSync(owned, link, process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => createPrecisionLossCandidate(path.join(link, 'candidate.json'), 'replacement'))
    .toThrow('must not be linked');
  expect(fs.readdirSync(owned)).toEqual([]);
});
