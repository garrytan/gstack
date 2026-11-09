/**
 * doc-links — relative links and #anchors in Markdown resolve (the docs lane's link check, R81; docs/pregate.md#docs-only).
 * Offline: links with a scheme (https:, mailto:) or a protocol-relative // are not checked. Links inside fenced code
 * blocks and inline code are ignored. An anchor into a Markdown file must match a heading slug (GitHub style, with -1,
 * -2 suffixes for repeats) or an explicit <a id="..."> / <a name="..."> in that file.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface BrokenLink { file: string; line: number; target: string; reason: string }

export function githubSlug(heading: string): string {
  return heading.trim().toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

function unfenced(text: string): string[] {
  let fence: string | null = null;
  return text.split('\n').map(line => {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m) { if (!fence) { fence = m[1]![0]!; return ''; } if (m[1]![0] === fence) { fence = null; return ''; } }
    return fence ? '' : line;
  });
}

export function anchorsOf(text: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of unfenced(text)) {
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      const base = githubSlug(h[1]!);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      out.add(n ? `${base}-${n}` : base);
    }
    for (const a of line.matchAll(/<a\s+(?:id|name)=["']([^"']+)["']/gi)) out.add(a[1]!);
  }
  return out;
}

/** Broken relative links in `files` (repo-relative Markdown paths) under `root`; with `added`, only on those 1-based lines of each file. */
export function brokenLinks(root: string, files: readonly string[], added?: ReadonlyMap<string, ReadonlySet<number>>): BrokenLink[] {
  const broken: BrokenLink[] = [];
  const cache = new Map<string, Set<string>>();
  const anchorsAt = (abs: string) => { if (!cache.has(abs)) cache.set(abs, anchorsOf(fs.readFileSync(abs, 'utf8'))); return cache.get(abs)!; };
  for (const file of files) {
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) continue;
    unfenced(fs.readFileSync(abs, 'utf8')).forEach((raw, i) => {
      if (added && !added.get(file)?.has(i + 1)) return;
      const line = raw.replace(/(`+)[^`]*?\1/g, '');
      for (const m of line.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*)?\)/g)) {
        const target = m[1]!;
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue;
        const [withLine, anchor] = target.split('#', 2) as [string, string | undefined];
        const rel = /\.md$/i.test(withLine) ? withLine : withLine.replace(/:\d+(?:-\d+)?$/, '');
        let dest: string;
        try { dest = rel ? (rel.startsWith('/') ? path.join(root, decodeURIComponent(rel)) : path.resolve(path.dirname(abs), decodeURIComponent(rel))) : abs; }
        catch { broken.push({ file, line: i + 1, target, reason: 'undecodable path' }); continue; }
        if (path.relative(root, dest).startsWith('..')) { broken.push({ file, line: i + 1, target, reason: 'points outside the repository' }); continue; }
        if (!fs.existsSync(dest)) { broken.push({ file, line: i + 1, target, reason: 'no such file' }); continue; }
        if (!anchor || !/\.md$/i.test(dest) || !fs.statSync(dest).isFile()) continue;
        let wanted: string;
        try { wanted = decodeURIComponent(anchor).toLowerCase(); }
        catch { broken.push({ file, line: i + 1, target, reason: 'undecodable anchor' }); continue; }
        if (!anchorsAt(dest).has(wanted) && !anchorsAt(dest).has(anchor)) broken.push({ file, line: i + 1, target, reason: `no heading or <a id> for #${anchor}` });
      }
    });
  }
  return broken;
}

/**
 * 1-based lines each file added since `base` (diffed against the working tree). A file absent at `base`, tracked or
 * not, is all added. Each file is diffed on its own, so no path is parsed back out of patch headers (quoted, prefixed
 * or tab-suffixed names). Throws when `base` does not resolve or git fails.
 */
export function addedLines(root: string, base: string, files: readonly string[]): Map<string, Set<number>> {
  const added = new Map<string, Set<number>>();
  const fail = (what: string, r: ReturnType<typeof spawnSync>) => new Error(`${what}: ${(String(r.stderr ?? '') || r.error?.message || '').trim().split('\n')[0]}`);
  if (!files.length) return added;
  const ref = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  if (ref.status !== 0) throw fail(`git diff ${base}: unknown revision`, ref);
  for (const f of files) {
    const lines = new Set<number>();
    added.set(f, lines);
    if (spawnSync('git', ['cat-file', '-e', `${base}:${f}`], { cwd: root, timeout: 30_000 }).status !== 0) {
      const abs = path.join(root, f);
      if (fs.existsSync(abs)) fs.readFileSync(abs, 'utf8').split('\n').forEach((_, i) => lines.add(i + 1));
      continue;
    }
    const d = spawnSync('git', ['diff', '-U0', '--no-ext-diff', '--no-color', base, '--', f], { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    if (d.status !== 0) throw fail(`git diff ${base}`, d);
    for (const line of d.stdout.split('\n')) {
      const h = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (h) for (let n = 0, start = Number(h[1]); n < Number(h[2] ?? 1); n++) lines.add(start + n);
    }
  }
  return added;
}
