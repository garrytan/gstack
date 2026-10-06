/**
 * A Windows host runtime root (~/.codex/skills/gstack and the other env-var
 * hosts) holds a copy of browse/dist with no node_modules, so its CLI starts
 * the source checkout's Node server bundle named by .source-path, and refuses
 * when the two come from different builds. Windows-safe (os.tmpdir paths
 * only), so the curated Windows lane runs it natively.
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'path';

describe('#3026: a Windows runtime root without node_modules runs the source checkout bundle', () => {
  const { resolveNodeServerScript } = require('../src/cli');
  const fs = require('fs');
  const os = require('os');

  function layout(opts: { runtimeModules: boolean; sourcePath: boolean; sourceModules: boolean }) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-runtime-root-'));
    const source = path.join(base, 'gstack');
    const runtime = path.join(base, 'home', '.codex', 'skills', 'gstack');
    for (const dir of [source, runtime]) {
      fs.mkdirSync(path.join(dir, 'browse', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'browse', 'dist', 'server-node.mjs'), '');
    }
    const playwright = (root: string) => {
      fs.mkdirSync(path.join(root, 'node_modules', 'playwright'), { recursive: true });
      fs.writeFileSync(path.join(root, 'node_modules', 'playwright', 'package.json'), '{}');
    };
    if (opts.sourceModules) playwright(source);
    if (opts.runtimeModules) playwright(runtime);
    if (opts.sourcePath) fs.writeFileSync(path.join(runtime, '.source-path'), `${source}\n`);
    return { base, source, runtime, exe: path.join(runtime, 'browse', 'dist', 'browse.exe') };
  }

  test('no reachable playwright beside the copy -> the checkout bundle named by .source-path', () => {
    const l = layout({ runtimeModules: false, sourcePath: true, sourceModules: true });
    try { expect(resolveNodeServerScript('/$bunfs/root', l.exe)).toBe(path.join(l.source, 'browse', 'dist', 'server-node.mjs')); }
    finally { fs.rmSync(l.base, { recursive: true, force: true }); }
  });

  test('a runtime root that reaches playwright keeps its own bundle', () => {
    const l = layout({ runtimeModules: true, sourcePath: true, sourceModules: true });
    try { expect(resolveNodeServerScript('/$bunfs/root', l.exe)).toBe(path.join(l.runtime, 'browse', 'dist', 'server-node.mjs')); }
    finally { fs.rmSync(l.base, { recursive: true, force: true }); }
  });

  test('without .source-path, or a checkout without node_modules, the adjacent bundle is unchanged', () => {
    for (const opts of [{ runtimeModules: false, sourcePath: false, sourceModules: true }, { runtimeModules: false, sourcePath: true, sourceModules: false }]) {
      const l = layout(opts);
      try { expect(resolveNodeServerScript('/$bunfs/root', l.exe)).toBe(path.join(l.runtime, 'browse', 'dist', 'server-node.mjs')); }
      finally { fs.rmSync(l.base, { recursive: true, force: true }); }
    }
  });

  test('same build on both sides -> the checkout bundle; different builds -> refusal with the ./setup fix and anchor', () => {
    const { BROWSE_VERSION_SKEW_ANCHOR } = require('../src/cli');
    const l = layout({ runtimeModules: false, sourcePath: true, sourceModules: true });
    const version = (root: string, v: string) => fs.writeFileSync(path.join(root, 'browse', 'dist', '.version'), `${v}\n`);
    try {
      version(l.runtime, 'a'.repeat(40));
      version(l.source, 'a'.repeat(40));
      expect(resolveNodeServerScript('/$bunfs/root', l.exe)).toBe(path.join(l.source, 'browse', 'dist', 'server-node.mjs'));
      version(l.source, 'b'.repeat(40));
      let message = '';
      try { resolveNodeServerScript('/$bunfs/root', l.exe); } catch (err: any) { message = err.message; }
      expect(message).toContain(`build ${'a'.repeat(12)}`);
      expect(message).toContain(`build ${'b'.repeat(12)}`);
      expect(message).toContain('are from different builds, so the server was not started');
      expect(message).toContain(`Fix: cd "${l.source}" && ./setup`);
      expect(message).toContain(BROWSE_VERSION_SKEW_ANCHOR);
      expect(BROWSE_VERSION_SKEW_ANCHOR).toBe('https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#browse-runtime-version-skew');
      // resolveServerLaunch surfaces the same refusal on Windows.
      expect(() => require('../src/cli').resolveServerLaunch('win32', {}, '/$bunfs/root', l.exe)).toThrow('different builds');
    } finally { fs.rmSync(l.base, { recursive: true, force: true }); }
  });

  test('an unversioned build on either side is not called skew', () => {
    const l = layout({ runtimeModules: false, sourcePath: true, sourceModules: true });
    try {
      fs.writeFileSync(path.join(l.runtime, 'browse', 'dist', '.version'), 'abc\n');
      expect(resolveNodeServerScript('/$bunfs/root', l.exe)).toBe(path.join(l.source, 'browse', 'dist', 'server-node.mjs'));
    } finally { fs.rmSync(l.base, { recursive: true, force: true }); }
  });

  test('setup records the source checkout in every runtime root it links', () => {
    const setup = fs.readFileSync(path.resolve(__dirname, '../../setup'), 'utf8');
    const fn = setup.slice(setup.indexOf('_link_runtime_dists() {'), setup.indexOf('\n}\n', setup.indexOf('_link_runtime_dists() {')));
    expect(fn).toContain(`printf '%s\\n' "$1" > "$2/.source-path"`);
    // Git Bash on Windows records a native (D:/...) path, not an MSYS one.
    expect(fn).toContain('cygpath -m "$1" > "$2/.source-path"');
  });

  test('an MSYS .source-path (/d/a/gstack) resolves to the drive path on Windows only', () => {
    const { nativeSourcePath } = require('../src/cli');
    expect(nativeSourcePath('/d/a/gstack/gstack', 'win32')).toBe('D:/a/gstack/gstack');
    expect(nativeSourcePath('/c', 'win32')).toBe('C:/');
    expect(nativeSourcePath('D:/a/gstack', 'win32')).toBe('D:/a/gstack');
    expect(nativeSourcePath('/home/u/gstack', 'linux')).toBe('/home/u/gstack');
    expect(nativeSourcePath('/home/u/gstack', 'win32')).toBe('/home/u/gstack');
  });
});
