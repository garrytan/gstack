/**
 * repo-state-clean — gstack-clean's plan and apply (#2627; plan GSTA-226 D8,
 * D9). Reclaims a fixed allowlist of byproducts in one repository's
 * `<git toplevel>/.gstack`, and nothing else:
 *
 *   tmp/codex-*            top-level regular files older than 7 days
 *   browse-*.log           over 1 MB, cut in place to the last 256 KB from a
 *                          line start (same inode, so O_APPEND writers go on)
 *   browse-audit.jsonl     only with --audit-days N: entries older than N days
 *
 * browse.json, session-state.json, chromium-profile/, browser-skills/,
 * browse-states/ and every other tmp/ entry (restamp journal, gate-ahead,
 * pregate.json, ship receipt, autoplan/, ship-queue/, eval-bisect/) are never
 * touched; test/gstack-clean-producers.test.ts classifies every tmp producer.
 * Dry run unless --apply. Each change re-checks the file and its group's
 * liveness first (live browse daemon, running codex, a write in the last
 * hour); an unknown answer skips the group with its reason.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveStateRoot } from './state-root';
import { resultLine } from './result-codes';

export const CLEAN_SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
export const SCRATCH_PREFIX = 'codex-';
export const SCRATCH_MIN_AGE_MS = 7 * DAY_MS;
export const RECENT_MS = 60 * 60 * 1000;
const LIVENESS_RECHECK_MS = 2000;
export const LOG_CUT_OVER_BYTES = 1024 * 1024;
export const LOG_KEEP_BYTES = 256 * 1024;
export const BROWSE_LOGS = ['browse-console.log', 'browse-network.log', 'browse-dialog.log', 'browse-daemon.log', 'browse-startup-error.log'] as const;
export const AUDIT_LOG = 'browse-audit.jsonl';
export const USAGE = 'usage: gstack-clean [--apply] [--audit-days N] [--json]';

export const HELP = `gstack-clean — reclaim throwaway files in this repository's .gstack folder

${USAGE}

Reports what it would do and changes nothing unless you pass --apply.
Target: <git toplevel>/.gstack of the current directory. Refuses (exit 3)
outside git, when .gstack is a symlink, when BROWSE_STATE_FILE names another
folder, and when the folder is, holds or sits inside the gstack state root.

What it cleans (fixed thresholds):
  tmp/codex-*           codex scratch files older than 7 days: removed
  browse-console.log, browse-network.log, browse-dialog.log,
  browse-daemon.log, browse-startup-error.log
                        over 1 MB: cut in place to the last 256 KB,
                        starting after a line break
  browse-audit.jsonl    only with --audit-days N: entries older than N days
                        removed; lines without a readable ts are kept

Everything else (browse.json, session-state.json, chromium-profile/,
browser-skills/, browse-states/, and every other tmp/ entry) is never touched.
Files changed in the last hour are skipped, browse files are skipped while the
browse daemon runs, tmp/ is skipped while codex runs, and a group is skipped
when that cannot be told.

Options:
  --apply           make the changes
  --audit-days N    also trim browse-audit.jsonl to the last N days (N >= 1)
  --json            print one versioned JSON object instead of text

Exit codes: 0 done or nothing to do, 1 an action failed (rerunning is safe),
2 usage, 3 target refused.
`;

type Group = 'tmp' | 'browse';
type Kind = 'remove' | 'cut' | 'rotate';
export interface CleanOptions { apply: boolean; json: boolean; auditDays: number | null }
interface Candidate { file: string; group: Group; kind: Kind }
interface Action extends Candidate { bytes: number; reason: string; keep?: Buffer }
interface Skip { file: string; group: Group; reason: string }
interface Done { action: Action; errno?: string }
export interface CleanTarget { target: string; chosenBy: string }
interface Io { out: (line: string) => void; err: (line: string) => void }

class Refused extends Error {}
class UsageError extends Error {}

export function parseCleanArgs(argv: string[]): CleanOptions | 'help' {
  const opts: CleanOptions = { apply: false, json: false, auditDays: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--apply') { opts.apply = true; continue; }
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--audit-days' || arg.startsWith('--audit-days=')) {
      const value = arg === '--audit-days' ? argv[++i] : arg.slice('--audit-days='.length);
      if (value === undefined || !/^[1-9]\d{0,4}$/.test(value)) throw new UsageError(`--audit-days needs a whole number of days from 1 to 99999; got ${JSON.stringify(value ?? '')}`);
      opts.auditDays = Number(value);
      continue;
    }
    throw new UsageError(`unknown flag ${JSON.stringify(arg)}`);
  }
  return opts;
}

/** realpath when the path exists, else its nearest existing parent's realpath plus the rest. */
function canonical(p: string): string {
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch { /* missing: resolve the parent */ }
  const parent = path.dirname(abs);
  return parent === abs ? abs : path.join(canonical(parent), path.basename(abs));
}

const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** The verified target, or the missing path when .gstack does not exist. Throws Refused. */
export function resolveCleanTarget(env: NodeJS.ProcessEnv, cwd: string): CleanTarget | { missing: string } {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true });
  const top = git.status === 0 ? git.stdout.trim() : '';
  if (!top) throw new Refused(`${cwd} is not inside a git work tree`);
  const toplevel = fs.realpathSync(top);
  const candidate = path.join(toplevel, '.gstack');
  if (env.BROWSE_STATE_FILE && canonical(path.resolve(cwd, env.BROWSE_STATE_FILE)) !== canonical(path.join(candidate, 'browse.json'))) {
    throw new Refused(`BROWSE_STATE_FILE is ${env.BROWSE_STATE_FILE}, not ${path.join(candidate, 'browse.json')}`);
  }
  let st: fs.Stats;
  try { st = fs.lstatSync(candidate); } catch (e: any) {
    if (e?.code === 'ENOENT') return { missing: candidate };
    throw e;
  }
  if (st.isSymbolicLink()) throw new Refused(`${candidate} is a symlink`);
  if (!st.isDirectory()) throw new Refused(`${candidate} is not a directory`);
  const target = fs.realpathSync(candidate);
  const stateRoot = canonical(path.resolve(cwd, resolveStateRoot(env)));
  if (within(target, stateRoot) || within(stateRoot, target)) {
    throw new Refused(`${target} is, holds or sits inside the gstack state root ${stateRoot}`);
  }
  const from = canonical(cwd) === toplevel ? '' : `, found from ${cwd}`;
  return { target, chosenBy: `the .gstack folder at the git toplevel ${toplevel}${from}` };
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code !== 'ESRCH'; }
}

/** Why browse files must wait, or null when no browse daemon can be using them. */
function browseBusy(target: string): string | null {
  if (process.platform === 'win32') return 'cannot tell whether the browse daemon is running on Windows';
  for (const name of ['browse.json', 'browse.json.lock']) {
    let text: string;
    try { text = fs.readFileSync(path.join(target, name), 'utf8'); } catch (e: any) {
      if (e?.code === 'ENOENT') continue;
      return `cannot read ${name} (${e?.code ?? 'error'}) to tell whether the browse daemon is running`;
    }
    let pid: unknown;
    try { pid = name === 'browse.json' ? JSON.parse(text)?.pid : Number(text.trim()); } catch { pid = undefined; }
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return `${name} names no pid, so the browse daemon may be running`;
    if (pidAlive(pid)) return `the browse daemon (pid ${pid}, ${name}) is running`;
  }
  return null;
}

/** Why tmp/ must wait, or null when no codex process runs. */
function codexBusy(): string | null {
  if (process.platform === 'win32') return 'cannot tell whether codex is running on Windows';
  const ps = spawnSync('ps', ['-A', '-o', 'args='], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  if (ps.error || ps.status !== 0) return 'cannot list processes to tell whether codex is running';
  for (const line of ps.stdout.split('\n')) {
    const words = line.trim().split(/\s+/).slice(0, 2);
    if (words.some(w => /^codex(?:\.js|-[^.]*)?$/.test(path.basename(w)))) return `codex is running (${line.trim().slice(0, 80)})`;
  }
  return null;
}

/** Audit lines to keep (newer than the cutoff, or without a readable ts), or why the file is malformed. */
function auditKeep(buf: Buffer, cutoffMs: number): Buffer | string {
  const kept: string[] = [];
  for (const [i, line] of buf.toString('utf8').split(/(?<=\n)/).entries()) {
    const body = line.replace(/\r?\n$/, '');
    if (body.trim() === '') { kept.push(line); continue; }
    let entry: unknown;
    try { entry = JSON.parse(body); } catch { return `line ${i + 1} is not JSON, so the file was left as it is`; }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return `line ${i + 1} is not a JSON object, so the file was left as it is`;
    const ts = Date.parse(String((entry as { ts?: unknown }).ts ?? ''));
    if (Number.isNaN(ts) || ts >= cutoffMs) kept.push(line);
  }
  return Buffer.from(kept.join(''), 'utf8');
}

function readTail(file: string, size: number): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const length = Math.min(size, LOG_KEEP_BYTES);
    const buf = Buffer.alloc(length);
    return buf.subarray(0, fs.readSync(fd, buf, 0, length, size - length));
  } finally { fs.closeSync(fd); }
}

/**
 * One file's action, a skip, or null when the file is not a target. `busy` is
 * the group's liveness answer; applyClean asks it again right before a change.
 */
function evaluate(c: Candidate, dir: string, busy: string | null, opts: CleanOptions, now: number): Action | Skip | null {
  let st: fs.Stats;
  try { st = fs.lstatSync(c.file); } catch (e: any) {
    return e?.code === 'ENOENT' ? null : { ...c, reason: `cannot stat (${e?.code ?? 'error'})` };
  }
  if (st.isSymbolicLink()) return { ...c, reason: 'is a symlink; left alone' };
  if (!st.isFile()) return c.kind === 'remove' ? { ...c, reason: 'is not a regular file; left alone' } : null;
  let real: string;
  try { real = fs.realpathSync(c.file); } catch (e: any) {
    return e?.code === 'ENOENT' ? null : { ...c, reason: `cannot resolve (${e?.code ?? 'error'})` };
  }
  if (path.dirname(real) !== dir) return { ...c, reason: 'resolves outside the folder being cleaned; left alone' };
  if (c.kind === 'remove' && now - st.mtimeMs < SCRATCH_MIN_AGE_MS) return null;
  if (c.kind === 'cut' && st.size <= LOG_CUT_OVER_BYTES) return null;
  if (now - st.mtimeMs < RECENT_MS) return { ...c, reason: 'modified within the last hour' };
  if (busy) return { ...c, reason: busy };
  if (c.kind === 'remove') return { ...c, bytes: st.size, reason: 'codex scratch older than 7 days' };
  if (st.nlink !== 1) return { ...c, reason: `has ${st.nlink} hard links, so cutting it would change a file outside this folder; left alone` };
  let content: Buffer;
  try { content = c.kind === 'cut' ? readTail(c.file, st.size) : fs.readFileSync(c.file); } catch (e: any) {
    return { ...c, reason: `cannot read (${e?.code ?? 'error'}); left alone` };
  }
  if (c.kind === 'cut') {
    const tail = content;
    const at = tail.indexOf(0x0a);
    if (at < 0) return { ...c, reason: 'no line break in its last 256 KB; left alone' };
    const keep = tail.subarray(at + 1);
    return { ...c, keep, bytes: st.size - keep.length, reason: 'over 1 MB; keeps the last 256 KB from a line start' };
  }
  const keep = auditKeep(content, now - opts.auditDays! * DAY_MS);
  if (typeof keep === 'string') return { ...c, reason: keep };
  if (keep.length === st.size) return null;
  return { ...c, keep, bytes: st.size - keep.length, reason: `audit entries older than ${opts.auditDays} days` };
}

function candidates(target: string, opts: CleanOptions): { list: Candidate[]; skips: Skip[] } {
  const list: Candidate[] = [];
  const skips: Skip[] = [];
  const tmp = path.join(target, 'tmp');
  let tmpStat: fs.Stats | null = null;
  try { tmpStat = fs.lstatSync(tmp); } catch (e: any) {
    if (e?.code !== 'ENOENT') skips.push({ file: tmp, group: 'tmp', reason: `cannot stat (${e?.code ?? 'error'}); the tmp group is skipped` });
  }
  if (tmpStat?.isSymbolicLink()) skips.push({ file: tmp, group: 'tmp', reason: 'tmp/ is a symlink; the tmp group is refused' });
  else if (tmpStat && !tmpStat.isDirectory()) skips.push({ file: tmp, group: 'tmp', reason: 'tmp is not a directory; the tmp group is skipped' });
  else if (tmpStat) {
    let names: string[] = [];
    try { names = fs.readdirSync(tmp).sort(); } catch (e: any) {
      skips.push({ file: tmp, group: 'tmp', reason: `cannot list (${e?.code ?? 'error'}); the tmp group is skipped` });
    }
    for (const name of names) if (name.startsWith(SCRATCH_PREFIX)) list.push({ file: path.join(tmp, name), group: 'tmp', kind: 'remove' });
  }
  for (const name of BROWSE_LOGS) list.push({ file: path.join(target, name), group: 'browse', kind: 'cut' });
  if (opts.auditDays !== null) list.push({ file: path.join(target, AUDIT_LOG), group: 'browse', kind: 'rotate' });
  return { list, skips };
}

const dirOf = (c: Candidate, target: string) => (c.group === 'tmp' ? path.join(target, 'tmp') : target);
const busyFor = (group: Group, target: string) => (group === 'tmp' ? codexBusy() : browseBusy(target));

export function planClean(target: string, opts: CleanOptions, now = Date.now()): { actions: Action[]; skips: Skip[] } {
  const { list, skips } = candidates(target, opts);
  const busy: Record<Group, string | null> = {
    tmp: list.some(c => c.group === 'tmp') ? busyFor('tmp', target) : null,
    browse: busyFor('browse', target),
  };
  const actions: Action[] = [];
  for (const c of list) {
    const result = evaluate(c, dirOf(c, target), busy[c.group], opts, now);
    if (result && 'bytes' in result) actions.push(result);
    else if (result) skips.push(result);
  }
  return { actions, skips };
}

function rewriteInPlace(file: string, keep: Buffer): void {
  const before = fs.lstatSync(file);
  const fd = fs.openSync(file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (st.ino !== before.ino || st.dev !== before.dev || st.nlink !== 1) throw Object.assign(new Error('the file changed before it could be cut'), { code: 'ECHANGED' });
    fs.writeSync(fd, keep, 0, keep.length, 0);
    fs.ftruncateSync(fd, keep.length);
  } finally { fs.closeSync(fd); }
}

/** Re-checks each planned action against its file and its group's liveness right before the change. */
export function applyClean(target: string, planned: Action[], opts: CleanOptions): { done: Done[]; skips: Skip[] } {
  const done: Done[] = [];
  const skips: Skip[] = [];
  const asked: Partial<Record<Group, { at: number; busy: string | null }>> = {};
  const busyNow = (group: Group): string | null => {
    const last = asked[group];
    if (last && Date.now() - last.at < LIVENESS_RECHECK_MS) return last.busy;
    const busy = busyFor(group, target);
    asked[group] = { at: Date.now(), busy };
    return busy;
  };
  for (const p of planned) {
    const fresh = evaluate({ file: p.file, group: p.group, kind: p.kind }, dirOf(p, target), busyNow(p.group), opts, Date.now());
    if (!fresh) continue;
    if (!('bytes' in fresh)) { skips.push(fresh); continue; }
    try {
      if (fresh.kind === 'remove') fs.unlinkSync(fresh.file);
      else rewriteInPlace(fresh.file, fresh.keep!);
      done.push({ action: fresh });
    } catch (e: any) {
      done.push({ action: fresh, errno: e?.code ?? 'UNKNOWN' });
    }
  }
  return { done, skips };
}

const VERB: Record<Kind, [string, string]> = { remove: ['would remove', 'removed'], cut: ['would cut', 'cut'], rotate: ['would trim', 'trimmed'] };

function report(io: Io, opts: CleanOptions, t: CleanTarget, rows: Done[], skips: Skip[]): number {
  const rel = (file: string) => path.relative(t.target, file) || '.';
  const failed = rows.filter(r => r.errno);
  const ok = rows.filter(r => !r.errno);
  const bytes = ok.reduce((n, r) => n + r.action.bytes, 0);
  const exit = failed.length ? 1 : 0;
  const partial = resultLine('gstack-clean', 'GSTACK_CLEAN_PARTIAL', `${failed.length} of ${rows.length} actions failed`);
  if (opts.json) {
    io.out(JSON.stringify({
      schema_version: CLEAN_SCHEMA_VERSION, tool: 'gstack-clean', mode: opts.apply ? 'apply' : 'dry-run',
      status: failed.length ? 'partial' : rows.length === 0 ? 'nothing_to_do' : opts.apply ? 'done' : 'planned',
      target: t.target, chosen_by: t.chosenBy, audit_days: opts.auditDays,
      actions: rows.map(({ action: a, errno }) => ({
        path: a.file, rel: rel(a.file), group: a.group, action: a.kind, bytes: a.bytes, reason: a.reason,
        status: errno ? 'failed' : opts.apply ? 'done' : 'planned', ...(errno ? { errno } : {}),
      })),
      skips: skips.map(s => ({ path: s.file, rel: rel(s.file), group: s.group, reason: s.reason })),
      total: { actions: ok.length, bytes, failed: failed.length, skipped: skips.length },
      error: failed.length ? { code: 'GSTACK_CLEAN_PARTIAL', message: partial } : null,
      exit_code: exit,
    }, null, 2));
    if (failed.length) io.err(partial);
    return exit;
  }
  io.out(`gstack-clean: target ${t.target} (${t.chosenBy})`);
  for (const { action: a, errno } of rows) {
    if (errno) { io.out(`FAILED ${a.file} ${errno}`); continue; }
    const size = a.kind === 'remove' ? `${a.bytes} bytes` : `${opts.apply ? 'freed' : 'freeing'} ${a.bytes} bytes`;
    io.out(`${VERB[a.kind][opts.apply ? 1 : 0].padEnd(12)} ${rel(a.file)} (${size}): ${a.reason}`);
  }
  for (const s of skips) io.out(`${'skip'.padEnd(12)} ${rel(s.file)}: ${s.reason}`);
  const failNote = failed.length ? `; ${failed.length} failed` : '';
  io.out(`total: ${ok.length} action${ok.length === 1 ? '' : 's'} ${opts.apply ? 'freed' : 'would free'} ${bytes} bytes${failNote}; ${skips.length} skipped`);
  if (failed.length) io.err(partial);
  else if (!opts.apply) io.out(rows.length ? `nothing changed; to do this: gstack-clean --apply${opts.auditDays === null ? '' : ` --audit-days ${opts.auditDays}`}` : 'nothing changed; nothing to clean');
  return exit;
}

function run(argv: string[], env: NodeJS.ProcessEnv, cwd: string, io: Io): number {
  let parsed: CleanOptions | 'help';
  try { parsed = parseCleanArgs(argv); } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.err(resultLine('gstack-clean', 'GSTACK_CLEAN_USAGE', e.message));
    io.err(USAGE);
    return 2;
  }
  if (parsed === 'help') { io.out(HELP.trimEnd()); return 0; }
  const opts = parsed;
  let resolved: CleanTarget | { missing: string };
  try { resolved = resolveCleanTarget(env, cwd); } catch (e) {
    if (!(e instanceof Refused)) throw e;
    const line = resultLine('gstack-clean', 'GSTACK_CLEAN_TARGET_REFUSED', e.message);
    io.err(line);
    if (opts.json) io.out(JSON.stringify({ schema_version: CLEAN_SCHEMA_VERSION, tool: 'gstack-clean', status: 'refused', error: { code: 'GSTACK_CLEAN_TARGET_REFUSED', message: line }, exit_code: 3 }, null, 2));
    return 3;
  }
  if ('missing' in resolved) {
    if (opts.json) io.out(JSON.stringify({ schema_version: CLEAN_SCHEMA_VERSION, tool: 'gstack-clean', mode: opts.apply ? 'apply' : 'dry-run', status: 'nothing_to_do', target: resolved.missing, actions: [], skips: [], total: { actions: 0, bytes: 0, failed: 0, skipped: 0 }, error: null, exit_code: 0 }, null, 2));
    else io.out(`nothing to clean: ${resolved.missing} does not exist`);
    return 0;
  }
  const plan = planClean(resolved.target, opts);
  if (!opts.apply) return report(io, opts, resolved, plan.actions.map(action => ({ action })), plan.skips);
  const applied = applyClean(resolved.target, plan.actions, opts);
  return report(io, opts, resolved, applied.done, [...plan.skips, ...applied.skips]);
}

/** The bin's entry. Never throws: an unexpected error prints one GSTACK_CLEAN_INTERNAL line and exits 1. */
export function main(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): number {
  const io: Io = { out: line => process.stdout.write(`${line}\n`), err: line => process.stderr.write(`${line}\n`) };
  try {
    return run(argv, env, cwd, io);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    io.err(resultLine('gstack-clean', 'GSTACK_CLEAN_INTERNAL', `${err.name}: ${err.message}`.slice(0, 300)));
    return 1;
  }
}
