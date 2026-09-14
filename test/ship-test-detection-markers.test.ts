/**
 * Regression: /ship Step 4 test-framework detection was blind to Django.
 *
 * A real Django project (manage.py + <app>/tests.py, green `python manage.py
 * test`, no pytest.ini and no tests/ directory) read as "no test framework",
 * so /ship bootstrapped pytest on top of a working suite. Same blindness hit
 * any config-less-but-tested project (Go *_test.go, in-source Rust #[test],
 * package.json with only a test script).
 *
 * These run the resolver's OWN emitted detection block against fixtures, so
 * the shell is checked, not just the prose — and the test is independent of
 * generated-SKILL.md regen state.
 *
 * Ported from time-attack/gstack commit e3259078 (GStack 2), adapted from the
 * fork's generated-markdown target to our resolver source of truth.
 */
import { describe, test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { generateTestBootstrap } from '../scripts/resolvers/testing';

const section = generateTestBootstrap({} as never);

/** The detection block the skill tells the agent to run (first bash fence). */
function detectionScript(): string {
  const open = section.indexOf('```bash\n');
  expect(open).toBeGreaterThan(-1);
  const start = open + '```bash\n'.length;
  const end = section.indexOf('```', start);
  return section.slice(start, end);
}

/** Run the detection block in a throwaway git repo laid out by `files`. */
function detect(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-detect-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    const script = path.join(dir, '.detect.sh');
    fs.writeFileSync(script, detectionScript());
    const git = (...args: string[]) => execFileSync('git', args, { timeout: 30_000, cwd: dir });
    git('init', '-q', '.');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture');
    // The block's last line is a `[ -f marker ] && echo`, so a clean project
    // exits 1 by design — read stdout, don't trust the status.
    return execFileSync('bash', [script], { timeout: 30_000, cwd: dir, encoding: 'utf-8' });
  } catch (err: unknown) {
    const e = err as { stdout?: string };
    if (typeof e.stdout === 'string') return e.stdout;
    throw err;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const testFileCount = (out: string): number =>
  Number(/^TESTFILES:(\d+)$/m.exec(out)?.[1] ?? -1);

describe('/ship Step 4 detection is multi-ecosystem', () => {
  test('Django project reports manage.py and its existing tests', () => {
    const out = detect({
      'manage.py': '#!/usr/bin/env python\n',
      'requirements.txt': 'Django==5.0\n',
      'polls/tests.py': 'from django.test import TestCase\n',
    });
    expect(out).toContain('MARKER:manage.py');
    expect(out).toContain('FRAMEWORK:django');
    expect(testFileCount(out)).toBeGreaterThan(0);
  });

  test('config-less projects with tests still report test evidence', () => {
    expect(testFileCount(detect({
      'go.mod': 'module x\n',
      'x_test.go': 'package x\n',
    }))).toBeGreaterThan(0);

    const node = detect({
      'package.json': '{"name":"n","scripts":{"test":"node --test"}}\n',
    });
    expect(node).toContain('SCRIPT:package.json test');

    const rust = detect({
      'Cargo.toml': '[package]\nname="x"\n',
      'src/lib.rs': '#[cfg(test)]\nmod t{ #[test] fn x(){} }\n',
    });
    expect(rust).toContain('TESTS:rust in-source');
  });

  test('a genuinely untested project reports no test evidence', () => {
    const out = detect({ 'go.mod': 'module x\n', 'x.go': 'package x\n' });
    expect(out).toContain('RUNTIME:go');
    expect(testFileCount(out)).toBe(0);
    expect(out).not.toContain('TESTS:');
  });

  test('every ecosystem marker maps to a command to OFFER, not to run blind', () => {
    expect(section).toContain('never a command to run blind');
    for (const marker of ['manage.py', 'go.mod', 'Cargo.toml', 'pom.xml',
      'build.gradle', 'mix.exs', 'composer.json', 'Gemfile', 'pytest.ini']) {
      expect(section).toContain(marker);
    }
    // The ask-and-persist contract, not a hardcoded project command.
    expect(section).toContain('AskUserQuestion');
    expect(section).toContain('persist the answer to CLAUDE.md');
  });
});
