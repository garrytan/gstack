/**
 * Claude Code runs gstack's hook shims through /bin/sh. A shim that does not
 * parse exits 2, which for a PreToolUse hook blocks the tool call in every
 * session. bin/gstack-hook-check parses every hook setup registers (the shim
 * with the interpreter its shebang names, and each TypeScript entry it runs
 * bundled with its local imports), and setup registers the hooks that parse,
 * refuses the rest with file and line, and exits non-zero.
 *
 * The setup tests run the real hook sections of setup (canonical root, gate,
 * heal, SessionStart, plan-tune and Stop registration, and the final refusal)
 * against a fixture install and a temp settings.json; driving all of ./setup
 * (builds, browser install) here is disproportionate.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const CHECK = path.join(ROOT, 'bin', 'gstack-hook-check');
const SETUP = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');

function slice(from: string, to: string | null): string {
  const start = SETUP.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = to === null ? SETUP.length : SETUP.indexOf(to, start);
  expect(end).toBeGreaterThan(start);
  return SETUP.slice(start, end);
}

const HOOK_SECTIONS = [
  slice('CANONICAL_GSTACK_ROOT="${CLAUDE_CONFIG_DIR', '# ─── GBrain detection'),
  slice('# 11. Plan-tune cathedral hook install', '# ─── Redact pre-push guard consent'),
  slice('if [ -n "${_HOOK_REFUSED:-}" ]; then', null),
].join('\n');

function listHooks(root: string, setupFile?: string): string[] {
  const args = setupFile ? ['--setup', setupFile, '--list', root] : ['--list', root];
  const r = spawnSync('bash', [CHECK, ...args], { encoding: 'utf8', timeout: 15_000 });
  expect(r.status).toBe(0);
  return r.stdout.trim().split('\n');
}

const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

const HOOKS = listHooks(ROOT);

/** Skills whose frontmatter registers a hook command. */
const SKILLS_WITH_HOOKS = fs.readdirSync(ROOT).filter((dir) => {
  const skill = path.join(ROOT, dir, 'SKILL.md');
  return fs.existsSync(skill) && /^---\n[\s\S]*?^\s*command:[\s\S]*?\n---/m.test(fs.readFileSync(skill, 'utf8'));
});

/** A gstack tree with the real hook shims and skill frontmatter, sourced helpers, and trivial TypeScript entries. */
function fixtureTree(root: string) {
  for (const hook of HOOKS) {
    fs.mkdirSync(path.dirname(path.join(root, hook)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, hook), path.join(root, hook));
    fs.chmodSync(path.join(root, hook), 0o755);
    if (fs.existsSync(path.join(ROOT, `${hook}.ts`))) fs.writeFileSync(path.join(root, `${hook}.ts`), 'export const ok = 1;\n');
  }
  for (const dir of SKILLS_WITH_HOOKS) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.copyFileSync(path.join(ROOT, dir, 'SKILL.md'), path.join(root, dir, 'SKILL.md'));
  }
  for (const helper of ['careful/bin/hook-extract.sh', 'bin/gstack-state-root.sh']) {
    fs.mkdirSync(path.dirname(path.join(root, helper)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, helper), path.join(root, helper));
  }
  fs.copyFileSync(path.join(ROOT, 'setup'), path.join(root, 'setup'));
}

function tmpBase(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-gate-'));
  bases.push(base);
  return base;
}

function check(root: string) {
  const r = spawnSync('bash', [CHECK, root], { encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('gstack-hook-check: the hook list is the registration code', () => {
  test('equals every hook setup resolves for registration plus every gstack path a skill frontmatter command runs', () => {
    const registered = [...SETUP.matchAll(/_hook_command_path (\S+)/g)].map(m => m[1]!.replace(/\W+$/, ''));
    const frontmatter = fs.readdirSync(ROOT).flatMap((dir) => {
      const skill = path.join(ROOT, dir, 'SKILL.md');
      if (!fs.existsSync(skill)) return [];
      const front = fs.readFileSync(skill, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
      return front.split('\n').filter(line => /^\s*command:/.test(line))
        .flatMap(line => [...line.matchAll(/skills\/gstack\/([\w./-]+)/g)].map(m => m[1]!));
    });
    const expected = [...new Set([...registered, ...frontmatter])].sort();
    expect(registered.length).toBeGreaterThanOrEqual(5);
    for (const hook of ['autoplan/bin/phase-publication-hook', 'careful/bin/check-careful.sh',
      'freeze/bin/check-freeze.sh', 'plan-ceo-review/bin/mode-handoff-hook']) expect(frontmatter).toContain(hook);
    expect([...HOOKS].sort()).toEqual(expected);
  });

  test('every shipped hook in this checkout passes', () => {
    const r = check(ROOT);
    expect(r.code).toBe(0);
    expect(r.out.trim().split('\n')).toEqual(HOOKS.map(h => `ok ${h}`));
  });
});

describe('gstack-hook-check: what fails', () => {
  test('healthy fixture passes', () => {
    const root = tmpBase();
    fixtureTree(root);
    expect(check(root).code).toBe(0);
  });

  test('a half-merged shell shim fails with its file and line', () => {
    const root = tmpBase();
    fixtureTree(root);
    const shim = path.join(root, 'hosts/claude/hooks/question-preference-hook');
    const lines = fs.readFileSync(shim, 'utf8').split('\n').length;
    fs.appendFileSync(shim, '<<<<<<< HEAD\nif [ -n "$x" ]; then\n');
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(new RegExp(`^fail hosts/claude/hooks/question-preference-hook ${shim}:${lines}: syntax error`, 'm'));
  });

  test('a TypeScript entry with a syntax error fails with its file and line', () => {
    const root = tmpBase();
    fixtureTree(root);
    const ts = path.join(root, 'hosts/claude/hooks/timeline-stop-hook.ts');
    fs.writeFileSync(ts, 'export const ok = 1;\nexport const x = {;\n');
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`fail hosts/claude/hooks/timeline-stop-hook ${ts}:2: Expected identifier`);
  });

  test('a broken module the entry imports fails at the imported file', () => {
    const root = tmpBase();
    fixtureTree(root);
    const dir = path.join(root, 'hosts/claude/hooks');
    fs.writeFileSync(path.join(dir, 'question-log-hook.ts'), "import { log } from './hook-log';\nimport { chromium } from 'playwright';\nlog(chromium);\n");
    fs.writeFileSync(path.join(dir, 'hook-log.ts'), 'export function log(x: unknown) {\n  return x +;\n}\n');
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`fail hosts/claude/hooks/question-log-hook ${path.join(dir, 'hook-log.ts')}:2:`);
    expect(r.out).not.toContain('playwright');
  });

  test('a missing local import fails', () => {
    const root = tmpBase();
    fixtureTree(root);
    const entry = path.join(root, 'autoplan/bin/phase-publication-hook.ts');
    fs.writeFileSync(entry, "import { x } from '../../lib/gone';\nconsole.log(x);\n");
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`fail autoplan/bin/phase-publication-hook ${entry}:1: Could not resolve: "../../lib/gone"`);
  });

  test('a missing entry fails instead of being skipped', () => {
    const root = tmpBase();
    fixtureTree(root);
    const entry = path.join(root, 'hosts/claude/hooks/auq-error-fallback-hook.ts');
    fs.rmSync(entry);
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`fail hosts/claude/hooks/auq-error-fallback-hook ${entry}:1: missing TypeScript entry`);
  });

  test('a sourced helper that does not parse fails at the helper', () => {
    const root = tmpBase();
    fixtureTree(root);
    const helper = path.join(root, 'careful/bin/hook-extract.sh');
    fs.appendFileSync(helper, 'if then\n');
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(new RegExp(`^fail careful/bin/check-careful.sh ${helper}:\\d+: syntax error`, 'm'));
    expect(r.out).toMatch(new RegExp(`^fail freeze/bin/check-freeze.sh ${helper}:\\d+: syntax error`, 'm'));
  });

  test('a conflict marker inside a heredoc of a transitively sourced helper still parses, and fails', () => {
    const root = tmpBase();
    fixtureTree(root);
    const helper = path.join(root, 'bin/gstack-state-root.sh');
    const lines = fs.readFileSync(helper, 'utf8').split('\n').length;
    fs.appendFileSync(helper, ": <<'EOF'\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\nEOF\n");
    expect(spawnSync('bash', ['-n', helper], { timeout: 10_000 }).status).toBe(0);
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`fail careful/bin/check-careful.sh ${helper}:${lines + 1}: unresolved merge conflict marker`);
    expect(r.out).toContain(`fail bin/gstack-session-update ${helper}:${lines + 1}: unresolved merge conflict marker`);
  });

  test('a conflict marker in a module the TypeScript entry imports fails, even inside a template literal', () => {
    const root = tmpBase();
    fixtureTree(root);
    const dir = path.join(root, 'hosts/claude/hooks');
    fs.writeFileSync(path.join(dir, 'question-log-hook.ts'), "import { msg } from './hook-msg';\nconsole.log(msg);\n");
    fs.writeFileSync(path.join(dir, 'hook-msg.ts'), 'export const msg = `\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n`;\n');
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`fail hosts/claude/hooks/question-log-hook ${path.join(dir, 'hook-msg.ts')}:2: unresolved merge conflict marker`);
  });

  test("the caller's tsconfig.json and bunfig.toml are not read, and a root with spaces works", () => {
    const base = tmpBase();
    const root = path.join(base, 'gstack root');
    fixtureTree(root);
    const caller = path.join(base, 'project');
    fs.mkdirSync(caller);
    fs.writeFileSync(path.join(caller, 'tsconfig.json'), '{ "compilerOptions": { ,,, ');
    fs.writeFileSync(path.join(caller, 'bunfig.toml'), '[[[ not toml');
    const r = spawnSync('bash', [CHECK, root], { cwd: caller, encoding: 'utf8', timeout: 30_000 });
    expect(`${r.stdout}${r.stderr}`).not.toContain('fail ');
    expect(r.status).toBe(0);
  });

  test('a missing shim is reported as missing, not failed (setup already skips registering it)', () => {
    const root = tmpBase();
    fixtureTree(root);
    fs.rmSync(path.join(root, 'hosts/claude/hooks/timeline-stop-hook'));
    const r = check(root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('missing hosts/claude/hooks/timeline-stop-hook');
  });
});

describe('setup: registers the hooks that parse, refuses the rest, exits non-zero', () => {
  test('the gate runs before any hook registration is healed or written', () => {
    const gate = SETUP.indexOf('# Hook parse gate');
    const heal = SETUP.indexOf('# Heal-first: prune dead gstack hook entries');
    expect(gate).toBeGreaterThan(-1);
    expect(heal).toBeGreaterThan(gate);
    const writes = [...SETUP.matchAll(/"\$SETTINGS_HOOK" (?:ensure-event|add-event|prune-stale|remove-source)/g)].map(m => m.index!);
    expect(writes.length).toBeGreaterThan(0);
    expect(Math.min(...writes)).toBeGreaterThan(heal);
    expect(SETUP).not.toContain('refusing to register hooks: a hook file does not parse');
  });

  function setupFixture() {
    const base = tmpBase();
    const home = path.join(base, 'home');
    const canonical = path.join(home, '.claude', 'skills', 'gstack');
    fs.mkdirSync(canonical, { recursive: true });
    fs.mkdirSync(path.join(home, '.gstack'), { recursive: true });
    fixtureTree(canonical);
    return { base, home, canonical, settings: path.join(home, '.claude', 'settings.json') };
  }
  type Fx = ReturnType<typeof setupFixture>;

  function runSetupHooks(fx: Fx) {
    const script = [
      'set -e',
      "log() { printf '%s\\n' \"$*\"; }",
      `BUN_CMD='${process.execPath}'`,
      `SOURCE_GSTACK_DIR='${ROOT}'`,
      `SETTINGS_HOOK='${ROOT}/bin/gstack-settings-hook'`,
      `GSTACK_CONFIG='${ROOT}/bin/gstack-config'`,
      'TEAM_MODE=1 NO_TEAM_MODE=0 IS_WINDOWS=0 QUIET=1 PLAN_TUNE_HOOKS_MODE="" TIMELINE_STOP_HOOK_MODE=""',
      HOOK_SECTIONS,
      'echo SETUP_HOOKS_DONE',
    ].join('\n');
    const env: Record<string, string> = {
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
      HOME: fx.home,
      GSTACK_STATE_ROOT: path.join(fx.home, '.gstack'),
      GSTACK_SETTINGS_FILE: fx.settings,
      GSTACK_PLAN_TUNE_HOOKS: 'yes',
      TMPDIR: fx.base,
    };
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env, timeout: 60_000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  }

  function registeredCommands(fx: Fx): string[] {
    const settings = JSON.parse(fs.readFileSync(fx.settings, 'utf8'));
    return Object.values(settings.hooks ?? {}).flatMap((entries: any) =>
      entries.flatMap((e: any) => (e.hooks ?? []).map((h: any) => String(h.command)))).sort();
  }

  const shim = (fx: Fx, rel: string) => path.join(fx.canonical, rel);
  const ALL = ['bin/gstack-session-update', 'hosts/claude/hooks/question-log-hook', 'hosts/claude/hooks/question-preference-hook',
    'hosts/claude/hooks/auq-error-fallback-hook', 'hosts/claude/hooks/timeline-stop-hook'];

  test('healthy install registers every hook and finishes', () => {
    const fx = setupFixture();
    const r = runSetupHooks(fx);
    expect(r.out).toContain('SETUP_HOOKS_DONE');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('refusing to register');
    expect(registeredCommands(fx)).toEqual(ALL.map(rel => shim(fx, rel)).sort());
  });

  test('fresh install: the unparseable hook is not registered, the rest are, and setup exits 1 with file:line', () => {
    const fx = setupFixture();
    const broken = shim(fx, 'hosts/claude/hooks/question-log-hook');
    const lines = fs.readFileSync(broken, 'utf8').split('\n').length;
    fs.appendFileSync(broken, 'if then\n');
    const r = runSetupHooks(fx);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('SETUP_HOOKS_DONE');
    expect(r.out).toContain('gstack setup: refusing to register hooks that do not parse');
    expect(r.out).toContain(`  ${broken}:${lines}: syntax error`);
    expect(r.out).toContain('Skipped: hosts/claude/hooks/question-log-hook');
    expect(r.out).toContain(`This is a gstack bug; report ${broken}:${lines}`);
    expect(r.out).toContain('Hooks that parse register as usual: bin/gstack-session-update hosts/claude/hooks/question-preference-hook');
    expect(r.out).toContain('https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#setup-hook-does-not-parse');
    expect(r.out).not.toContain('previous install is still active');
    expect(r.out).not.toContain('no stable install');
    expect(registeredCommands(fx)).toEqual(ALL.filter(rel => rel !== 'hosts/claude/hooks/question-log-hook').map(rel => shim(fx, rel)).sort());
  });

  test('upgrade over live registrations: the others stay registered, the broken one is not re-registered, exit 1', () => {
    const fx = setupFixture();
    expect(runSetupHooks(fx).code).toBe(0);
    const before = registeredCommands(fx);
    expect(before).toHaveLength(ALL.length);

    // The new revision's Stop hook entry does not parse.
    fs.writeFileSync(shim(fx, 'hosts/claude/hooks/timeline-stop-hook.ts'), 'export const x = {;\n');
    const r = runSetupHooks(fx);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${shim(fx, 'hosts/claude/hooks/timeline-stop-hook.ts')}:1: Expected identifier`);
    expect(r.out).toContain('Skipped: hosts/claude/hooks/timeline-stop-hook');
    expect(r.out).toContain('keeps running the broken file until it is fixed');
    expect(r.out).not.toContain('previous install is still active');
    expect(registeredCommands(fx)).toEqual(before);
  });
});
