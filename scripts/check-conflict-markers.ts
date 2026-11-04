#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * check-conflict-markers — refuse merge conflict markers on the lines a branch changed (GST-1190).
 *
 *   bun scripts/check-conflict-markers.ts [--base <ref>]
 *
 * Reads every line the branch adds against its merge base with <ref> (default origin/main) twice: in the
 * committed HEAD, which is what a push publishes, and in the working tree's tracked files (deleted files are
 * skipped; untracked files are never pushed, so they are not read). A line starting with `<<<<<<<` or
 * `>>>>>>>` followed by a space or the line end, or a line that is exactly `=======`, is a marker. This
 * catches a marker the parser accepts, such as one inside a template literal (#3927). Markdown files
 * (`.md`, `.mdx`, `.markdown`, `.md.tmpl`) skip lines inside a ``` or ~~~ fence whose info string is empty,
 * text, txt, plaintext, diff or console, the fences a doc uses to show git output; a conflict inside a bash,
 * ts or other code fence is still refused. They count `=======` only between a `<<<<<<<` and its close, so a
 * setext heading underline passes. A file whose first five lines include one that is only the declaration
 * `gstack-conflict-markers: fixture` (after an optional comment leader such as `#`, `//` or `<!--`) is
 * skipped. Prints one CONFLICT_MARKER: <path>:<line> <marker> per hit and exits 1, or CONFLICT_MARKERS: none
 * and exits 0; a git failure exits 2.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const OPEN = /^<{7}( |$)/, CLOSE = /^>{7}( |$)/, MID = /^={7}$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const SHOWN = /^(|text|txt|plaintext|diff|console)$/i;
const MARKDOWN = /\.(md|mdx|markdown|md\.tmpl)$/i;
const DECLARATION = /^\s*(?:#|\/\/|\/\*|\*|<!--|--)?\s*gstack-conflict-markers: fixture\s*(?:\*\/|-->)?\s*$/;
const GIT = ['-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false'];

function git(args: string[], allowFail = false): string | null {
  const r = spawnSync('git', [...GIT, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 120_000 });
  if (r.status === 0) return r.stdout;
  if (allowFail) return null;
  console.error(`check-conflict-markers: git ${args.join(' ')} failed: ${(r.stderr || r.error?.message || '').trim()}`);
  process.exit(2);
}

/** The added line numbers per path, from a zero-context diff whose headers name paths with fixed a/ and b/ prefixes. */
function addedLines(diff: string): Map<string, Set<number>> {
  const added = new Map<string, Set<number>>();
  let file = '', header = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { header = true; file = ''; continue; }
    if (header && line.startsWith('+++ ')) { file = line.startsWith('+++ b/') ? line.slice(6).replace(/\t$/, '') : ''; header = false; continue; }
    if (header) continue;
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !file) continue;
    const start = Number(hunk[1]), count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const set = added.get(file) ?? new Set<number>();
    for (let n = start; n < start + count; n++) set.add(n);
    added.set(file, set);
  }
  return added;
}

const seen = new Set<string>();
function scan(f: string, text: string, lines: Set<number>, where: string, hits: Set<string>): void {
  const all = text.split('\n');
  if (text.includes('\0') || all.slice(0, 5).some(l => DECLARATION.test(l))) return;
  const md = MARKDOWN.test(f);
  let fence = '', shown = false, open = false;
  all.forEach((raw, idx) => {
    const l = raw.replace(/\r$/, '');
    if (md) {
      const m = FENCE.exec(l);
      if (m && !fence) { fence = m[1]!; shown = SHOWN.test(m[2]!); return; }
      if (m && !m[2] && m[1]![0] === fence[0] && m[1]!.length >= fence.length) { fence = ''; shown = false; return; }
      if (shown) return;
    }
    const marker = OPEN.test(l) ? '<'.repeat(7) : CLOSE.test(l) ? '>'.repeat(7) : MID.test(l) && (!md || open) ? '='.repeat(7) : '';
    if (OPEN.test(l)) open = true;
    if (CLOSE.test(l)) open = false;
    if (!marker || !lines.has(idx + 1) || seen.has(`${f}:${idx + 1}`)) return;
    seen.add(`${f}:${idx + 1}`);
    hits.add(`CONFLICT_MARKER: ${f}:${idx + 1} ${marker}${where}`);
  });
}

const i = process.argv.indexOf('--base');
const base = i > 0 ? process.argv[i + 1]! : 'origin/main';
const root = git(['rev-parse', '--show-toplevel'])!.trim();
process.chdir(root);
const fork = git(['merge-base', base, 'HEAD'])!.trim();
const DIFF = ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', '--diff-filter=AM'];

const hits = new Set<string>();
const committed = addedLines(git([...DIFF, fork, 'HEAD', '--'])!);
for (const [f, lines] of committed) {
  const text = git(['show', `HEAD:${f}`], true);
  if (text !== null) scan(f, text, lines, '', hits);
}
const working = addedLines(git([...DIFF, fork, '--'])!);
for (const [f, lines] of working) {
  let text: string;
  try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
  scan(f, text, lines, ' (working tree)', hits);
}
const files = new Set([...committed.keys(), ...working.keys()]).size;
if (hits.size) {
  console.log([...hits].sort().join('\n'));
  console.log('fix: finish the merge in each file above (keep the right side, delete the marker lines) and commit; a fixture that shows markers on purpose declares the fixture line documented in docs/pregate.md#prepush in its first five lines');
  process.exit(1);
}
console.log(`CONFLICT_MARKERS: none (${files} changed file(s) against ${fork.slice(0, 12)})`);
