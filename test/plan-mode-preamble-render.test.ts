/**
 * plan_mode_preamble=off reaches every installed render (#3168).
 *
 * Installed gstack never runs the generator by hand, so the key only works if
 * every render ./setup and the bin/ helpers run carries --plan-mode=off. The
 * default Claude install serves the committed SKILL.md files (which carry the
 * preamble) with no render at all, so with the key off it must get a render,
 * and turning the key back on must drop that render even where a detector
 * failure (gbrain=unknown) would otherwise keep it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const PLAN_ARG = '${_PLAN_MODE_ARG:+"$_PLAN_MODE_ARG"}';
const GENERATOR = /(?:\bbun(?: --no-env-file --config=(?:\/dev\/null|"\$\{GSTACK_BUN_CONFIG:-\/dev\/null\}"))?|\bbun_cmd|_gstack_render_bun) run (?:gen:skill-docs(?::user)?|scripts\/gen-skill-docs\.ts) --[a-z]/;
const CONFIG_READ = '[ "$("$GSTACK_CONFIG" get plan_mode_preamble 2>/dev/null || true)" != off ] || _PLAN_MODE_ARG="--plan-mode=off"';

/** Generator invocations in a file: not comments, and not echoed or logged instructions. */
function renders(rel: string): string[] {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n')
    .filter(line => GENERATOR.test(line) && !/^\s*(#|echo\b|log\b)/.test(line));
}

describe('every installed-skill render carries the plan-mode arg', () => {
  test('setup: every gen:skill-docs call site, with the key read once', () => {
    const lines = renders('setup');
    expect(lines.length).toBeGreaterThanOrEqual(16);
    for (const line of lines) expect(line, line).toContain(PLAN_ARG);
    const setup = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');
    expect(setup.split(CONFIG_READ).length - 1).toBe(1);
    expect(setup.indexOf(CONFIG_READ)).toBeLessThan(setup.indexOf('bun_cmd run gen:skill-docs --host factory'));
  });

  test('the Claude render helper, gbrain-refresh and the relink router render', () => {
    for (const rel of ['bin/gstack-render-claude.sh', 'bin/gstack-config', 'bin/gstack-relink']) {
      const lines = renders(rel);
      expect(lines.length, rel).toBeGreaterThanOrEqual(1);
      for (const line of lines) expect(line, `${rel}: ${line}`).toContain(PLAN_ARG);
    }
    expect(fs.readFileSync(path.join(ROOT, 'bin/gstack-relink'), 'utf8')).toContain(CONFIG_READ);
    expect(fs.readFileSync(path.join(ROOT, 'bin/gstack-config'), 'utf8'))
      .toContain('[ "$("$0" get plan_mode_preamble 2>/dev/null || true)" != off ] || _PLAN_MODE_ARG="--plan-mode=off"');
  });

  test('setup: a build (which renders without the arg) does not skip the host re-renders when the key is off', () => {
    const setup = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');
    const guards = setup.split('\n').filter(line => /^if \[ "\$INSTALL_[A-Z]+" -eq 1 \] && .*NEEDS_BUILD/.test(line));
    expect(guards.length).toBe(6);
    for (const line of guards) expect(line, line).toContain('{ [ "$NEEDS_BUILD" -eq 0 ] || [ -n "$_PLAN_MODE_ARG" ]; }');
  });

  test('setup: with the key off the gbrain-absent branch leaves the render for the plain re-render (a failed render keeps it)', () => {
    const setup = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');
    const removal = setup.split('\n').filter(line => /if \[ -d "\$_GSTACK_RENDER_DIR" \].*\$_GSTACK_OVERLAY" = claude/.test(line));
    expect(removal.length).toBe(1);
    expect(removal[0]).toContain('[ -z "$_PLAN_MODE_ARG" ]');
  });
});

describe('gstack-relink router re-render', () => {
  const BINS = ['gstack-config', 'gstack-relink', 'gstack-patch-names', 'gstack-state-root.sh', 'gstack-install-registry.sh'];
  const SAFE = '## Plan Mode Safe Operations';

  function relinkFixture() {
    const install = path.join(tmp, 'gstack');
    fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
    for (const b of BINS) {
      fs.copyFileSync(path.join(ROOT, 'bin', b), path.join(install, 'bin', b));
      fs.chmodSync(path.join(install, 'bin', b), 0o755);
    }
    fs.symlinkSync(path.join(ROOT, 'scripts'), path.join(install, 'scripts'));
    fs.copyFileSync(path.join(ROOT, 'SKILL.md'), path.join(install, 'SKILL.md'));
    fs.mkdirSync(path.join(install, 'ship'));
    fs.writeFileSync(path.join(install, 'ship', 'SKILL.md'), '---\nname: ship\ndescription: test\n---\n# ship\n');
    const env = {
      ...process.env,
      GSTACK_HOME: path.join(tmp, 'state'),
      GSTACK_STATE_ROOT: '',
      GSTACK_STATE_DIR: '',
      GSTACK_INSTALL_DIR: install,
      GSTACK_SKILLS_DIR: path.join(tmp, 'skills'),
      GSTACK_SETUP_RUNNING: '1',
    };
    const run = (bin: string, ...args: string[]) => {
      const r = spawnSync('bash', [path.join(install, 'bin', bin), ...args], { encoding: 'utf8', timeout: 60_000, env });
      expect(r.status, r.stderr).toBe(0);
      return r;
    };
    const router = () => fs.readFileSync(path.join(install, 'SKILL.md'), 'utf8');
    const alias = () => fs.readFileSync(path.join(tmp, 'skills', '_gstack-command', 'SKILL.md'), 'utf8');
    const asAlias = (text: string) => text.replace(/^name: gstack$/m, 'name: _gstack-command');
    return { run, router, alias, asAlias };
  }

  test('off strips the router and its _gstack-command alias; on restores both to the committed bytes', () => {
    const { run, router, alias, asAlias } = relinkFixture();
    const committed = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
    run('gstack-relink');
    expect(router()).toBe(committed);
    expect(alias()).toBe(asAlias(committed));

    run('gstack-config', 'set', 'plan_mode_preamble', 'off');
    run('gstack-relink');
    expect(router()).not.toContain(SAFE);
    expect(router()).toContain('PLAN MODE EXCEPTION');
    expect(alias()).toBe(asAlias(router()));

    run('gstack-config', 'set', 'plan_mode_preamble', 'on');
    run('gstack-relink');
    expect(router()).toBe(committed);
    expect(alias()).toBe(asAlias(committed));
  });

  test('disabled_skills: the alias follows the re-rendered router in the same run', () => {
    const { run, router, alias, asAlias } = relinkFixture();
    run('gstack-config', 'set', 'disabled_skills', 'ship');
    run('gstack-relink');
    expect(router()).toContain('Disabled on this install (never invoke or suggest them): `/ship`.');
    expect(alias()).toBe(asAlias(router()));
  });
});

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-plan-mode-render-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/**
 * Source the real helper with a stub generator (bun_cmd) that logs its
 * arguments and writes one SKILL.md into --out-dir, then run SCRIPT.
 * PLAN is the caller's _PLAN_MODE_ARG; OVERLAY a pinned overlay or claude.
 */
function helper(script: string, plan: string, overlay = 'claude') {
  const src = path.join(tmp, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'VERSION'), '0.1.2.3\n');
  const prelude = `set -euo pipefail
. ${JSON.stringify(path.join(ROOT, 'bin/gstack-render-claude.sh'))}
_swap_in_render() { rm -rf "$1"; mv "$2" "$1"; }
bun_cmd() {
  printf '%s\\n' "$*" >> "$TMPROOT/bun.log"
  local out="" prev=""
  for a in "$@"; do [ "$prev" = --out-dir ] && out="$a"; prev="$a"; done
  mkdir -p "$out/autoplan" && echo rendered > "$out/autoplan/SKILL.md"
}
SRC="$TMPROOT/src"; R="$TMPROOT/render/claude"
_GSTACK_OVERLAY="$OVERLAY"; _GSTACK_OVERLAY_ID="$OVERLAY"; _GSTACK_OVERLAY_GENERIC=0
_GSTACK_OVERLAY_SOURCE=default; [ "$OVERLAY" = claude ] || _GSTACK_OVERLAY_SOURCE=explicit
_PLAN_MODE_ARG="$PLAN"
`;
  const r = spawnSync('bash', ['-c', prelude + script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPROOT: tmp, PLAN: plan, OVERLAY: overlay },
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}
const action = (gbrain: string, plan: string, overlay = 'claude') =>
  helper(`gstack_claude_render_action "$R" ${gbrain}; echo "$_GSTACK_RENDER_ACTION"`, plan, overlay).trim();
const record = () => fs.readFileSync(path.join(tmp, 'render/claude.overlay'), 'utf8');
const bunLog = () => fs.readFileSync(path.join(tmp, 'bun.log'), 'utf8');

describe('gstack_claude_render_action / render_plain / render_settle', () => {
  test('key on or unset: the default install keeps today\'s actions', () => {
    expect(action('unknown', '')).toBe('keep');
    expect(action('absent', '')).toBe('remove');
    expect(action('ok', '')).toBe('user');
    expect(action('absent', '', 'opus-4-7')).toBe('plain');
  });

  test('key off: the default install renders (plain) whatever detection says, brain renders stay user', () => {
    expect(action('unknown', '--plan-mode=off')).toBe('plain');
    expect(action('absent', '--plan-mode=off')).toBe('plain');
    expect(action('ok', '--plan-mode=off')).toBe('user');
  });

  test('key off: the plain render passes --plan-mode=off and the record says so', () => {
    const out = helper('gstack_claude_render_plain "$SRC" "$R" && gstack_claude_render_settle "$SRC" "$R" absent rendered', '--plan-mode=off');
    expect(out).toContain('Rendering Claude skills with the claude overlay and no plan-mode preamble into');
    expect(bunLog()).toMatch(/run gen:skill-docs --host claude --out-dir \S+ --link-root \S+ --model claude --plan-mode=off$/m);
    expect(fs.existsSync(path.join(tmp, 'render/claude/autoplan/SKILL.md'))).toBe(true);
    expect(record()).toBe('overlay=claude\nsource=default\nmodel=claude\nversion=0.1.2.3\ngbrain=absent\nrender=user\nplan_mode=off\n');
    expect(out).not.toContain('Claude skill overlay:');
  });

  test('switching back on drops the stale render, including the gbrain=unknown keep branch', () => {
    helper('gstack_claude_render_plain "$SRC" "$R" && gstack_claude_render_settle "$SRC" "$R" unknown rendered', '--plan-mode=off');
    expect(record()).toContain('plan_mode=off');
    expect(action('unknown', '')).toBe('remove');
    expect(action('absent', '')).toBe('remove');
    helper('rm -rf "$R"; gstack_claude_render_settle "$SRC" "$R" unknown removed', '');
    expect(fs.existsSync(path.join(tmp, 'render/claude.overlay'))).toBe(false);
    expect(action('unknown', '')).toBe('keep');
  });

  test('a brain render made with the key on is still kept on gbrain=unknown', () => {
    helper('mkdir -p "$R" && gstack_claude_render_settle "$SRC" "$R" ok rendered', '');
    expect(record()).not.toContain('plan_mode');
    expect(action('unknown', '')).toBe('keep');
  });

  test('key on: a pinned render and its record are byte-for-byte unchanged', () => {
    helper('gstack_claude_render_plain "$SRC" "$R" && gstack_claude_render_settle "$SRC" "$R" absent rendered', '', 'opus-4-7');
    expect(bunLog()).toMatch(/run gen:skill-docs --host claude --out-dir \S+ --link-root \S+ --model opus-4-7$/m);
    expect(record()).toBe('overlay=opus-4-7\nsource=explicit\nmodel=opus-4-7\nversion=0.1.2.3\ngbrain=absent\nrender=user\n');
  });
});
