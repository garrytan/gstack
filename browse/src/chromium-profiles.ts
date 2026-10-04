/**
 * Per-project headed Chromium profiles (D5, #2492).
 *
 * The headed profile used to be machine-wide (<gstack home>/chromium-profile),
 * so starting headed browse in one project SIGKILLed another project's live
 * headed Chromium. Each project now gets <project>/.gstack/chromium-profile
 * (config.resolveChromiumProfile). This module owns the profile lifecycle:
 * who holds a profile's SingletonLock, first-use seeding from the old
 * machine-wide profile, and `browse profiles list|prune`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveGstackHome } from './config';
import { isProcessAlive } from './error-handling';
import { readPidCmdline } from './xvfb';
import { atomicWriteSync } from '../../lib/fs-atomic';

export type ProfileOwner =
  | { state: 'free' }
  | { state: 'orphan'; pid: number }
  | { state: 'live'; pid: number; detail: string };

/** Processes an orphan is reparented to: init, launchd, and common subreapers. */
const REAPERS = new Set(['init', 'systemd', 'launchd', 'tini', 'dumb-init', 'docker-init']);

export function legacyProfileDir(): string {
  return path.join(resolveGstackHome(), 'chromium-profile');
}

function registryPath(): string {
  return path.join(resolveGstackHome(), 'browse-profiles.json');
}

function readParentPid(pid: number): number {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    try {
      const r = Bun.spawnSync(['ps', '-o', 'ppid=', '-p', String(pid)], { stdout: 'pipe', stderr: 'pipe', timeout: 2000, windowsHide: true });
      return r.exitCode === 0 ? Number(r.stdout.toString().trim()) : 0;
    } catch {
      return 0;
    }
  }
}

/**
 * Who holds this profile. The SingletonLock symlink target is "host-PID".
 * Only a process on this host that is a Chromium using this exact profile
 * counts as the holder; a dead or recycled PID means the lock is stale. An
 * orphan (reparented to init or a subreaper after its daemon died) may be
 * reaped; anything else, including a lock from another host, is a live owner
 * that must never be killed.
 */
export function profileOwner(profileDir: string): ProfileOwner {
  let target: string;
  try {
    target = fs.readlinkSync(path.join(profileDir, 'SingletonLock'));
  } catch {
    return { state: 'free' };
  }
  const dash = target.lastIndexOf('-');
  const host = target.slice(0, dash);
  const pid = Number(target.slice(dash + 1));
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'free' };
  if (host !== os.hostname()) {
    return { state: 'live', pid, detail: `locked by PID ${pid} on another host (${host})` };
  }
  if (!isProcessAlive(pid)) return { state: 'free' };
  const cmd = readPidCmdline(pid);
  const dirs = new Set([profileDir]);
  try { dirs.add(fs.realpathSync(profileDir)); } catch {}
  const usesProfile = [...dirs].some(d => cmd.includes(`--user-data-dir=${d}`));
  if (!/chrom/i.test(cmd) || !usesProfile) return { state: 'free' };
  const ppid = readParentPid(pid);
  const parent = ppid > 1 ? path.basename(readPidCmdline(ppid).split(' ')[0] || '') : '';
  if (ppid <= 1 || !isProcessAlive(ppid) || REAPERS.has(parent)) return { state: 'orphan', pid };
  return { state: 'live', pid, detail: `in use by Chromium PID ${pid} (started by PID ${ppid}: ${parent || 'unknown'})` };
}

function readRegistry(): string[] {
  try {
    const list = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

function writeRegistry(list: string[]): void {
  fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
  atomicWriteSync(registryPath(), JSON.stringify([...new Set(list)].sort(), null, 2) + '\n');
}

/**
 * Create a project's headed profile on first use. Seeds it from the old
 * machine-wide profile only when nothing holds that profile, copying into a
 * temporary 0700 directory without Singleton* files and renaming it into
 * place, so a concurrent first use or an interrupted copy never leaves a
 * half-written profile. Says what happened once, through `log`.
 */
export function ensureProjectProfile(profileDir: string, log: (msg: string) => void = console.log): void {
  if (fs.existsSync(profileDir)) return;
  // An explicit CHROMIUM_PROFILE belongs to its caller (gbrowser's per-workspace
  // gbd): never seed it from the shared profile or register it for pruning.
  const explicit = process.env.CHROMIUM_PROFILE;
  if (explicit && path.resolve(explicit) === path.resolve(profileDir)) return;
  const legacy = legacyProfileDir();
  if (path.resolve(profileDir) === path.resolve(legacy)) return;
  writeRegistry([...readRegistry(), path.resolve(profileDir)]);
  fs.mkdirSync(path.dirname(profileDir), { recursive: true });
  const fresh = (why: string) => {
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    if (why) log(why);
  };
  if (!fs.existsSync(legacy)) return fresh('');
  const before = profileOwner(legacy);
  if (before.state !== 'free') {
    return fresh(`[browse] Headed browse now keeps a profile per project (${profileDir}). The old shared profile (${legacy}) is ${'detail' in before ? before.detail : `held by orphaned PID ${before.pid}`}, so this project starts with a fresh profile. To import it later: close that browser, delete ${profileDir}, and start headed browse again.`);
  }
  const tmp = `${profileDir}.seed-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    fs.cpSync(legacy, tmp, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => !path.basename(src).startsWith('Singleton'),
    });
    fs.chmodSync(tmp, 0o700);
    if (profileOwner(legacy).state !== 'free') {
      fs.rmSync(tmp, { recursive: true, force: true });
      return fresh(`[browse] The old shared profile (${legacy}) came into use while it was being copied, so this project (${profileDir}) starts with a fresh profile.`);
    }
    fs.renameSync(tmp, profileDir);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (fs.existsSync(profileDir)) return;
    throw err;
  }
  log(`[browse] Headed browse now keeps a profile per project. Copied your logins and settings from ${legacy} to ${profileDir} (${formatBytes(dirBytes(profileDir))}). See \`browse profiles\` to list or prune profiles.`);
}

function dirBytes(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    }
  };
  try { walk(dir); } catch {}
  return total;
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function describeOwner(owner: ProfileOwner): string {
  if (owner.state === 'free') return 'idle';
  if (owner.state === 'orphan') return `held by orphaned PID ${owner.pid}`;
  return owner.detail;
}

/** `browse profiles [list]` and `browse profiles prune [--days N]`. Returns the exit code. */
export function runProfilesCommand(args: string[], out: (line: string) => void = console.log): number {
  const sub = args[0] ?? 'list';
  const known = readRegistry();
  const legacy = legacyProfileDir();
  if (sub === 'list') {
    const rows = [...(fs.existsSync(legacy) ? [legacy] : []), ...known];
    if (rows.length === 0) {
      out('No headed browser profiles yet. One is created per project on first `browse --headed` or `browse connect`.');
      return 0;
    }
    for (const dir of rows) {
      if (!fs.existsSync(dir)) { out(`${dir}  (missing: project moved or deleted; \`browse profiles prune\` forgets it)`); continue; }
      const age = Math.floor((Date.now() - fs.statSync(dir).mtimeMs) / 86_400_000);
      out(`${dir}  ${formatBytes(dirBytes(dir))}  last used ${age}d ago  ${describeOwner(profileOwner(dir))}${dir === legacy ? '  (old shared profile)' : ''}`);
    }
    return 0;
  }
  if (sub === 'prune') {
    const daysIdx = args.indexOf('--days');
    const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : 30;
    if (!Number.isFinite(days) || days < 0) {
      out('Usage: browse profiles prune [--days N]  (default 30)');
      return 2;
    }
    const keep: string[] = [];
    let freed = 0;
    for (const dir of known) {
      if (!fs.existsSync(dir)) { out(`forgot ${dir} (no longer exists)`); continue; }
      const idleDays = (Date.now() - fs.statSync(dir).mtimeMs) / 86_400_000;
      const owner = profileOwner(dir);
      if (idleDays < days || owner.state !== 'free') { keep.push(dir); continue; }
      const bytes = dirBytes(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      freed += bytes;
      out(`removed ${dir} (${formatBytes(bytes)}, idle ${Math.floor(idleDays)}d)`);
    }
    writeRegistry(keep);
    out(`Pruned profiles idle for ${days}+ days; freed ${formatBytes(freed)}. Profiles in use are never removed. The old shared profile (${legacy}) is left alone.`);
    return 0;
  }
  out('Usage: browse profiles [list] | browse profiles prune [--days N]');
  return 2;
}
