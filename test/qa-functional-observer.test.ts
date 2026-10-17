import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createQAFunctionalFixture, fixtureCommand, fixtureGit } from './helpers/qa-functional-fixture';
import { decodeQAInotify, observeQAWrites, qaWriteVerdict, qaCommandAllowed } from './helpers/qa-functional-observer';

const kernelRecord = (wd: number, mask: number) => {
  const buffer = Buffer.alloc(16);
  buffer.writeInt32LE(wd, 0); buffer.writeUInt32LE(mask, 4);
  return buffer;
};

describe('QA command-observation boundary', () => {
  test('registered functional callback denies external mutation and permits owned webhook probes', async () => {
    const fixture = createQAFunctionalFixture('webhook');
    let mutations = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
      if (request.method === 'POST') mutations++;
      return new Response('synthetic mutation target');
    } });
    try {
      const settings = path.join(fixture.config, 'settings.json');
      expect(fixture.config.startsWith(fixture.root + path.sep)).toBe(false);
      expect(fs.statSync(fixture.config).mode & 0o777).toBe(0o700);
      expect(fs.existsSync(settings)).toBe(true);
      const registration = JSON.parse(fs.readFileSync(settings, 'utf8')).hooks.PreToolUse;
      expect(registration).toHaveLength(1);
      expect(registration[0].matcher).toBe('^Bash$');
      const callback = (command: string, extra: Record<string, unknown> = {}) => {
        const result = spawnSync('bash', ['-c', registration[0].hooks[0].command], {
          cwd: fixture.root, input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: fixture.root,
            tool_name: 'Bash', tool_input: { command, ...extra } }), encoding: 'utf8', timeout: 5000,
        });
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;
      };
      const command = `curl -X POST http://127.0.0.1:${server.port}/mutate`;
      const decision = callback(command);
      if (decision === 'allow') await fetch(`http://127.0.0.1:${server.port}/mutate`, { method: 'POST' });
      expect(decision).toBe('deny');
      expect(mutations).toBe(0);
      expect(fixtureGit(fixture.root, ['status', '--porcelain'])).toBe('');
      expect(callback('bun run probe -- happy', { run_in_background: true })).toBe('deny');
      expect(callback('bun run probe -- happy')).toBe('allow');
      const allowed = fixtureCommand(fixture.root, ['probe.ts', 'happy']);
      expect(allowed.exit, allowed.stderr).toBe(0);
      expect(JSON.parse(allowed.stdout).state.effects).toHaveLength(1);
    } finally {
      server.stop(true);
      fixture.cleanup();
      expect(fs.existsSync(fixture.config)).toBe(false);
    }
  });

  test('captured 39006896632 webhook-report cat attempts stay denied (Q3 negative controls)', () => {
    // qa-functional-webhook-report, paid run 39006896632: the hook denied two shell reads the prompt routes to Read/Glob/Grep.
    const fixture = createQAFunctionalFixture('webhook');
    try {
      const registration = JSON.parse(fs.readFileSync(path.join(fixture.config, 'settings.json'), 'utf8')).hooks.PreToolUse;
      for (const command of ['cat package.json probe.ts .gitignore', 'cat src/*.ts test/*.ts']) {
        expect(qaCommandAllowed(command, fixture.root), command).toBe(false);
        const result = spawnSync('bash', ['-c', registration[0].hooks[0].command], {
          cwd: fixture.root, input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: fixture.root, tool_name: 'Bash', tool_input: { command } }),
          encoding: 'utf8', timeout: 5000,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny',
          permissionDecisionReason: 'Only foreground commands from the owned functional fixture interface are authorized.' });
      }
    } finally { fixture.cleanup(); }
  });

  test('admits native fixture commands and rejects unobserved shell effects', () => {
    for (const command of ['date -u +%Y-%m-%dT%H:%M:%SZ', 'bun run probe -- apply credit 7junk', 'bun run probe -- apply UPPER 7', 'bun run probe -- apply 9bad 7', 'bun run probe -- apply', 'bun run probe -- apply credit', 'bun run probe -- apply credit 7 extra', 'bun run probe -- partial', 'bun test test/regression.test.ts', 'git status --short']) expect(qaCommandAllowed(command)).toBe(true);
    for (const command of ['bun bin/gstack-qa-evidence', 'bun /abs/runtime/bin/gstack-qa-deadline', 'bun bin/gstack-qa-evidence --help']) expect(qaCommandAllowed(command), command).toBe(true);
    for (const command of ['bun bin/gstack-qa-evidence capture', 'bun bin/gstack-qa-deadline start x 1', 'bun bin/gstack-qa-evidence; touch bad']) expect(qaCommandAllowed(command), command).toBe(false);
    for (const command of ['date', 'date -u', 'date -u +%s', ' date -u +%Y-%m-%dT%H:%M:%SZ', 'date -u +%Y-%m-%dT%H:%M:%SZ ', 'date -u +%Y-%m-%dT%H:%M:%SZ --set tomorrow', 'python3 mutate-with-mmap.py', 'echo ok; git commit -am fix', 'bun test > result.txt', 'curl https://example.com', 'bun -e "42"', 'git stash', 'git reset --hard', 'bun run probe -- partial && true', 'bun run probe -- apply $(touch bad) 7', 'bun run probe -- apply * 7', 'bun run probe -- apply credit 7; touch bad']) expect(qaCommandAllowed(command)).toBe(false);
  });
  test('malformed event buffers cannot become empty successful observations', () => {
    expect(() => decodeQAInotify(Buffer.alloc(1))).toThrow('truncated');
    const buffer = kernelRecord(1, 2); buffer.writeUInt32LE(80, 12);
    expect(() => decodeQAInotify(buffer)).toThrow('truncated');
  });
});

(process.platform === 'linux' ? describe : describe.skip)('QA independent kernel write observer', () => {
  for (const mutation of ['restore', 'shell', 'rename', 'delete', 'new-test', 'git', 'hardlink']) {
    test(`rejects ${mutation} even when the final tracked diff is clean`, async () => {
      const fixture = createQAFunctionalFixture('cli');
      const observer = await observeQAWrites(fixture.root);
      try {
        const source = path.join(fixture.root, 'src/cli.ts');
        const original = fs.readFileSync(source, 'utf8');
        if (mutation === 'restore') { fs.writeFileSync(source, 'changed'); fs.writeFileSync(source, original); }
        if (mutation === 'shell') fixtureCommand(fixture.root, ['-e', `const fs = require('fs'); const p = 'src/cli.ts'; const old = fs.readFileSync(p); fs.writeFileSync(p, 'changed'); fs.writeFileSync(p, old);`]);
        if (mutation === 'rename') { fs.renameSync(source, source + '.moved'); fs.renameSync(source + '.moved', source); }
        if (mutation === 'delete') { fs.unlinkSync(source); fs.writeFileSync(source, original); }
        if (mutation === 'new-test') { const file = path.join(fixture.root, 'test/unwanted.test.ts'); fs.writeFileSync(file, 'test'); fs.unlinkSync(file); }
        if (mutation === 'git') { fixtureGit(fixture.root, ['commit', '--allow-empty', '-m', 'Forbidden commit']); fixtureGit(fixture.root, ['reset', '--soft', fixture.revision]); }
        if (mutation === 'hardlink') { const link = path.join(fixture.root, '.qa-state/link'); fs.linkSync(source, link); fs.writeFileSync(link, 'changed'); fs.writeFileSync(link, original); fs.unlinkSync(link); }
        expect(fixtureGit(fixture.root, ['diff'])).toBe('');
        expect(qaWriteVerdict(observer.stop(), 'qa-only').length).toBeGreaterThan(0);
      } finally { fixture.cleanup(); }
    });
  }

  test('allows only owned fixture state and report writes in report-only mode', async () => {
    const fixture = createQAFunctionalFixture('cli');
    const observer = await observeQAWrites(fixture.root);
    try {
      fixtureCommand(fixture.root, ['src/cli.ts', 'apply', 'credit', '7']);
      fs.writeFileSync(path.join(fixture.root, 'qa-reports/report.md'), 'Synthetic evidence');
      const result = observer.stop();
      expect(result.events.length).toBeGreaterThan(2);
      expect(qaWriteVerdict(result, 'qa-only')).toEqual([]);
    } finally { fixture.cleanup(); }
  });

  for (const [label, record] of [['overflow', kernelRecord(-1, 0x4000)], ['unknown watch', kernelRecord(99999, 2)], ['truncated', Buffer.alloc(1)]] as const) {
    test(`fails closed for ${label}`, async () => {
      const fixture = createQAFunctionalFixture('cli');
      const observer = await observeQAWrites(fixture.root);
      try {
        observer.injectKernelRecordsForTest(record);
        const result = observer.stop();
        expect(result.complete).toBe(false);
        expect(qaWriteVerdict(result, 'qa-only')).toContain('incomplete write observation');
      } finally { fixture.cleanup(); }
    });
  }

  // ci-36709485593-1-eval-slices-6 qa-functional-cli-fix: link(2) raised the temporary receipt's nlink to 2 before the
  // receipt.json name resolved, so the observer's open failed with ENOENT during an ordinary atomic publication.
  for (const variant of ['published', 'foreign-link-kept', 'foreign-link-dropped', 'replaced-target'] as const) {
    test(`evidence publication observed mid-link: ${variant}`, async () => {
      const fixture = createQAFunctionalFixture('cli');
      const outside = fs.mkdtempSync(path.join(path.dirname(fixture.root), 'qa-link-'));
      const observer = await observeQAWrites(fixture.root, { evidenceProducer: true });
      try {
        const directory = path.join(fixture.root, 'qa-reports/.qa-evidence/002');
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        observer.drain();
        const temporary = path.join(directory, 'receipt.json.tmp.2282.fd4f6b4d');
        const target = path.join(directory, 'receipt.json');
        const foreign = path.join(outside, 'second-name');
        fs.writeFileSync(temporary, JSON.stringify({ version: 1, id: '002', status: 'complete' }), { mode: 0o600 });
        fs.linkSync(temporary, foreign);
        observer.drain();
        if (variant === 'published') { fs.unlinkSync(foreign); fs.linkSync(temporary, target); observer.drain(); fs.unlinkSync(temporary); }
        if (variant === 'foreign-link-dropped') fs.unlinkSync(temporary);
        if (variant === 'replaced-target') { fs.unlinkSync(foreign); fs.unlinkSync(temporary); fs.writeFileSync(target, '{}', { mode: 0o600 }); }
        const verdict = qaWriteVerdict(observer.stop(), 'qa-only');
        if (variant === 'published') expect(verdict).toEqual([]);
        else expect(verdict).toContain('incomplete write observation');
      } finally { fixture.cleanup(); fs.rmSync(outside, { recursive: true, force: true }); }
    });
  }

  test('lost directory watches and allowed-directory link substitutions fail closed', async () => {
    const fixture = createQAFunctionalFixture('cli');
    const observer = await observeQAWrites(fixture.root);
    try {
      const reports = path.join(fixture.root, 'qa-reports');
      fs.rmdirSync(reports);
      fs.symlinkSync(path.join(fixture.root, 'src'), reports);
      expect(qaWriteVerdict(observer.stop(), 'qa-only').length).toBeGreaterThan(0);
    } finally { fixture.cleanup(); }
  });

  test('demonstrates mmap blind spot and rejects its unobserved command class', async () => {
    const { dlopen, FFIType, toArrayBuffer } = await import('bun:ffi');
    const libc = dlopen('libc.so.6', {
      mmap: { args: [FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i64], returns: FFIType.ptr },
      msync: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
      munmap: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    });
    const fixture = createQAFunctionalFixture('cli');
    const source = path.join(fixture.root, 'src/cli.ts');
    const fd = fs.openSync(source, 'r+');
    const address = libc.symbols.mmap(null, 1, 3, 1, fd, 0);
    if (!address || Number(address) === -1) throw new Error('mmap control unavailable');
    const monitor = await observeQAWrites(fixture.root);
    try {
      const bytes = new Uint8Array(toArrayBuffer(address, 0, 1));
      const original = bytes[0]!;
      bytes[0] = 120; libc.symbols.msync(address, 1, 4);
      bytes[0] = original; libc.symbols.msync(address, 1, 4);
      const observation = monitor.stop();
      expect(qaWriteVerdict(observation, 'qa-only')).toEqual([]);
      expect(observation.limits.join(' ')).toContain('memory-mapped');
      expect(qaCommandAllowed('python3 mmap-and-restore.py')).toBe(false);
    } finally {
      libc.symbols.munmap(address, 1); fs.closeSync(fd); libc.close(); fixture.cleanup();
    }
  });
});
