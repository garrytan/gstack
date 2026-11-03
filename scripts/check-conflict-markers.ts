#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * check-conflict-markers — refuse merge conflict markers on the lines a branch changed (GST-1190).
 *
 *   bun scripts/check-conflict-markers.ts [--base <ref>]
 *
 * Reads every line the working tree adds against the merge base with <ref> (default origin/main): committed,
 * staged, unstaged and untracked, deleted files skipped. A line starting with `<<<<<<<` or `>>>>>>>` followed
 * by a space or the line end, or a line that is exactly `=======`, is a marker. This catches a marker the
 * parser accepts, such as one inside a template literal (#3927). Markdown files skip lines inside a ``` or ~~~
 * fence, and count `=======` only between an unfenced `<<<<<<<` and its close, so a setext heading underline
 * and a code block that shows a conflict both pass. A file with a line containing
 * `gstack-conflict-markers: fixture` is skipped. Prints one CONFLICT_MARKER: <path>:<line> <marker> per hit
 * and exits 1, or CONFLICT_MARKERS: none and exits 0; a git failure exits 2.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const OPEN = /^<{7}( |$)/, CLOSE = /^>{7}( |$)/, MID = /^={7}$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const MARKDOWN = /\.(md|mdx|markdown)$/i;
const FIXTURE = 'gstack-conflict-markers: fixture';

function git(args: string[]): string {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 120_000 });
  if (r.status !== 0) { console.error(`check-conflict-markers: git ${args.join(' ')} failed: ${(r.stderr || r.error?.message || '').trim()}`); process.exit(2); }
  return r.stdout;
}

const i = process.argv.indexOf('--base');
const base = i > 0 ? process.argv[i + 1]! : 'origin/main';
const root = git(['rev-parse', '--show-toplevel']).trim();
process.chdir(root);
const fork = git(['merge-base', base, 'HEAD']).trim();

const added = new Map<string, Set<number>>();
let file = '';
for (const line of git(['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', '--diff-filter=AM', fork, '--']).split('\n')) {
  if (line.startsWith('+++ ')) { file = line.startsWith('+++ b/') ? line.slice(6) : ''; continue; }
  const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!hunk || !file) continue;
  const start = Number(hunk[1]), count = hunk[2] === undefined ? 1 : Number(hunk[2]);
  const set = added.get(file) ?? new Set<number>();
  for (let n = start; n < start + count; n++) set.add(n);
  added.set(file, set);
}
for (const f of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) added.set(f, new Set([Infinity]));

const hits: string[] = [];
for (const [f, lines] of [...added].sort(([a], [b]) => a.localeCompare(b))) {
  let text: string;
  try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
  if (text.includes('\0') || text.includes(FIXTURE)) continue;
  const md = MARKDOWN.test(f);
  let fence = '', open = false;
  text.split('\n').forEach((raw, idx) => {
    const l = raw.replace(/\r$/, '');
    if (md) {
      const m = FENCE.exec(l);
      if (m && (!fence || (m[1]![0] === fence[0] && m[1]!.length >= fence.length))) { fence = fence ? '' : m[1]!; return; }
      if (fence) return;
    }
    const marker = OPEN.test(l) ? '<'.repeat(7) : CLOSE.test(l) ? '>'.repeat(7) : MID.test(l) && (!md || open) ? '='.repeat(7) : '';
    if (OPEN.test(l)) open = true;
    if (CLOSE.test(l)) open = false;
    if (marker && (lines.has(Infinity) || lines.has(idx + 1))) hits.push(`CONFLICT_MARKER: ${f}:${idx + 1} ${marker}`);
  });
}
if (hits.length) {
  console.log(hits.join('\n'));
  console.log(`fix: finish the merge in each file above (keep the right side, delete the marker lines), or add a line with "${FIXTURE}" to a fixture that shows markers on purpose`);
  process.exit(1);
}
console.log(`CONFLICT_MARKERS: none (${added.size} changed file(s) against ${fork.slice(0, 12)})`);
