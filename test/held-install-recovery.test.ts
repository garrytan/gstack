/**
 * The held-install recovery commands published in docs/troubleshooting.md
 * (#auto-update-held-install-recovery). An install held by #3184 runs its own
 * old updater and old /gstack-upgrade, so the recovery fetches the new
 * bin/gstack-ff-update from the new revision into a private `mktemp -d`
 * directory and runs it there. The Git Bash forms run here verbatim against a
 * real gstack tree in three states (clean, dirty-conflicting,
 * already-unmerged), all in prefix mode; the PowerShell forms run under
 * powershell.exe in .github/workflows/windows-setup-e2e.yml.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gitFixtureTemplate } from './helpers/git-fixture-template';

const ROOT = path.resolve(import.meta.dir, '..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'troubleshooting.md'), 'utf8');
const SETUP_TAIL = '[ "$s" = 0 ] && ./setup';
const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

function form(name: string): string {
  const m = DOC.match(new RegExp(`<!-- form:${name} -->\\n\`\`\`(?:bash|powershell)\\n(.+)\\n\`\`\``));
  expect(m, name).not.toBeNull();
  return m![1]!;
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', timeout: 60_000 }).trim();
}
const EDITED = 'bin/gstack-session-update';
const CONFLICT_LINE = 'THROTTLE_SECONDS=3600  # 1 hour';

/**
 * origin/main: this tree with an upstream edit to one line of EDITED. Each
 * install sits one commit behind it, at the same tree without
 * bin/gstack-ff-update (an install that predates it), with VERSION 1.91.101.0.
 */
function makeFixture(source = ROOT) {
  if (source !== ROOT) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-held-')));
    bases.push(base);
    const { src, ...fx } = buildFixture(base, source);
    expect(src).toContain(CONFLICT_LINE);
    return { base, ...fx };
  }
  const { root: base, meta: { src, ...fx } } = rootTemplate.copy();
  bases.push(base);
  expect(src).toContain(CONFLICT_LINE);
  return { base, origin: path.join(base, 'origin.git'), ...fx };
}

/** makeFixture's origin.git for this checkout, built once per file; the per-test source checkouts build their own. */
const rootTemplate = gitFixtureTemplate({
  prefix: 'gstack-held-',
  realpath: true,
  build: (base) => {
    const { origin, ...meta } = buildFixture(base, ROOT);
    fs.rmSync(path.join(base, 'work'), { recursive: true, force: true });
    return meta;
  },
  rebind: () => {},
});
afterAll(() => rootTemplate.dispose());

function buildFixture(base: string, source: string) {
  const origin = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  execFileSync('git', ['clone', '-q', '--shared', source, work], { timeout: 60_000 });
  // A root commit of this tree: the checkout may be shallow, and a bare
  // origin refuses a shallow push. The clone already has a local main when
  // the source is on main (actions/checkout runs `checkout -B main` on a push).
  git(work, 'checkout', '-q', '--orphan', 'held-fixture');
  fs.writeFileSync(path.join(work, 'VERSION'), '1.91.101.0\n');
  fs.rmSync(path.join(work, 'bin', 'gstack-ff-update'), { force: true });
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'v1.91.101.0-shaped install');
  const held = git(work, 'rev-parse', 'HEAD');
  fs.copyFileSync(path.join(ROOT, 'bin', 'gstack-ff-update'), path.join(work, 'bin', 'gstack-ff-update'));
  const src = fs.readFileSync(path.join(work, EDITED), 'utf8');
  fs.writeFileSync(path.join(work, EDITED), src.replace(CONFLICT_LINE, 'THROTTLE_SECONDS=3600  # 1 hour (upstream)'));
  fs.writeFileSync(path.join(work, 'VERSION'), '1.91.102.0\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'the fixed release');
  const fixed = git(work, 'rev-parse', 'HEAD');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { timeout: 60_000 });
  git(work, 'push', '-q', origin, 'HEAD:refs/heads/main');
  return { origin, held, fixed, src };
}
type Fx = ReturnType<typeof makeFixture>;

/** An install at ~/.claude/skills/gstack under its own HOME (with a space), in prefix mode. */
function makeInstall(fx: Fx, name: string, state: 'clean' | 'dirty' | 'unmerged') {
  const home = path.join(fx.base, `home ${name}`);
  const install = path.join(home, '.claude', 'skills', 'gstack');
  fs.mkdirSync(path.dirname(install), { recursive: true });
  execFileSync('git', ['clone', '-q', fx.origin, install], { timeout: 60_000 });
  git(install, 'reset', '-q', '--hard', fx.held);
  for (const f of git(install, 'ls-files', 'SKILL.md', '*/SKILL.md').split('\n').slice(0, 12)) {
    const p = path.join(install, f);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/^name: (?!gstack-)/m, 'name: gstack-'));
  }
  const p = path.join(install, EDITED);
  if (state === 'dirty') fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(CONFLICT_LINE, 'THROTTLE_SECONDS=60  # LOCAL-EDIT'));
  if (state === 'unmerged') {
    const blob = (body: string) => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: install, input: body, encoding: 'utf8', timeout: 30_000 }).trim();
    const stages = [blob('base\n'), blob('ours LOCAL-EDIT\n'), blob('theirs\n')];
    git(install, 'update-index', '--force-remove', 'README.md');
    execFileSync('git', ['update-index', '--index-info'], { cwd: install, timeout: 30_000, input: stages.map((s, i) => `100644 ${s} ${i + 1}\tREADME.md\n`).join('') });
    fs.writeFileSync(path.join(install, 'README.md'), '<<<<<<< ours\nours LOCAL-EDIT\n=======\ntheirs\n>>>>>>> theirs\n');
  }
  return { home, install };
}

/** The Git Bash recovery form, verbatim up to its setup step, which prints a marker here. */
function recovery(home: string, tmp: string) {
  const cmd = form('recovery-gitbash');
  expect(cmd.endsWith(SETUP_TAIL)).toBe(true);
  return spawn('bash', ['-c', `${cmd.slice(0, -'./setup'.length)}echo SETUP_RAN`], {
    cwd: os.tmpdir(), env: { PATH: process.env.PATH!, HOME: home, TMPDIR: tmp, GIT_CONFIG_NOSYSTEM: '1' },
  });
}
function finish(child: ReturnType<typeof spawn>): Promise<{ code: number | null; out: string }> {
  let out = '';
  child.stdout!.on('data', (d) => { out += d; });
  child.stderr!.on('data', (d) => { out += d; });
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, out })));
}
function trap(fx: Fx) {
  const tmp = path.join(fx.base, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const victim = path.join(fx.base, 'victim');
  fs.writeFileSync(victim, 'victim\n');
  fs.symlinkSync(victim, path.join(tmp, 'gstack-ff-update'));
  return { tmp, victim };
}

describe.skipIf(process.platform === 'win32')('held-install recovery (Git Bash form)', () => {
  test('the published forms are labelled by shell and the PowerShell ones carry no double quotes inside bash', () => {
    for (const shell of ['recovery', 'trial', 'goback']) {
      expect(form(`${shell}-gitbash`)).toStartWith('cd ~/.claude/skills/gstack && ');
      const ps = form(`${shell}-powershell`);
      expect(ps).toStartWith('Set-Location -LiteralPath "$HOME\\.claude\\skills\\gstack" -ErrorAction Stop; $gb = Join-Path (git --exec-path) ');
      expect(ps).toEndWith('; if ($LASTEXITCODE -eq 0) { .\\setup.ps1 }');
      expect(ps).not.toContain('&&  ');
      const inner = ps.match(/& \$gb -c '([^']*)'/)![1]!;
      expect(inner).not.toContain('"');
      expect(ps.replace(/'[^']*'/g, '')).not.toContain('&&');
    }
    expect(form('recovery-gitbash')).toContain('d=$(mktemp -d)');
    expect(form('recovery-powershell')).toContain('d=$(mktemp -d)');
  });

  for (const checkout of ['on main', 'detached with no branch'] as const) {
    test(`the fixture builds from a source checkout ${checkout}`, () => {
      const src = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-held-src-'))), 'src');
      bases.push(path.dirname(src));
      execFileSync('git', ['clone', '-q', '--shared', ROOT, src], { timeout: 60_000 });
      if (checkout === 'on main') git(src, 'checkout', '-q', '-B', 'main');
      else {
        git(src, 'checkout', '-q', '--detach');
        for (const b of git(src, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean)) git(src, 'branch', '-q', '-D', b);
      }
      const fx = makeFixture(src);
      expect(git(fx.origin, 'rev-parse', 'refs/heads/main')).toBe(fx.fixed);
      expect(git(fx.origin, 'rev-parse', `${fx.fixed}^`)).toBe(fx.held);
      expect(git(fx.origin, 'rev-list', '--max-parents=0', fx.fixed)).toBe(fx.held);
    }, 60_000);
  }

  for (const state of ['clean', 'dirty', 'unmerged'] as const) {
    test(`a ${state} prefix-mode install reaches the fixed release; a planted symlink is never followed`, async () => {
      const fx = makeFixture();
      const { install, home } = makeInstall(fx, state, state);
      const { tmp, victim } = trap(fx);
      const { code, out } = await finish(recovery(home, tmp));
      expect(code, out).toBe(0);
      expect(out).toContain('SETUP_RAN');
      expect(git(install, 'rev-parse', 'HEAD')).toBe(fx.fixed);
      expect(git(install, 'ls-files', '-u')).toBe('');
      expect(fs.existsSync(path.join(install, 'bin', 'gstack-ff-update'))).toBe(true);
      expect(fs.readFileSync(path.join(install, 'SKILL.md'), 'utf8')).toMatch(/^name: gstack-/m);
      const refs = git(install, 'for-each-ref', '--format=%(refname)', 'refs/gstack/rescue').split('\n').filter(Boolean);
      if (state === 'clean') {
        expect(refs).toEqual([]);
        expect(out).toMatch(/^ok [0-9a-f]+ [0-9a-f]+$/m);
      } else {
        expect(refs).toHaveLength(1);
        const file = state === 'dirty' ? EDITED : 'README.md';
        expect(git(install, 'show', `${refs[0]}:${file}`)).toContain('LOCAL-EDIT');
        expect(git(install, 'diff', '--name-only', `${refs[0]}^`, refs[0])).toBe(file);
        expect(out).toContain(`unmerged=${state === 'unmerged' ? 1 : 0}`);
      }
      expect(fs.readFileSync(victim, 'utf8')).toBe('victim\n');
      expect(fs.readdirSync(tmp)).toEqual(['gstack-ff-update']);
    }, 60_000);
  }

  test('two recoveries at once share no script and clobber nothing', async () => {
    const fx = makeFixture();
    const a = makeInstall(fx, 'a', 'dirty');
    const b = makeInstall(fx, 'b', 'clean');
    const { tmp, victim } = trap(fx);
    const [ra, rb] = await Promise.all([finish(recovery(a.home, tmp)), finish(recovery(b.home, tmp))]);
    expect(ra.code, ra.out).toBe(0);
    expect(rb.code, rb.out).toBe(0);
    expect(git(a.install, 'rev-parse', 'HEAD')).toBe(fx.fixed);
    expect(git(b.install, 'rev-parse', 'HEAD')).toBe(fx.fixed);
    expect(fs.readFileSync(victim, 'utf8')).toBe('victim\n');
    expect(fs.readdirSync(tmp)).toEqual(['gstack-ff-update']);
  }, 60_000);

  test('trying a fix branch detaches with the footprint discarded, and going back returns to main', () => {
    const fx = makeFixture();
    const { install, home } = makeInstall(fx, 'trial', 'clean');
    git(install, 'reset', '-q', '--hard', fx.fixed);
    git(fx.origin, 'update-ref', 'refs/heads/fix-branch', fx.held);
    const run = (cmd: string) => spawnSync('bash', ['-c', cmd.replace(/ && \.\/setup$/, ' && echo SETUP_RAN')], {
      cwd: os.tmpdir(), encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }, timeout: 60_000,
    });
    fs.writeFileSync(path.join(install, 'SKILL.md'), fs.readFileSync(path.join(install, 'SKILL.md'), 'utf8').replace(/^name: (?!gstack-)/m, 'name: gstack-'));
    const trial = run(form('trial-gitbash').replace('<branch>', 'fix-branch'));
    expect(trial.status, trial.stdout + trial.stderr).toBe(0);
    expect(trial.stdout).toContain('SETUP_RAN');
    expect(git(install, 'rev-parse', 'HEAD')).toBe(fx.held);
    expect(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: install, timeout: 30_000 }).status).not.toBe(0);
    fs.writeFileSync(path.join(install, 'SKILL.md'), fs.readFileSync(path.join(install, 'SKILL.md'), 'utf8').replace(/^name: (?!gstack-)/m, 'name: gstack-'));
    const back = run(form('goback-gitbash'));
    expect(back.status, back.stdout + back.stderr).toBe(0);
    expect(git(install, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(git(install, 'rev-parse', 'HEAD')).toBe(fx.fixed);
    expect(git(install, 'status', '--porcelain')).toBe('');
  }, 60_000);
});
