/**
 * Build a git fixture once per test file and hand each test its own copy.
 *
 * build(root) runs once, on the first copy(), into a template directory under
 * os.tmpdir(). Every copy() makes a fresh sibling directory, copies the
 * template into it with fs.cpSync (symlinks kept verbatim) and calls
 * rebind(copyRoot, templateRoot), which must rewrite every path-bearing file
 * the fixture wrote: remote URLs and pushurls in .git/config, reflog messages,
 * FETCH_HEAD, objects/info/alternates, state roots, install records. The copy
 * is then scanned for any remaining reference to the template root (native,
 * forward-slash and backslash-escaped spellings, plus the realpath and Git
 * Bash forms where they differ); a hit throws, so a test can never push into,
 * fetch from or read state out of the shared template. dispose() removes the
 * template; call it from afterAll.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface GitFixtureCopy<T> { root: string; meta: T }
export interface GitFixtureTemplate<T> { copy: (prefix?: string) => GitFixtureCopy<T>; dispose: () => void }

/** The spellings a path takes inside files git and gstack write, escaped form first so a rewrite never splits it. */
export function pathSpellings(root: string): string[] {
  const forms = (p: string) => {
    const forward = p.replace(/\\/g, '/');
    const drive = /^([A-Za-z]):\//.exec(forward);
    return [p.replace(/\\/g, '\\\\'), p, forward, ...(drive ? ['/' + drive[1]!.toLowerCase() + '/' + forward.slice(3)] : [])];
  };
  let real = root;
  try { real = fs.realpathSync.native(root); } catch {}
  return [...new Set([...forms(root), ...forms(real)])];
}

/** Rewrite every spelling of from to the same spelling of to in a text file, when the file exists. */
export function rebindFile(file: string, from: string, to: string): void {
  if (!fs.existsSync(file)) return;
  const targets = pathSpellings(to);
  let text = fs.readFileSync(file, 'utf8');
  const before = text;
  pathSpellings(from).forEach((spelling, i) => { text = text.split(spelling).join(targets[i] ?? to); });
  if (text !== before) fs.writeFileSync(file, text);
}

/** Rebind the path-bearing files git writes in a git directory: config, FETCH_HEAD, alternates and every reflog. */
export function rebindGitDir(gitDir: string, from: string, to: string): void {
  for (const rel of ['config', 'FETCH_HEAD', path.join('objects', 'info', 'alternates')]) rebindFile(path.join(gitDir, rel), from, to);
  const logs = path.join(gitDir, 'logs');
  if (!fs.existsSync(logs)) return;
  for (const entry of fs.readdirSync(logs, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) rebindFile(path.join(entry.parentPath, entry.name), from, to);
  }
}

/** Files and symlinks under dir (and the template's meta value) that still name templateRoot; zlib-compressed object storage is skipped. */
export function templateReferences(dir: string, templateRoot: string, meta?: unknown): string[] {
  const needles = pathSpellings(templateRoot).map(s => Buffer.from(s));
  const names = (buf: Buffer) => needles.some(n => buf.includes(n));
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isSymbolicLink()) { if (names(Buffer.from(fs.readlinkSync(p)))) hits.push(p); }
      else if (entry.isDirectory()) { if (!(path.basename(d) === 'objects' && /^(pack|[0-9a-f]{2})$/.test(entry.name))) walk(p); }
      else if (entry.isFile() && names(fs.readFileSync(p))) hits.push(p);
    }
  };
  walk(dir);
  if (meta !== undefined && names(Buffer.from(JSON.stringify(meta)))) hits.push('(template meta)');
  return hits;
}

export function gitFixtureTemplate<T>(opts: {
  prefix: string;
  build: (root: string) => T;
  rebind: (copyRoot: string, templateRoot: string) => void;
  realpath?: boolean;
}): GitFixtureTemplate<T> {
  let template: GitFixtureCopy<T> | null = null;
  const mkroot = (prefix: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return opts.realpath ? fs.realpathSync(dir) : dir;
  };
  return {
    copy(prefix = opts.prefix) {
      if (!template) {
        const root = mkroot(opts.prefix + 'tpl-');
        template = { root, meta: opts.build(root) };
      }
      const { root: from, meta } = template;
      const root = mkroot(prefix);
      if (pathSpellings(root).some(s => pathSpellings(from).some(t => s.startsWith(t)))) throw new Error('git fixture copy ' + root + ' lies under its template ' + from);
      fs.cpSync(from, root, { recursive: true, verbatimSymlinks: true });
      opts.rebind(root, from);
      const leaks = templateReferences(root, from, meta);
      if (leaks.length) fs.rmSync(root, { recursive: true, force: true });
      if (leaks.length) throw new Error('git fixture copy still references its template ' + from + ' (rebind missed them):\n' + leaks.join('\n'));
      return { root, meta };
    },
    dispose() {
      if (template) fs.rmSync(template.root, { recursive: true, force: true });
      template = null;
    },
  };
}
