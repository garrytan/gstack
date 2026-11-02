import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { attributeFreeHomeWriters, diffFreeHome, guardFreeHome, snapshotFreeHome } from '../scripts/lib/free-home-guard';
import { runFreeShard } from '../scripts/test-free-shards';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });

function fakeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'free-home-guard-'));
  homes.push(home);
  for (const dir of ['.gstack/security', '.claude/skills', '.claude/projects/p', '.codex/skills', '.agents/skills', '.config/gstack']) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(home, '.gstack/.last-setup-version'), '1.0.0\n');
  fs.writeFileSync(path.join(home, '.claude/projects/p/session.jsonl'), '{}\n');
  return home;
}

const bump = (file: string) => {
  const later = new Date(Date.now() + 5_000);
  fs.utimesSync(file, later, later);
};

describe('free-suite home-write tripwire (#2895)', () => {
  test.skipIf(process.platform === 'win32')('names install and state writes on every watched surface', () => {
    const home = fakeHome();
    const before = snapshotFreeHome(home);
    fs.writeFileSync(path.join(home, '.gstack/.last-setup-version'), '9.9.9\n');
    bump(path.join(home, '.gstack/.last-setup-version'));
    fs.appendFileSync(path.join(home, '.gstack/security/prepush-skip.jsonl'), '{"reason":"env-skip"}\n');
    fs.symlinkSync(path.join(home, 'checkout'), path.join(home, '.claude/skills/gstack'));
    fs.mkdirSync(path.join(home, '.codex/skills/gstack-qa'));
    fs.writeFileSync(path.join(home, '.agents/skills/marker'), 'x');
    fs.writeFileSync(path.join(home, '.config/gstack/config.yaml'), 'a: b\n');
    expect(diffFreeHome(before, snapshotFreeHome(home)).map(entry => entry.split(path.sep).join('/'))).toEqual([
      '.agents/skills/marker',
      '.claude/skills/gstack',
      '.codex/skills/gstack-qa',
      '.config/gstack/config.yaml',
      '.gstack/.last-setup-version',
      '.gstack/security/prepush-skip.jsonl',
    ]);
  });

  test('ignores live session logs and directory-only mtime churn', () => {
    const home = fakeHome();
    const before = snapshotFreeHome(home);
    fs.appendFileSync(path.join(home, '.claude/projects/p/session.jsonl'), '{"more":true}\n');
    fs.writeFileSync(path.join(home, '.claude/history.jsonl'), 'line\n');
    fs.writeFileSync(path.join(home, '.claude/.tmp-write'), 'x');
    fs.rmSync(path.join(home, '.claude/.tmp-write'));
    expect(diffFreeHome(before, snapshotFreeHome(home))).toEqual([]);
  });

  test.skipIf(process.platform === 'win32')('a removed entry and a retargeted link count as changes', () => {
    const home = fakeHome();
    fs.symlinkSync('/one', path.join(home, '.claude/skills/link'));
    const before = snapshotFreeHome(home);
    fs.rmSync(path.join(home, '.gstack/.last-setup-version'));
    fs.rmSync(path.join(home, '.claude/skills/link'));
    fs.symlinkSync('/two', path.join(home, '.claude/skills/link'));
    expect(diffFreeHome(before, snapshotFreeHome(home)).map(entry => entry.split(path.sep).join('/')))
      .toEqual(['.claude/skills/link', '.gstack/.last-setup-version']);
  });

  test('the guard reports nothing for an untouched home and names the shard files otherwise', () => {
    const home = fakeHome();
    expect(guardFreeHome(['test/a.test.ts'], { HOME: home }).verify()).toBeNull();
    const guard = guardFreeHome(['test/a.test.ts', 'test/b.test.ts'], { HOME: home });
    fs.writeFileSync(path.join(home, '.gstack/.last-setup-version'), '2.0.0\n');
    bump(path.join(home, '.gstack/.last-setup-version'));
    const failure = guard.verify();
    expect(failure).toContain('~/.gstack/.last-setup-version');
    expect(failure).toContain('Shard files: test/a.test.ts, test/b.test.ts');
    expect(failure).toContain('only');
  });

  test.skipIf(process.platform === 'win32')('the wrapping gstack-evidence lane log is excluded by its exact path; a foreign write beside it still trips', async () => {
    const home = fakeHome();
    const logs = path.join(home, '.gstack/projects/p/logs');
    fs.mkdirSync(logs, { recursive: true });
    const laneLog = path.join(logs, 'focused.log');
    fs.writeFileSync(laneLog, 'lane start\n');
    const unexcluded = guardFreeHome(['test/a.test.ts'], { HOME: home });
    const options = (script: string, name: string) => ({ env: { ...process.env, HOME: home, GSTACK_EVIDENCE_LOG: laneLog }, quiet: true, log: () => {},
      logFilePath: path.join(home, `${name}.log`),
      commandFor: () => ({ command: process.execPath, args: ['-e', `${script}console.log('Ran 1 tests across 1 files. [1.00ms]')`] }) });
    const grow = `require('fs').appendFileSync(${JSON.stringify(laneLog)}, 'lane output\\n');`;
    const errors: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
    try {
      expect((await runFreeShard(['test/a.test.ts'], 1, 1, options(grow, 'lane'))).status).toBe('passed');
      expect(unexcluded.verify()).toContain('~/.gstack/projects/p/logs/focused.log');
      const foreign = `${grow}require('fs').writeFileSync(${JSON.stringify(path.join(logs, 'other.log'))}, 'x');`;
      expect((await runFreeShard(['test/a.test.ts'], 1, 1, options(foreign, 'foreign'))).status).toBe('failed');
      expect(errors.join('\n')).toContain('~/.gstack/projects/p/logs/other.log');
      expect(errors.join('\n')).not.toContain('focused.log');
    } finally {
      spy.mockRestore();
      for (const retained of errors.flatMap(line => /retained (\S+)$/.exec(line)?.[1] ?? [])) {
        if (/^gstack-free-shard-/.test(path.basename(retained))) fs.rmSync(retained, { recursive: true, force: true });
      }
    }
  });

  test('a concurrent phase guard names no shard and points at attribution', () => {
    const home = fakeHome();
    const guard = guardFreeHome(['test/a.test.ts', 'test/b.test.ts'], { HOME: home }, { kind: 'concurrent', shards: 3 });
    fs.writeFileSync(path.join(home, '.gstack/security/egress.jsonl'), '{}\n');
    const failure = guard.verify();
    expect(failure).toContain('~/.gstack/security/egress.jsonl');
    expect(failure).toContain('while 3 shards ran concurrently');
    expect(failure).toContain('--attribute-home');
    expect(failure).not.toContain('test/a.test.ts');
  });

  test.skipIf(process.platform === 'win32')('attribution runs each file alone in a private HOME and names only the writer', async () => {
    const home = fakeHome();
    const before = snapshotFreeHome(home);
    const writer = `require('fs').mkdirSync(require('path').join(process.env.HOME, '.gstack', 'security'), { recursive: true });`
      + `require('fs').writeFileSync(require('path').join(process.env.HOME, '.gstack', 'security', 'attempts.jsonl'), '{}\\n');`
      + `console.log('Ran 1 tests across 1 files. [1.00ms]')`;
    const clean = `console.log('Ran 1 tests across 1 files. [1.00ms]')`;
    const errors: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const exitCode = await attributeFreeHomeWriters(['test/clean.test.ts', 'test/writer.test.ts'], [], 2, (file, index, homeGuard) =>
        runFreeShard([file], index + 1, 2, { env: { ...process.env, HOME: home }, quiet: true, log: () => {}, homeGuard,
          logFilePath: path.join(home, `${index}.log`),
          commandFor: () => ({ command: process.execPath, args: ['-e', file.includes('writer') ? writer : clean] }) }));
      expect(exitCode).toBe(1);
      const verdicts = errors.filter(line => line.startsWith('[test:free] ✗ '));
      expect(verdicts).toHaveLength(1);
      expect(verdicts[0]).toContain('test/writer.test.ts wrote its private HOME');
      expect(verdicts[0]).toContain('~/.gstack/security/attempts.jsonl');
      expect(diffFreeHome(before, snapshotFreeHome(home))).toEqual([]);
    } finally {
      spy.mockRestore();
      logSpy.mockRestore();
      for (const retained of errors.flatMap(line => /retained (\S+)$/.exec(line)?.[1] ?? [])) {
        if (/^gstack-free-shard-/.test(path.basename(retained))) fs.rmSync(retained, { recursive: true, force: true });
      }
    }
  });

  test.skipIf(process.platform === 'win32')('a free shard that writes the real home fails and names its files', async () => {
    const home = fakeHome();
    const writer = `require('fs').writeFileSync(require('path').join(process.env.HOME, '.gstack', '.last-setup-version'), '7.7.7\\n');`
      + `console.log('Ran 1 tests across 1 files. [1.00ms]')`;
    const clean = `console.log('Ran 1 tests across 1 files. [1.00ms]')`;
    const errors: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
    try {
      const options = (script: string) => ({ env: { ...process.env, HOME: home }, quiet: true, log: () => {},
        logFilePath: path.join(home, `${script === clean ? 'clean' : 'writer'}.log`),
        commandFor: () => ({ command: process.execPath, args: ['-e', script] }) });
      expect((await runFreeShard(['test/clean.test.ts'], 1, 2, options(clean))).status).toBe('passed');
      const outcome = await runFreeShard(['test/writer.test.ts'], 2, 2, options(writer));
      expect(outcome.status).toBe('failed');
      expect(outcome.unattributedFailures).toBeGreaterThan(0);
      expect(errors.join('\n')).toContain('~/.gstack/.last-setup-version');
      expect(errors.join('\n')).toContain('Shard files: test/writer.test.ts');
    } finally {
      spy.mockRestore();
      for (const retained of errors.flatMap(line => /retained (\S+)$/.exec(line)?.[1] ?? [])) {
        if (/^gstack-free-shard-/.test(path.basename(retained))) fs.rmSync(retained, { recursive: true, force: true });
      }
    }
  });
});
