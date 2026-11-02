/**
 * The Go build check gstack-checks detects runs through the same bash invocation pregate's supervise uses (Git Bash on
 * Windows), so its discard path must survive bash: os.devNull on Windows is \\.\nul, which bash mangles to \.nul.
 * Kept out of test/gstack-checks.test.ts so a lane with Go can run it on its own. Skips where Go is not installed.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { manifestChecks } from '../lib/checks';
import { bashCommandInvocation } from '../lib/script-invocation';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-checks-go-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), text); };
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)).map(f => `${e.name}/${f}`) : [e.name]).sort();

describe('the detected Go build check', () => {
  // Value: protects=the build check passes and writes nothing on a one-main module and a three-main module;
  //   fails_when=the discard path is mangled (a false FAIL on several mains) or dropped (a binary lands in the tree);
  //   why_new=the -o discard is new; seam=the production bash invocation; no_claim=Go toolchains without go on PATH
  test.skipIf(!Bun.which('go'))('builds every package through bash and leaves the tree unchanged', () => {
    // One root main package (go build would write ./x) and three main packages (a mangled -o path fails with several).
    for (const [mod, mains] of [['one', ['main.go']], ['many', ['main.go', 'cmd/a/main.go', 'cmd/b/main.go']]] as const) {
      const dir = path.join(tmp, mod);
      write(`${mod}/go.mod`, `module example.com/${mod}\n\ngo 1.21\n`);
      for (const rel of mains) write(`${mod}/${rel}`, 'package main\n\nfunc main() {}\n');
      const before = files(dir);
      const build = manifestChecks(dir).find(c => c.name === 'build')!;
      const inv = bashCommandInvocation(build.command);
      if (!inv.ok) throw new Error(inv.error);
      const r = spawnSync(inv.cmd, inv.argv, { cwd: dir, encoding: 'utf8', timeout: 120_000, env: { ...process.env, GOWORK: 'off' } });
      expect(`${r.stdout}${r.stderr}`).toBe('');
      expect(r.status).toBe(0);
      expect(files(dir)).toEqual(before);
    }
  }, 150_000);
});
