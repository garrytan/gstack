/**
 * sealed-guard — the sealed-output guard (field wave CD4), shared by the
 * managed pre-push hook (bin/gstack-redact-prepush) and the standalone
 * preflight `gstack-pregate sealed [--range <a..b>]`.
 *
 * A repo opts in with a `sealed` key in `.gstack/pregate.json`:
 *   paths           globs that may never be published (held-out sets, cells)
 *   transcripts     globs of per-cell transcripts
 *   answer_markers  regexes for a quoted sealed answer in added text
 *   seed_patterns   regexes for a sampling seed in added text
 *   local_paths     true: a local home path (/home/<u>/, /Users/<u>/) in added text
 *   allow_paths     globs exempt from the path rules (read from the base branch only; never folds case)
 *   case_insensitive true: `paths` and `transcripts` match regardless of case
 *   visibility      "public" | "private": the destination override (reviewed on the base branch)
 *
 * The publication boundary is every commit the push publishes: the local sha
 * minus everything the destination remote already has (`git rev-list <local>
 * --not --remotes=<remote> ^<remote sha>`); a destination with no refs means
 * everything reachable. Path rules see every path a commit adds, renames or
 * copies, independent of content (binary, empty, add-then-delete); text rules
 * see each commit's added lines. The effective policy is the union of the
 * destination base branch's `sealed` and the pushed one (a push can tighten,
 * never relax); `allow_paths` exceptions come only from the base branch's
 * policy and remove path findings before waivers, which come only from the
 * base branch's `.gstack/sealed-allow.tsv`. A malformed or unreadable policy refuses (fail
 * closed). Visibility: the base override, else a cache under the state root
 * (a `public` answer for 24 h, a `private` one for 1 h before it may
 * downgrade a refusal), else `gh repo view` (5 s); unknown counts as public.
 * Findings name file, line, rule and commit, never the matched text.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { containedRelative, globToRegExp } from './ship-policy';
import { resolveStateRoot } from './state-root';

export const SEALED_CONFIG_PATH = '.gstack/pregate.json';
export const SEALED_ALLOW_PATH = '.gstack/sealed-allow.tsv';
export const VISIBILITY_OVERRIDE_KEY = 'sealed.visibility';
export type SealedRule = 'sealed.path' | 'sealed.transcript' | 'sealed.answer' | 'sealed.seed' | 'sealed.local_path';
export interface SealedPolicy { paths: string[]; transcripts: string[]; answer_markers: string[]; seed_patterns: string[]; local_paths: boolean; allow_paths: string[]; case_insensitive: boolean; visibility?: 'public' | 'private' }
export interface SealedFinding { rule: SealedRule; file: string; line?: number; commit: string }
export type ExemptFinding = SealedFinding & { glob: string };
export interface AllowEntry { rule: string; path: string; sha: string; reason: string }
export type Visibility = 'public' | 'private' | 'unknown';

const KEYS = ['paths', 'transcripts', 'answer_markers', 'seed_patterns', 'local_paths', 'allow_paths', 'case_insensitive', 'visibility'];
const MAX_ENTRIES = 64;
const MAX_REGEX = 256;
const LOCAL_PATH_RE = /(?:^|[^A-Za-z0-9_.~-])(?:\/home\/[^/\s'"`]+\/|\/Users\/[^/\s'"`]+\/|[A-Za-z]:\\+Users\\+[^\\\s'"`]+\\)/;
const PUBLIC_TTL_MS = 24 * 3600_000;
const PRIVATE_TTL_MS = 3600_000;

/** `<key>: <message>` errors for a `sealed` value; empty when valid. Shared with lib/pregate/config.ts. */
export function sealedErrors(raw: unknown): Array<{ path: string; message: string }> {
  const errors: Array<{ path: string; message: string }> = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [{ path: 'sealed', message: `must be an object { ${KEYS.join(', ')} }` }];
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!KEYS.includes(k)) errors.push({ path: `sealed.${k}`, message: `unknown key; valid keys: ${KEYS.join(', ')} (if the key comes from a newer gstack, upgrade gstack on this machine)` });
  const list = (key: string, check: (s: string) => string | null) => {
    if (!(key in o)) return;
    const v = o[key];
    if (!Array.isArray(v) || v.some(s => typeof s !== 'string')) { errors.push({ path: `sealed.${key}`, message: 'must be an array of strings' }); return; }
    if (v.length > MAX_ENTRIES) errors.push({ path: `sealed.${key}`, message: `more than ${MAX_ENTRIES} entries` });
    (v as string[]).forEach((s, i) => { const why = check(s); if (why) errors.push({ path: `sealed.${key}[${i}]`, message: `${JSON.stringify(s)} ${why}` }); });
  };
  const glob = (g: string) => { const why = containedRelative(g); if (why) return why; try { globToRegExp(g); return null; } catch (e: any) { return e.message; } };
  const regex = (r: string) => { if (!r || r.length > MAX_REGEX) return `must be 1-${MAX_REGEX} characters`; try { new RegExp(r); return null; } catch (e: any) { return `is not a valid regex (${e.message})`; } };
  const exception = (g: string) => { const name = g.split('/').pop()!; return glob(g) ?? (name.includes('**') || /^[*?]+(\.|$)/.test(name) ? 'has a wildcard file name, which would exempt whole directories or file types; name the file (e.g. **/sealed/*/MANIFEST.json)' : null); };
  list('paths', glob); list('transcripts', glob); list('answer_markers', regex); list('seed_patterns', regex); list('allow_paths', exception);
  for (const k of ['local_paths', 'case_insensitive']) if (k in o && typeof o[k] !== 'boolean') errors.push({ path: `sealed.${k}`, message: 'must be true or false' });
  if ('visibility' in o && o.visibility !== 'public' && o.visibility !== 'private') errors.push({ path: 'sealed.visibility', message: 'must be "public" or "private"' });
  return errors;
}

function git(repoRoot: string, args: string[], input?: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', input, timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '').trim() };
}

export type PolicyRead = { policy: SealedPolicy | null; label: string } | { error: string; label: string };

/** The `sealed` key of `.gstack/pregate.json` at a commit; null when absent; an error when present but unreadable. */
export function sealedPolicyAt(repoRoot: string, treeish: string, label: string): PolicyRead {
  const spec = `${treeish}:${SEALED_CONFIG_PATH}`;
  if (!git(repoRoot, ['cat-file', '-e', spec]).ok) return { policy: null, label };
  const show = git(repoRoot, ['cat-file', 'blob', spec]);
  if (!show.ok) return { error: `cannot read ${SEALED_CONFIG_PATH} (${show.err})`, label };
  let raw: any;
  try { raw = JSON.parse(show.out); }
  catch (e: any) { return /"sealed"/.test(show.out) ? { error: `${SEALED_CONFIG_PATH} is not valid JSON (${e.message})`, label } : { policy: null, label }; }
  if (!raw || typeof raw !== 'object' || !('sealed' in raw)) return { policy: null, label };
  const errors = sealedErrors(raw.sealed);
  if (errors.length) return { error: errors.map(e => `${e.path}: ${e.message}`).join('; '), label };
  const s = raw.sealed;
  return { policy: { paths: s.paths ?? [], transcripts: s.transcripts ?? [], answer_markers: s.answer_markers ?? [], seed_patterns: s.seed_patterns ?? [], local_paths: s.local_paths === true, allow_paths: s.allow_paths ?? [], case_insensitive: s.case_insensitive === true, visibility: s.visibility }, label };
}

/** Base ∪ pushed: deny lists concatenate, `local_paths` and `case_insensitive` OR (both only tighten); `allow_paths` relax, so they come from the base alone; visibility stays private only when the base says so and the push does not say public. */
export function unionPolicies(base: SealedPolicy | null, pushed: SealedPolicy | null): SealedPolicy | null {
  if (!base && !pushed) return null;
  const u = (k: 'paths' | 'transcripts' | 'answer_markers' | 'seed_patterns') => [...new Set([...(base?.[k] ?? []), ...(pushed?.[k] ?? [])])];
  const visibility = pushed?.visibility === 'public' || base?.visibility === 'public' ? 'public' : base?.visibility === 'private' ? 'private' : undefined;
  return { paths: u('paths'), transcripts: u('transcripts'), answer_markers: u('answer_markers'), seed_patterns: u('seed_patterns'), local_paths: !!(base?.local_paths || pushed?.local_paths), allow_paths: base?.allow_paths ?? [], case_insensitive: !!(base?.case_insensitive || pushed?.case_insensitive), visibility };
}

/** Reviewed waivers: `rule<TAB>path<TAB>sha<TAB>reason` lines in the base branch's allow file. */
export function allowEntriesAt(repoRoot: string, treeish: string | null): AllowEntry[] {
  if (!treeish) return [];
  const show = git(repoRoot, ['cat-file', 'blob', `${treeish}:${SEALED_ALLOW_PATH}`]);
  if (!show.ok) return [];
  return show.out.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => l.split('\t')).filter(f => f.length >= 4 && /^[0-9a-f]{7,64}$/.test(f[2]!) && f[3]!.trim())
    .map(f => ({ rule: f[0]!.trim(), path: f[1]!.trim(), sha: f[2]!, reason: f.slice(3).join('\t').trim() }));
}

/** Commits a push publishes: local minus the remote's refs (and its tip for this ref); null remote and no tip → everything reachable. */
export function publishedCommits(repoRoot: string, o: { localSha: string; remoteSha?: string | null; remoteName?: string | null }): { commits: string[] } | { error: string } {
  const not: string[] = [];
  if (o.remoteName) not.push(`--remotes=${o.remoteName}/*`);
  if (o.remoteSha && !/^0+$/.test(o.remoteSha) && git(repoRoot, ['cat-file', '-e', `${o.remoteSha}^{commit}`]).ok) not.push(o.remoteSha);
  const r = git(repoRoot, ['rev-list', o.localSha, ...(not.length ? ['--not', ...not] : [])]);
  if (!r.ok) return { error: `git rev-list failed: ${r.err.slice(0, 200)}` };
  return { commits: r.out.split('\n').filter(Boolean) };
}

export function rangeCommits(repoRoot: string, range: string): { commits: string[] } | { error: string } {
  const r = git(repoRoot, ['rev-list', range]);
  if (!r.ok) return { error: `git rev-list ${range} failed: ${r.err.slice(0, 200)}` };
  return { commits: r.out.split('\n').filter(Boolean) };
}

const HEX = /^[0-9a-f]{40,64}$/;

/** The first glob matching a repo-relative path, compiled once per list (`matchesAny` normalization); null when none does. */
function globMatcher(globs: string[], ignoreCase: boolean): (file: string) => string | null {
  const compiled = globs.map(g => { const re = globToRegExp(g); return { g, re: ignoreCase ? new RegExp(re.source, 'i') : re }; });
  return file => { const norm = file.replace(/\\/g, '/').replace(/^\.\//, ''); return compiled.find(c => c.re.test(norm))?.g ?? null; };
}

/** Path rules over every added, renamed or copied path, per commit (merges: paths new against every parent). */
function pathFindings(repoRoot: string, commits: string[], p: SealedPolicy): SealedFinding[] {
  if (!p.paths.length && !p.transcripts.length) return [];
  const r = git(repoRoot, ['-c', 'core.quotePath=false', 'diff-tree', '--stdin', '-r', '--root', '-M', '-C', '--cc', '--name-status', '-z'], commits.join('\n') + '\n');
  if (!r.ok) throw new Error(`git diff-tree failed: ${r.err.slice(0, 200)}`);
  const out: SealedFinding[] = [];
  const transcript = globMatcher(p.transcripts, p.case_insensitive);
  const sealedPath = globMatcher(p.paths, p.case_insensitive);
  const tokens = r.out.split('\0');
  let commit = '';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!t) continue;
    if (HEX.test(t)) { commit = t; continue; }
    const renamed = /^[RC]\d*$/.test(t);
    const file = renamed ? tokens[i += 2]! : tokens[++i]!;
    if (!renamed && !t.includes('A')) continue;
    if (transcript(file)) out.push({ rule: 'sealed.transcript', file, commit });
    else if (sealedPath(file)) out.push({ rule: 'sealed.path', file, commit });
  }
  return out;
}

/** Text rules over each commit's added lines (`--cc` for merges: only the resolution's own lines). */
function textFindings(repoRoot: string, commits: string[], p: SealedPolicy): SealedFinding[] {
  const rules: Array<[SealedRule, RegExp]> = [
    ...p.answer_markers.map(r => ['sealed.answer', new RegExp(r)] as [SealedRule, RegExp]),
    ...p.seed_patterns.map(r => ['sealed.seed', new RegExp(r)] as [SealedRule, RegExp]),
    ...(p.local_paths ? [['sealed.local_path', LOCAL_PATH_RE] as [SealedRule, RegExp]] : []),
  ];
  if (!rules.length) return [];
  const r = git(repoRoot, ['-c', 'core.quotePath=false', 'diff-tree', '--stdin', '-r', '--root', '-M', '-C', '--cc', '-p', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv'], commits.join('\n') + '\n');
  if (!r.ok) throw new Error(`git diff-tree -p failed: ${r.err.slice(0, 200)}`);
  const out: SealedFinding[] = [];
  let commit = ''; let file = ''; let inHunk = false; let parents = 1; let next = 0;
  for (const line of r.out.split('\n')) {
    if (HEX.test(line)) { commit = line; inHunk = false; continue; }
    if (line.startsWith('diff --')) { inHunk = false; file = ''; continue; }
    if (line.startsWith('@@')) { inHunk = true; parents = (/^@+/.exec(line)?.[0].length ?? 2) - 1; next = Number(/ \+(\d+)(?:,\d+)? @+/.exec(line)?.[1] ?? 0); continue; }
    if (!inHunk) { if (line.startsWith('+++ ')) file = line.startsWith('+++ b/') ? line.slice(6) : ''; continue; }
    const prefix = line.slice(0, parents);
    if (line.startsWith('\\') || prefix.includes('-')) continue;
    const n = next++;
    if (!prefix.includes('+')) continue;
    const text = line.slice(parents);
    for (const [rule, re] of rules) if (re.test(text)) out.push({ rule, file, line: n, commit });
  }
  return out;
}

export function scanCommits(repoRoot: string, commits: string[], policy: SealedPolicy): SealedFinding[] {
  if (!commits.length) return [];
  const seen = new Set<string>();
  return [...pathFindings(repoRoot, commits, policy), ...textFindings(repoRoot, commits, policy)].filter(f => {
    const key = `${f.rule}\0${f.file}\0${f.line ?? ''}\0${f.commit}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `owner/repo` for a GitHub remote URL; null for anything else (a local path, another host). */
export function githubSlug(url: string | null | undefined): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec((url ?? '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export interface VisibilityOptions { env?: NodeJS.ProcessEnv; gh?: (args: string[]) => { ok: boolean; out: string }; now?: number }

/** Destination visibility: cache (public 24 h, private 1 h), else `gh repo view` (5 s); unknown on any failure or a non-GitHub remote. */
export function resolveVisibility(url: string | null, o: VisibilityOptions = {}): { visibility: Visibility; source: string } {
  const slug = githubSlug(url);
  if (!slug) return { visibility: 'unknown', source: 'not a GitHub remote' };
  const now = o.now ?? Date.now();
  const file = path.join(resolveStateRoot(o.env ?? process.env), 'sealed-visibility.json');
  let cache: Record<string, { visibility: Visibility; checked_at: number }> = {};
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')).entries ?? {}; } catch { cache = {}; }
  const hit = cache[slug];
  if (hit && ((hit.visibility === 'public' && now - hit.checked_at < PUBLIC_TTL_MS) || (hit.visibility === 'private' && now - hit.checked_at < PRIVATE_TTL_MS))) return { visibility: hit.visibility, source: `cache ${new Date(hit.checked_at).toISOString()}` };
  const gh = o.gh ?? ((args: string[]) => { const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 5_000, env: o.env ?? process.env }); return { ok: r.status === 0, out: r.stdout ?? '' }; });
  const r = gh(['repo', 'view', slug, '--json', 'visibility']);
  let v: string | undefined;
  try { v = r.ok ? String(JSON.parse(r.out).visibility ?? '').toLowerCase() : undefined; } catch { v = undefined; }
  if (v !== 'public' && v !== 'private' && v !== 'internal') return { visibility: 'unknown', source: `gh repo view ${slug} failed (a new or unreadable repository counts as public)` };
  const visibility: Visibility = v === 'public' ? 'public' : 'private';
  cache[slug] = { visibility, checked_at: now };
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ entries: cache }, null, 2) + '\n'); } catch { /* an unwritable cache only costs a lookup */ }
  return { visibility, source: `gh repo view ${slug}` };
}

export interface SealedReport {
  status: 'no-policy' | 'clear' | 'refused' | 'warned' | 'error';
  policyLabels: string[]; commits: number; findings: SealedFinding[]; exempt: ExemptFinding[]; waived: Array<SealedFinding & { reason: string }>;
  visibility: Visibility; visibilitySource: string; target: string; error?: string;
}

export interface EvaluateOptions {
  repoRoot: string; targets: Array<{ commits: string[]; pushedSha: string }>; baseRef: string | null; baseLabel?: string; remoteUrl: string | null; target: string;
  env?: NodeJS.ProcessEnv; gh?: VisibilityOptions['gh'];
}

/** A report for a failure before any policy is read (an unlisted range, an unreadable push); renders as a fail-closed refusal. */
export function sealedErrorReport(error: string, target: string): SealedReport {
  return { status: 'error', error, policyLabels: [], commits: 0, findings: [], exempt: [], waived: [], visibility: 'unknown', visibilitySource: '', target };
}

/** The whole guard for one push (or range): policies, commits, findings, waivers, visibility, verdict. */
export function evaluateSealed(o: EvaluateOptions): SealedReport {
  const blank = { ...sealedErrorReport('', o.target), error: undefined };
  const base = o.baseRef ? sealedPolicyAt(o.repoRoot, o.baseRef, o.baseLabel ?? o.baseRef) : { policy: null, label: '(no destination base branch)' };
  if ('error' in base) return { ...blank, status: 'error', error: `the sealed policy on ${base.label} is unreadable: ${base.error}` };
  let policy: SealedPolicy | null = base.policy;
  const labels = base.policy ? [base.label] : [];
  for (const t of o.targets) {
    const pushed = sealedPolicyAt(o.repoRoot, t.pushedSha, `commit ${t.pushedSha.slice(0, 12)}`);
    if ('error' in pushed) return { ...blank, status: 'error', error: `the sealed policy in ${pushed.label} is unreadable: ${pushed.error}` };
    if (pushed.policy) labels.push(pushed.label);
    policy = unionPolicies(policy, pushed.policy);
  }
  if (!policy) return { ...blank, status: 'no-policy' };
  const commits = [...new Set(o.targets.flatMap(t => t.commits))];
  let found: SealedFinding[];
  try { found = scanCommits(o.repoRoot, commits, policy); }
  catch (e: any) { return { ...blank, policyLabels: labels, commits: commits.length, status: 'error', error: `could not read the published commits: ${e.message}` }; }
  const exception = globMatcher(policy.allow_paths, false);
  const exempt: ExemptFinding[] = [];
  found = found.filter(f => {
    const glob = f.rule === 'sealed.path' || f.rule === 'sealed.transcript' ? exception(f.file) : null;
    if (glob) exempt.push({ ...f, glob });
    return !glob;
  });
  const allow = allowEntriesAt(o.repoRoot, o.baseRef);
  const waived: SealedReport['waived'] = [];
  const findings = found.filter(f => {
    const entry = allow.find(a => a.rule === f.rule && a.path === f.file && f.commit.startsWith(a.sha));
    if (entry) waived.push({ ...f, reason: entry.reason });
    return !entry;
  });
  const vis = policy.visibility ? { visibility: policy.visibility as Visibility, source: `${VISIBILITY_OVERRIDE_KEY} override` } : resolveVisibility(o.remoteUrl, { env: o.env, gh: o.gh });
  const status = findings.length === 0 ? 'clear' : vis.visibility === 'private' ? 'warned' : 'refused';
  return { status, policyLabels: labels, commits: commits.length, findings, exempt, waived, visibility: vis.visibility, visibilitySource: vis.source, target: o.target };
}

const where = (f: SealedFinding) => `${f.file || '(unknown file)'}${f.line ? `:${f.line}` : ''}`;

/** stderr text for a report: findings one per line (`<rule>  <file[:line]>  commit <sha12>`), never the matched text. */
export function renderSealed(r: SealedReport, context: string): string {
  const lines: string[] = [];
  for (const e of r.exempt) lines.push(`${context}: exempt ${e.rule}  ${where(e)}  commit ${e.commit.slice(0, 12)} (sealed.allow_paths ${e.glob})`);
  for (const w of r.waived) lines.push(`${context}: waived ${w.rule}  ${where(w)}  commit ${w.commit.slice(0, 12)} (${SEALED_ALLOW_PATH}: ${w.reason})`);
  const vis = `visibility: ${r.visibility}${r.visibility === 'unknown' ? ', counted public' : ''}; ${r.visibilitySource}`;
  const body = r.findings.map(f => `  ${f.rule}  ${where(f)}  commit ${f.commit.slice(0, 12)}`);
  if (r.status === 'error') {
    lines.push(`\n⛔ ${context} BLOCKED the publication of ${r.target} — ${r.error}.`);
    lines.push(`Fix the sealed policy (gstack-pregate validate), then retry; an unreadable policy never passes (SEALED_OUTPUT_REFUSED)`);
  } else if (r.status === 'refused') {
    lines.push(`\n⛔ ${context} BLOCKED the publication of ${r.target} (${vis}) — sealed or eval output in ${r.commits} published commit(s):`, ...body);
    lines.push(`Remove it from every published commit before this branch reaches a public repository, exempt a publishable path with a sealed.allow_paths glob in the base branch's ${SEALED_CONFIG_PATH}, or waive one reviewed finding with a \`rule<TAB>path<TAB>sha<TAB>reason\` line in the base branch's ${SEALED_ALLOW_PATH}. A private destination: set ${VISIBILITY_OVERRIDE_KEY} "private" in the base branch's ${SEALED_CONFIG_PATH} (SEALED_OUTPUT_REFUSED)`);
  } else if (r.status === 'warned') {
    lines.push(`${context}: warning — sealed or eval output in a push to a private destination (${vis}); it would be refused for a public one:`, ...body);
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}
