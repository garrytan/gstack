/**
 * review-vendored — the review_vendored key of .gstack/ship-policy.json and the check that a vendored file is
 * byte-for-byte an allowlisted upstream's file at a pinned commit (docs/vendored-code.md, GST-3298).
 *
 * The base branch's policy names the upstream repositories a repo trusts and the manifests that pin files to them. A
 * manifest (gstack-vendored/v1, written by the repo's own build) maps each local path, by prefix, to a path at one
 * commit of one upstream. A file is verified only when: its upstream is on the base allowlist; the commit is reachable
 * from that upstream's default branch, one of its tags, or a branch matching a glob the base names for it (never
 * refs/pull/* or another repository in its fork network); and the blob at the upstream path has the same git blob id
 * and mode (100644 on both sides) as the head's file. A blob id is git's hash of the exact bytes, so equal ids mean
 * equal bytes. Anything else is a verdict with a reason code, and a caller treats it as not vendored.
 *
 * Fetches go straight to the upstream over https with no ambient git configuration (no credential helper, extra
 * header or URL rewrite), no prompt, no redirect and a timeout, so a check that passes on one machine passes in CI.
 * Each upstream has two bare caches under the state root: refs.git (commit history only, for reachability) and
 * trees.git (each pin's trees at depth 1, no file contents). Verdicts are cached per pin, so resolveVendored with
 * fetch: false answers offline from what a fetching run recorded.
 */
import { spawnSync } from './spawn-sync';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const MANIFEST_SCHEMA = 'gstack-vendored/v1';
export interface VendoredUpstream { url: string; branches: string[] }
/** The key as a policy file writes it. */
export interface VendoredPolicyRaw { upstreams: Array<string | { url: string; branches?: string[] }>; manifests: string[] }
export interface VendoredPolicy { upstreams: VendoredUpstream[]; manifests: string[] }
export interface VendoredPin { upstream: string; commit: string; local_prefix: string; upstream_prefix: string; files: string[] }
export interface VendoredEntry { path: string; upstream: string; commit: string; upstream_path: string }
export type VendoredVerdict = 'verified' | 'mismatched' | 'absent-upstream' | 'absent-local' | 'mode' | 'unreachable' | 'not-allowlisted' | 'fetch-failed';
export interface EntryResult extends VendoredEntry { verdict: VendoredVerdict; detail?: string }
export interface PinResult { upstream: string; commit: string; reachable_from: string | null; files: number; verified: number }

/** What \`gstack-ship-policy init --explain\` prints for the key. */
export const VENDORED_EXPLANATION = '{ upstreams, manifests } or null (default), read from the base branch only: upstreams lists the https URLs of the repositories a repo vendors unchanged files from (a string, or { url, branches } to also accept commits on branches matching those globs); manifests lists the repo paths of gstack-vendored/v1 manifests that pin each vendored file to an upstream path at a commit. gstack-vendored-verify checks every pinned file is byte-for-byte that upstream file at a commit reachable from the upstream\'s default branch or a tag; a head cannot add an upstream or a manifest (docs/vendored-code.md).';

const UPSTREAM = /^https:\/\/[a-z0-9]([a-z0-9.-]{0,252}[a-z0-9])?(:[0-9]{1,5})?(\/[A-Za-z0-9_.-]{1,100}){2,4}$/;
const BRANCH_GLOB = /^(?!refs\/)(?!pull\/)(?!gh-readonly-queue\/)[A-Za-z0-9._\/-]*\*?[A-Za-z0-9._\/-]*$/;
type PolicyError = { code: 'POLICY_INVALID'; path: string; message: string };

/** The key normalized: every upstream as { url, branches }; null when the policy does not declare it. */
export function vendoredPolicy(p: { review_vendored?: unknown } | null | undefined): VendoredPolicy | null {
  const v = p?.review_vendored as { upstreams?: Array<string | { url: string; branches?: string[] }>; manifests?: string[] } | null | undefined;
  if (!v) return null;
  return { upstreams: (v.upstreams ?? []).map(u => (typeof u === 'string' ? { url: u, branches: [] } : { url: u.url, branches: u.branches ?? [] })), manifests: [...(v.manifests ?? [])] };
}

/** \`review_vendored\`: each field's error at its path (\`contained\` is lib/ship-policy.ts's containedRelative). */
export function vendoredErrors(value: unknown, out: PolicyError[] | any[], contained: (p: string) => string | null): void {
  if (value === null) return;
  const err = (p: string, message: string) => out.push({ code: 'POLICY_INVALID', path: p, message });
  if (!value || typeof value !== 'object' || Array.isArray(value)) { err('review_vendored', 'must be { upstreams, manifests } or null'); return; }
  const v = value as Record<string, unknown>;
  for (const k of Object.keys(v)) if (k !== 'upstreams' && k !== 'manifests') err(`review_vendored.${k}`, 'unknown key');
  if (!Array.isArray(v.upstreams) || !v.upstreams.length || v.upstreams.length > 64) err('review_vendored.upstreams', 'must be an array of 1 to 64 upstreams');
  else v.upstreams.forEach((u, i) => {
    const at = `review_vendored.upstreams[${i}]`;
    const o = typeof u === 'string' ? { url: u } : u && typeof u === 'object' && !Array.isArray(u) ? (u as Record<string, unknown>) : null;
    if (!o) { err(at, 'must be an https URL or { url, branches? }'); return; }
    for (const k of Object.keys(o)) if (k !== 'url' && k !== 'branches') err(`${at}.${k}`, 'unknown key');
    if (typeof o.url !== 'string' || !UPSTREAM.test(o.url) || /\.\.|\/\.$|\.git\//.test(o.url)) err(at, `${JSON.stringify(o.url)} must be an https URL of a repository (https://github.com/owner/repo), with no credentials, query or fragment`);
    if ('branches' in o && (!Array.isArray(o.branches) || o.branches.length > 16 || o.branches.some(b => typeof b !== 'string' || !b || b.length > 100 || !BRANCH_GLOB.test(b)))) {
      err(`${at}.branches`, 'must be at most 16 branch names or globs with one *, never under refs/, pull/ or gh-readonly-queue/');
    }
  });
  if (Array.isArray(v.upstreams)) {
    const urls = v.upstreams.map(u => (typeof u === 'string' ? u : (u as { url?: unknown })?.url));
    urls.forEach((u, i) => { if (urls.indexOf(u) !== i) err(`review_vendored.upstreams[${i}]`, 'is listed twice'); });
  }
  if (!Array.isArray(v.manifests) || !v.manifests.length || v.manifests.length > 16) err('review_vendored.manifests', 'must be an array of 1 to 16 manifest paths');
  else v.manifests.forEach((m, i) => {
    const why = typeof m !== 'string' ? 'must be a string' : contained(m) ?? (pathProblem(m) ?? (/[*?[\]]/.test(m) ? 'must be a path, not a glob' : null));
    if (why) err(`review_vendored.manifests[${i}]`, `${JSON.stringify(m)} ${why}`);
  });
}

/** Why a repo-relative path is refused, or null: no empty, . or .. segment, leading /, backslash or control character. */
export function pathProblem(p: string): string | null {
  if (!p) return 'is empty';
  if (p.startsWith('/')) return 'must be relative';
  if (/[\\\x00-\x1f\x7f]/.test(p)) return 'contains a backslash or control character';
  if (p.split('/').some(s => s === '' || s === '.' || s === '..')) return 'has an empty, . or .. segment';
  return null;
}

/** A manifest's pins and every problem with it; entries are the pins flattened to one row per file. */
export function parseManifest(text: string, where: string): { pins: VendoredPin[]; entries: VendoredEntry[]; errors: string[] } {
  const errors: string[] = [];
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { pins: [], entries: [], errors: [`${where}: not JSON (${(e as Error).message})`] }; }
  const m = raw as { schema?: unknown; pins?: unknown };
  if (!m || typeof m !== 'object' || m.schema !== MANIFEST_SCHEMA) errors.push(`${where}: schema must be "${MANIFEST_SCHEMA}"`);
  if (!Array.isArray(m?.pins) || !m.pins.length) return { pins: [], entries: [], errors: [...errors, `${where}: pins must be a non-empty array`] };
  const pins: VendoredPin[] = [];
  const entries: VendoredEntry[] = [];
  const seen = new Map<string, string>();
  m.pins.forEach((p: any, i: number) => {
    const at = `${where}: pins[${i}]`;
    const bad = (s: string) => errors.push(`${at}${s}`);
    if (!p || typeof p !== 'object') { bad(' must be an object'); return; }
    for (const k of Object.keys(p)) if (!['upstream', 'commit', 'local_prefix', 'upstream_prefix', 'files'].includes(k)) bad(`.${k}: unknown key`);
    if (typeof p.upstream !== 'string' || !UPSTREAM.test(p.upstream)) bad('.upstream must be an https repository URL');
    if (typeof p.commit !== 'string' || !/^[0-9a-f]{40}$/.test(p.commit)) bad('.commit must be a full 40-character lowercase commit id');
    for (const k of ['local_prefix', 'upstream_prefix'] as const) {
      const v = p[k];
      if (typeof v !== 'string' || (v !== '' && (!v.endsWith('/') || pathProblem(v.slice(0, -1)))) || (k === 'local_prefix' && v === '')) bad(`.${k} must be ${k === 'local_prefix' ? 'a' : '"" or a'} repo-relative directory ending in /`);
    }
    if (!Array.isArray(p.files) || !p.files.length) { bad('.files must be a non-empty array'); return; }
    const ok = errors.length;
    p.files.forEach((f: unknown, j: number) => { const why = typeof f !== 'string' ? 'must be a string' : pathProblem(f); if (why) bad(`.files[${j}] ${JSON.stringify(f)} ${why}`); });
    if (errors.length !== ok || typeof p.local_prefix !== 'string' || typeof p.upstream_prefix !== 'string') return;
    pins.push({ upstream: p.upstream, commit: p.commit, local_prefix: p.local_prefix, upstream_prefix: p.upstream_prefix, files: [...p.files] });
    for (const f of p.files as string[]) {
      const local = p.local_prefix + f;
      const folded = local.toLowerCase();
      if (seen.has(folded)) { bad(`: ${local} collides with ${seen.get(folded)} (listed twice, or the same path in another letter case)`); continue; }
      seen.set(folded, local);
      entries.push({ path: local, upstream: p.upstream, commit: p.commit, upstream_path: p.upstream_prefix + f });
    }
  });
  return { pins, entries, errors };
}

/** The fetch environment: no global or system git config, no prompt, nothing that lets ambient credentials or rewrites in. */
function gitEnv(cache: string): NodeJS.ProcessEnv {
  const empty = path.join(cache, 'empty.gitconfig');
  if (!fs.existsSync(empty)) fs.writeFileSync(empty, '');
  const keep = Object.fromEntries(['SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR'].flatMap(k => (process.env[k] ? [[k, process.env[k]!]] : [])));
  return { ...keep, PATH: process.env.PATH ?? '', HOME: cache, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never', LANG: 'C', LC_ALL: 'C' };
}

const TEST_ROOT = 'GSTACK_VENDORED_FETCH_ROOT';
/** Where a fetch goes: the upstream itself, or (tests only) the same host/path under GSTACK_VENDORED_FETCH_ROOT. */
export function fetchUrl(url: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env[TEST_ROOT];
  return root ? `${root.replace(/\/+$/, '')}/${url.replace(/^https:\/\//, '')}` : url;
}

function remoteFlags(env: NodeJS.ProcessEnv): string[] {
  const test = !!env[TEST_ROOT];
  return ['-c', 'credential.helper=', '-c', 'http.extraHeader=', '-c', 'http.followRedirects=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
    ...(test ? ['-c', 'protocol.file.allow=always', '-c', 'protocol.http.allow=always'] : []), '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=30'];
}

const timeoutMs = (env: NodeJS.ProcessEnv) => { const n = Number(env.GSTACK_VENDORED_FETCH_TIMEOUT_MS); return Number.isFinite(n) && n > 0 ? n : 180_000; };

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv, timeout = 60_000): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '', err: `${r.stderr ?? ''}${r.error ? ` ${r.error.message}` : ''}`.trim() };
}

/** One lock file per upstream cache; a lock older than ten minutes belonged to a dead process. */
function withLock<T>(dir: string, fn: () => T): T {
  const lock = path.join(dir, 'lock');
  for (let i = 0; ; i++) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 600_000) { fs.rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (i > 600) throw new Error(`vendored cache ${dir} stayed locked`);
      Bun.sleepSync(100);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}

interface PinCache { reachable_from: string | null; default_branch?: string; checked_at: number; tree: Record<string, [string, string] | null>; error?: string; failed?: string }

/** Whether a cached ref the commit sits on is one the current policy trusts: a tag, the default branch, or a branch the base names, never a merge-queue branch. */
function trustedHolder(ref: string, def: string | undefined, up: VendoredUpstream): boolean {
  if (ref.startsWith('tags/')) return true;
  if (!ref.startsWith('heads/')) return false;
  const branch = ref.slice('heads/'.length);
  if (branch.startsWith('gh-readonly-queue/')) return false;
  return branch === def || up.branches.some(g => new RegExp(`^${g.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(branch));
}
const key = (url: string) => createHash('sha256').update(url).digest('hex').slice(0, 24);
const pinFile = (dir: string, commit: string) => path.join(dir, 'pins', `${commit}.json`);
function readPin(dir: string, commit: string): PinCache | null { try { return JSON.parse(fs.readFileSync(pinFile(dir, commit), 'utf8')) as PinCache; } catch { return null; } }
function writePin(dir: string, commit: string, p: PinCache): void {
  fs.mkdirSync(path.join(dir, 'pins'), { recursive: true });
  const f = pinFile(dir, commit);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(p));
  fs.renameSync(`${f}.tmp`, f);
}

/**
 * Fetch one upstream's reachability refs and each pin's trees into its cache and record, per pin, the ref that holds
 * the commit and the mode and blob id of every upstream path asked for. A failed fetch is this run's error for each pin it
 * covers. It is recorded as the pin's error when the cache holds no good record for it; a good record stays, marked with
 * the failure (`failed`) until a later fetch succeeds, so gstack-vendored-verify --offline keeps answering from it while
 * review selection keeps the pin's files, as the run that failed did.
 */
function fetchUpstream(cacheRoot: string, up: VendoredUpstream, pins: Map<string, Set<string>>, env: NodeJS.ProcessEnv): Map<string, string> {
  const dir = path.join(cacheRoot, key(up.url));
  fs.mkdirSync(dir, { recursive: true });
  const errors = new Map<string, string>();
  const failPin = (commit: string, error: string, rec: PinCache) => {
    errors.set(commit, error);
    const prev = readPin(dir, commit);
    writePin(dir, commit, prev?.reachable_from && !prev.error ? { ...prev, failed: error } : { ...rec, error });
  };
  withLock(dir, () => {
    const genv = gitEnv(dir);
    const flags = remoteFlags(env);
    const url = fetchUrl(up.url, env);
    const t = timeoutMs(env);
    for (const repo of ['refs.git', 'trees.git']) if (!fs.existsSync(path.join(dir, repo, 'HEAD'))) git(dir, ['init', '--quiet', '--bare', repo], genv);
    const refs = path.join(dir, 'refs.git');
    const trees = path.join(dir, 'trees.git');
    const fail = (error: string) => { for (const c of pins.keys()) failPin(c, error, { reachable_from: null, checked_at: Date.now(), tree: {} }); };
    const head = git(refs, [...flags, 'ls-remote', '--symref', url, 'HEAD', 'refs/heads/*'], genv, t);
    const def = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(head.out)?.[1];
    if (!head.ok || !def) { fail(`could not read the default branch (${head.err.split('\n').pop() || 'no HEAD'})`); return; }
    const heads = new Set(head.out.split('\n').map(l => l.split('\t')[1]).filter(Boolean));
    const named = up.branches.filter(b => b.includes('*') || heads.has(`refs/heads/${b}`));
    for (const b of up.branches) if (!b.includes('*') && !heads.has(`refs/heads/${b}`)) git(refs, ['update-ref', '-d', `refs/vendored/heads/${b}`], genv);
    const specs = [`+refs/heads/${def}:refs/vendored/heads/${def}`, '+refs/tags/*:refs/vendored/tags/*', ...named.map(b => `+refs/heads/${b}:refs/vendored/heads/${b}`)];
    const f = git(refs, [...flags, 'fetch', '--quiet', '--no-tags', '--prune', '--filter=tree:0', url, ...specs], genv, t);
    if (!f.ok) { fail(`could not fetch its branches and tags (${f.err.split('\n').pop()})`); return; }
    for (const [commit, paths] of pins) {
      const has = git(refs, ['cat-file', '-e', `${commit}^{commit}`], genv).ok;
      const holders = has ? git(refs, ['for-each-ref', '--format=%(refname)', '--contains', commit, 'refs/vendored/'], genv).out.split('\n').map(r => r.trim().replace(/^refs\/vendored\//, '')) : [];
      const reachable_from = holders.find(r => r && trustedHolder(r, def, up)) ?? null;
      if (!reachable_from) { writePin(dir, commit, { reachable_from: null, default_branch: def, checked_at: Date.now(), tree: {} }); continue; }
      const tf = git(trees, [...flags, 'fetch', '--quiet', '--no-tags', '--depth=1', '--filter=blob:none', url, commit], genv, t);
      if (!tf.ok) { failPin(commit, `could not fetch the commit's trees (${tf.err.split('\n').pop()})`, { reachable_from, default_branch: def, checked_at: Date.now(), tree: {} }); continue; }
      const ls = git(trees, ['ls-tree', '-r', '-z', '--full-tree', commit], genv);
      if (!ls.ok) { failPin(commit, 'could not list the commit\'s tree', { reachable_from, default_branch: def, checked_at: Date.now(), tree: {} }); continue; }
      const all = new Map<string, [string, string]>();
      for (const rec of ls.out.split('\0')) { const m = /^(\d{6}) (?:blob|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(rec); if (m) all.set(m[3]!, [m[1]!, m[2]!]); }
      const prev = readPin(dir, commit);
      const tree: Record<string, [string, string] | null> = { ...(prev?.reachable_from ? prev.tree : {}) };
      for (const p of paths) tree[p] = all.get(p) ?? null;
      writePin(dir, commit, { reachable_from, default_branch: def, checked_at: Date.now(), tree });
    }
  });
  return errors;
}

/** The head's mode and blob id for each path (git ls-tree under each pin's prefix); missing paths are absent. */
function headBlobs(root: string, rev: string, entries: readonly VendoredEntry[]): Map<string, [string, string]> | null {
  const out = new Map<string, [string, string]>();
  const prefixes = [...new Set(entries.map(e => e.path.slice(0, e.path.lastIndexOf('/') + 1)))].sort();
  const roots = prefixes.filter((p, i) => !prefixes.slice(0, i).some(q => p.startsWith(q)));
  for (let i = 0; i < roots.length; i += 200) {
    const r = spawnSync('git', ['ls-tree', '-r', '-z', '--full-tree', rev, '--', ...roots.slice(i, i + 200).map(p => `:(top,literal)${p || '.'}`)], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) return null;
    for (const rec of (r.stdout ?? '').split('\0')) { const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(rec); if (m) out.set(m[4]!, [m[1]!, m[3]!]); }
  }
  return out;
}

export interface ResolveInput {
  root: string; rev: string; policy: VendoredPolicy; entries: readonly VendoredEntry[];
  /** Fetch upstreams and refresh the cache (gstack-vendored-verify); false answers from the cache alone. */
  fetch: boolean; cacheRoot: string; env?: NodeJS.ProcessEnv;
  /** Answer from a good cached record whose latest fetch failed (gstack-vendored-verify); unset, such a pin is fetch-failed. */
  keepGood?: boolean;
}

/** One verdict per entry, one summary per pin, and a digest over both; null when git could not read the head. */
export function resolveVendored(i: ResolveInput): { entries: EntryResult[]; pins: PinResult[]; digest: string } | null {
  const env = i.env ?? process.env;
  const allowed = new Map(i.policy.upstreams.map(u => [u.url, u]));
  const byUpstream = new Map<string, Map<string, Set<string>>>();
  for (const e of i.entries) {
    if (!allowed.has(e.upstream)) continue;
    const pins = byUpstream.get(e.upstream) ?? new Map<string, Set<string>>();
    pins.set(e.commit, (pins.get(e.commit) ?? new Set()).add(e.upstream_path));
    byUpstream.set(e.upstream, pins);
  }
  const fetchErrors = new Map<string, string>();
  if (i.fetch) for (const [url, pins] of byUpstream) for (const [commit, error] of fetchUpstream(i.cacheRoot, allowed.get(url)!, pins, env)) fetchErrors.set(`${url}@${commit}`, error);
  const head = headBlobs(i.root, i.rev, i.entries);
  if (!head) return null;
  const results: EntryResult[] = i.entries.map(e => {
    const local = head.get(e.path);
    if (!allowed.has(e.upstream)) return { ...e, verdict: 'not-allowlisted' };
    if (!local) return { ...e, verdict: 'absent-local' };
    const fetchError = fetchErrors.get(`${e.upstream}@${e.commit}`);
    if (fetchError) return { ...e, verdict: 'fetch-failed', detail: fetchError };
    const pin = readPin(path.join(i.cacheRoot, key(e.upstream)), e.commit);
    if (pin?.failed && !i.keepGood) return { ...e, verdict: 'fetch-failed', detail: `the latest fetch failed (${pin.failed}); review keeps the file until a fetch succeeds` };
    if (!pin || !(e.upstream_path in pin.tree) && !pin.error && pin.reachable_from) return { ...e, verdict: 'fetch-failed', detail: 'not in the cache; run gstack-vendored-verify' };
    if (pin.error) return { ...e, verdict: 'fetch-failed', detail: pin.error };
    if (!pin.reachable_from) return { ...e, verdict: 'unreachable' };
    if (!trustedHolder(pin.reachable_from, pin.default_branch, allowed.get(e.upstream)!)) return { ...e, verdict: 'unreachable', detail: `the cached ref ${pin.reachable_from} is not a tag, the default branch or a branch the base names` };
    const up = pin.tree[e.upstream_path];
    if (!up) return { ...e, verdict: 'absent-upstream' };
    if (local[0] !== '100644' || up[0] !== '100644') return { ...e, verdict: 'mode', detail: `head ${local[0]}, upstream ${up[0]}` };
    return local[1] === up[1] ? { ...e, verdict: 'verified' } : { ...e, verdict: 'mismatched', detail: `head blob ${local[1].slice(0, 12)}, upstream blob ${up[1].slice(0, 12)}` };
  });
  const pinRows = new Map<string, PinResult>();
  for (const r of results) {
    const k = `${r.upstream}@${r.commit}`;
    const row = pinRows.get(k) ?? { upstream: r.upstream, commit: r.commit, reachable_from: allowed.has(r.upstream) ? readPin(path.join(i.cacheRoot, key(r.upstream)), r.commit)?.reachable_from ?? null : null, files: 0, verified: 0 };
    row.files++;
    if (r.verdict === 'verified') row.verified++;
    pinRows.set(k, row);
  }
  const pins = [...pinRows.values()].sort((a, b) => (a.upstream + a.commit < b.upstream + b.commit ? -1 : 1));
  const sorted = [...results].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest = createHash('sha256').update(JSON.stringify({ policy: i.policy, entries: sorted.map(r => [r.path, r.upstream, r.commit, r.upstream_path, r.verdict]) })).digest('hex');
  return { entries: sorted, pins, digest };
}

/** The cache directory under a state root. */
export const vendoredCacheRoot = (stateRoot: string) => path.join(stateRoot, 'vendored-cache');

/** What a review range may treat as vendored (lib/review-exclude.ts): sorted verified paths, the entries that did not verify, the pins, and a digest of the verified list. */
export interface VendoredSelection { verified: string[]; failed: EntryResult[]; pins: PinResult[]; digest: string }

/**
 * The verified vendored files among `changed`: entries of the head's manifests, checked at the head, and files the range
 * deletes that the merge base's manifests list, checked at the merge base (a re-pin's old files). A head entry the merge
 * base already has counts only when the base manifests pinned it there too and its base copy verifies, so a branch that
 * swaps our own code (or a local patch) for upstream bytes keeps that removal in review; a file new on the branch needs
 * only its head check. With no head (a live tree) the manifests and blobs come from HEAD, and a file the working tree or
 * index changes is not verified. A manifest that is missing at the head, does not parse, or pins one path twice gives
 * { error } and nothing is verified.
 */
export function vendoredSelection(i: { root: string; policy: VendoredPolicy; head?: string; mergeBase: string; changed: ReadonlySet<string>; fetch: boolean; cacheRoot: string; env?: NodeJS.ProcessEnv }): VendoredSelection | { error: string } {
  const show = (rev: string, f: string) => { const r = spawnSync('git', ['show', `${rev}:${f}`], { cwd: i.root, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }); return r.status === 0 ? r.stdout ?? '' : null; };
  const rev = i.head ?? 'HEAD';
  const now: VendoredEntry[] = [];
  const old: VendoredEntry[] = [];
  for (const m of i.policy.manifests) {
    const text = show(rev, m);
    if (text === null) return { error: `${m} is not in ${i.head ? i.head.slice(0, 12) : 'HEAD'}` };
    const parsed = parseManifest(text, m);
    if (parsed.errors.length) return { error: parsed.errors[0]! };
    now.push(...parsed.entries);
    const before = show(i.mergeBase, m);
    if (before !== null) old.push(...parseManifest(before, m).entries);
  }
  const lower = new Set<string>();
  for (const e of now) { if (lower.has(e.path.toLowerCase())) return { error: `${e.path} is pinned more than once` }; lower.add(e.path.toLowerCase()); }
  const atHead = now.filter(e => i.changed.has(e.path));
  const missing = (at: string, paths: string[]): Set<string> | null => {
    if (!paths.length) return new Set();
    const r = spawnSync('git', ['cat-file', '--batch-check=%(objectname)'], { cwd: i.root, input: paths.map(p => `${at}:${p}\n`).join(''), encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) return null;
    const lines = (r.stdout ?? '').split('\n');
    return new Set(paths.filter((p, k) => lines[k] === `${at}:${p} missing`));
  };
  const dropped = old.filter(e => i.changed.has(e.path) && !lower.has(e.path.toLowerCase()) && !e.path.includes('\n'));
  const deleted = missing(rev, dropped.map(e => e.path));
  const added = missing(i.mergeBase, atHead.filter(e => !e.path.includes('\n')).map(e => e.path));
  if (!deleted || !added) return { error: 'git could not check which vendored files the range adds or deletes' };
  const gone = dropped.filter(e => deleted.has(e.path) && (i.head || !fs.existsSync(path.join(i.root, e.path))));
  const oldByPath = new Map(old.map(e => [e.path, e]));
  const modified = new Set(atHead.filter(e => !added.has(e.path)).map(e => e.path));
  const prior = [...modified].flatMap(p => oldByPath.get(p) ?? []);
  const head = resolveVendored({ root: i.root, rev, policy: i.policy, entries: atHead, fetch: i.fetch, cacheRoot: i.cacheRoot, env: i.env });
  const base = gone.length || prior.length ? resolveVendored({ root: i.root, rev: i.mergeBase, policy: i.policy, entries: [...gone, ...prior], fetch: i.fetch, cacheRoot: i.cacheRoot, env: i.env }) : { entries: [], pins: [], digest: '' };
  if (!head || !base) return { error: 'git could not list the vendored files' };
  const atBase = new Map(base.entries.filter(e => modified.has(e.path)).map(e => [e.path, e]));
  const ours = (p: string): string | null => {
    if (!modified.has(p)) return null;
    const b = atBase.get(p);
    if (!b) return 'the merge base has this file but its manifests do not pin it, so the branch replaces our own code; it stays in review';
    return b.verdict === 'verified' ? null : `its merge-base copy is not the upstream's file (${b.verdict}${b.detail ? `: ${b.detail}` : ''}), so the branch replaces our own code; it stays in review`;
  };
  const dirty = new Set<string>();
  if (!i.head) {
    const d = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-renames', 'HEAD'], { cwd: i.root, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    if (d.status !== 0) return { error: 'git could not list the working tree changes' };
    for (const f of (d.stdout ?? '').split('\0')) if (f) dirty.add(f);
  }
  const all = [...head.entries, ...base.entries.filter(e => !modified.has(e.path))];
  const why = (e: EntryResult) => (e.verdict !== 'verified' ? null : dirty.has(e.path) ? 'changed in the working tree' : ours(e.path));
  const verified = all.filter(e => e.verdict === 'verified' && why(e) === null).map(e => e.path).sort();
  const failed = all.filter(e => e.verdict !== 'verified' || why(e) !== null).map(e => (e.verdict === 'verified' ? { ...e, verdict: 'mismatched' as const, detail: why(e)! } : e));
  return { verified, failed, pins: [...head.pins, ...base.pins], digest: createHash('sha256').update(JSON.stringify(verified)).digest('hex') };
}

