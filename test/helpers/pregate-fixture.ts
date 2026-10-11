/**
 * Fixture repo for the C-pregate tests (gstack-regen, gstack-pregate,
 * gstack-issue-links): a bare origin plus a working clone with a generator
 * (`gen.js` → `generated/digest.md` from `src/version.js`), a `lib/` module
 * tree, a `test/` tree whose files reach `lib/` through imports, repo-path
 * literals and the `bin/<name>` convention, two GitHub workflows (a Linux
 * unit lane and a Windows lane whose matrix is planner-computed), a
 * committed `.gstack/generated.json` and `.gstack/pregate.json`. Everything
 * lives under os.tmpdir(), outside any checkout, with its own hermetic git
 * identity (never the operator's).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gitArgvIn } from './scratch-repo';

export const ROOT = path.resolve(import.meta.dir, '..', '..');
export const BIN = (name: string) => path.join(ROOT, 'bin', name);

export interface FixtureRepo { root: string; work: string; origin: string; home: string; git: (...args: string[]) => string; env: Record<string, string> }

export const BASE_REGISTRY = {
  $schema: 'https://github.com/garrytan/gstack/docs/pregate.md#generated-v1',
  entries: [
    { id: 'digest', command: 'node gen.js', outputs: ['generated/**'], inputs: ['src/version.js', 'gen.js'] },
    { id: 'goldens', command: null, outputs: ['test/golden/*.txt'], inputs: ['src/**'], note: 'copy the rendered output by hand' },
  ],
};

export const BASE_PREGATE = {
  $schema: 'https://github.com/garrytan/gstack/docs/pregate.md#pregate-v1',
  runner: 'node --test {files}',
  dependencies: {
    'bin/tool': ['test/tool-cli.test.js'],
    'docs/**': [],
    'README.md': [],
  },
  selection: {
    'windows.yml/windows-shard': 'node scripts/windows-list.js',
  },
  warn: ['strays'],
  strays: { allow: ['Makefile'] },
};

const WORKFLOW_UNIT = `name: Free Tests
on: [push]
jobs:
  unit:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.2
      - name: Run unit tests
        run: node --test test/*.test.js
`;
const WORKFLOW_WINDOWS = `name: Windows Free Tests
on: [push]
jobs:
  windows-plan:
    runs-on: ubuntu-24.04
    outputs:
      matrix: \${{ steps.plan.outputs.matrix }}
    steps:
      - id: plan
        run: node scripts/windows-list.js --matrix
  windows-shard:
    needs: windows-plan
    runs-on: windows-latest
    strategy:
      matrix: \${{ fromJSON(needs.windows-plan.outputs.matrix) }}
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 24.18.0
      - name: Run the Windows-safe subset
        run: node --test \${{ matrix.files }}
`;

export function makeFixtureRepo(opts: { registry?: Record<string, unknown> | null; pregate?: Record<string, unknown> | null; prefix?: string } = {}): FixtureRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), opts.prefix ?? 'gstack-pregate-fx-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const env = { GSTACK_HOME: home, GSTACK_STATE_DIR: home, HOME: home, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@test\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  const git = (...args: string[]): string => {
    const r = gitArgvIn(work, args, 30_000, { ...process.env, ...env });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr?.toString()}`);
    return r.stdout?.toString().trim() ?? '';
  };
  spawnSync('git', ['init', '-q', '--bare', origin], { timeout: 30_000, env: { ...process.env, ...env } });
  git('init', '-q', '-b', 'main');
  for (const dir of ['src', 'lib', 'bin', 'test', 'test/golden', 'test/nightly', 'generated', 'docs', 'scripts', '.gstack', '.github/workflows']) fs.mkdirSync(path.join(work, dir), { recursive: true });
  write(work, 'src/version.js', "module.exports = { VERSION: '1.0.0' };\n");
  write(work, 'gen.js', "const fs=require('fs');const {VERSION}=require('./src/version.js');fs.writeFileSync('generated/digest.md',`# digest v${VERSION}\\n`);\n");
  write(work, 'generated/digest.md', '# digest v1.0.0\n');
  write(work, 'test/golden/digest.txt', 'digest v1.0.0\n');
  write(work, 'lib/retry.js', "exports.MAX_RETRIES = 3;\nexports.TIMEOUT_MS = 5000;\nexports.retry = (fn) => fn();\n");
  write(work, 'lib/util.js', "exports.add = (a, b) => a + b;\n");
  write(work, 'lib/orphan.js', "exports.lonely = () => 1;\n");
  write(work, 'lib/config.json', '{"limit": 10}\n');
  write(work, 'bin/tool', "#!/usr/bin/env node\nconsole.log('tool');\n");
  fs.chmodSync(path.join(work, 'bin/tool'), 0o755);
  write(work, 'test/retry.test.js', "const test = require('node:test');\nconst assert = require('node:assert');\nconst { MAX_RETRIES } = require('../lib/retry.js');\ntest('retries three times', () => assert.strictEqual(MAX_RETRIES, 3));\n");
  write(work, 'test/util.test.js', "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('../lib/util.js');\ntest('adds', () => assert.strictEqual(add(1, 2), 3));\n");
  write(work, 'test/config-read.test.js', "const test = require('node:test');\nconst assert = require('node:assert');\nconst fs = require('node:fs');\nconst path = require('node:path');\ntest('reads the config literal', () => assert.strictEqual(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib/config.json'), 'utf8')).limit, 10));\n");
  write(work, 'test/tool-cli.test.js', "const test = require('node:test');\nconst assert = require('node:assert');\nconst { spawnSync } = require('node:child_process');\ntest('tool prints', () => assert.strictEqual(spawnSync(process.execPath, [require('node:path').join(__dirname, '..', 'bin', 'tool')], { encoding: 'utf8', timeout: 10000 }).stdout.trim(), 'tool'));\n");
  write(work, 'test/nightly/retry-heavy.test.js', "const test = require('node:test');\nconst assert = require('node:assert');\ntest('heavy: timeout is 5000', () => assert.strictEqual(require('../../lib/retry.js').TIMEOUT_MS, 5000));\n");
  write(work, 'test/windows-paths.test.js', "const test = require('node:test');\ntest('windows paths', () => {});\n");
  write(work, 'scripts/windows-list.js', "if (process.argv.includes('--matrix')) console.log(JSON.stringify({ files: ['test/windows-paths.test.js'] }));\nelse console.log('test/windows-paths.test.js');\n");
  write(work, 'docs/README.md', '# docs\n');
  write(work, 'README.md', '# fixture\n');
  write(work, 'Makefile', 'all:\n\ttrue\n');
  write(work, 'package.json', JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node --test test/*.test.js', generate: 'node gen.js' } }, null, 2) + '\n');
  write(work, '.gitignore', 'node_modules/\n.gstack/tmp/\n');
  write(work, '.github/workflows/free-tests.yml', WORKFLOW_UNIT);
  write(work, '.github/workflows/windows.yml', WORKFLOW_WINDOWS);
  if (opts.registry !== null) write(work, '.gstack/generated.json', JSON.stringify(opts.registry ?? BASE_REGISTRY, null, 2) + '\n');
  if (opts.pregate !== null) write(work, '.gstack/pregate.json', JSON.stringify(opts.pregate ?? BASE_PREGATE, null, 2) + '\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  git('remote', 'set-head', 'origin', 'main');
  git('checkout', '-q', '-b', 'feature');
  return { root, work, origin, home, git, env };
}

export function write(work: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
  fs.writeFileSync(path.join(work, rel), text);
}

export function readFile(repo: FixtureRepo, rel: string): string {
  return fs.readFileSync(path.join(repo.work, rel), 'utf8');
}

/** Edit files on the feature branch and commit them (the PR's own commits). */
export function commit(repo: FixtureRepo, files: Record<string, string | null>, message = 'feat'): string {
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) fs.rmSync(path.join(repo.work, rel), { force: true });
    else write(repo.work, rel, text);
  }
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', message);
  return repo.git('rev-parse', 'HEAD');
}

export function runBin(repo: FixtureRepo, name: string, args: string[], extraEnv: Record<string, string> = {}, cwd = repo.work) {
  const r = spawnSync(BIN(name), args, { cwd, encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...repo.env, ...extraEnv } });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

export function cleanup(repo: FixtureRepo): void {
  fs.rmSync(repo.root, { recursive: true, force: true });
}

/** A `gh` on PATH answering `gh issue view <n> --json ...` from a map and `gh issue list` / `gh run view` from fixed data. */
export function ghShim(repo: FixtureRepo, data: { issues?: Record<string, unknown>; issueList?: unknown[]; runs?: Record<string, unknown> }): { PATH: string } {
  const dir = path.join(repo.root, 'gh-shim');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ issues: {}, issueList: [], runs: {}, ...data }));
  const script = [
    '#!/bin/sh',
    `DATA="${path.join(dir, 'data.json')}"`,
    'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
    '  node -e "const d=require(process.argv[1]);const p=d.issues[process.argv[2]];if(!p){console.error(\'GraphQL: Could not resolve to an Issue\');process.exit(1)}console.log(JSON.stringify(p))" "$DATA" "$3"',
    '  exit $?',
    'fi',
    '# issue list: entries whose body contains the quoted --search token, numbers only (what gstack-issue-links asks for)',
    'if [ "$1" = "issue" ] && [ "$2" = "list" ]; then node -e "const a=process.argv.slice(2);const q=(a[a.indexOf(\'--search\')+1]||\'\').replace(/^\\"|\\" in:body$/g,\'\');console.log(JSON.stringify(require(process.argv[1]).issueList.filter(i=>!q||String(i.body||\'\').includes(q)).map(i=>({number:i.number}))))" "$DATA" "$@"; exit $?; fi',
    'if [ "$1" = "run" ] && [ "$2" = "view" ]; then',
    '  node -e "const d=require(process.argv[1]);const p=d.runs[process.argv[2]];if(!p){console.error(\'run not found\');process.exit(1)}console.log(JSON.stringify(p))" "$DATA" "$3"',
    '  exit $?',
    'fi',
    'echo "gh shim: unsupported $*" >&2; exit 1',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'gh'), script, { mode: 0o755 });
  return { PATH: `${dir}:${process.env.PATH ?? ''}` };
}
