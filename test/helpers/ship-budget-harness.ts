/**
 * Scratch harness for the /ship budget tests (GSTA-152): a git repository with
 * a feature branch and an origin/main ref, a private state root, a checkpoint
 * directory standing in for the Drive mirror, an invocation record with the six
 * headings, and runners for bin/gstack-ship-budget and bin/gstack-review-log.
 */
import { spawnSync } from 'node:child_process';
import { bunIsolationArgs } from '../../lib/bun-isolation';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..', '..');
export const BUDGET_BIN = path.join(ROOT, 'bin', 'gstack-ship-budget');
export const REVIEW_LOG_BIN = path.join(ROOT, 'bin', 'gstack-review-log');

export const RECORD_TEXT = [
  '# /ship invocation record', '',
  '## Release', 'reviewed tree: pending', '',
  '## Decisions', '- Garry, 2026-10-29: "do it" covers the CHANGELOG wording in CHANGELOG.md', '',
  '## Reviews', '- Step 9 pass 1 start token 1b4e28ba-2fa1-11d2-883f-0016d3cca427', '',
  '## Checks', '- bun test: 12 pass', '',
  '## Documentation', '- none yet', '',
  '## Next steps', '- [ ] Step 7', '',
].join('\n');

export interface Run { code: number; out: string; err: string }
export interface Harness {
  root: string; repo: string; state: string; checkpoints: string; env: NodeJS.ProcessEnv;
  record(name?: string): string;
  sb(args: string[], extraEnv?: NodeJS.ProcessEnv): Run;
  reviewLog(args: string[]): Run;
  git(...args: string[]): string;
  field(out: string, line: string, key: string): string;
  ledger(file: string): any;
  cleanup(): void;
}

export function budgetHarness(): Harness {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ship-budget-')));
  const repo = path.join(root, 'repo');
  const state = path.join(root, 'state');
  const checkpoints = path.join(root, 'checkpoints');
  fs.mkdirSync(repo, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, GSTACK_STATE_ROOT: state, GSTACK_HOME: state, GSTACK_CAPY: '', GSTACK_SHIP_BUDGET_CHECKPOINT_DIR: checkpoints,
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  delete env.GSTACK_SHIP_TOKEN_CAP;
  delete env.GSTACK_LAUNCH_FILE;
  delete env.GSTACK_STATE_DIR;
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const x = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const x = 2;\n');
  git('commit', '-qam', 'change');
  const run = (bin: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Run => {
    const argv = bin === REVIEW_LOG_BIN ? ['bash', bin] : [process.execPath, ...bunIsolationArgs(), bin];
    const r = spawnSync(argv[0], [...argv.slice(1), ...args], { cwd: repo, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60_000 });
    return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  let records = 0;
  return {
    root, repo, state, checkpoints, env, git,
    record(name = `record-${++records}.md`) {
      const file = path.join(root, 'records', name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, RECORD_TEXT);
      return file;
    },
    sb: (args, extraEnv) => run(BUDGET_BIN, args, extraEnv),
    reviewLog: args => run(REVIEW_LOG_BIN, args),
    field(out, line, key) {
      const row = out.split('\n').find(l => l.startsWith(line + ':'));
      const m = row ? new RegExp(`(?:^|\\s)${key}=(\\S+)`).exec(row) : null;
      if (!m) throw new Error(`no ${key}= on a ${line}: line in:\n${out}`);
      return m[1]!;
    },
    ledger: file => JSON.parse(fs.readFileSync(file, 'utf8')),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
