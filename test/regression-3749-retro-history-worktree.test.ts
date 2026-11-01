/**
 * Regression for #3749: /retro kept its history in .context/retros/ inside the
 * working tree, so a run in a linked worktree (Conductor, Claude Code) found
 * none of the main checkout's snapshots, reported "First retro recorded", and
 * wrote its own snapshot where `git worktree remove` deletes it. History now
 * lives in the state root, keyed by project slug (shared by every worktree of
 * a repository), and an existing .context/retros/ is migrated on first use.
 *
 * Runs the real Step 12 bash block (history and the Step 13 snapshot path) from the generated
 * retro/SKILL.md with the gstack install pointed at this checkout.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SKILL = fs.readFileSync(path.join(ROOT, 'retro', 'SKILL.md'), 'utf-8');
const TMPL = fs.readFileSync(path.join(ROOT, 'retro', 'SKILL.md.tmpl'), 'utf-8');

function bashBlockAfter(heading: string, contains: string): string {
  const start = SKILL.indexOf(heading);
  if (start < 0) throw new Error(`retro/SKILL.md: heading not found: ${heading}`);
  const end = SKILL.indexOf('\n### ', start + heading.length);
  const re = /```bash\n([\s\S]*?)```/g;
  re.lastIndex = start;
  for (let m = re.exec(SKILL); m && m.index < end; m = re.exec(SKILL)) {
    if (m[1].includes(contains)) {
      return m[1].replaceAll('$HOME/.claude/skills/gstack', ROOT).replaceAll('~/.claude/skills/gstack', ROOT);
    }
  }
  throw new Error(`retro/SKILL.md: no bash block containing ${contains} under ${heading}`);
}

const LOAD = bashBlockAfter('### Step 12: Load History & Compare', 'retro').replace('<today>', '2026-11-01');

let tmp: string;
let home: string;

/** Git Bash on Windows prints the state root as given plus `/projects/...`; compare with forward slashes. */
const fwd = (p: string) => p.replaceAll('\\', '/');

function sh(script: string, cwd: string) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of ['GSTACK_STATE_ROOT', 'GSTACK_STATE_DIR', 'GSTACK_PROJECT_SLUG', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR']) delete env[k];
  const r = spawnSync('bash', ['-c', script], { cwd, env: { ...env, HOME: tmp, GSTACK_HOME: home }, encoding: 'utf-8', timeout: 30_000 });
  return { stdout: fwd(r.stdout ?? ''), stderr: r.stderr ?? '', status: r.status ?? -1 };
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

function snapshot(dir: string, name: string, body: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

/** A main checkout with one commit (fixture-local identity) and a linked worktree under it. */
function layout() {
  const main = path.join(tmp, 'widget');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'remote', 'add', 'origin', 'https://github.com/acme/widget.git');
  git(main, 'config', 'user.name', 'Fixture');
  git(main, 'config', 'user.email', 'fixture@example.com');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(main, 'worktree', 'add', '-q', '-b', 'demo', path.join(main, '.claude', 'worktrees', 'demo'));
  const wt = fs.realpathSync(path.join(main, '.claude', 'worktrees', 'demo'));
  const slug = sh(`'${ROOT}/bin/gstack-slug' --get SLUG`, main).stdout.trim();
  expect(slug).not.toBe('');
  return { main, wt, history: path.join(home, 'projects', slug, 'retros') };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retro-3749-')));
  home = path.join(tmp, '.gstack');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('#3749 retro history is shared across linked worktrees', () => {
  test('Step 12 in a linked worktree finds the main checkout\'s earlier snapshot', () => {
    const { main, wt, history } = layout();
    snapshot(path.join(main, '.context', 'retros'), '2026-10-25-1.json', { date: '2026-10-25', window: '7d' });

    const r = sh(LOAD, wt);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(fwd(path.join(history, '2026-10-25-1.json')));
    expect(fs.existsSync(path.join(history, '2026-10-25-1.json'))).toBe(true);
    expect(fs.existsSync(path.join(main, '.context', 'retros'))).toBe(false);
  });

  test('the snapshot path from a linked worktree is outside the worktree, and the main checkout sees it', () => {
    const { main, wt, history } = layout();
    const save = sh(LOAD, wt);
    expect(save.status).toBe(0);
    const file = save.stdout.match(/^RETRO_FILE: (.+)$/m)?.[1];
    expect(file).toBe(fwd(path.join(history, '2026-11-01-1.json')));
    expect(file!.startsWith(fwd(wt))).toBe(false);
    fs.writeFileSync(file!, JSON.stringify({ date: '2026-11-01', window: '7d' }));

    git(main, 'worktree', 'remove', '--force', wt);
    const fromMain = sh(LOAD, main).stdout;
    expect(fromMain).toContain(file!);
    expect(fromMain).toContain(`RETRO_FILE: ${fwd(path.join(history, '2026-11-01-2.json'))}`);
  });

  test('migration keeps every snapshot: duplicates collapse, same-name differing snapshots get the next number', () => {
    const { main, wt, history } = layout();
    for (const tree of [main, wt]) snapshot(path.join(tree, '.context', 'retros'), '2026-10-18-1.json', { date: '2026-10-18', window: '7d' });
    snapshot(path.join(main, '.context', 'retros'), '2026-10-25-1.json', { date: '2026-10-25', from: 'main' });
    snapshot(path.join(wt, '.context', 'retros'), '2026-10-25-1.json', { date: '2026-10-25', from: 'worktree' });

    const r = sh(LOAD, wt);
    expect(r.status).toBe(0);
    expect(fs.readdirSync(history).sort()).toEqual(['2026-10-18-1.json', '2026-10-25-1.json', '2026-10-25-2.json', '2026-11-01-1.json']);
    const froms = ['2026-10-25-1.json', '2026-10-25-2.json'].map((f) => JSON.parse(fs.readFileSync(path.join(history, f), 'utf-8')).from).sort();
    expect(froms).toEqual(['main', 'worktree']);
    for (const tree of [main, wt]) expect(fs.existsSync(path.join(tree, '.context', 'retros'))).toBe(false);
  });

  test('a .context/retros symlinked to the shared history is left alone, so migration cannot delete it', () => {
    const { wt, history } = layout();
    const kept = snapshot(history, '2026-10-25-1.json', { date: '2026-10-25', window: '7d' });
    fs.mkdirSync(path.join(wt, '.context'), { recursive: true });
    fs.symlinkSync(history, path.join(wt, '.context', 'retros'));

    const r = sh(LOAD, wt);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(kept, 'utf-8')).toContain('2026-10-25');
    expect(r.stdout).toContain(`RETRO_PRIOR: ${fwd(kept)}`);
  });

  test('RETRO_FILE is reserved, so two runs in different worktrees never get the same path', () => {
    const { main, wt, history } = layout();
    const first = sh(LOAD, wt).stdout.match(/^RETRO_FILE: (.+)$/m)?.[1];
    const second = sh(LOAD, main).stdout.match(/^RETRO_FILE: (.+)$/m)?.[1];
    expect(first).toBe(fwd(path.join(history, '2026-11-01-1.json')));
    expect(second).toBe(fwd(path.join(history, '2026-11-01-2.json')));
    expect(fs.readFileSync(first!, 'utf-8').trim()).toBe('{}');
  });

  test('the gbrain prior-retros query reads the same state-root history', () => {
    expect(TMPL).toContain('glob: "{gstack_state_root}/projects/{repo_slug}/retros/*.json"');
    expect(TMPL).not.toContain('glob: ".context/retros/*.json"');
  });
});
