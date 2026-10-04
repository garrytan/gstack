/**
 * W7 Claude overlay opt-in (`./setup --claude-model <id>`), exercised through
 * the real ./setup and `gstack-config gbrain-refresh` against throwaway
 * checkouts and HOMEs (test/helpers/install-fixture.ts).
 *
 * The overlay is the family of the persisted `claude_overlay_model`, written
 * only by `--claude-model`, or `claude` when the key is absent. Renders and
 * their activation records come from bin/gstack-render-claude.sh. The marker
 * below is text only the opus-4-7 and opus-4-8 overlays render.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupFixtures, cleanupSeed, type Fixture, makeFixture, makeSource, put, registryRows, runSetup, setVersion } from './helpers/install-fixture';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

const MARKER = 'Effort-match the step';

/** The fixture's bun, plus a switch that fails every out-dir render. */
function failableBun(f: Fixture) {
  put(join(f.commands, 'bun'), `#!/usr/bin/env bash
case "$*" in
  'install --frozen-lockfile') exit 0 ;;
  'run build') echo 'Unexpected build in an install fixture' >&2; exit 90 ;;
  *gen:skill-docs*--out-dir*) if [ -f "$HOME/fail-render" ]; then echo 'render failed (fixture)' >&2; exit 7; fi ;;
esac
exec ${JSON.stringify(process.execPath)} "$@"
`, 0o755);
}

/** gbrain detection driven by $HOME/gbrain-mode: ok, absent (default) or fail. */
function fakeDetect(src: string) {
  put(join(src, 'bin/gstack-gbrain-detect'), `#!/usr/bin/env bash
mode="$(cat "$HOME/gbrain-mode" 2>/dev/null || echo absent)"
[ "$mode" = fail ] && exit 1
if [ "\${1:-}" = --is-ok ]; then [ "$mode" = ok ]; exit $?; fi
if [ "$mode" = ok ]; then echo '{"gbrain_local_status":"ok","gbrain_version":"0.0.1"}'; else echo '{"gbrain_local_status":"no-cli"}'; fi
`, 0o755);
}

function setup(f: Fixture, src: string, args: string[] = [], cwd?: string) {
  const r = runSetup(f, join(src, 'setup'), ['--no-prefix', ...args], { cwd });
  return { ...r, out: `${r.stdout}\n${r.stderr}` };
}

function config(f: Fixture, src: string, ...args: string[]) {
  return spawnSync('bash', [join(src, 'bin/gstack-config'), ...args], { env: f.env, encoding: 'utf8', timeout: 120_000 });
}

const defaultRender = (f: Fixture) => join(f.home, '.gstack/render/claude');

function record(render: string): Record<string, string> {
  const file = `${render}.overlay`;
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
}

const served = (skills: string) => readFileSync(join(skills, 'autoplan/SKILL.md'), 'utf8');

describe.skipIf(process.platform === 'win32')('./setup --claude-model (default install)', () => {
  test('no claude_overlay_model: committed render, no render dir, no record', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    const r = setup(f, src);
    expect(r.status, r.out).toBe(0);
    expect(existsSync(defaultRender(f))).toBe(false);
    expect(existsSync(`${defaultRender(f)}.overlay`)).toBe(false);
    expect(config(f, src, 'has', 'claude_overlay_model').status).not.toBe(0);
    expect(served(join(f.home, '.claude/skills'))).toBe(readFileSync(join(src, 'autoplan/SKILL.md'), 'utf8'));
    expect(r.out).not.toContain('Claude skill overlay:');
    const status = setup(f, src, ['--status']);
    expect(status.stdout).toContain('~/.claude/skills: claude (default, committed render)');
  }, 120_000);

  test('pinned overlay renders and persists; the banner shows only on change; claude returns to committed files', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    const skills = join(f.home, '.claude/skills');

    const pinned = setup(f, src, ['--claude-model', 'claude-opus-4-7']);
    expect(pinned.status, pinned.out).toBe(0);
    expect(config(f, src, 'get', 'claude_overlay_model').stdout).toBe('claude-opus-4-7');
    expect(pinned.out).toContain('Claude skill overlay: opus-4-7 (was claude).');
    expect(pinned.out).toContain('./setup --claude-model claude');
    expect(record(defaultRender(f))).toMatchObject({ overlay: 'opus-4-7', source: 'explicit', model: 'claude-opus-4-7', gbrain: 'absent', render: 'user' });
    expect(served(skills)).toContain(MARKER);
    expect(readFileSync(join(src, 'autoplan/SKILL.md'), 'utf8')).not.toContain(MARKER);

    const again = setup(f, src);
    expect(again.status, again.out).toBe(0);
    expect(again.out).not.toContain('Claude skill overlay:');
    expect(served(skills)).toContain(MARKER);

    const back = setup(f, src, ['--claude-model', 'claude']);
    expect(back.status, back.out).toBe(0);
    expect(config(f, src, 'get', 'claude_overlay_model').stdout).toBe('claude');
    expect(back.out).toContain('Claude skill overlay: claude (was opus-4-7).');
    expect(existsSync(defaultRender(f))).toBe(false);
    expect(record(defaultRender(f))).toMatchObject({ overlay: 'claude', source: 'explicit', render: 'committed' });
    expect(served(skills)).not.toContain(MARKER);
  }, 180_000);

  test('an ID without its own overlay is accepted as the generic overlay', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    const r = setup(f, src, ['--claude-model=claude-opus-5-5']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('claude-opus-5-5 has no overlay of its own, so it uses the generic claude overlay');
    expect(config(f, src, 'get', 'claude_overlay_model').stdout).toBe('claude-opus-5-5');
    expect(existsSync(defaultRender(f))).toBe(false);
  }, 120_000);

  test('invalid IDs, a missing value and a non-Claude host error before anything is persisted', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    for (const [args, expected] of [
      [['--claude-model', 'opus'], 'is a Claude Code alias'],
      [['--claude-model', 'gpt-5.4'], 'selects Claude overlays only'],
      [['--claude-model=banana'], 'does not match any model family'],
      [['--host', 'codex', '--claude-model', 'claude-opus-4-7'], '--claude-model is supported only when Claude is selected'],
    ] as const) {
      const r = setup(f, src, [...args]);
      expect(r.status, r.out).toBe(1);
      expect(r.stderr).toContain(expected);
      expect(r.stderr).toContain('Nothing was installed or changed.');
    }
    expect(config(f, src, 'has', 'claude_overlay_model').status).not.toBe(0);
    for (const args of [['--claude-model'], ['--claude-model=']]) {
      const missing = spawnSync('bash', [join(src, 'setup'), ...args], { env: f.env, encoding: 'utf8', timeout: 30_000 });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('Missing value for --claude-model');
    }
    const typo = runSetup(f, join(src, 'setup'), ['--claude-modle', 'claude-opus-4-8']);
    expect(typo.status).toBe(2);
    expect(typo.stderr).toContain('Did you mean: ./setup --claude-model claude-opus-4-8');
    const codexOnly = setup(f, src, ['--model', 'gpt-5.4']);
    expect(codexOnly.stderr).toContain('For the Claude overlay, use --claude-model <id>.');
  }, 240_000);

  test('a persisted ID that no longer resolves falls back to claude and says why', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    expect(config(f, src, 'set', 'claude_overlay_model', 'opus').status).toBe(0);
    const r = setup(f, src);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("claude_overlay_model 'opus' no longer resolves to a Claude overlay");
    expect(r.out).toContain('using the generic claude overlay');
    expect(existsSync(defaultRender(f))).toBe(false);
  }, 120_000);
});

describe.skipIf(process.platform === 'win32')('overlay render lifecycle with gbrain and failures', () => {
  test('gbrain present → absent keeps a pinned overlay; a failed detector still renders it', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    fakeDetect(src);
    const skills = join(f.home, '.claude/skills');

    put(join(f.home, 'gbrain-mode'), 'ok');
    expect(setup(f, src, ['--claude-model', 'claude-opus-4-8']).status).toBe(0);
    expect(record(defaultRender(f))).toMatchObject({ overlay: 'opus-4-8', gbrain: 'ok' });
    expect(served(skills)).toContain(MARKER);

    put(join(f.home, 'gbrain-mode'), 'absent');
    const refresh = config(f, src, 'gbrain-refresh');
    expect(refresh.status, refresh.stdout + refresh.stderr).toBe(0);
    expect(refresh.stdout).toContain('gbrain not detected');
    expect(record(defaultRender(f))).toMatchObject({ overlay: 'opus-4-8', gbrain: 'absent' });
    expect(served(skills)).toContain(MARKER);

    put(join(f.home, 'gbrain-mode'), 'fail');
    const failed = setup(f, src);
    expect(failed.status, failed.out).toBe(0);
    expect(failed.out).toContain('gstack-gbrain-detect failed');
    expect(record(defaultRender(f))).toMatchObject({ overlay: 'opus-4-8', gbrain: 'unknown' });
    expect(served(skills)).toContain(MARKER);
  }, 240_000);

  test('gbrain present → absent with the default overlay drops the brain render', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    fakeDetect(src);
    expect(setup(f, src).status).toBe(0);
    put(join(f.home, 'gbrain-mode'), 'ok');
    expect(config(f, src, 'gbrain-refresh').status).toBe(0);
    expect(existsSync(join(defaultRender(f), 'autoplan/SKILL.md'))).toBe(true);
    expect(record(defaultRender(f))).toMatchObject({ overlay: 'claude', source: 'default', gbrain: 'ok' });

    put(join(f.home, 'gbrain-mode'), 'absent');
    const r = config(f, src, 'gbrain-refresh');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(defaultRender(f))).toBe(false);
    expect(existsSync(`${defaultRender(f)}.overlay`)).toBe(false);
    expect(served(join(f.home, '.claude/skills'))).toBe(readFileSync(join(src, 'autoplan/SKILL.md'), 'utf8'));
  }, 180_000);

  test('a failed render keeps the previous render; after an upgrade it serves the committed files', () => {
    const f = makeFixture();
    failableBun(f);
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    const skills = join(f.home, '.claude/skills');
    expect(setup(f, src, ['--claude-model', 'claude-sonnet-5']).status).toBe(0);
    expect(record(defaultRender(f)).overlay).toBe('sonnet-5');

    put(join(f.home, 'fail-render'), '1');
    const kept = setup(f, src);
    expect(kept.status, kept.out).toBe(0);
    expect(kept.out).toContain('the previous render (sonnet-5 overlay) stays in use');
    expect(existsSync(join(defaultRender(f), 'autoplan/SKILL.md'))).toBe(true);

    setVersion(src, '9.9.9.9');
    const upgraded = setup(f, src);
    expect(upgraded.status, upgraded.out).toBe(0);
    expect(upgraded.out).toContain('the committed claude render is served');
    expect(upgraded.out).toContain('Claude skill overlay: claude (was sonnet-5).');
    expect(existsSync(defaultRender(f))).toBe(false);
    expect(record(defaultRender(f))).toMatchObject({ overlay: 'claude', source: 'explicit', render: 'committed', version: '9.9.9.9' });
    expect(served(skills)).toBe(readFileSync(join(src, 'autoplan/SKILL.md'), 'utf8'));
  }, 240_000);

  test('concurrent gbrain-refresh runs leave one valid render and no temp, old or lock dirs', async () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    fakeDetect(src);
    expect(setup(f, src, ['--claude-model', 'claude-opus-4-7']).status).toBe(0);
    put(join(f.home, 'gbrain-mode'), 'ok');
    const run = () => new Promise<{ code: number | null; err: string }>(resolve => {
      const child = spawn('bash', [join(src, 'bin/gstack-config'), 'gbrain-refresh'], { env: f.env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', chunk => { err += chunk; });
      child.on('exit', code => resolve({ code, err }));
    });
    const runs = await Promise.all([run(), run(), run()]);
    expect(runs).toEqual([{ code: 0, err: '' }, { code: 0, err: '' }, { code: 0, err: '' }]);
    const renderParent = join(f.home, '.gstack/render');
    expect(readdirSync(renderParent).sort()).toEqual(['claude', 'claude.overlay']);
    expect(readdirSync(defaultRender(f)).filter(name => name.startsWith('claude'))).toEqual([]);
    expect(readFileSync(join(defaultRender(f), 'autoplan/SKILL.md'), 'utf8')).toContain(MARKER);
    expect(record(defaultRender(f))).toMatchObject({ overlay: 'opus-4-7', gbrain: 'ok' });
  }, 240_000);
});

describe.skipIf(process.platform === 'win32')('nondefault installs, refresh and status', () => {
  test('a project install keeps its own per-install render: pinned, back to claude, failure keeps the previous render', () => {
    const f = makeFixture();
    failableBun(f);
    const project = join(f.home, 'proj');
    const vendored = makeSource(f, join(project, '.claude/skills/gstack'));
    const skills = join(project, '.claude/skills');
    const renderOf = () => registryRows(f).find(row => row[0] === 'claude')?.[8] ?? '';

    expect(setup(f, vendored, ['--claude-model', 'claude-opus-4-7'], project).status).toBe(0);
    const render = renderOf();
    expect(render).toContain('/render/installs/claude-');
    expect(record(render)).toMatchObject({ overlay: 'opus-4-7', source: 'explicit' });
    expect(served(skills)).toContain(MARKER);
    expect(served(skills)).toContain(`${vendored}/bin/gstack-skill-start`);

    expect(setup(f, vendored, ['--claude-model', 'claude'], project).status).toBe(0);
    expect(renderOf()).toBe(render);
    expect(record(render).overlay).toBe('claude');
    expect(served(skills)).not.toContain(MARKER);
    expect(served(skills)).toContain(`${vendored}/bin/gstack-skill-start`);

    put(join(f.home, 'fail-render'), '1');
    const failed = setup(f, vendored, ['--claude-model', 'claude-opus-4-8'], project);
    expect(failed.status, failed.out).toBe(0);
    expect(failed.out).toContain('the previous render stays in use');
    expect(served(skills)).toContain(`${vendored}/bin/gstack-skill-start`);
    expect(served(skills)).not.toContain(MARKER);
  }, 240_000);

  test('--refresh-registered persists the overlay before refreshing; later refreshes honor it with no flag', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    expect(setup(f, src).status).toBe(0);
    const refreshed = setup(f, src, ['--refresh-registered', '--claude-model', 'claude-opus-4-7']);
    expect(refreshed.status, refreshed.out).toBe(0);
    expect(config(f, src, 'get', 'claude_overlay_model').stdout).toBe('claude-opus-4-7');
    expect(record(defaultRender(f)).overlay).toBe('opus-4-7');

    const quiet = runSetup(f, join(src, 'setup'), ['-q', '--refresh-registered']);
    expect(quiet.status, quiet.stdout + quiet.stderr).toBe(0);
    expect(record(defaultRender(f)).overlay).toBe('opus-4-7');
    expect(served(join(f.home, '.claude/skills'))).toContain(MARKER);
  }, 180_000);

  test('./setup --status reports the overlay without bun on PATH', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    expect(setup(f, src, ['--claude-model', 'claude-opus-4-7']).status).toBe(0);
    const noBunPath = '/usr/bin:/bin';
    expect(spawnSync('bash', ['-c', 'command -v bun'], { env: { ...f.env, PATH: noBunPath }, encoding: 'utf8', timeout: 10_000 }).status).not.toBe(0);
    const r = spawnSync('bash', [join(src, 'setup'), '--status'], { env: { ...f.env, PATH: noBunPath }, encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Claude skill overlay:');
    expect(r.stdout).toContain('~/.claude/skills: opus-4-7 (explicit: claude-opus-4-7, user render, gstack ');
  }, 120_000);
});
