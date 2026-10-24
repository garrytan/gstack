/**
 * /context-save records the commit a checkpoint describes, and /context-restore
 * notices when commits landed after it, end to end.
 *
 * Runs the REAL save-path, stamp and head-check bash blocks extracted from the
 * generated context-save and context-restore SKILL.md files (with
 * ~/.claude/skills/gstack pointed at this checkout) inside fixture repos. The bug
 * these pin: a checkpoint saved before work landed came back as the current plan,
 * with nothing saying HEAD had moved, so restore offered to redo finished steps.
 *
 * Value: protects=save stamps head: and restore reports unchanged, moved, diverged, untracked and unknown commits; fails_when=the stamp drops head: or restore stops comparing it with HEAD; why_new=no test compares a checkpoint with commits made after it; seam=none; no_claim=fixture repos and a hand-written checkpoint body stand in for a live /context-save, so green does not prove the agent follows the prompt
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
// Forward slashes keep the path intact inside bash on Windows (Git Bash); a no-op elsewhere.
const BASH_ROOT = ROOT.split(path.sep).join('/');

function bashBlockAfter(skillFile: string, heading: string, contains?: string): string {
  const md = fs.readFileSync(path.join(ROOT, skillFile), 'utf-8');
  const start = md.indexOf(heading);
  if (start < 0) throw new Error(`${skillFile}: heading not found: ${heading}`);
  const re = /```bash\n([\s\S]*?)```/g;
  re.lastIndex = start;
  for (let m = re.exec(md); m; m = re.exec(md)) {
    if (!contains || m[1].includes(contains)) return m[1].replaceAll('~/.claude/skills/gstack', BASH_ROOT);
  }
  throw new Error(`${skillFile}: no bash block after ${heading}`);
}

const SAVE_PATH_BLOCK = bashBlockAfter('context-save/SKILL.md', '### Step 4: Write saved-context file').replace(
  'TIMESTAMP=$(date +%Y%m%d-%H%M%S)',
  'TIMESTAMP="$TEST_TIMESTAMP"',
);
const STAMP_BLOCK = bashBlockAfter('context-save/SKILL.md', '### Step 4: Write saved-context file', '--stamp-checkpoint');
const HEAD_BLOCK = bashBlockAfter('context-restore/SKILL.md', '**Check whether the branch moved since the save.**', 'SAVED_HEAD');

let tmp: string;
let home: string;

function env(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
  delete out.GSTACK_PROJECT_SLUG;
  delete out.GSTACK_STATE_ROOT;
  delete out.GSTACK_STATE_DIR;
  delete out.CURRENT_BRANCH;
  delete out.CLAUDE_PROJECT_DIR;
  return { ...out, HOME: tmp, GSTACK_HOME: home, ...extra };
}

function sh(script: string, cwd: string, extra: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', script], { cwd, env: env(extra), encoding: 'utf-8', timeout: 30_000 });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(cwd: string, subject: string) {
  fs.appendFileSync(path.join(cwd, 'app.txt'), `${subject}\n`);
  git(cwd, 'add', 'app.txt');
  git(cwd, 'commit', '-q', '-m', subject);
}

function repo(): string {
  const dir = path.join(tmp, 'app');
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', 'https://github.com/example/head-check.git');
  git(dir, 'config', 'user.name', 'gstack test');
  git(dir, 'config', 'user.email', 'gstack-test@example.invalid');
  commit(dir, 'baseline');
  return dir;
}

/** The context-save flow: path block, the agent's Write, then the stamp block. */
function save(cwd: string): string {
  const paths = sh(SAVE_PATH_BLOCK, cwd, { TITLE_RAW: 'login flow', TEST_TIMESTAMP: '20261020-090000' });
  expect(paths.status).toBe(0);
  const file = paths.stdout.match(/^FILE=(.+)$/m)![1];
  fs.writeFileSync(file, '---\nstatus: in-progress\nbranch: main\n---\n\n## Working on: login flow\n');
  const stamp = sh(STAMP_BLOCK.replace('FILE="<the FILE path printed above>"', `FILE=${JSON.stringify(file)}`), cwd);
  expect(stamp.stdout).toContain('STAMPED');
  return file;
}

function headCheck(cwd: string, file: string) {
  const r = sh(HEAD_BLOCK.replace('FILE="<the chosen file>"', `FILE=${JSON.stringify(file)}`), cwd);
  expect(r.status).toBe(0);
  return r.stdout;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-head-')));
  home = path.join(tmp, '.gstack');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('context-save records the commit a checkpoint describes', () => {
  test('the stamp writes head: once, and re-stamping does not duplicate it', () => {
    const app = repo();
    const file = save(app);
    const fm = fs.readFileSync(file, 'utf-8').split('---')[1];
    expect(fm).toContain(`\nhead: ${git(app, 'rev-parse', 'HEAD')}\n`);
    spawnSync('bash', [path.join(ROOT, 'bin', 'gstack-slug'), '--stamp-checkpoint', file], { cwd: app, env: env(), timeout: 30_000 });
    expect(fs.readFileSync(file, 'utf-8').split('---')[1].match(/^head:/gm)?.length).toBe(1);
  });
});

describe('context-restore compares the checkpoint with HEAD', () => {
  test('nothing to add when no commit landed after the save', () => {
    const app = repo();
    expect(headCheck(app, save(app)).trim()).toBe('HEAD_UNCHANGED');
  });

  test('commits that landed after the save are counted and listed', () => {
    const app = repo();
    const file = save(app);
    commit(app, 'add the login route');
    commit(app, 'add login tests');
    const out = headCheck(app, file);
    expect(out).toStartWith('HEAD_MOVED 2\n');
    expect(out).toContain('add the login route');
    expect(out).toContain('add login tests');
  });

  test('a checkpoint whose commit left the branch history is reported, not trusted', () => {
    const app = repo();
    commit(app, 'work in progress');
    const file = save(app);
    git(app, 'reset', '-q', '--hard', 'HEAD~1');
    commit(app, 'rewritten work');
    expect(headCheck(app, file)).toStartWith('HEAD_DIVERGED ');
  });

  test('checkpoints saved before head tracking, or with a malformed head, are never treated as current', () => {
    const app = repo();
    const legacy = path.join(tmp, 'legacy.md');
    fs.writeFileSync(legacy, '---\nstatus: in-progress\nbranch: main\n---\n');
    expect(headCheck(app, legacy).trim()).toBe('HEAD_UNTRACKED');
    const bogus = path.join(tmp, 'bogus.md');
    fs.writeFileSync(bogus, '---\nbranch: main\nhead: $(touch pwned)\n---\n');
    expect(headCheck(app, bogus)).toStartWith('HEAD_UNKNOWN ');
    expect(fs.existsSync(path.join(app, 'pwned'))).toBe(false);
  });

  test('the prompt maps every status to what the user sees', () => {
    const restore = fs.readFileSync(path.join(ROOT, 'context-restore/SKILL.md'), 'utf-8');
    for (const status of ['HEAD_UNCHANGED', 'HEAD_NOT_CHECKED', 'HEAD_MOVED <n>', 'HEAD_DIVERGED', 'HEAD_UNKNOWN', 'HEAD_UNTRACKED']) {
      expect(restore).toContain(`\`${status}\``);
    }
    expect(restore).toContain('`<n> commit(s) landed since this save:`');
    expect(restore).toContain('under **Verify first**');
    expect(restore).toContain('{commit-tracking lines, if any}');
    const save = fs.readFileSync(path.join(ROOT, 'context-save/SKILL.md'), 'utf-8');
    expect(save).toContain('`project_root:`, `worktree:` or `head:` yourself');
  });
});
