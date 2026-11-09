/**
 * GST-2146: selected test files the configured vitest or jest runner's own
 * config excludes are not applicable, never run and never a failure. Repro:
 * alphaclaw#386, where accept's final pregate handed 51 tests/live and
 * tests/container files (excluded unless OPENCLAW_LIVE_E2E=1) to
 * `npx vitest run {files}`, which exited 1 on "No test files found" and the
 * lane went `fail (final tree)`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { excludedByConfig, listCommand, noTestFilesFound } from '../lib/pregate/runner-config';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const temps: string[] = [];
afterEach(() => {
  while (repos.length) cleanup(repos.pop()!);
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});
const tempDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-runner-config-')); temps.push(d); return d; };

const VITEST_NO_FILES = '\n RUN  v4.1.12 /repo\n\nNo test files found, exiting with code 1\n\nfilter: tests/live/a.test.js\ninclude: tests/**/*.test.js\nexclude:  **/node_modules/**, **/.git/**, tests/live/**\n';

describe('the runner-config helpers', () => {
  // Value: protects=only vitest run and jest commands get a listing probe, with their own prefix and flags kept; fails_when=another
  //   runner (bun, playwright, a dispatcher) is probed and its files dropped; why_new=new helper; seam=none; no_claim=the runners
  test('listCommand rewrites vitest run and jest, keeps the prefix and flags, and leaves every other runner alone', () => {
    expect(listCommand('npx vitest run {files}', ['tests/a.test.js'], '/s/l.json')).toBe("npx vitest list --filesOnly --json='/s/l.json' 'tests/a.test.js'");
    expect(listCommand('pnpm exec vitest run --config vitest.live.config.js {files}', ['a.test.ts'], '/s/l.json')).toBe("pnpm exec vitest list --filesOnly --json='/s/l.json' --config vitest.live.config.js 'a.test.ts'");
    expect(listCommand('npx jest {files}', ['a.test.js'], '/s/l.json')).toBe("npx jest --listTests --json 'a.test.js'");
    expect(listCommand('./node_modules/.bin/jest --ci {files}', ['a.test.js'], '/s/l.json')).toBe("./node_modules/.bin/jest --listTests --json --ci 'a.test.js'");
    for (const runner of ['bun test {files}', 'node --test {files}', 'npx playwright test --reporter=list {files}', 'npx vitest {files}', 'node scripts/run-tests.js {files}', 'npx jest --listTests {files}']) expect(listCommand(runner, ['a.test.js'], '/s/l.json')).toBeNull();
  });

  // Value: protects=a run that ended on the runner's own no-files message for files on disk is read as not applicable, with the
  //   config's patterns as the reason, while a missing file (a bad selector) or any other exit stays judged; fails_when=the message
  //   alone clears a lane or the existence guard goes; why_new=new helper; seam=none; no_claim=which files the config excludes
  test('noTestFilesFound reads vitest and jest no-files exits for files that exist, and nothing else', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'tests/live'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tests/live/a.test.js'), '');
    expect(noTestFilesFound(VITEST_NO_FILES, dir, ['tests/live/a.test.js'])).toBe('the runner\'s config excludes them: the runner said "No test files found" (include: tests/**/*.test.js; exclude: **/node_modules/**, **/.git/**, tests/live/**)');
    const jest = 'No tests found, exiting with code 1\nRun with `--passWithNoTests` to exit with code 0\nIn /repo\n  6 files checked.\n  testPathIgnorePatterns: /node_modules/, /tests/live/ - 5 matches\nPattern: tests/live/a.test.js - 0 matches\n';
    expect(noTestFilesFound(jest, dir, ['tests/live/a.test.js'])).toBe('the runner\'s config excludes them: the runner said "No tests found" (testPathIgnorePatterns: /node_modules/, /tests/live/ - 5 matches)');
    expect(noTestFilesFound(VITEST_NO_FILES, dir, ['tests/live/a.test.js', 'tests/live/gone.test.js'])).toBeNull();
    expect(noTestFilesFound(' Test Files  1 failed (1)\n      Tests  1 failed (1)\n', dir, ['tests/live/a.test.js'])).toBeNull();
    expect(noTestFilesFound(VITEST_NO_FILES, dir, [])).toBeNull();
  });

  // Value: protects=jest's --listTests answer decides which files a jest group keeps, and a listing that fails or prints no JSON
  //   runs every file as before; fails_when=a failed probe drops files; why_new=new helper; seam=a jest shim on PATH; no_claim=real jest
  test('excludedByConfig keeps what jest lists, names the rest, and falls back to every file on a failed or unreadable listing', () => {
    const dir = tempDir();
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'jest'), '#!/usr/bin/env bash\n[ -n "$JEST_SHIM_EXIT" ] && exit "$JEST_SHIM_EXIT"\n[ -n "$JEST_SHIM_TEXT" ] && { echo "$JEST_SHIM_TEXT"; exit 0; }\nprintf \'["%s"]\' "$PWD/tests/unit/b.test.js"\n', { mode: 0o755 });
    for (const f of ['tests/unit/b.test.js', 'tests/live/a.test.js']) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), ''); }
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
    const files = ['tests/live/a.test.js', 'tests/unit/b.test.js'];
    expect(excludedByConfig('jest {files}', dir, files, env, dir, 30_000)).toEqual({ files: ['tests/live/a.test.js'], reason: "the runner's config excludes them: `jest --listTests` does not list them in this environment" });
    expect(excludedByConfig('jest {files}', dir, ['tests/unit/b.test.js'], env, dir, 30_000)).toBeNull();
    expect(excludedByConfig('jest {files}', dir, files, { ...env, JEST_SHIM_EXIT: '1' }, dir, 30_000)).toBeNull();
    expect(excludedByConfig('jest {files}', dir, files, { ...env, JEST_SHIM_TEXT: 'not json' }, dir, 30_000)).toBeNull();
    expect(excludedByConfig('bun test {files}', dir, files, env, dir, 30_000)).toBeNull();
  });
});

/**
 * An `npx` on PATH that behaves like vitest under a config excluding tests/live/**: `vitest list --filesOnly --json=<f>`
 * writes the files outside tests/live (VITEST_SHIM_LIST_FAIL makes it exit 2), and `vitest run` prints a summary for those
 * (a file containing FAILS fails) or "No test files found" and exit 1 when every file is under tests/live. The lane's bash
 * puts the shim first again through BASH_ENV, ahead of the launch Bun's directory and any real npx.
 */
const npxShim = (repo: FixtureRepo): Record<string, string> => {
  const dir = path.join(repo.root, 'npx-shim');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'npx'), [
    '#!/usr/bin/env bash',
    '[ "$1" = vitest ] || exit 99',
    'mode=$2; shift 2; out=; files=()',
    'for a in "$@"; do case "$a" in --filesOnly) ;; --json=*) out=${a#--json=} ;; *) files+=("$a") ;; esac; done',
    'if [ "$mode" = list ]; then',
    '  [ -n "$VITEST_SHIM_LIST_FAIL" ] && { echo "list: unknown option" >&2; exit 2; }',
    '  { printf "["; sep=; for f in "${files[@]}"; do case "$f" in tests/live/*) ;; *) printf \'%s{"file":"%s"}\' "$sep" "$PWD/$f"; sep=, ;; esac; done; printf "]"; } > "$out"',
    '  exit 0',
    'fi',
    'echo "vitest run: ${files[*]}" >> "$VITEST_SHIM_LOG"',
    'kept=(); for f in "${files[@]}"; do case "$f" in tests/live/*) ;; *) kept+=("$f") ;; esac; done',
    'if [ ${#kept[@]} -eq 0 ]; then printf "\\nNo test files found, exiting with code 1\\n\\nfilter: %s\\ninclude: tests/**/*.test.js\\nexclude:  **/node_modules/**, tests/live/**\\n" "${files[*]}" >&2; exit 1; fi',
    'n=${#kept[@]}; failed=0; for f in "${kept[@]}"; do grep -q FAILS "$f" && failed=$((failed+1)); done',
    'if [ $failed -gt 0 ]; then echo " Test Files  $failed failed | $((n-failed)) passed ($n)"; echo "      Tests  $failed failed | $((n-failed)) passed ($n)"; exit 1; fi',
    'echo " Test Files  $n passed ($n)"; echo "      Tests  $n passed ($n)"',
    '',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'path.sh'), `PATH='${dir}':"$PATH"\n`);
  return { PATH: `${dir}:${process.env.PATH ?? ''}`, BASH_ENV: path.join(dir, 'path.sh'), VITEST_SHIM_LOG: path.join(repo.root, 'vitest-runs.log') };
};

describe('lanes under a vitest config that excludes tests/live', () => {
  const TEST = (name: string) => `import { test } from 'vitest';\ntest('${name}', () => {});\n`;
  const BASE = {
    'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^4.0.18' } }, null, 2) + '\n',
    'vitest.config.js': "export default { test: { include: ['tests/**/*.test.js'], exclude: process.env.LIVE === '1' ? [] : ['tests/live/**'] } };\n",
    'tests/live/a.test.js': TEST('live a'),
    'tests/live/b.test.js': TEST('live b'),
    'tests/unit/c.test.js': TEST('unit c'),
  };
  /** A fixture on main with BASE and no workflows, then one commit of `files` on top, run through the lanes check. */
  const run = (files: Record<string, string>, opts: { serial?: string[]; env?: Record<string, string> } = {}) => {
    const repo = makeFixtureRepo({ pregate: { $schema: 'https://github.com/garrytan/gstack/docs/pregate.md#pregate-v1', dependencies: { 'docs/**': [], 'README.md': [] }, ...(opts.serial ? { serial_patterns: opts.serial } : {}) }, baseFiles: BASE });
    repos.push(repo);
    commit(repo, { '.github/workflows/free-tests.yml': null, '.github/workflows/windows.yml': null }, 'no workflows');
    repo.git('push', '-q', 'origin', 'HEAD:main');
    repo.git('fetch', '-q', 'origin');
    commit(repo, files);
    const shim = npxShim(repo);
    const r = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--only', 'lanes'], { ...shim, ...opts.env });
    const runs = fs.existsSync(shim.VITEST_SHIM_LOG!) ? fs.readFileSync(shim.VITEST_SHIM_LOG!, 'utf8').trim().split('\n') : [];
    return { ...r, runs, lanes: /^tests {6}lanes {5}.*$/m.exec(r.out)?.[0] ?? '' };
  };

  // Value: protects=a selection the config excludes entirely is not applicable, never handed to vitest and never `fail`
  //   (alphaclaw#386); fails_when=excluded files are run again and "No test files found" reads as PREGATE_LANE_FAILED;
  //   why_new=no fixture had a runner config that excludes a directory; seam=an npx shim on PATH; no_claim=real vitest (checked by hand)
  test('only excluded files: not run, pass, each named as not applicable with the reason', () => {
    const r = run({ 'tests/live/a.test.js': TEST('live a2'), 'tests/live/b.test.js': TEST('live b2') });
    expect(r.runs).toEqual([]);
    expect(r.lanes).toMatch(/ pass .*no selected file runs under the runner's config here; 2 selected file\(s\) not applicable here \(not run, not counted as covered; the runner's config excludes them: `vitest list --filesOnly` does not list them in this environment\): tests\/live\/a\.test\.js tests\/live\/b\.test\.js/);
    expect(r.status).toBe(EXIT.ok);
  }, 60_000);

  // Value: protects=a file the config does not exclude still runs, alone, and only it counts as run; fails_when=the excluded file is
  //   passed to vitest and counted in "ran in N file(s)", or the kept file is dropped; why_new=new path; seam=an npx shim; no_claim=real vitest
  test('excluded and included files together: the included file runs and the excluded one is named', () => {
    const r = run({ 'tests/live/a.test.js': TEST('live a2'), 'tests/unit/c.test.js': TEST('unit c2') });
    expect(r.runs).toEqual(['vitest run: tests/unit/c.test.js']);
    expect(r.lanes).toMatch(/ pass .*1 tests ran in 1 file\(s\), exit 0; 1 selected file\(s\) not applicable here .*: tests\/live\/a\.test\.js/);
    expect(r.status).toBe(EXIT.ok);
  }, 60_000);

  // Value: protects=the config's env-gated branch decides, not a static reading of it: the same files run when the environment
  //   includes them; fails_when=exclusion ignores the lane's environment; why_new=new path; seam=an npx shim; no_claim=real vitest
  test('a listing that includes the files leaves the run as before', () => {
    const r = run({ 'tests/unit/c.test.js': TEST('unit c2') });
    expect(r.runs).toEqual(['vitest run: tests/unit/c.test.js']);
    expect(r.lanes).toMatch(/ pass .*1 tests ran in 1 file\(s\), exit 0$/);
  }, 60_000);

  // Value: protects=when the listing cannot answer, a run that still ends on vitest's "No test files found" for existing files is
  //   not applicable, with vitest's include and exclude lines as the reason; fails_when=that exit is PREGATE_LANE_FAILED again;
  //   why_new=new path; seam=an npx shim whose list fails; no_claim=real vitest
  test('listing unavailable: the run ends on "No test files found" and the files are not applicable, not failed', () => {
    const r = run({ 'tests/live/a.test.js': TEST('live a2') }, { env: { VITEST_SHIM_LIST_FAIL: '1' } });
    expect(r.runs).toEqual(['vitest run: tests/live/a.test.js']);
    expect(r.lanes).toMatch(/ pass .*1 selected file\(s\) not applicable here \(not run, not counted as covered; the runner's config excludes them: the runner said "No test files found" \(include: tests\/\*\*\/\*\.test\.js; exclude: \*\*\/node_modules\/\*\*, tests\/live\/\*\*\)\): tests\/live\/a\.test\.js/);
    expect(r.status).toBe(EXIT.ok);
  }, 60_000);

  // Value: protects=(hold) a real failure beside excluded files still fails, whether the listing removed them or their own run
  //   ended on "No test files found"; fails_when=a not-applicable run hides the failed one; why_new=new path; seam=an npx shim;
  //   no_claim=real vitest
  test('hold: a failing included test still fails the lane beside excluded files', () => {
    const failing = { 'tests/live/a.test.js': TEST('live a2'), 'tests/unit/c.test.js': `${TEST('unit c2')}// FAILS\n` };
    for (const env of [{}, { VITEST_SHIM_LIST_FAIL: '1' }] as Record<string, string>[]) {
      const r = run(failing, { serial: ['tests/live/**'], env });
      expect(r.lanes).toMatch(/ fail .*local lane exited 1 \(1 failed of 1 ran; 1 files; pipefail\) \(PREGATE_LANE_FAILED\)/);
      expect(r.status).not.toBe(EXIT.ok);
    }
  }, 120_000);
});
