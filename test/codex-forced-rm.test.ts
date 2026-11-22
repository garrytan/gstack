/**
 * Codex CLI refuses forced rm (GST-3364).
 *
 * Codex classifies every literal command in a shell script it is asked to run
 * (inside quotes, $(...), trap actions and bash -c too). An rm with a force
 * option before "--" (-f, -rf, -fr, --force, any single-dash cluster holding
 * "f") is a dangerous command: with approvals off Codex rejects it with "rm -f
 * style commands are not permitted. Use a safer approach", otherwise it stops
 * to ask. Source: openai/codex codex-rs/shell-command/src/command_safety/
 * is_dangerous_command.rs (rm_args_include_force_option) and
 * codex-rs/core/src/exec_policy.rs at rust-v0.170.0.
 *
 * Renders the Codex host and fails on any forced rm in a shell fence or an
 * inline code span. Cleanup that must tolerate a missing path uses
 * "rm X 2>/dev/null || true" or "[ ! -e X ] || rm X"; a folder that can hold
 * read-only files (a git checkout) uses "rm -r X </dev/null", so a tty never
 * stops to ask.
 * The detector is deliberately broader than Codex: it also flags rm text inside
 * echo strings, because a model told to run that text gets the same refusal.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runGeneration } from '../scripts/gen-skill-docs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-codex-rm-'));
const renderDir = path.join(tmp, 'render');
const SHELL_LANGS = new Set(['', 'bash', 'sh', 'shell', 'zsh', 'console']);
const WRAPPERS = new Set(['sudo', 'env', 'exec', 'command', 'then', 'do', 'else', 'time', 'nohup', 'xargs', '!']);
/** These skills document the commands their guard warns about; the spans are not commands to run. */
const GUARD_DOCS = new Set(['gstack-careful', 'gstack-guard']);

/** Forced rm invocations in shell text, as Codex's rule reads them (a superset: quoted text counts). */
export function forcedRm(text: string): string[] {
  const hits: string[] = [];
  for (const m of text.matchAll(/(?<![\w.\/-])(?:\/(?:[\w.-]+\/)*)?rm(?=[ \t])/g)) {
    const at = m.index!;
    const before = text.slice(text.lastIndexOf('\n', at - 1) + 1, at);
    const prev = before.trimEnd().split(/\s+/).at(-1) ?? '';
    const atCommand = prev === '' || /[;&|(\x60'"{}]$/.test(prev) || WRAPPERS.has(prev) || /^[A-Za-z_]\w*=/.test(prev);
    if (!atCommand) continue;
    const rest = text.slice(at + m[0].length).split(/[;&|)\n\x60]/)[0];
    for (const raw of rest.trim().split(/\s+/)) {
      const arg = raw.replace(/^['"]+|['"]+$/g, '');
      if (arg === '--') break;
      if (arg === '--force' || /^-[A-Za-z]*f[A-Za-z]*$/.test(arg)) { hits.push((m[0] + rest).trim()); break; }
    }
  }
  return hits;
}

function renderedDocs(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...renderedDocs(p));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** Shell fences and inline code spans outside fences (CommonMark: a longer outer fence hides inner ones). */
function shellText(text: string): { fences: Array<{ line: number; body: string }>; spans: Array<{ line: number; body: string }> } {
  const lines = text.split('\n');
  const fences: Array<{ line: number; body: string }> = [];
  const spans: Array<{ line: number; body: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)(\x60{3,}|~{3,})(.*)$/);
    if (!open) {
      for (const s of lines[i].matchAll(/\x60([^\x60\n]+)\x60/g)) spans.push({ line: i + 1, body: s[1] });
      continue;
    }
    let end = i + 1;
    const close = new RegExp('^\\s*' + open[2][0] + '{' + open[2].length + ',}\\s*$');
    while (end < lines.length && !close.test(lines[end])) end++;
    if (SHELL_LANGS.has(open[3].trim())) fences.push({ line: i + 1, body: lines.slice(i + 1, end).join('\n') });
    i = end;
  }
  return { fences, spans };
}

beforeAll(async () => {
  const result = await runGeneration({ host: 'codex', outputRoot: renderDir });
  if (result.exitCode !== 0) throw new Error(result.diagnostics.filter(d => d.kind === 'error').map(d => d.message).join('\n'));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('forcedRm follows Codex 0.170 is_dangerous_command', () => {
  test('flags the shapes Codex refuses', () => {
    for (const script of [
      'rm -rf /', 'rm -f /', '/bin/rm -fr /tmp/example', 'rm -r -f /tmp/example', 'rm --force /tmp/example',
      'rm /tmp/example -f', 'sudo rm -rf /tmp/example', 'env TARGET=/tmp/example rm -rf /tmp/example',
      'printf x | rm -rf /tmp/example', 'if test -d /tmp/example; then rm --force /tmp/example; fi',
      'rm -rf "$TARGET" >/dev/null', 'for t in /tmp/a /tmp/b; do rm -r -f "$t"; done', 'echo "$(rm -rf /tmp/example)"',
      "bash -c 'rm -rf /tmp/example'", "trap 'rm -rf /tmp/example' EXIT",
      'X=1 rm -Rf "$X"', 'cp a b && rm -f "$F" && echo ok', "trap 'rm -f \"$A\"; [ -z \"$B\" ] || rm -rf \"$B\"' EXIT",
    ]) expect(forcedRm(script), script).not.toEqual([]);
  });

  test('passes the cleanup forms gstack uses and commands that only contain the letters', () => {
    for (const script of [
      'rm -r /tmp/example', 'rm -- -f', 'rm "$F" 2>/dev/null || true', '[ ! -e "$F" ] || rm -- "$F"',
      'rm -r -- "$D" </dev/null', "trap 'rm -r \"$_OUTSIDE_TMP\"' EXIT", 'env TARGET=/tmp/example rm -r /tmp/example',
      'git rm -f x', 'docker rm -f c', 'git worktree remove --force "$D/wt"', 'cp -Rf a b', 'confirm -f', 'npm run rm -f',
    ]) expect(forcedRm(script), script).toEqual([]);
  });
});

describe('Codex renders contain no forced rm', () => {
  test('every shell fence and inline code span of every Codex render file', () => {
    const root = path.join(renderDir, '.agents', 'skills');
    const files = renderedDocs(root);
    expect(files.length).toBeGreaterThan(100);
    let fenceCount = 0;
    const problems: string[] = [];
    for (const file of files) {
      const rel = path.relative(root, file);
      const { fences, spans } = shellText(fs.readFileSync(file, 'utf8'));
      fenceCount += fences.length;
      for (const f of fences) for (const hit of forcedRm(f.body)) problems.push(rel + ':' + f.line + ' fence: ' + hit);
      if (GUARD_DOCS.has(rel.split(path.sep)[0])) continue;
      for (const s of spans) for (const hit of forcedRm(s.body)) problems.push(rel + ':' + s.line + ' inline: ' + hit);
    }
    expect(fenceCount).toBeGreaterThan(1000);
    expect(problems).toEqual([]);
  });
});
