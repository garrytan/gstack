/**
 * GSTA-56 ratchet: every Bun that gstack starts ignores the working
 * directory's .env files and bunfig.toml (lib/bun-isolation.ts). Bun reads
 * both from the directory it starts in, gstack runs inside the repository it
 * audits, and a bunfig.toml preload runs code before gstack's own. Five entry
 * kinds are held to the isolated form:
 *   1. bun shebangs: exactly ISOLATED_SHEBANG (`bun run <file>` ignores the
 *      shebang, so callers carry the flags too);
 *   2. shell callers: skill templates, generated skill docs and resolvers
 *      spell `bun --no-env-file --config=/dev/null` before `run`, `-e`/`-p`
 *      or a script path; shipped shell files spell SHELL_FLAGS after
 *      CONFIG_DEF, so a Windows bash with MSYS path conversion off passes
 *      NUL instead of a /dev/null native Bun cannot open (#3415);
 *   3. TypeScript spawns of a Bun: bunIsolationArgs() (or browse's
 *      bunChildFlags()) in the argument list;
 *   4. scriptInvocation, which launches gstack's own bun bins;
 *   5. `bun build --compile`: both --no-compile-autoload-dotenv and
 *      --no-compile-autoload-bunfig.
 * test/bun-dotenv-isolation.test.ts runs the real bins in a hostile fixture.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bunIsolationArgs, emptyBunConfig } from '../lib/bun-isolation';
import { scriptInvocation } from '../lib/script-invocation';
import { emptyBunConfig as browseEmptyBunConfig } from '../browse/src/bun-child-config';

const ROOT = path.resolve(import.meta.dir, '..');
const FLAGS = '--no-env-file --config=/dev/null';
const ISOLATED_SHEBANG = `#!/usr/bin/env -S bun ${FLAGS}`;
const SHELL_FLAGS = '--no-env-file --config="${GSTACK_BUN_CONFIG:-/dev/null}"';
const CONFIG_DEF = 'GSTACK_BUN_CONFIG=/dev/null; case "${OSTYPE:-}" in msys*|cygwin*) if command -v cygpath >/dev/null 2>&1; then GSTACK_BUN_CONFIG=NUL; fi ;; esac';

const TRACKED = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).stdout.split('\0').filter(Boolean)
  .filter(f => !/(^|\/)test\//.test(f) && fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile());

function firstLine(file: string): string {
  const fd = fs.openSync(path.join(ROOT, file), 'r');
  try {
    const buf = Buffer.alloc(160);
    return buf.subarray(0, fs.readSync(fd, buf, 0, 160, 0)).toString('utf8').split('\n')[0] ?? '';
  } finally { fs.closeSync(fd); }
}

const BUN_WORD = /(^|[\s;&|({`"']|\$\()(bun|"\$\{?\w*(?:BUN|[Bb]un)\w*\}?"|\$\{?\w*(?:BUN|[Bb]un)\w*\}?)(?=[ \t])/g;
/** Any variable at a command position (`"$RUNNER" x.ts`, `OUT=$("$RUNNER" ...)`, `case) "$RUNNER" ...`); it is a Bun when it launches a TypeScript file. */
const VAR_COMMAND = /(^\s*|[;&|({)`!]\s*|\$\(\s*|\b(?:then|do|else|exec)\s+)("\$\{?[A-Za-z_]\w*\}?"|\$\{?[A-Za-z_]\w*\}?)(?=[ \t])/g;

const afterFlags = (rest: string) => rest.replace(/^\s+/, '').replace(/^(?:--(?:no-env-file|cwd[= ]\S+|config(?:=\S*|\s+\S+))\s+)*/, '');
const runsTypeScript = (rest: string) => /^(?:run\s+)?["']?[^\s"'|;&)]*\.(?:ts|tsx|mts)(?:["'\s)|;&\\`]|$)/.test(afterFlags(rest));

/** Whether the text after a `bun` word starts a program: -e/-p, a script path, `run <var>` or a bin path. A package script (`bun run build`) is not one. */
function runsCode(rest: string): boolean {
  const r = afterFlags(rest);
  return /^(?:run\s+)?(?:-e|-p|--eval|--print)(?:\s|=|$)/.test(r)
    || /^(?:run\s+)?["']?[^\s"'|;&)]*\.(?:ts|js|mjs|cjs|tsx)(?:["'\s)|;&\\`]|$)/.test(r)
    || /^run\s+["']?\$\{?[A-Za-z_]/.test(r)
    || /^(?:run\s+)?["']?[~$]?[^\s"']*\/bin\/[\w.-]+["']?(?:[\s`)]|$)/.test(r);
}

/** Bun invocations on one shell line that start a program without the isolation flags. */
function unisolatedBunCalls(line: string, flags = FLAGS): string[] {
  if (/^\s*(#|\/\/|\*)/.test(line)) return [];
  const out: string[] = [];
  for (const m of line.matchAll(BUN_WORD)) {
    const at = m.index! + m[1]!.length;
    if (/\bln\s+-\w+\s+$/.test(line.slice(0, at))) continue;
    const rest = line.slice(at + m[2]!.length);
    if (!rest.startsWith(` ${flags}`) && runsCode(rest)) out.push(line.slice(at, at + 80));
  }
  for (const m of line.matchAll(VAR_COMMAND)) {
    const at = m.index! + m[1]!.length;
    if (new RegExp(BUN_WORD.source).test(m[2]!)) continue;
    const rest = line.slice(at + m[2]!.length);
    if (!rest.startsWith(` ${flags}`) && runsTypeScript(rest)) out.push(line.slice(at, at + 80));
  }
  return out;
}

/** Each entry runs code that already belongs to its own directory, so that directory's config is the code's own. */
const SHELL_EXEMPT: Record<string, string> = {
  'skillify/SKILL.md.tmpl': 'describes how a codified browser-skill runs its own script in its own directory',
  'skillify/SKILL.md': 'generated from skillify/SKILL.md.tmpl',
};

/** Run only on Linux (the Ubicloud VM or its Linux-only local fallback), where /dev/null is the spelling; remote command strings expand there. */
const SHELL_LINUX_ONLY = (f: string) => f.startsWith('scripts/ubicloud/');

/** Lines of shell text that use GSTACK_BUN_CONFIG with no CONFIG_DEF line before them, or define it any other way. A `local` definition covers only the rest of its function. */
function configDefinitionGaps(text: string): string[] {
  const gaps: string[] = [];
  let defined = false;
  let definedInFunction = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*(?:local\s+)?GSTACK_BUN_CONFIG=/.test(line)) {
      const local = /^\s*local\s/.test(line);
      if (line.trim().replace(/^local\s+/, '') !== CONFIG_DEF) gaps.push(`${i + 1}: redefined: ${line.trim()}`);
      else if (local) definedInFunction = true;
      else defined = true;
    } else if (/^}/.test(line)) definedInFunction = false;
    else if (!defined && !definedInFunction && line.includes('${GSTACK_BUN_CONFIG')) gaps.push(`${i + 1}: used before CONFIG_DEF`);
  });
  return gaps;
}

const isShell = (f: string) => f.endsWith('.sh') || /^#!.*\b(?:ba|z)?sh\b/.test(firstLine(f));
const isSkillSource = (f: string) => f.endsWith('.tmpl') || /^scripts\/resolvers\/.+\.ts$/.test(f)
  || /(^|\/)SKILL\.md$/.test(f) || /\/sections\/[^/]+\.md$/.test(f);

describe('GSTA-56: gstack never takes configuration from the audited repository', () => {
  test('every bun shebang is the isolated shebang', () => {
    const offenders = TRACKED.filter(f => { const l = firstLine(f); return l.startsWith('#!') && /\bbun\b/.test(l) && l !== ISOLATED_SHEBANG; });
    expect(offenders).toEqual([]);
    expect(TRACKED.filter(f => firstLine(f) === ISOLATED_SHEBANG).length).toBeGreaterThan(100);
  });

  test('developer scripts run as ./scripts/<name>.ts start isolated', () => {
    const scripts = [
      'browse/scripts/extension-id.ts',
      'scripts/detect-bump.ts',
      'scripts/eval-compare.ts',
      'scripts/eval-summary.ts',
      'scripts/garry-output-comparison.ts',
      'crew/scripts/measure-journal-read.ts',
    ];
    expect(scripts.filter(f => firstLine(f) !== ISOLATED_SHEBANG)).toEqual([]);
  });

  test('the shell-caller detector flags unisolated calls and passes isolated ones', () => {
    for (const bad of [
      'bun run ~/.claude/skills/gstack/bin/gstack-render.ts x.html',
      'out=$(bun "$BIN/gstack-runtime-pins.ts" --project "$p")',
      'printf x | bun -e "console.log(1)"',
      'exec bun run "$ENTRY" "$@"',
      'QUEUE=$(bun run ~/.claude/skills/gstack/bin/gstack-next-version --base main)',
      '"$BUN" -e \'1\'',
      'bun --no-env-file run "$X/bin/gstack-design-detect.ts"',
      'running=$(bun -p process.execPath)',
      'PINS_OUT=$("$RUNNER" "$ROOT/bin/gstack-runtime-pins.ts" --project "$PROJECT" 2>/dev/null)',
      '    parser) "$RUNNER" "$ROOT/bin/gstack-runtime-pins.ts" --project "$PROJECT" --bun "$1" | grep -q x ;;',
      'node_accept() { ! "$RUNNER" "$ROOT/bin/gstack-runtime-pins.ts" --node "$1"; }',
      '"$RUNNER" run "$ROOT/bin/gstack-runtime-pins.ts"',
      'v=$("$REC_BUN" -e "console.log(1)")',
      '"$_bun" run "$X/bin/gstack-design-detect"',
    ]) expect(unisolatedBunCalls(bad)).not.toEqual([]);
    for (const ok of [
      `bun ${FLAGS} run ~/.claude/skills/gstack/bin/gstack-render.ts x.html`,
      `printf x | bun ${FLAGS} -e "console.log(1)"`,
      'cd "$SRC" && bun run build',
      'bun install --frozen-lockfile',
      'bun test test/foo.test.ts',
      '# bun run scripts/x.ts in a comment',
      'say "installing bun $WANT from its release archive"',
      'ln -sf bun "$HOME/.bun/bin/bunx"',
      `PINS_OUT=$("$RUNNER" ${FLAGS} "$ROOT/bin/gstack-runtime-pins.ts" --project "$PROJECT")`,
      '[ -f "$ROOT/bin/gstack-runtime-pins.ts" ] && echo yes',
      'cp "$SRC" "$DEST/pins.ts"',
      'echo "$X" a.ts',
      '"$NODE" -e "console.log(1)"',
      '_got=$("$RUNNER" --version 2>/dev/null | head -1)',
      'out=$("$GSTACK_BUN_CONFIG")',
    ]) expect(unisolatedBunCalls(ok)).toEqual([]);
  });

  test('in shipped shell files the detector requires the Windows-safe, fail-closed config spelling (#3415)', () => {
    for (const bad of [
      `printf x | bun ${FLAGS} -e "console.log(1)"`,
      'bun --no-env-file --config="$GSTACK_BUN_CONFIG" -e 1',
      'bun --no-env-file --config= -e 1',
      'bun --no-env-file --config=NUL run "$X/bin/gstack-design-detect.ts"',
    ]) expect(unisolatedBunCalls(bad, SHELL_FLAGS)).not.toEqual([]);
    for (const ok of [
      `printf x | bun ${SHELL_FLAGS} -e "console.log(1)"`,
      `exec bun ${SHELL_FLAGS} "$HERE/question-log-hook.ts"`,
      `probe_cmd="bun ${SHELL_FLAGS} --eval 'import x from \\"y\\"'"`,
      `PINS_OUT=$("$RUNNER" ${SHELL_FLAGS} "$ROOT/bin/gstack-runtime-pins.ts" --project "$PROJECT")`,
    ]) expect(unisolatedBunCalls(ok, SHELL_FLAGS)).toEqual([]);
  });

  test('the config-definition check flags a missing, late or altered GSTACK_BUN_CONFIG definition', () => {
    const use = `bun ${SHELL_FLAGS} -e 1`;
    expect(configDefinitionGaps(`#!/usr/bin/env bash\n${CONFIG_DEF}\n${use}\n`)).toEqual([]);
    expect(configDefinitionGaps(`f() {\n  local ${CONFIG_DEF}\n  ${use}\n}\n`)).toEqual([]);
    expect(configDefinitionGaps(`f() {\n  local ${CONFIG_DEF}\n}\ng() {\n  ${use}\n}\n`)).toEqual(['5: used before CONFIG_DEF']);
    expect(configDefinitionGaps(`#!/usr/bin/env bash\n${use}\n`)).toEqual(['2: used before CONFIG_DEF']);
    expect(configDefinitionGaps(`${use}\n${CONFIG_DEF}\n`)).toEqual(['1: used before CONFIG_DEF']);
    expect(configDefinitionGaps(`GSTACK_BUN_CONFIG=./bunfig.toml\n${use}\n`)).toEqual(['1: redefined: GSTACK_BUN_CONFIG=./bunfig.toml', '2: used before CONFIG_DEF']);
    expect(configDefinitionGaps(`${CONFIG_DEF}\nGSTACK_BUN_CONFIG=\n${use}\n`)).toEqual(['2: redefined: GSTACK_BUN_CONFIG=']);
  });

  test('shell callers, skill templates, generated skill docs and resolvers pass the isolation flags', () => {
    const offenders: string[] = [];
    for (const f of TRACKED) {
      if (f.startsWith('.github/') || SHELL_EXEMPT[f] || !(isSkillSource(f) || isShell(f))) continue;
      const flags = isSkillSource(f) || SHELL_LINUX_ONLY(f) ? FLAGS : SHELL_FLAGS;
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      text.split('\n').forEach((line, i) => {
        for (const call of unisolatedBunCalls(line, flags)) offenders.push(`${f}:${i + 1}: ${call}`);
      });
      if (flags === SHELL_FLAGS) for (const gap of configDefinitionGaps(text)) offenders.push(`${f}:${gap}`);
    }
    expect(offenders).toEqual([]);
  });

  test('TypeScript spawns of a Bun carry bunIsolationArgs()', () => {
    const SPAWN_BUN = /\b(?:spawn|spawnSync|execFile|execFileSync|Bun\.spawn|Bun\.spawnSync)\(\s*\[?\s*(?:process\.execPath|['"]bun['"]|bunExecutable\(\))\s*,?/g;
    const EXEMPT: Record<string, string> = {
      'browse/src/cli.ts': 'the Windows launcher string runs under node -e, where process.execPath is node',
    };
    const offenders: string[] = [];
    for (const f of TRACKED) {
      if (f.startsWith('.github/') || f.startsWith('scripts/') || f.startsWith('crew/scripts/') || /\.test\.ts$|^test-setup\.ts$/.test(f) || EXEMPT[f]) continue;
      if (!f.endsWith('.ts') && !/^#!.*\bbun\b/.test(firstLine(f))) continue;
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      for (const m of src.matchAll(SPAWN_BUN)) {
        const lineStart = src.lastIndexOf('\n', m.index!) + 1;
        if (/^\s*(?:\/\/|\*)/.test(src.slice(lineStart, m.index!))) continue;
        const args = src.slice(m.index! + m[0].length, m.index! + m[0].length + 160);
        if (/bunIsolationArgs\(\)|bunChildFlags\(\)|['"]--version['"]|--no-env-file['"][^\]]*--config=\$\{emptyBunConfig\(\)\}/.test(args)) continue;
        const held = /^\s*([A-Za-z_]\w*)\s*[,)]/.exec(args)?.[1];
        if (held && new RegExp(`\\b(?:const|let)\\s+${held}\\s*=\\s*\\[\\s*\\.\\.\\.bunIsolationArgs\\(\\)`).test(src)) continue;
        offenders.push(`${f}:${src.slice(0, m.index).split('\n').length}: ${m[0]}${args.split('\n')[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('scriptInvocation launches a bun bin with the isolation flags first', () => {
    const inv = scriptInvocation(path.join(ROOT, 'bin', 'gstack-decision-log'), ['--help'], { bunExe: 'bun' });
    expect(inv).toEqual({ ok: true, cmd: 'bun', argv: [...bunIsolationArgs(), path.join(ROOT, 'bin', 'gstack-decision-log'), '--help'] });
    expect(bunIsolationArgs('linux')).toEqual(['--no-env-file', '--config=/dev/null']);
    expect(bunIsolationArgs('win32')).toEqual(['--no-env-file', `--config=${emptyBunConfig('win32')}`]);
    expect(browseEmptyBunConfig('linux')).toBe(emptyBunConfig('linux'));
    expect(fs.statSync(browseEmptyBunConfig('win32')).size).toBe(0);
    expect(fs.statSync(emptyBunConfig('win32')).size).toBe(0);
  });

  test('the Windows empty bunfig outlives the process that named it, so a detached child can still read it', () => {
    const lib = path.join(ROOT, 'lib', 'bun-isolation.ts');
    const made = spawnSync(process.execPath, [...bunIsolationArgs(), '-e', `const { emptyBunConfig } = await import(${JSON.stringify(lib)}); console.log(emptyBunConfig('win32'));`], { encoding: 'utf8', timeout: 30_000 });
    expect(made.status).toBe(0);
    const file = made.stdout.trim();
    expect(fs.lstatSync(file).isFile()).toBe(true);
    expect(fs.statSync(file).size).toBe(0);
    fs.writeFileSync(file, 'preload = ["./x.ts"]\n');
    expect(emptyBunConfig('win32')).toBe(file);
    expect(fs.statSync(file).size).toBe(0);
  });

  test('every bun build --compile disables .env and bunfig autoload', () => {
    const offenders: string[] = [];
    for (const f of TRACKED) {
      if (!/(^|\/)(package\.json|setup|[^/]+\.sh|[^/]+\.ya?ml)$/.test(f) && !/(^|\/)scripts\/build[^/]*\.ts$/.test(f)) continue;
      const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*#/.test(line) || !/\bbuild --compile\b/.test(line)) return;
        let cmd = line;
        for (let j = i; /\\\s*$/.test(lines[j] ?? '') && j + 1 < lines.length; j++) cmd += lines[j + 1];
        for (const one of cmd.split(/&&|;/).filter(c => /\bbuild --compile\b/.test(c))) {
          if (!one.includes('--no-compile-autoload-dotenv') || !one.includes('--no-compile-autoload-bunfig')) offenders.push(`${f}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
