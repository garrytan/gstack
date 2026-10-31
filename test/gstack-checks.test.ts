/**
 * gstack-checks (/verify's loop, GST-116): detection, the consent boundary,
 * pregate-owned test selection and the no-false-green verdicts, end to end on
 * the pregate fixture repo (bare origin + clone, node --test runner, a Windows
 * lane whose file list comes from a selection manifest command).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { declaredVerify, healthStack, manifestChecks, testVerdict } from '../lib/checks';
import type { CheckResult } from '../lib/pregate/types';
import { BASE_PREGATE, ROOT, cleanup, commit, makeFixtureRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (repos.length) cleanup(repos.pop()!);
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const TYPECHECK = "const s=require('fs').readFileSync('lib/util.js','utf8');if(s.includes('TYPE_ERROR')){console.error('lib/util.js: TYPE_ERROR');process.exit(2)}";
const LIST = "require('fs').writeFileSync(process.env.SELECTION_MARK||'/dev/null','ran');if(process.argv.includes('--matrix'))console.log(JSON.stringify({files:['test/windows-paths.test.js']}));else console.log('test/windows-paths.test.js');\n";

function setup(runner = BASE_PREGATE.runner): { repo: FixtureRepo; mark: string; checks: (args: string[], env?: Record<string, string>) => ReturnType<typeof runBin> } {
  const repo = makeFixtureRepo({
    prefix: 'gstack-checks-fx-',
    baseFiles: {
      'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node --test test/*.test.js', typecheck: 'node scripts/typecheck.js' } }, null, 2) + '\n',
      'scripts/typecheck.js': TYPECHECK + '\n',
      'scripts/windows-list.js': LIST,
      '.gstack/pregate.json': JSON.stringify({ ...BASE_PREGATE, runner, dependencies: { ...BASE_PREGATE.dependencies, 'scripts/**': [], 'package.json': [] } }, null, 2) + '\n',
    },
  });
  repos.push(repo);
  const mark = path.join(repo.root, 'selection-ran');
  return { repo, mark, checks: (args, env = {}) => runBin(repo, 'gstack-checks', [...args, '--base', 'main'], { SELECTION_MARK: mark, ...env }) };
}
const run = (s: ReturnType<typeof setup>, ...extra: string[]) => s.checks(['run', ...extra]);

describe('detection', () => {
  // Value: protects=/verify reads the same gstack:verify: command gstack-verify-gate runs; fails_when=the TS port and the hook's sed
  //   disagree on a comment wrapper, backticks or trailing space; why_new=the port is new; seam=the hook's own sed line; no_claim=none
  test('declaredVerify matches gstack-verify-gate\'s sed on the same text', () => {
    const hook = fs.readFileSync(path.join(ROOT, 'bin/gstack-verify-gate'), 'utf8');
    const sed = /CMD="\$\(sed -n '([^']+)'/.exec(hook)![1];
    for (const text of ['<!-- gstack:verify: bun test -->', '  gstack:verify:   ' + '\u0060npm run check\u0060  ', 'intro\ngstack:verify: make test\ngstack:verify: second', 'no declaration here', 'gstack:verify:   ']) {
      const r = spawnSync('sh', ['-c', `sed -n '${sed}' | head -1`], { input: text + '\n', encoding: 'utf8', timeout: 10_000 });
      const viaSed = r.stdout.replace(/\n$/, '').split('-->')[0].replace(/\u0060/g, '').replace(/\s+$/, '');
      expect(declaredVerify(text)).toBe(viaSed || null);
    }
  });

  // Value: protects=a Health Stack section replaces manifest detection and leaves tests to pregate; manifests never invent a tool;
  //   fails_when=test rows run twice or a tsc/eslint command appears for a project that does not declare the tool; why_new=detection is
  //   new; seam=none; no_claim=which commands succeed
  test('Health Stack rows and manifest checks', () => {
    expect(healthStack('# x\n## Health Stack\n\n- typecheck: tsc --noEmit\n- test: bun test\n- shell: shellcheck *.sh\n## Next\n- lint: nope\n').map(c => [c.name, c.command]))
      .toEqual([['typecheck', 'tsc --noEmit'], ['shell', 'shellcheck *.sh']]);
    // A repeated key keeps both checks under their own names, and a tests row is pregate's, so status never reads one verdict for two checks.
    expect(healthStack('## Health Stack\n- lint: eslint .\n- lint: stylelint "**/*.css"\n- lint: oxlint\n- tests: npm test\n').map(c => c.name)).toEqual(['lint', 'lint-2', 'lint-3']);
    expect(healthStack('## Health Stack\n- lint: eslint .\n- lint-2: oxlint\n- lint: stylelint x\n').map(c => c.name)).toEqual(['lint', 'lint-2', 'lint-3']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-checks-manifest-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }));
    expect(manifestChecks(dir).map(c => c.command)).toEqual(['npm run build']);
    fs.writeFileSync(path.join(dir, 'bun.lock'), '');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' }, devDependencies: { typescript: '5' } }));
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module x\n');
    expect(manifestChecks(dir).map(c => c.command)).toEqual(['bunx tsc --noEmit', 'bun run lint', 'go vet ./...', `go build -o ${process.platform === 'win32' ? 'NUL' : '/dev/null'} ./...`]);
    // Clippy is a rustup component Cargo.toml does not declare: it runs only when the repo opts in.
    const rs = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-checks-rs-'));
    dirs.push(rs);
    fs.writeFileSync(path.join(rs, 'Cargo.toml'), '[package]\nname = "x"\n');
    expect(manifestChecks(rs).map(c => c.command)).toEqual(['cargo check --all-targets']);
    fs.writeFileSync(path.join(rs, 'Cargo.toml'), '[package]\nname = "x"\n[lints.clippy]\npedantic = "warn"\n');
    expect(manifestChecks(rs).map(c => c.command)).toEqual(['cargo check --all-targets', 'cargo clippy --all-targets']);
    const py = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-checks-py-'));
    dirs.push(py);
    expect(manifestChecks(py)).toEqual([]);
    fs.writeFileSync(path.join(py, 'pyproject.toml'), '[tool.ruff]\nline-length = 100\n[tool.mypy]\nstrict = true\n');
    expect(manifestChecks(py).map(c => c.command)).toEqual(['ruff check .', 'mypy .']);
  });
});

describe('testVerdict', () => {
  // Value: protects=only a pregate pass is green; fails_when=an unmapped file, a zero-run selection, a stall or an incomplete run reads
  //   PASS; why_new=the mapping is new; seam=pregate's CheckResult codes; no_claim=pregate's own classification
  test('maps pregate lanes results without a false green', () => {
    const r = (x: Partial<CheckResult>): CheckResult => ({ id: 'lanes', stage: 'tests', status: 'pass', inputs: {}, ...x } as CheckResult);
    expect(testVerdict(r({ status: 'fail', code: 'PREGATE_NO_LANE', detail: '1 touched file(s) with no test lane: a.js' })).verdict).toBe('UNMAPPED');
    expect(testVerdict(r({ status: 'warn', code: 'PREGATE_NO_POLICY', detail: 'x' })).verdict).toBe('UNMAPPED');
    expect(testVerdict(r({ status: 'fail', code: 'PREGATE_LANE_FAILED', detail: 'ZERO-RUN: the runner reported 0 tests' })).verdict).toBe('ZERO_RUN');
    expect(testVerdict(r({ status: 'incomplete', code: 'PREGATE_STALLED', detail: 'stalled' })).verdict).toBe('TIMEOUT');
    expect(testVerdict(r({ status: 'incomplete', code: 'PREGATE_INCOMPLETE', detail: 'no test runner detected' })).verdict).toBe('INCOMPLETE');
    expect(testVerdict(r({ status: 'incomplete', cause: 'environment', detail: 'not on PATH' } as Partial<CheckResult>)).verdict).toBe('ENV');
    const owed = testVerdict(r({ status: 'requires-remote', remote: [{ lane: 'windows.yml/windows-shard', receipt: null } as any] }));
    expect([owed.verdict, owed.notCovered]).toEqual(['PASS', ['windows.yml/windows-shard']]);
  });
});

describe('gstack-checks on a fixture repo', () => {
  // Value: protects=nothing runs before consent, including pregate's selection manifest command, and any change to a check or a
  //   selection command needs consent again; fails_when=an untrusted or edited command executes; why_new=the boundary is new;
  //   seam=the fixture's selection command writes a marker when it runs; no_claim=the trust grant log's contents
  test('consent covers the checks and the selection manifest commands', () => {
    const s = setup();
    commit(s.repo, { 'lib/util.js': 'exports.add = (a, b) => b + a;\n' });
    const refused = run(s);
    expect(refused.status).toBe(3);
    expect(refused.err).toContain('CHECKS_CONSENT_REQUIRED');
    expect(fs.existsSync(s.mark)).toBe(false);
    expect(s.checks(['detect']).out).toContain('TRUST untrusted');
    expect(fs.existsSync(s.mark)).toBe(false);
    expect(s.checks(['trust']).status).toBe(0);
    const green = run(s);
    expect(green.out).toContain('CHECK typecheck PASS');
    expect(green.out).toContain('CHECK tests PASS');
    expect(green.status).toBe(0);
    expect(s.checks(['status']).out).toMatch(/^READY_FOR_SHIP tree=\w+ checks=typecheck,tests not_covered=/);
    // A changed check command needs consent again.
    write(s.repo.work, 'package.json', JSON.stringify({ name: 'fixture', scripts: { typecheck: 'node scripts/typecheck.js --strict' } }) + '\n');
    expect(run(s).status).toBe(3);
    expect(s.checks(['status']).out).toStartWith('NOT_READY');
    s.repo.git('checkout', '-q', '--', 'package.json');
    // A selection manifest command changed on the base needs consent before anything executes.
    s.repo.git('checkout', '-q', 'main');
    write(s.repo.work, '.gstack/pregate.json', JSON.stringify({ ...BASE_PREGATE, selection: { 'windows.yml/windows-shard': 'node scripts/windows-list.js --changed' }, dependencies: { ...BASE_PREGATE.dependencies, 'scripts/**': [], 'package.json': [] } }, null, 2) + '\n');
    s.repo.git('commit', '-q', '-am', 'policy');
    s.repo.git('push', '-q', 'origin', 'main');
    s.repo.git('checkout', '-q', 'feature');
    fs.rmSync(s.mark, { force: true });
    const again = run(s);
    expect(again.status).toBe(3);
    expect(fs.existsSync(s.mark)).toBe(false);
  }, 60_000);

  // Value: protects=a source change that breaks an untouched test is a red to fix, not a pre-existing one; an unmapped file and a
  //   zero-run selection are never green; status never reports ready from a red or stale run; fails_when=any of those reads green;
  //   why_new=the verdicts are new; seam=pregate's real selection and runner; no_claim=output wording beyond the verdict tokens
  test('reds, unmapped and status', () => {
    const s = setup();
    expect(s.checks(['trust']).status).toBe(0);
    expect(s.checks(['status']).out).toStartWith('NOT_READY');
    commit(s.repo, { 'lib/util.js': 'exports.add = (a, b) => a - b;\n' });
    const red = run(s);
    expect(red.status).toBe(1);
    expect(red.out).toContain('CHECK tests FAIL');
    expect(s.checks(['status']).out).toContain('tests=FAIL');
    write(s.repo.work, 'lib/util.js', 'exports.add = (a, b) => a + b; // TYPE_ERROR\n');
    const typeRed = run(s, '--only', 'typecheck');
    expect(typeRed.out).toContain('CHECK typecheck FAIL');
    expect(typeRed.out).toContain('| lib/util.js: TYPE_ERROR');
    write(s.repo.work, 'lib/util.js', 'exports.add = (a, b) => a + b;\n');
    write(s.repo.work, 'lib/orphan.js', 'exports.lonely = () => 2;\n');
    const unmapped = run(s);
    expect(unmapped.out).toContain('CHECK tests UNMAPPED');
    expect(unmapped.status).toBe(1);
    s.repo.git('checkout', '-q', '--', 'lib/orphan.js');
    expect(run(s).status).toBe(0);
    expect(s.checks(['status']).status).toBe(0);
    write(s.repo.work, 'README.md', '# changed after the run\n');
    expect(s.checks(['status']).out).toContain('the last run was at');
  }, 60_000);

  // Value: protects=two --only runs at one tree add up to READY, and a tree that changes during a run is never green; bad arguments
  //   run nothing; fails_when=a partial rerun drops the other verdicts, a run that edited the tree reads PASS, or an unknown --only name
  //   is ignored; why_new=the ledger merge and tree re-check are new; seam=a declared check that writes a file; no_claim=signals
  test('partial runs, a tree moved mid-run and argument errors', () => {
    const s = setup();
    expect(s.checks(['trust']).status).toBe(0);
    commit(s.repo, { 'lib/util.js': 'exports.add = (a, b) => b + a;\n' });
    expect(run(s, '--only', 'typecheck').status).toBe(0);
    expect(s.checks(['status']).out).toContain('tests=not run');
    expect(run(s, '--only', 'tests').status).toBe(0);
    expect(s.checks(['status']).out).toStartWith('READY_FOR_SHIP');
    expect(run(s, '--only', 'nope').status).toBe(64);
    expect(run(s, '--timeout', '0').status).toBe(64);
    expect(s.checks(['--base']).status).toBe(64);
    write(s.repo.work, 'CLAUDE.md', 'gstack:verify: node -e "require(\'fs\').writeFileSync(\'touched.txt\', \'x\')"\n');
    commit(s.repo, {});
    expect(s.checks(['trust']).status).toBe(0);
    const moved = run(s, '--only', 'verify');
    expect(moved.out).toContain('CHECK verify INCOMPLETE');
    expect(moved.status).toBe(1);
  }, 60_000);

  // Value: protects=a selection that runs zero tests is not green; fails_when=exit 0 with no test counted reads PASS; why_new=the
  //   verdict is new; seam=pregate's runner summary (a bats stub printing an empty TAP plan); no_claim=node --test, which counts
  //   each file as a test, so an empty file there is not a zero run
  test('zero-run selection', () => {
    const z = setup('bats {files}');
    expect(z.checks(['trust']).status).toBe(0);
    const stub = path.join(z.repo.root, 'bin-stub');
    fs.mkdirSync(stub, { recursive: true });
    fs.writeFileSync(path.join(stub, 'bats'), "#!/bin/sh\nprintf '1..0\\n'\n", { mode: 0o755 });
    write(z.repo.work, 'test/empty.test.js', "require('../lib/util.js');\n");
    const zero = z.checks(['run', '--only', 'tests'], { PATH: `${stub}:${process.env.PATH ?? ''}` });
    expect(zero.out).toContain('CHECK tests ZERO_RUN');
    expect(zero.status).toBe(1);
  }, 60_000);
});
