import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { win32 } from 'node:path';
import { CsoError } from './contracts';

export const WINDOWS_DOCKER_ANCHOR =
  'https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#cso-windows-docker';

export interface WindowsDockerProbe {
  /** Known-folder roots (Program Files, Program Files (x86), Windows), never the process environment. */
  knownFolders(): string[];
  /** Candidate docker.exe paths: a PATH lookup and the Docker Desktop default under each root. */
  candidates(roots: string[]): string[];
  realpath(path: string): string;
  isReparsePoint(path: string): boolean;
}

function under(path: string, root: string): boolean {
  const p = win32.resolve(path).toLowerCase();
  const r = win32.resolve(root).toLowerCase().replace(/\\+$/, '');
  return p.startsWith(`${r}\\`);
}

/** Every existing component of `path` from its drive root down, the file included. */
function components(path: string): string[] {
  const resolved = win32.resolve(path);
  const root = win32.parse(resolved).root;
  const parts = resolved.slice(root.length).split('\\').filter(Boolean);
  return parts.map((_, i) => win32.join(root, ...parts.slice(0, i + 1)));
}

/**
 * /cso on Windows: find docker.exe only under the known-folder install roots.
 * Each candidate's real path must stay under a root and no component may be a
 * reparse point (symlink or junction). A bound docker.exe still cannot carry
 * /cso's isolation (lib/cso/docker.ts admits only unix:/// endpoints), so this
 * always throws: the "not supported yet" outcome when Docker is trusted, the
 * refusal when it is outside the trusted locations, or the not-installed error.
 */
export function windowsDockerUnavailable(probe: WindowsDockerProbe = systemProbe()): never {
  let roots: string[] = [];
  try {
    roots = probe.knownFolders().filter((root) => win32.isAbsolute(root));
  } catch {}
  const found = [...new Set(probe.candidates(roots))].filter((candidate) => {
    try {
      probe.realpath(candidate);
      return true;
    } catch {
      return false;
    }
  });
  if (!found.length)
    throw new CsoError(
      'TOOL_UNAVAILABLE',
      'docker is not installed in a trusted system executable directory',
    );
  for (const candidate of found) {
    let real = '';
    try {
      real = probe.realpath(candidate);
      if (components(candidate).some((part) => probe.isReparsePoint(part))) continue;
    } catch {
      continue;
    }
    if (win32.resolve(real).toLowerCase() !== win32.resolve(candidate).toLowerCase()) continue;
    if (!roots.some((root) => under(real, root))) continue;
    throw new CsoError(
      'TOOL_UNAVAILABLE',
      `Docker found at ${real}, but native Windows Docker transport is not supported yet; static assessment only. ${WINDOWS_DOCKER_ANCHOR}`,
    );
  }
  throw new CsoError(
    'TOOL_UNAVAILABLE',
    `docker.exe at ${found[0]} is outside the trusted install locations (${roots.join(', ') || 'none resolved'}), ` +
      'or reaches them through a symlink or junction. A user-writable directory is untrusted for a child that ' +
      'carries registry credentials. Fix: install Docker Desktop under Program Files, or run /cso static-only. ' +
      `This is not overridable. ${WINDOWS_DOCKER_ANCHOR}`,
  );
}

function systemProbe(): WindowsDockerProbe {
  const windows = process.env.SystemRoot || 'C:\\Windows';
  return {
    knownFolders() {
      const r = spawnSync(
        win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "'ProgramFiles','ProgramFilesX86','Windows' | ForEach-Object { [Environment]::GetFolderPath($_) }",
        ],
        { encoding: 'utf8', timeout: 10_000, windowsHide: true },
      );
      if (r.status !== 0) return [];
      return r.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    },
    candidates(roots) {
      const onPath = Bun.which('docker');
      return [
        ...(onPath ? [onPath] : []),
        ...roots.map((root) => win32.join(root, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')),
      ];
    },
    realpath: (path) => realpathSync.native(path),
    isReparsePoint: (path) => lstatSync(path).isSymbolicLink(),
  };
}
