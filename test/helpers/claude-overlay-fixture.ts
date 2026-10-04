/**
 * Shared setup for the W7 Claude overlay opt-in tests
 * (test/claude-overlay-setup-{default,lifecycle,installs}.test.ts), which
 * exercise `./setup --claude-model <id>` and `gstack-config gbrain-refresh`
 * through the real ./setup against throwaway checkouts and HOMEs
 * (test/helpers/install-fixture.ts).
 *
 * The overlay is the family of the persisted `claude_overlay_model`, written
 * only by `--claude-model`, or `claude` when the key is absent. Renders and
 * their activation records come from bin/gstack-render-claude.sh. MARKER is
 * text only the opus-4-7 and opus-4-8 overlays render.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Fixture, put, runSetup } from './install-fixture';

export const MARKER = 'Effort-match the step';

/** The fixture's bun, plus a switch that fails every out-dir render. */
export function failableBun(f: Fixture) {
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
export function fakeDetect(src: string) {
  put(join(src, 'bin/gstack-gbrain-detect'), `#!/usr/bin/env bash
mode="$(cat "$HOME/gbrain-mode" 2>/dev/null || echo absent)"
[ "$mode" = fail ] && exit 1
if [ "\${1:-}" = --is-ok ]; then [ "$mode" = ok ]; exit $?; fi
if [ "$mode" = ok ]; then echo '{"gbrain_local_status":"ok","gbrain_version":"0.0.1"}'; else echo '{"gbrain_local_status":"no-cli"}'; fi
`, 0o755);
}

export function setup(f: Fixture, src: string, args: string[] = [], cwd?: string) {
  const r = runSetup(f, join(src, 'setup'), ['--no-prefix', ...args], { cwd });
  return { ...r, out: `${r.stdout}\n${r.stderr}` };
}

export function config(f: Fixture, src: string, ...args: string[]) {
  return spawnSync('bash', [join(src, 'bin/gstack-config'), ...args], { env: f.env, encoding: 'utf8', timeout: 120_000 });
}

export const defaultRender = (f: Fixture) => join(f.home, '.gstack/render/claude');

export function record(render: string): Record<string, string> {
  const file = `${render}.overlay`;
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
}

export const served = (skills: string) => readFileSync(join(skills, 'autoplan/SKILL.md'), 'utf8');
