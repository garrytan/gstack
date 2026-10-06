/**
 * /ship Step 10 (CEO-19, ENG-1): the PR check runs before the Greptile triage
 * dispatch, and every outcome except an existing PR skips the dispatch with
 * its reason. The check block is executed from the generated section against
 * stub `gh` binaries.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SECTION = fs.readFileSync(path.join(ROOT, 'ship/sections/greptile.md.tmpl'), 'utf8');
const CHECK = SECTION.match(/```bash\n([\s\S]*?)\n```/)![1];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ship-greptile-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/**
 * Run the check with the stub gh first on PATH (or no gh at all when null).
 * The real PATH stays, so bash and coreutils resolve natively on every
 * platform, Windows Git Bash included.
 */
function check(gh: string | null): string {
  const bin = fs.mkdtempSync(path.join(tmp, 'bin-'));
  if (gh !== null) fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash\n${gh}\n`, { mode: 0o755 });
  const sep = process.platform === 'win32' ? ';' : ':';
  const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
  // Only the no-gh case drops directories that hold a real gh; a stub case keeps
  // the whole PATH (the stub's `env bash` must resolve) with the stub first.
  const inherited = (process.env[pathKey] ?? '').split(sep)
    .filter(dir => dir && (gh !== null || (!fs.existsSync(path.join(dir, 'gh')) && !fs.existsSync(path.join(dir, 'gh.exe')))));
  const env = { ...process.env, [pathKey]: [bin, ...inherited].join(sep), GH_TOKEN: '', GITHUB_TOKEN: '' };
  const r = spawnSync(Bun.which('bash')!, ['-c', CHECK], { cwd: tmp, encoding: 'utf8', timeout: 10_000, env });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}

describe('/ship Step 10 Greptile PR check', () => {
  test('the PR check precedes the dispatch, and only an existing PR dispatches', () => {
    const checkIdx = SECTION.indexOf('gh pr view --json number');
    const dispatchIdx = SECTION.indexOf('Dispatch a subagent through Agent');
    expect(checkIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(checkIdx);
    const between = SECTION.slice(checkIdx, dispatchIdx);
    expect(between).toContain('Only `PR: exists` dispatches.');
    expect(between).toContain('"Greptile: not run (<reason>); runs on the PR once it exists"');
    expect(SECTION).not.toContain('PR: unknown');
  });

  const ok = 'exit 0';
  const cases: Array<[string, string | null, string]> = [
    ['gh missing', null, 'PR: skip (gh not installed)'],
    ['gh not logged in', `[ "$1" = auth ] && { echo "You are not logged into any GitHub hosts." >&2; exit 1; }; ${ok}`, 'PR: skip (gh not logged in)'],
    ['non-GitHub remote', `[ "$1" = repo ] && { echo "none of the git remotes configured for this repository point to a known GitHub host" >&2; exit 1; }; ${ok}`,
      'PR: skip (not a GitHub remote: none of the git remotes configured for this repository point to a known GitHub host)'],
    ['no PR yet', `[ "$1" = pr ] && { echo 'no pull requests found for branch "feat"' >&2; exit 1; }; ${ok}`, 'PR: skip (no PR yet)'],
    ['other lookup error', `[ "$1" = pr ] && { printf 'HTTP 502: bad gateway\\nretry later\\n' >&2; exit 1; }; ${ok}`, 'PR: skip (PR lookup failed: HTTP 502: bad gateway)'],
    ['PR exists', `[ "$1" = pr ] && { echo 12; exit 0; }; ${ok}`, 'PR: exists'],
  ];
  for (const [name, gh, expected] of cases) {
    test(name, () => expect(check(gh)).toBe(expected));
  }
});
