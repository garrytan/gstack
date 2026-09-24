#!/usr/bin/env bun
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalizeRemote, scanSerializedPage, transcriptIngestEnabled } from '../lib/gstack-memory-helpers';
import { repoPolicyTierBatch } from '../lib/gbrain-repo-policy-client';

const MAX_BYTES = 1024 * 1024;
const HELD = 4;
const PUSH_FAILED = 10;
const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' };

function hold(reason: string): never {
  throw Object.assign(new Error(reason), { name: 'PublicationHeld' });
}

function git(repo: string, args: string[], maxBuffer = 16 * MAX_BYTES): Buffer {
  const result = spawnSync('git', ['-C', repo, ...args], { env, timeout: 30_000, maxBuffer });
  if (result.status !== 0 || result.error) hold('Git snapshot unavailable; inspect local history before retrying');
  return result.stdout;
}

function text(repo: string, args: string[]): string {
  return git(repo, args).toString('utf8').trim();
}

function checkLock(repo: string, owner: string) {
  const dir = join(repo, '.brain-sync.lock.d');
  if (!/^\d+$/.test(owner) || !lstatSync(dir).isDirectory()
    || lstatSync(join(dir, 'pid')).isSymbolicLink()
    || readFileSync(join(dir, 'pid'), 'utf8').trim() !== owner) {
    hold('publication lock changed; retry through gstack-brain-sync');
  }
  process.kill(Number(owner), 0);
}

function head(repo: string) {
  const branch = text(repo, ['symbolic-ref', '-q', 'HEAD']);
  if (!branch.startsWith('refs/heads/')) hold('expected a local branch; restore it before retrying');
  return { branch, sha: text(repo, ['rev-parse', '--verify', 'HEAD^{commit}']) };
}

function checkHead(repo: string, sha: string, branch: string) {
  const current = head(repo);
  if (current.sha !== sha || current.branch !== branch) hold('branch changed after scanning; queue and history preserved');
}

type Entry = { mode: string; oid: string; path: string };

function entries(repo: string, tree: string): Entry[] {
  const raw = git(repo, ['ls-tree', '-r', '-z', tree, '--', 'transcripts']);
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  return decoded.split('\0').filter(Boolean).map(line => {
    const match = /^(\d+) (blob|tree|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
    if (!match) hold('transcript tree is malformed; inspect local history');
    return { mode: match[1], oid: match[3], path: match[4] };
  });
}

function scanner(repo: string) {
  const scanned = new Set<string>();
  const pages = new Map<string, { remote: string; start: string }>();
  let cachedBytes = 0;
  return {
    scan(entry: Entry) {
      if (!/^transcripts\/run-[^/\s]+\/(?:[^/\s]+\/)*[^/\s]+\.md$/.test(entry.path)
        || entry.path.includes('\\') || entry.path.split('/').some(part => part.startsWith('.'))
        || entry.mode !== '100644') {
        hold('unexpected transcript object; inspect its source mapping and file type');
      }
      const key = `${entry.path}\0${entry.oid}`;
      if (scanned.has(key)) return;
      cachedBytes += Buffer.byteLength(key) + 256;
      if (cachedBytes > 16 * MAX_BYTES) hold('transcript history exceeds the bounded scan budget; review locally');
      const size = Number(text(repo, ['cat-file', '-s', entry.oid]));
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES) hold('transcript exceeds the 1 MiB scan limit; split it before retrying');
      const bytes = git(repo, ['cat-file', 'blob', entry.oid], MAX_BYTES + 1);
      if (bytes.length !== size) hold('transcript object changed or is unreadable');
      const page = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(page)?.[1];
      if (!front) hold('page metadata missing; inspect its source mapping');
      const metadata = Bun.YAML.parse(front) as Record<string, unknown> | null;
      const field = (key: string) => {
        const values = [...front.matchAll(new RegExp(`^${key}:[ \\t]*([^\\r\\n]*)$`, 'gm'))];
        if (values.length !== 1 || !metadata || metadata[key] !== values[0][1].trim()) hold('page metadata is ambiguous or unmapped');
        return values[0][1].trim();
      };
      const type = field('type');
      const prefix = entry.path.split('/')[2];
      if (type !== 'transcript') {
        if (!['eureka', 'learning', 'timeline', 'ceo-plan', 'design-doc', 'retro', 'builder-profile-entry'].includes(type)
          || prefix !== `${type}s`) hold('page type does not match its source mapping');
        scanned.add(key);
        return;
      }
      if (prefix !== 'transcripts') hold('transcript type does not match its source mapping');
      if (!transcriptIngestEnabled()) hold('transcript ingestion disabled; explicitly enroll before publication');
      const remote = field('git_remote');
      const start = field('start_time');
      if (!remote || /\s/.test(remote) || canonicalizeRemote(remote) !== remote
        || (remote !== '_unattributed' && !/^[^/]+\/[^/]+(?:\/[^/]+)+$/.test(remote))
        || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(start) || !Number.isFinite(Date.parse(start))) {
        hold('transcript source metadata is malformed; review locally');
      }
      let verdict: ReturnType<typeof scanSerializedPage>;
      try {
        verdict = pages.has(entry.oid) ? { ok: true } : scanSerializedPage(bytes);
      } catch {
        hold('transcript scanner unavailable; repair it before retrying');
      }
      if (!verdict || verdict.ok !== true) {
        const reason = verdict?.reason;
        if (typeof reason === 'string' && /\bHIGH\b/.test(reason)) hold('HIGH transcript finding; review locally before retrying');
        if (typeof reason === 'string' && /\bMEDIUM\b/.test(reason)) hold('MEDIUM transcript finding; review locally before retrying');
        hold(verdict?.systemic ? 'transcript scanner unavailable; repair it before retrying' : 'transcript scan held; review the local page before retrying');
      }
      scanned.add(key);
      pages.set(entry.oid, { remote, start });
    },
    consent() {
      if (!pages.size) return;
      if (!transcriptIngestEnabled()) hold('transcript consent changed; queue and history preserved');
      let enrollment: { remote: string | null; since: string | null } | undefined;
      try {
        const state = JSON.parse(readFileSync(join(repo, '.transcript-ingest-state.json'), 'utf8'));
        if (!state || state.schema_version !== 1 || !state.sessions || typeof state.sessions !== 'object' || Array.isArray(state.sessions)) hold('ingestion state is malformed; review locally');
        enrollment = state.enrollment;
        if (enrollment !== undefined && (!enrollment
          || (enrollment.remote !== null && (typeof enrollment.remote !== 'string' || !enrollment.remote))
          || (enrollment.since !== null && (typeof enrollment.since !== 'string' || !Number.isFinite(Date.parse(enrollment.since)))))) hold('enrollment is malformed; review locally');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const policies = repoPolicyTierBatch([...new Set([...pages.values()].map(page => page.remote))]);
      for (const page of pages.values()) {
        const policy = policies.get(page.remote);
        if (!policy || policy.error || policy.tier === 'deny' || policy.tier === 'read-only') hold('transcript remote policy holds publication; review local policy');
        if (enrollment && ((enrollment.remote !== null && enrollment.remote !== page.remote)
          || (enrollment.since !== null && Date.parse(page.start) < Date.parse(enrollment.since)))) hold('transcript falls outside current enrollment; review local scope');
      }
      if (!transcriptIngestEnabled()) hold('transcript consent changed; queue and history preserved');
    },
  };
}

function scanTree(repo: string, tree: string, baseline: Map<string, string>, scan: ReturnType<typeof scanner>) {
  for (const entry of entries(repo, tree)) {
    if (baseline.get(entry.path) !== `${entry.mode} ${entry.oid}`) scan.scan(entry);
  }
}

function baseline(repo: string, tree?: string): Map<string, string> {
  return new Map(tree ? entries(repo, tree).map(entry => [entry.path, `${entry.mode} ${entry.oid}`]) : []);
}

function outgoing(repo: string, sha: string, branch: string, scan: ReturnType<typeof scanner>) {
  if (text(repo, ['rev-parse', '--is-shallow-repository']) !== 'false') hold('shallow history cannot prove publication safety; fetch complete history first');
  const grafts = text(repo, ['rev-parse', '--git-path', 'info/grafts']);
  try {
    if (readFileSync(grafts.startsWith('/') ? grafts : join(repo, grafts), 'utf8').trim()) hold('grafted history cannot prove publication safety');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const ref = `refs/remotes/origin/${branch.slice('refs/heads/'.length)}`;
  const refs = text(repo, ['for-each-ref', '--format=%(objectname)', ref]).split('\n').filter(Boolean);
  if (refs.length > 1) hold('remote branch mapping is ambiguous');
  const base = refs[0];
  const published = baseline(repo, base);
  const commits = text(repo, ['rev-list', sha, ...(base ? ['--not', base] : [])]).split('\n').filter(Boolean);
  for (const commit of commits) scanTree(repo, commit, published, scan);
  return { base, ref };
}

function checkBase(repo: string, ref: string, base?: string) {
  if (text(repo, ['for-each-ref', '--format=%(objectname)', ref]) !== (base || '')) hold('remote tracking ref changed after scanning; retry');
}

function main(): number {
  const [action, repo, owner, ...expected] = process.argv.slice(2);
  if (action === 'enabled') return transcriptIngestEnabled() ? 0 : 1;
  if (!repo || !owner) hold('publication guard requires a locked artifact repository');
  checkLock(repo, owner);
  const current = head(repo);
  if (action === 'index') {
    const tree = text(repo, ['write-tree']);
    const scan = scanner(repo);
    scanTree(repo, tree, baseline(repo, current.sha), scan);
    const { base, ref } = outgoing(repo, current.sha, current.branch, scan);
    checkLock(repo, owner);
    checkHead(repo, current.sha, current.branch);
    checkBase(repo, ref, base);
    if (text(repo, ['write-tree']) !== tree) hold('index changed after scanning; queue preserved');
    scan.consent();
    console.log(`${current.sha} ${tree} ${current.branch}`);
    return 0;
  }
  if (action === 'committed') {
    const [expectedSha, expectedTree, expectedBranch] = expected;
    if (current.branch !== expectedBranch
      || text(repo, ['rev-parse', 'HEAD^{tree}']) !== expectedTree
      || text(repo, ['rev-list', '--parents', '-n', '1', current.sha]) !== `${current.sha} ${expectedSha}`
      || text(repo, ['write-tree']) !== expectedTree) hold('commit or index changed after scanning; queue and history preserved');
    console.log(current.sha);
    return 0;
  }
  if (action !== 'push') hold('unknown publication operation');
  const [expectedSha, expectedBranch] = expected;
  if (current.sha !== expectedSha || current.branch !== expectedBranch) hold('branch changed before publication; queue and history preserved');
  const scan = scanner(repo);
  const { base, ref } = outgoing(repo, current.sha, current.branch, scan);
  if (base) {
    const ancestry = spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', base, current.sha], { env, timeout: 30_000 });
    if (ancestry.status === 1) return PUSH_FAILED;
    if (ancestry.status !== 0) hold('outgoing ancestry unavailable; inspect local history');
  }
  checkLock(repo, owner);
  checkHead(repo, current.sha, current.branch);
  checkBase(repo, ref, base);
  scan.consent();
  checkHead(repo, current.sha, current.branch);
  const result = spawnSync('git', ['-c', 'http.lowSpeedLimit=1024', '-c', 'http.lowSpeedTime=30', '-C', repo,
    'push', '--no-follow-tags', '--no-mirror', '--recurse-submodules=no',
    `--force-with-lease=${current.branch}:${base || ''}`, 'origin', `${current.sha}:${current.branch}`],
  { env, encoding: 'utf8', timeout: 60_000, maxBuffer: MAX_BYTES });
  checkLock(repo, owner);
  checkHead(repo, current.sha, current.branch);
  if (result.status !== 0 || result.error) {
    const authFailure = (result.stderr || '').split(/\r?\n/).some(line =>
      /^(?:remote:\s*)?(?:(?:fatal|error):\s*)?(?:authentication failed\b|permission denied\b|permission to .+ denied to\b|write access to repository not granted\b|invalid username or (?:password|token)\b|could not read (?:username|password)\b|(?:HTTP(?:\/[\d.]+)?\s+)?(?:401 unauthorized|403 forbidden)\b)/i.test(line) ||
      /^[^\s@]+@[^\s:]+:\s*permission denied\b/i.test(line) ||
      /^(?:fatal|error|remote):[^\n]*The requested URL returned error:\s*(?:401|403)\s*$/i.test(line));
    console.error(authFailure ? 'push failed: auth' : 'push failed; local commit retained');
    return PUSH_FAILED;
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`BRAIN_SYNC: blocked: ${error instanceof Error && error.name === 'PublicationHeld' ? error.message : 'transcript publication check failed; inspect local state and scanner availability'}`);
    process.exitCode = HELD;
  }
}
