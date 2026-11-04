/**
 * review-fetch — what /ship's readers may fetch (GST-1322, docs/review-policy.md#what-readers-may-fetch).
 *
 * One rules table drives three things: the fetch paragraph every reader brief carries (lib/review-brief.ts), the
 * scanner that reads a reader's own tool calls (`gstack-review-dispatch audit-fetch`), and the tests. By default a
 * reader reads the checkout under review and its local git history, and may read single documentation pages; it
 * never clones, fetches or downloads another repository, dataset or archive. The base policy's `readers` key
 * (lib/ship-policy-readers.ts) adds hosts, repositories and paths no reader may reach at all, and a note.
 *
 * The scanner works on tool inputs only, never results: it splits each command into words and flags only a known
 * download tool aimed at a network target, so `grep "git clone"` or reading this file is not a hit. A hit is a
 * `violation` (a forbidden fetch or path) or a `note` (a fetch of the checkout's own remote by name).
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { loadPolicyAt } from './ship-policy-at';
import { isUnavailable, SHIP_POLICY_PATH } from './ship-policy';
import { effectiveReaders, readersPolicy, READERS_POLICY_DEFAULT, type EffectiveReaders } from './ship-policy-readers';

/** The default rule, one row per forbidden fetch shape; `brief` is how the paragraph names it. */
export const FETCH_RULES = [
  { id: 'git-remote', brief: '`git clone`, `fetch`, `pull`, `ls-remote` or `submodule update` against a network remote' },
  { id: 'gh-repo', brief: '`gh repo clone`, `gh api` tarball, zipball or contents, `gh release download`' },
  { id: 'dataset', brief: 'dataset or model downloads (`hf`, `huggingface-cli`, `snapshot_download`, `load_dataset`)' },
  { id: 'archive', brief: '`curl` or `wget` of an archive or a raw repository file' },
  { id: 'git-install', brief: 'package installs from a git URL' },
] as const;
export type FetchRule = typeof FETCH_RULES[number]['id'] | 'forbid-fetch' | 'forbid-path' | 'own-remote';

/** The paragraph every brief carries: the default rule, then the base policy's additions when it declares any. */
export function fetchParagraph(r: Pick<EffectiveReaders, 'forbid_fetch' | 'forbid_paths' | 'brief_note'> = READERS_POLICY_DEFAULT): string {
  const lines = [`Fetch rule: review only this checkout and its local git history; the diff base is already local. Do not clone, fetch, pull or download any other repository, dataset or archive: no ${FETCH_RULES.map(x => x.brief).join('; ')}. This brief asks for no fetch. Reading a single documentation web page is fine.`];
  if (r.forbid_fetch.length) lines.push(`This repository's policy also forbids any access to ${r.forbid_fetch.join(', ')}, web page reads included.`);
  if (r.forbid_paths.length) lines.push(`Do not open, read or search files matching ${r.forbid_paths.map(p => '`' + p + '`').join(', ')}; they are left out of the diff on purpose.`);
  if (r.brief_note) lines.push(`Repository note: ${r.brief_note}`);
  return lines.join(' ');
}

/**
 * `:(top,exclude,glob)` pathspecs for forbid_paths: added to every reader's diff and never kept back. Each pattern also excludes
 * `<pattern>/**`, because git's glob `*` stops at a slash: `sealed/*` alone would leave `sealed/d/x` in the diff (forbiddenPath agrees).
 */
export const forbidSpecs = (r: Pick<EffectiveReaders, 'forbid_paths'>) => r.forbid_paths.flatMap(p => { const q = p.replace(/\/+$/, ''); return q.endsWith('/**') ? [':(top,exclude,glob)' + q] : [':(top,exclude,glob)' + q, ':(top,exclude,glob)' + q + '/**']; });

export type ReadersLoad = { state: 'ok'; readers: EffectiveReaders; source: string } | { state: 'refused'; code: 'POLICY_SOURCE_UNAVAILABLE' | 'POLICY_INVALID'; lines: string[] };

/** The readers policy a pass applies: the base's, plus forbid_fetch entries the head adds. An unreadable or invalid base refuses; an invalid head adds nothing. */
export function loadReaders(root: string, baseSha: string, ref: string, headSha?: string): ReadersLoad {
  const base = loadPolicyAt(root, baseSha, ref);
  if (isUnavailable(base)) return { state: 'refused', code: 'POLICY_SOURCE_UNAVAILABLE', lines: [`READERS: refused: the base policy is unreadable (${base.detail}); a pass never runs without knowing what its readers may not fetch; fix: git fetch origin ${base.base}, then rerun (POLICY_SOURCE_UNAVAILABLE)`] };
  if (base.errors.length) return { state: 'refused', code: 'POLICY_INVALID', lines: base.errors.map(e => `READERS: refused: ${base.source.label} ${e.path}: ${e.message}; fix the base branch's ${SHIP_POLICY_PATH} (POLICY_INVALID)`) };
  const head = headSha ? loadPolicyAt(root, headSha, 'HEAD') : null;
  const headReaders = head && !isUnavailable(head) && !head.errors.length ? readersPolicy(head.policy) : null;
  return { state: 'ok', readers: effectiveReaders(readersPolicy(base.policy), headReaders), source: base.source.label };
}

/** The plan's one line: what readers may not reach on this pass. */
export function readersLine(r: EffectiveReaders): string {
  if (!r.forbid_fetch.length && !r.forbid_paths.length && !r.brief_note) return 'READERS: default (fetch rule only)';
  return `READERS: forbid_fetch=${r.forbid_fetch.length} forbid_paths=${r.forbid_paths.length} note=${r.brief_note ? 'yes' : 'no'} head_added=${r.head_added.length} digest=${r.digest}`;
}

export interface FetchHit { tool: string; target: string; rule: FetchRule; severity: 'violation' | 'note' }
/** One tool call as the scanner reads it: the tool's name and its input (never its result). */
export interface ToolEvent { tool: string; input: unknown }

const URL_RE = /^(?:https?|git|ssh|ftp|s3|gs|hf):\/\/\S+$/i;
const SCP_RE = /^[\w.-]+@([\w.-]+):([\w./-]+)$/;
const ARCHIVE_RE = /\.(?:tar|tgz|tar\.gz|tar\.xz|tar\.bz2|tar\.zst|zip|7z|gz|xz|bz2|zst|parquet|arrow|jsonl|bundle|pack)$/i;
const RAW_HOST_RE = /^(?:raw\.githubusercontent\.com|codeload\.github\.com|objects\.githubusercontent\.com|gist\.githubusercontent\.com)$/i;
const RAW_PATH_RE = /\/(?:archive|tarball|zipball|releases\/download|raw|resolve)\//i;
const WRAPPERS = new Set(['sudo', 'env', 'timeout', 'nice', 'nohup', 'command', 'exec', 'time', 'xargs', 'stdbuf']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const unquote = (a: string) => a.replace(/^['"]|['"]$/g, '');

/** A network target's host and path, or null for a local path, file:// URL or plain word. */
export function networkTarget(arg: string): { host: string; path: string } | null {
  const a = unquote(arg);
  if (/^file:/i.test(a)) return null;
  if (URL_RE.test(a)) { try { const u = new URL(a); return { host: u.hostname.toLowerCase(), path: u.pathname }; } catch { return null; } }
  const scp = SCP_RE.exec(a);
  return scp ? { host: scp[1]!.toLowerCase(), path: '/' + scp[2]! } : null;
}

/** The forbid_fetch entry a target is under: its host (or a subdomain), and owner/repo when the entry names them. */
export function forbiddenBy(t: { host: string; path: string }, entries: readonly string[]): string | null {
  for (const e of entries) {
    const [host, ...rest] = e.toLowerCase().split('/');
    if (t.host !== host && !t.host.endsWith('.' + host)) continue;
    const want = rest.join('/');
    const got = t.path.toLowerCase().replace(/^\/+/, '').replace(/\.git(?=\/|$)/, '');
    if (!want || got === want || got.startsWith(want + '/')) return e;
  }
  return null;
}

/** A command line split into simple commands (`;`, `&&`, `||`, `|`, newlines) and words, with quotes honored. */
export function splitCommands(line: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [], word = '', quote: string | null = null, has = false;
  const endWord = () => { if (has) words.push(word); word = ''; has = false; };
  const endCmd = () => { endWord(); if (words.length) out.push(words); words = []; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) { if (c === quote) quote = null; else if (c === '\\' && quote === '"' && i + 1 < line.length) word += line[++i]; else word += c; continue; }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < line.length) { word += line[++i]; has = true; continue; }
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')') { endCmd(); continue; }
    if (/\s/.test(c)) { endWord(); continue; }
    word += c; has = true;
  }
  endCmd();
  return out;
}

/** The words a command runs after leading assignments and wrappers (`sudo`, `timeout 60`, `env A=b`); `bash -c` recurses. */
function commandWords(words: string[]): string[][] {
  const w = [...words];
  for (;;) {
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) w.shift();
    if (!w.length) return [];
    const exe = path.basename(w[0]!);
    if (WRAPPERS.has(exe)) { w.shift(); while (w.length && (/^-/.test(w[0]!) || /^\d+[smhd]?$/.test(w[0]!))) w.shift(); continue; }
    if (SHELLS.has(exe)) { const c = w.indexOf('-c'); return c >= 0 && w[c + 1] ? splitCommands(w[c + 1]!).flatMap(commandWords) : []; }
    if (exe === 'cd' || exe === 'pushd') return [];
    return [w];
  }
}

function scanWords(tool: string, w: string[], forbid: readonly string[], pathHit: (p: string) => boolean): FetchHit[] {
  const hits: FetchHit[] = [];
  const exe = path.basename(w[0]!);
  const args = w.slice(1);
  const hit = (target: string, rule: FetchRule, severity: FetchHit['severity'] = 'violation') => hits.push({ tool, target, rule, severity });
  const targets = args.flatMap(a => { const t = networkTarget(a); return t ? [{ a, t }] : []; });
  for (const { a, t } of targets) if (forbiddenBy(t, forbid)) hit(a, 'forbid-fetch');
  for (const a of args) if (!a.startsWith(':(') && !a.startsWith('-') && pathHit(a)) hit(a, 'forbid-path');
  if (exe === 'git') {
    let i = 0;
    while (i < args.length && args[i]!.startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree'].includes(args[i]!) ? 2 : 1;
    const sub = args[i];
    const rest = args.slice(i + 1);
    if (sub === 'show' || sub === 'cat-file') for (const a of rest) { const m = /^[^:\s]+:(.+)$/.exec(a); if (m && pathHit(m[1]!)) hit(a, 'forbid-path'); }
    if (sub && ['clone', 'fetch', 'pull', 'ls-remote'].includes(sub)) {
      const net = rest.filter(a => networkTarget(a));
      if (net.length) for (const a of net) hit(a, 'git-remote');
      else if (sub !== 'clone' && rest.some(a => !a.startsWith('-'))) hit('git ' + sub + ' ' + rest.filter(a => !a.startsWith('-'))[0], 'own-remote', 'note');
    }
    if (sub === 'submodule' && rest.some(a => a === 'update' || a === 'add')) hit('git submodule ' + rest.join(' '), 'git-remote');
  }
  if (exe === 'gh') {
    if (args[0] === 'repo' && args[1] === 'clone') hit(args.slice(2).find(a => !a.startsWith('-')) ?? 'gh repo clone', 'gh-repo');
    if (args[0] === 'release' && args[1] === 'download') hit('gh release download ' + args.slice(2).join(' '), 'gh-repo');
    const ep = args[0] === 'api' ? args.slice(1).find(a => /^\/?repos\/[\w.-]+\/[\w.-]+/.test(a)) : undefined;
    if (ep && /\/(tarball|zipball|contents)(\/|$|\?)/.test(ep)) hit(ep, 'gh-repo');
    const named = [...args.filter((a, k) => (args[k - 1] === '-R' || args[k - 1] === '--repo' || (args[0] === 'repo' && k === 2)) && /^[\w.-]+\/[\w.-]+$/.test(a)), ...(ep ? [/^\/?repos\/([\w.-]+\/[\w.-]+)/.exec(ep)![1]!] : [])];
    for (const repo of named) if (forbiddenBy({ host: 'github.com', path: '/' + repo }, forbid)) hit(repo, 'forbid-fetch');
  }
  if ((exe === 'hf' || exe === 'huggingface-cli') && (args[0] === 'download' || args[0] === 'snapshot-download')) hit(exe + ' ' + args.join(' '), 'dataset');
  if (/^python[0-9.]*$/.test(exe) || ['uv', 'node', 'bun', 'deno'].includes(exe)) {
    const code = args.join(' ');
    if (/\b(?:snapshot_download|hf_hub_download|load_dataset)\s*\(/.test(code)) hit(code.slice(0, 120), 'dataset');
  }
  if (['curl', 'wget', 'aria2c', 'http', 'xh'].includes(exe)) for (const { a, t } of targets) if (ARCHIVE_RE.test(t.path) || RAW_HOST_RE.test(t.host) || RAW_PATH_RE.test(t.path)) hit(a, 'archive');
  const installer = ['pip', 'pip3', 'npm', 'pnpm', 'yarn', 'bun', 'uv', 'cargo', 'go'].includes(exe) && args.some(a => ['install', 'add', 'i', 'get'].includes(a));
  if (installer) for (const a of args) if (/^git\+|^git:\/\/|^github:|\.git(#.*)?$/.test(a) || (networkTarget(a) && /github\.com|gitlab\.com|bitbucket\.org/.test(a))) hit(a, 'git-install');
  return hits;
}

/** The command strings in one tool input: a shell tool's command, and every `command:` string inside a program. */
function commandsOf(input: unknown): string[] {
  if (typeof input === 'string') return [input];
  if (!input || typeof input !== 'object') return [];
  const o = input as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ['command', 'cmd']) if (typeof o[k] === 'string') out.push(o[k] as string);
  if (typeof o.code === 'string') for (const m of o.code.matchAll(/\bcommand\s*:\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g)) out.push(m[2]!.replace(/\\n/g, '\n').replace(/\\(["'`\\])/g, '$1'));
  return out;
}
const field = (input: unknown, keys: string[], code: RegExp): string[] => {
  if (!input || typeof input !== 'object') return [];
  const o = input as Record<string, unknown>;
  return [...keys.map(k => o[k]).filter((v): v is string => typeof v === 'string'), ...(typeof o.code === 'string' ? [...o.code.matchAll(code)].map(m => m[2]!) : [])];
};

/** Whether a repo-relative path is one forbidSpecs excludes: the path itself or a directory above it matches a pattern (git then excludes `<dir>/**`). */
export function forbiddenPath(globs: readonly InstanceType<typeof Bun.Glob>[], rel: string): boolean {
  const parts = rel.replace(/\/+$/, '').split('/');
  return parts.some((_, i) => { const p = parts.slice(0, i + 1).join('/'); return globs.some(g => g.match(p)); });
}

/** Scan a reader's tool calls against the default rule and the pass's readers policy; `root` is the checkout under review. */
export function scanEvents(events: readonly ToolEvent[], r: Pick<EffectiveReaders, 'forbid_fetch' | 'forbid_paths'>, root: string): FetchHit[] {
  const globs = r.forbid_paths.map(p => new Bun.Glob(p.replace(/\/+$/, '')));
  const pathHit = (p: string): boolean => {
    if (!globs.length) return false;
    const clean = unquote(p);
    const rel = path.isAbsolute(clean) ? path.relative(root, clean) : clean.replace(/^\.\//, '');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    return forbiddenPath(globs, rel);
  };
  const hits: FetchHit[] = [];
  for (const e of events) {
    for (const c of commandsOf(e.input)) for (const w of splitCommands(c).flatMap(commandWords)) hits.push(...scanWords(e.tool, w, r.forbid_fetch, pathHit));
    for (const u of field(e.input, ['url'], /\burl\s*:\s*(["'`])(https?:\/\/[^"'`\s]+)\1/g)) {
      const t = networkTarget(u);
      if (t && forbiddenBy(t, r.forbid_fetch)) hits.push({ tool: e.tool, target: u, rule: 'forbid-fetch', severity: 'violation' });
      else if (t && (ARCHIVE_RE.test(t.path) || RAW_HOST_RE.test(t.host))) hits.push({ tool: e.tool, target: u, rule: 'archive', severity: 'violation' });
    }
    for (const p of field(e.input, ['path', 'file_path', 'filePath'], /\bpath\s*:\s*(["'`])([^"'`]+)\1/g)) if (pathHit(p)) hits.push({ tool: e.tool, target: p, rule: 'forbid-path', severity: 'violation' });
  }
  const seen = new Set<string>();
  return hits.filter(h => { const k = h.tool + '\0' + h.target + '\0' + h.rule; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** The audit verdict over one reader's events: clean, or a violation when any hit is one. */
export const auditVerdict = (hits: readonly FetchHit[]): 'clean' | 'violation' => (hits.some(h => h.severity === 'violation') ? 'violation' : 'clean');
export const eventsDigest = (text: string) => createHash('sha256').update(text).digest('hex');
