import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const DRIVER = path.join(ROOT, 'bin', 'gstack-jsonl-merge');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-jsonl-merge-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Run the merge driver the way git does: `driver <base> <ours> <theirs>`.
 * The driver writes the merged result back to the <ours> file. Returns that
 * file's content. `base`/`ours`/`theirs` are arrays of JSONL lines (the file
 * is created from them); pass `null` to omit a file entirely (git passes an
 * absent path for an added file, which the driver must tolerate).
 */
function runMerge(
  base: string[] | null,
  ours: string[] | null,
  theirs: string[] | null,
): string {
  const write = (name: string, lines: string[] | null): string => {
    const p = path.join(tmpDir, name);
    if (lines === null) return path.join(tmpDir, `${name}.absent`);
    fs.writeFileSync(p, lines.length ? lines.join('\n') + '\n' : '');
    return p;
  };
  const basePath = write('base', base);
  const oursPath = write('ours', ours);
  const theirsPath = write('theirs', theirs);
  execFileSync(DRIVER, [basePath, oursPath, theirsPath], {
    encoding: 'utf-8',
    timeout: 15000,
  });
  return fs.readFileSync(oursPath, 'utf-8');
}

describe('gstack-jsonl-merge', () => {
  test('equal-ts entries resolve identically regardless of side (convergence)', () => {
    // Two machines append a different event in the same second, then each
    // merges the other's push. Machine A sees its own line as "ours"; machine
    // B sees the same line as "theirs". The merge must produce the same file
    // on both, or the repos diverge and never reconcile.
    const a = '{"ts":"2026-05-28T10:00:00Z","event":"a"}';
    const b = '{"ts":"2026-05-28T10:00:00Z","event":"b"}';

    const machineA = runMerge([], [a], [b]); // a = ours, b = theirs
    const machineB = runMerge([], [b], [a]); // b = ours, a = theirs

    expect(machineA).toBe(machineB);
    // Both lines survive.
    expect(machineA).toContain('"event":"a"');
    expect(machineA).toContain('"event":"b"');
  });

  test('non-timestamped lines also resolve identically regardless of side', () => {
    const a = '{"event":"a"}'; // no ts -> hash-ordered
    const b = '{"event":"b"}';
    expect(runMerge([], [a], [b])).toBe(runMerge([], [b], [a]));
  });

  test('plain (non-JSON) lines resolve identically regardless of side', () => {
    expect(runMerge([], ['zebra'], ['apple'])).toBe(
      runMerge([], ['apple'], ['zebra']),
    );
  });

  test('exact-duplicate lines are deduped', () => {
    const line = '{"ts":"2026-05-28T10:00:00Z","event":"a"}';
    const out = runMerge([line], [line], [line]);
    expect(out.trimEnd().split('\n')).toEqual([line]);
  });

  test('timestamped entries sort ascending by ts', () => {
    const early = '{"ts":"2026-05-28T09:00:00Z","event":"early"}';
    const late = '{"ts":"2026-05-28T11:00:00Z","event":"late"}';
    const out = runMerge([], [late], [early]).trimEnd().split('\n');
    expect(out).toEqual([early, late]);
  });

  test('absent ours/theirs files are tolerated (added-file merge)', () => {
    const a = '{"ts":"2026-05-28T10:00:00Z","event":"a"}';
    const out = runMerge(null, [a], null);
    expect(out.trimEnd()).toBe(a);
  });
});
