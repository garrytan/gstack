/**
 * #4784: a one-shot `aside repl` deletes its session directory when the script
 * ends and its sandbox refuses every path outside it (verified on Aside CLI
 * 1.26.1107), so the old "save with a relative path, print ASIDE_DIR=, cp it
 * afterwards" pattern always lost the file. Artifacts now leave over stdout
 * through bin/gstack-aside-repl. This file pins three things:
 *   1. no generated skill doc carries the copy-after-the-script pattern, and
 *      every Aside script that saves a file runs through the wrapper;
 *   2. the $B fallback never uses the wrapper or the old copy step;
 *   3. the wrapper's stdout contract, against a fake `aside`.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateBrowseFallback } from '../scripts/resolvers/browse';
import { HOST_PATHS } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');
const WRAPPER = path.join(ROOT, 'bin', 'gstack-aside-repl');

const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).stdout.split('\0').filter(Boolean);
const GENERATED = tracked.filter(f => f.endsWith('.md') && tracked.includes(`${f}.tmpl`));

/** Every bash script handed to Aside: [launcher line, script body]. */
function asideScripts(doc: string): Array<[string, string]> {
  return [...doc.matchAll(/^(.*\b(?:aside repl|gstack-aside-repl)\b.*) '\n([\s\S]*?)\n'\n/gm)].map(m => [m[1], m[2]]);
}

describe('#4784: generated skill docs never copy artifacts out of the Aside session directory', () => {
  test('the generated docs exist and some of them save Aside artifacts', () => {
    expect(GENERATED.length).toBeGreaterThan(40);
    expect(GENERATED.filter(f => fs.readFileSync(path.join(ROOT, f), 'utf8').includes('saveArtifact(')).length).toBeGreaterThanOrEqual(8);
  });

  for (const file of GENERATED) {
    const doc = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (!/aside repl|gstack-aside-repl|ASIDE_DIR|saveArtifact/.test(doc)) continue;
    test(`${file}: no ASIDE_DIR copy step, no file written into the session dir, every saving script wrapped`, () => {
      expect(doc).not.toContain('ASIDE_DIR');
      expect(doc).not.toMatch(/path\.join\(pwd/);
      expect(doc).not.toMatch(/\.(?:screenshot|pdf)\(\{ path/);
      for (const [launcher, body] of asideScripts(doc)) {
        const saves = /saveArtifact\(|fs\.writeFile/.test(body);
        if (!saves) continue;
        expect({ launcher, wrapped: /gstack-aside-repl --out \S/.test(launcher) }).toEqual({ launcher, wrapped: true });
        expect(body).not.toContain('fs.writeFile');
      }
    });
  }
});

describe('#4784: the $B fallback is unchanged by the Aside artifact fix', () => {
  const ctx = { skillName: 'browse', tmplPath: '', host: 'claude' as const, paths: HOST_PATHS['claude'] };
  for (const skillName of ['browse', 'qa', 'design-review', 'canary']) {
    test(`${skillName}: only the Aside column of the translation table names the wrapper; $B commands stay as they were`, () => {
      const fallback = generateBrowseFallback({ ...ctx, skillName });
      expect(fallback).not.toContain('ASIDE_DIR');
      for (const line of fallback.split('\n').filter(l => /saveArtifact|gstack-aside-repl|SAVED=/.test(l))) {
        const cells = line.split(' | ');
        expect({ line, row: line.startsWith('| ') }).toEqual({ line, row: true });
        expect(['\`$B screenshot <path>\` (already on disk) |', '\`$B pdf <out> [flags]\` |']).toContain(cells[cells.length - 1]);
      }
      if (fallback.includes('### Translate the Aside scripts')) {
        expect(fallback).toContain('| \`$B screenshot <path>\` (already on disk) |');
        expect(fallback).toContain('| \`$B pdf <out> [flags]\` |');
      }
    });
  }
});

describe.skipIf(process.platform === 'win32')('bin/gstack-aside-repl against a fake aside', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-repl-'));
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const scriptFile = path.join(tmp, 'script.js');
  /** A fake `aside`: records the script it got, then prints what the test says (MARK expands to the real marker). */
  const fake = (body: string, exit = 0) => fs.writeFileSync(path.join(bin, 'aside'), [
    '#!/bin/sh',
    `printf '%s' "$2" > ${JSON.stringify(scriptFile)}`,
    `MARK=$(head -1 ${JSON.stringify(scriptFile)} | sed 's/.*"\\(GSTACK_ARTIFACT_[0-9a-f]*\\)".*/\\1/')`,
    body,
    `exit ${exit}`,
  ].join('\n'), { mode: 0o755 });
  const run = (args: string[]) => spawnSync(WRAPPER, args, { cwd: tmp, encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const b64 = (s: string) => Buffer.from(s).toString('base64');

  test('saves each marked artifact to --out, prints SAVED= in its place and passes evidence lines through', () => {
    const out = path.join(tmp, 'ok');
    fake(`echo "URL=http://localhost/"; echo "$MARK shot.jpg 10 ${b64('JPEG-BYTES')}"; echo GSTACK_STEP_OK`);
    const r = run(['--out', out, 'saveArtifact("shot.jpg", await pg.screenshot())']);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(out, 'shot.jpg'), 'utf8')).toBe('JPEG-BYTES');
    expect(r.stdout.split('\n')).toEqual(['URL=http://localhost/', `SAVED=${path.join(out, 'shot.jpg')} bytes=10`, 'GSTACK_STEP_OK', '']);
    expect(r.stdout).not.toContain(b64('JPEG-BYTES'));
    const script = fs.readFileSync(scriptFile, 'utf8');
    expect(script.split('\n')[0]).toStartWith('const saveArtifact = ');
    expect(script.split('\n').slice(1).join('\n')).toBe('saveArtifact("shot.jpg", await pg.screenshot())');
  });

  test('the injected saveArtifact prints name, byte count and data on one line, and throws on a name that is not one plain file name', () => {
    fake('echo GSTACK_STEP_OK');
    run(['--out', path.join(tmp, 'prelude'), 'await 1']);
    const prelude = fs.readFileSync(scriptFile, 'utf8').split('\n')[0];
    const lines: string[] = [];
    const call = (body: string) => new Function('Buffer', 'console', `${prelude}\n${body}`)(Buffer, { log: (s: string) => lines.push(s) });
    call('saveArtifact("a.txt", "h\u00e9\\nx"); saveArtifact("b.bin", new Uint8Array([0, 1, 255]));');
    expect(lines).toHaveLength(2);
    const [, nameA, sizeA, dataA] = lines[0].split(' ');
    const [, nameB, sizeB, dataB] = lines[1].split(' ');
    expect([nameA, sizeA, Buffer.from(dataA, 'base64').toString('utf8')]).toEqual(['a.txt', '5', 'h\u00e9\nx']);
    expect([nameB, sizeB, [...Buffer.from(dataB, 'base64')]]).toEqual(['b.bin', '3', [0, 1, 255]]);
    for (const bad of ['flow-sign up.jpg', '../up.jpg', 'a/b.jpg', '']) {
      expect(() => call(`saveArtifact(${JSON.stringify(bad)}, "x")`)).toThrow('saveArtifact: bad name');
    }
    expect(lines).toHaveLength(2);
  });

  test('a line that imitates an artifact without the per-run marker (page text) is never written', () => {
    const out = path.join(tmp, 'forged');
    fake(`echo "GSTACK_ARTIFACT_00000000 evil.jpg ${b64('evil')}"; echo GSTACK_STEP_OK`);
    const r = run(['--out', out, 'await 1']);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(out, 'evil.jpg'))).toBe(false);
    expect(r.stdout).toContain('IGNORED a line that imitates an artifact (wrong marker)');
    expect(r.stdout).not.toContain(b64('evil'));
  });

  test('a name with a folder, a leading dot or a parent step is refused and the run fails', () => {
    const out = path.join(tmp, 'names');
    fake(`for n in ../up.jpg a/b.jpg .hidden; do echo "$MARK $n 1 ${b64('x')}"; done; echo GSTACK_STEP_OK`);
    const r = run(['--out', out, 'await 1']);
    expect(r.status).toBe(1);
    expect(r.stdout.match(/^ARTIFACT_ERROR=bad name/gm)).toHaveLength(3);
    expect(fs.existsSync(path.join(tmp, 'up.jpg'))).toBe(false);
    expect(fs.existsSync(out) ? fs.readdirSync(out) : []).toEqual([]);
  });

  test('a line whose data decodes to another byte count (truncated output) or that has extra fields is an error, never a file', () => {
    const out = path.join(tmp, 'short');
    fake(`echo "$MARK cut.png 999 ${b64('only-part')}"; echo "$MARK my file.png 1 ${b64('x')}"; echo GSTACK_STEP_OK`);
    const r = run(['--out', out, 'await 1']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('truncated: expected 999 bytes, decoded 9');
    expect(r.stdout.match(/^ARTIFACT_ERROR=/gm)).toHaveLength(2);
    expect(fs.existsSync(out) ? fs.readdirSync(out) : []).toEqual([]);
  });

  test('an existing symlink at the target is not written through', () => {
    const out = path.join(tmp, 'link');
    const victim = path.join(tmp, 'victim.txt');
    fs.mkdirSync(out);
    fs.writeFileSync(victim, 'keep');
    fs.symlinkSync(victim, path.join(out, 'shot.jpg'));
    fake(`echo "$MARK shot.jpg 9 ${b64('overwrite')}"; echo GSTACK_STEP_OK`);
    const r = run(['--out', out, 'await 1']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('refusing to write through a symlink');
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep');
  });

  test("aside's own exit code comes through, and a missing --out is a usage error", () => {
    fake('echo "[error boom"', 3);
    expect(run(['--out', path.join(tmp, 'exit'), 'await 1']).status).toBe(3);
    const usage = run(['await 1']);
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('usage: gstack-aside-repl --out <dir>');
  });
});
