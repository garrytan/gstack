/**
 * Ratchet: no skill fence and no shell helper prints the process environment.
 *
 * GSTA-96 (2026-10-26): during an unattended /ship, the Step 14.5 docs-audit
 * child re-typed the GSTACK_LAUNCH assignments as `export $(...)`. The
 * substitution came back empty, so the shell ran a bare `export`, which prints
 * every exported variable, and three API key values landed in its tool output.
 * The launch environment is applied with `. <GSTACK_LAUNCH_FILE>` (the
 * installer's sourceable file); nothing in a fence may dump the environment.
 *
 * Rules, per command segment (split on `;`, `&&`, `||` and `|`):
 *   export-subst   `export` whose first argument is a substitution or an unquoted expansion
 *                  (`export $(...)`, `export "$(...)"`, `export \`...\``, `export $VAR`), each of
 *                  which can splat a whole NAME=value file; `export "$name"` is one word, so
 *                  like `export NAME=value` and `export NAME` it stays allowed
 *   env            `env` or `/usr/bin/env` with no arguments or only flags, piped or
 *                  not (`env FOO=1 cmd` launches, fine)
 *   printenv       `printenv`, with or without a name (`echo "$NAME"` is explicit)
 *   export         bare `export`, `export -p`, `declare -x`, `typeset -x`, `declare -p`, `typeset -p`
 *   set            bare `set` as a segment, redirections included; `set | grep '^NAME_'`
 *                  prints only the variables the anchored name filter admits and stays allowed
 * Fenced blocks in Markdown (generated SKILL.md, sections, DRIVER.md, the Capy
 * skill) are scanned line by line; a shell helper under bin/ is scanned whole.
 * Comments are skipped. The negative-control fixtures prove the scanner fires.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { CAPY_LAUNCH_MARKERS } from '../scripts/lib/shard-engine';

const ROOT = path.resolve(import.meta.dir, '..');

export type Violation = { file: string; line: number; rule: string; text: string };

const EXPORT_SUBST = /\bexport\s+(?:"?\$\(|"?`|\$\{?[A-Za-z_])/;
const SEGMENTS = /\s*(?:;|&&|\|\||\|)\s*/g;
const BARE = {
  env: /^(\/usr\/bin\/)?env(\s+-\S+)*$/,
  printenv: /^printenv(\s|$)/,
  export: /^(export|export -p|declare -x|typeset -x|declare -p|typeset -p)$/,
  set: /^set(\s+[0-9&]*>\S*)*$/,
} as const;
/** The one allowed `set` shape: piped straight into an anchored name filter. */
const SET_FILTER = /^grep\s+(?:-\S+\s+)*["']\^/;

/** Blank single- and double-quoted strings, keeping every offset, so a quoted word is never read as a command. */
function unquoted(line: string): string {
  return line.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, q => q[0] + ' '.repeat(q.length - 2) + q[0]);
}

export function rulesFor(line: string): string[] {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return [];
  const rules: string[] = [];
  const blanked = unquoted(trimmed);
  const comment = blanked.search(/\s+#/);
  const raw = comment >= 0 ? trimmed.slice(0, comment) : trimmed;
  const bare = comment >= 0 ? blanked.slice(0, comment) : blanked;
  const subst = EXPORT_SUBST.exec(raw);
  if (subst && bare.startsWith('export', subst.index)) rules.push('export-subst');
  const segments: Array<[number, number]> = [];
  let start = 0;
  for (const sep of bare.matchAll(SEGMENTS)) { segments.push([start, sep.index]); start = sep.index + sep[0].length; }
  segments.push([start, bare.length]);
  segments.forEach(([from, to], i) => {
    const cmd = bare.slice(from, to).replace(/^\$\s+/, '').trim();
    if (BARE.env.test(cmd)) rules.push('env');
    if (BARE.printenv.test(cmd)) rules.push('printenv');
    if (BARE.export.test(cmd)) rules.push('export');
    const next = segments[i + 1];
    if (BARE.set.test(cmd) && !(next && SET_FILTER.test(raw.slice(next[0], next[1]).trim()))) rules.push('set');
  });
  return rules;
}

/** Lines inside any ``` fence (template-literal fences included). */
function fencedLines(text: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  let inFence = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*(?:\\`|`){3}/.test(line)) { inFence = !inFence; return; }
    if (inFence) out.push([i + 1, line]);
  });
  return out;
}

export function scanText(file: string, text: string, mode: 'fenced' | 'whole'): Violation[] {
  const lines = mode === 'fenced' ? fencedLines(text) : text.split('\n').map((l, i) => [i + 1, l] as [number, string]);
  const out: Violation[] = [];
  for (const [line, text] of lines) for (const rule of rulesFor(text)) out.push({ file, line, rule, text: text.trim() });
  return out;
}

const isShell = (file: string, text: string) => file.endsWith('.sh') || /^#!.*\b(bash|sh)\b/.test(text.split('\n')[0] ?? '');

function listFiles(dir: string, keep: (rel: string) => boolean, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!/^(node_modules|\.git|test|dist|hosts)$/.test(entry.name)) listFiles(rel, keep, out); }
    else if (keep(rel)) out.push(rel);
  }
  return out;
}

/** Generated SKILL.md and section files, their templates, DRIVER.md and the Capy skill. */
function markdownTargets(): string[] {
  return listFiles('.', rel =>
    /^[^/]+\/SKILL\.md(\.tmpl)?$/.test(rel) ||
    /^[^/]+\/sections\/[^/]+\.md(\.tmpl)?$/.test(rel) ||
    /^(autoplan|ship)\/DRIVER\.md(\.tmpl)?$/.test(rel) ||
    /^capy\/skill\/gstack\/[^/]+\.md$/.test(rel));
}

/** Every shell helper under bin/, the setup script and the scripts/*.sh build and doctor scripts. */
function shellTargets(): string[] {
  const candidates = [...fs.readdirSync(path.join(ROOT, 'bin')).map(name => path.join('bin', name)), 'setup',
    ...fs.readdirSync(path.join(ROOT, 'scripts')).filter(name => name.endsWith('.sh')).map(name => path.join('scripts', name))];
  return candidates.filter(rel => {
    const full = path.join(ROOT, rel);
    return fs.statSync(full).isFile() && isShell(rel, fs.readFileSync(full, 'utf8'));
  });
}

describe('launch-env echo ratchet', () => {
  test('the negative-control Markdown fixture trips every rule and only on the banned lines', () => {
    const file = 'test/fixtures/launch-env-echo/negative-control.md';
    const found = scanText(file, fs.readFileSync(path.join(ROOT, file), 'utf8'), 'fenced');
    expect(found.map(v => [v.text, v.rule])).toEqual([
      ["export $(sed -n 's/^GSTACK_LAUNCH: //p' install.log)", 'export-subst'],
      ['export "$(cat launch.env)"', 'export-subst'],
      ['env', 'env'],
      ['env | grep -i key', 'env'],
      ['printenv', 'printenv'],
      ['printenv ANTHROPIC_API_KEY', 'printenv'],
      ['set', 'set'],
      ['export', 'export'],
      ['export -p', 'export'],
      ['declare -x', 'export'],
      ['typeset -x', 'export'],
      ['declare -p', 'export'],
      ['cd /repo && env', 'env'],
      ['typeset -p', 'export'],
      ['export `cat launch.env`', 'export-subst'],
      ['export $LAUNCH', 'export-subst'],
      ['export ${LAUNCH}', 'export-subst'],
      ['cd /repo && set', 'set'],
      ['set 2>&1 | tee out.txt', 'set'],
      ['env -0', 'env'],
      ['/usr/bin/env', 'env'],
      ['echo "a #b" && env', 'env'],
    ]);
    const allowedStart = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').findIndex(l => l === 'Allowed:') + 1;
    expect(found.every(v => v.line < allowedStart)).toBe(true);
  });

  test('the negative-control shell fixture is scanned whole, comments and quoted words excluded', () => {
    const file = 'test/fixtures/launch-env-echo/negative-control.sh';
    const found = scanText(file, fs.readFileSync(path.join(ROOT, file), 'utf8'), 'whole');
    expect(found.map(v => [v.line, v.rule])).toEqual([[5, 'export-subst'], [6, 'env'], [7, 'printenv'], [8, 'set'], [9, 'export']]);
  });

  test('the scan covers the skill surfaces and the shell helpers', () => {
    const md = markdownTargets();
    for (const want of ['ship/SKILL.md', 'ship/sections/documentation.md', 'review/SKILL.md', 'qa/SKILL.md',
      'document-release/SKILL.md', 'autoplan/DRIVER.md', 'ship/DRIVER.md', 'capy/skill/gstack/SKILL.md']) expect(md).toContain(want);
    const sh = shellTargets();
    for (const want of ['bin/gstack-capy-install', 'bin/gstack-capy-session', 'bin/gstack-skill-start', 'setup', 'scripts/build.sh', 'scripts/sandbox-doctor.sh']) expect(sh).toContain(want);
  });

  test('no skill fence prints the environment', () => {
    const violations = markdownTargets().flatMap(file => scanText(file, fs.readFileSync(path.join(ROOT, file), 'utf8'), 'fenced'));
    expect(violations.map(v => `${v.file}:${v.line} [${v.rule}] ${v.text}`)).toEqual([]);
  });

  test('no shell helper under bin/, setup or install script prints the environment', () => {
    const violations = shellTargets().flatMap(file => scanText(file, fs.readFileSync(path.join(ROOT, file), 'utf8'), 'whole'));
    expect(violations.map(v => `${v.file}:${v.line} [${v.rule}] ${v.text}`)).toEqual([]);
  });

  test('the installer writes the launch file the skills tell callers to source, mode 0600, and prints its path', () => {
    const installer = fs.readFileSync(path.join(ROOT, 'bin/gstack-capy-install'), 'utf8');
    expect(installer).toContain('LAUNCH_FILE="${VERDICT%.json}.env"');
    expect(installer).toContain('chmod 0600 "$tmp"');
    for (const name of CAPY_LAUNCH_MARKERS) expect(installer, name).toMatch(new RegExp(`^\\s*echo "export ${name}=`, 'm'));
    // Both directions: every `export NAME=` line the launch file writes is either a marker the shard
    // sandbox and the test preload strip, or GSTACK_STATE_ROOT, which they keep on purpose (GSTA-99).
    // The PATH prepend is a separate `case` line this regex ignores; PATH is kept too.
    const exported = [...installer.matchAll(/^\s*echo "export ([A-Z_]+)=/gm)].map(m => m[1]).sort();
    expect(exported).toEqual([...CAPY_LAUNCH_MARKERS, 'GSTACK_STATE_ROOT'].sort());
    expect(installer).toContain('echo "GSTACK_LAUNCH_FILE: $LAUNCH_FILE"');
    for (const file of ['ship/sections/documentation.md', 'document-release/SKILL.md', 'autoplan/DRIVER.md', 'capy/skill/gstack/SKILL.md']) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(text, file).toContain('GSTACK_LAUNCH_FILE');
      expect(text, file).toMatch(/never[^\n]*`export \$\(\.\.\.\)`/);
    }
    expect(fs.readFileSync(path.join(ROOT, 'bin/gstack-skill-start'), 'utf8')).toContain('GSTACK_LAUNCH_FILE the installer printed');
  });
});
