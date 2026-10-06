/**
 * /cso on Windows: docker.exe is discovered only under the known-folder
 * install roots (resolved through [Environment]::GetFolderPath, not the
 * process environment), by real path, with no symlink or junction on the way.
 * lib/cso/docker.ts admits only unix:/// endpoints, so a trusted docker.exe
 * yields the "native Windows Docker transport is not supported yet; static
 * assessment only" outcome, never a run; anything else is refused.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CsoError } from '../lib/cso/contracts';
import { WINDOWS_DOCKER_ANCHOR, windowsDockerUnavailable, type WindowsDockerProbe } from '../lib/cso/windows-docker';

const ROOTS = ['C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\Windows'];
const DESKTOP = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';

function probe(files: Record<string, string>, opts: { reparse?: string[]; roots?: string[]; onPath?: string } = {}): WindowsDockerProbe {
  const real = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    knownFolders: () => opts.roots ?? ROOTS,
    candidates: (roots) => [...(opts.onPath ? [opts.onPath] : []), ...roots.map((r) => `${r}\\Docker\\Docker\\resources\\bin\\docker.exe`)],
    realpath: (p) => {
      const hit = real.get(p.toLowerCase());
      if (!hit) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return hit;
    },
    isReparsePoint: (p) => (opts.reparse ?? []).some((r) => r.toLowerCase() === p.toLowerCase()),
  };
}

function outcome(p: WindowsDockerProbe): string {
  try {
    windowsDockerUnavailable(p);
  } catch (err) {
    expect(err).toBeInstanceOf(CsoError);
    return (err as Error).message;
  }
  throw new Error('windowsDockerUnavailable returned');
}

describe('/cso Windows Docker discovery', () => {
  test('Docker Desktop under Program Files: not supported yet, static assessment only, with the anchor', () => {
    const msg = outcome(probe({ [DESKTOP]: DESKTOP }));
    expect(msg).toBe(`Docker found at ${DESKTOP}, but native Windows Docker transport is not supported yet; static assessment only. ${WINDOWS_DOCKER_ANCHOR}`);
    expect(WINDOWS_DOCKER_ANCHOR).toBe('https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#cso-windows-docker');
  });

  test('a docker.exe on PATH in a user-writable directory is refused as outside the trusted install locations', () => {
    const user = 'C:\\Users\\dev\\AppData\\Local\\bin\\docker.exe';
    const msg = outcome(probe({ [user]: user }, { onPath: user }));
    expect(msg).toContain(`docker.exe at ${user} is outside the trusted install locations (${ROOTS.join(', ')})`);
    expect(msg).toContain('A user-writable directory is untrusted for a child that carries registry credentials');
    expect(msg).toContain('Fix: install Docker Desktop under Program Files, or run /cso static-only');
    expect(msg).toContain('This is not overridable');
    expect(msg).toContain(WINDOWS_DOCKER_ANCHOR);
  });

  test('a sibling directory that only shares the prefix is not under Program Files', () => {
    const evil = 'C:\\Program Files Evil\\docker.exe';
    expect(outcome(probe({ [evil]: evil }, { onPath: evil }))).toContain('is outside the trusted install locations');
  });

  test('the real path decides: a Program Files path that resolves into a user directory is refused', () => {
    const escaped = 'C:\\Users\\dev\\docker.exe';
    expect(outcome(probe({ [DESKTOP]: escaped }))).toContain(`docker.exe at ${DESKTOP} is outside the trusted install locations`);
  });

  test('a junction anywhere on the path is refused even when it resolves in place', () => {
    const msg = outcome(probe({ [DESKTOP]: DESKTOP }, { reparse: ['C:\\Program Files\\Docker'] }));
    expect(msg).toContain('reaches them through a symlink or junction');
  });

  test('roots come from the known-folder probe: an unresolved probe trusts nothing', () => {
    expect(outcome(probe({ [DESKTOP]: DESKTOP }, { roots: [], onPath: DESKTOP }))).toContain('outside the trusted install locations (none resolved)');
  });

  test('no docker.exe anywhere keeps the not-installed error', () => {
    expect(outcome(probe({}))).toBe('docker is not installed in a trusted system executable directory');
  });

  test('the system probe asks PowerShell for the known folders, never the environment', () => {
    const src = fs.readFileSync(path.join(import.meta.dir, '..', 'lib', 'cso', 'windows-docker.ts'), 'utf8');
    expect(src).toContain('[Environment]::GetFolderPath($_)');
    expect(src).toContain("'ProgramFiles','ProgramFilesX86','Windows'");
    expect(src).not.toMatch(/process\.env\.(ProgramFiles|ProgramW6432|"ProgramFiles)/);
    expect(src).toContain('realpathSync.native');
  });

  test('executable("docker") routes Windows through the discovery', () => {
    const src = fs.readFileSync(path.join(import.meta.dir, '..', 'lib', 'cso', 'process.ts'), 'utf8');
    expect(src).toContain("if (process.platform === 'win32' && name.toLowerCase() === 'docker') windowsDockerUnavailable();");
  });
});
