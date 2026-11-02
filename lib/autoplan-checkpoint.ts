/**
 * autoplan-checkpoint — an opt-in durable copy of a run directory (next-wave
 * B12). With GSTACK_AUTOPLAN_CHECKPOINT_DIR set, every mutating command that
 * leaves the run at rest (gate_pending, amend_pending, complete, reviewed, incomplete)
 * publishes one immutable generation under `<dir>/<run>/generations/<name>/`:
 * `checkpoint.json` (every file's sha256), the run files under `run/`, the
 * owner's plan file under `plan-input/` when it lives outside the run, and
 * `restore.md`. `current.json` then switches to it with one rename; the
 * previous generation stays until the switch commits, so an interrupted
 * publish leaves the last checkpoint current. A generation never replaces a
 * newer one (higher run revision). Publication and restore hold the
 * collection's `.lock`; restore also holds `<out>.lock`. Field list 2, W7:
 * a generation is also published after each bound voice and each phase
 * transition (so a restored run never redispatches a bound voice); on Capy
 * with no directory set the runner prints the export line naming the private
 * project-user Drive folder, and uses that folder only after `gstack-config
 * set autoplan_checkpoint drive`.
 *
 * Restore picks the named generation, or the newest generation that verifies
 * when `--from` names the collection (or a root holding one run). It refuses
 * overlapping source and target paths (symlink aliases included), any listed
 * file whose real path leaves the generation, and any hash mismatch; it
 * validates the staged run (gstack-artifact's validateRun) before publishing
 * it to `--out` with one rename, so a refusal leaves `--out` absent.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256File, validateRun } from './headless-artifacts';
import { FILES, RunError, journal, now, readState, type RunState } from './autoplan-state';
import { repoRoot } from './autoplan-plan-text';
import { readConfigKey } from './state-root';

const MANIFEST = 'checkpoint.json';
const CURRENT = 'current.json';
const GENERATIONS = 'generations';
const AT_REST = ['gate_pending', 'amend_pending', 'complete', 'reviewed', 'incomplete'];
const FOREIGN_LOCK_STALE_MS = 10 * 60_000;
interface CheckpointManifest {
  schema_version: 1; run: string; status: string; gate_rev: number; revision: number; at: string; host: string; gstack_version?: string;
  files: Record<string, string>;
  plan_input?: { original: string; file: string; sha256: string };
}
export interface Generation { dir: string; manifest?: CheckpointManifest; problem?: string }

const inside = (root: string, p: string) => { const rel = path.relative(root, p); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
const overlaps = (a: string, b: string) => a === b || inside(a, b) || inside(b, a);
/** The real path of `p`, resolving symlinks through its deepest existing ancestor. */
function canonical(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  while (!fs.existsSync(cur) && path.dirname(cur) !== cur) { rest.unshift(path.basename(cur)); cur = path.dirname(cur); }
  return path.join(fs.realpathSync(cur), ...rest);
}
function refuseOverlap(what: string, a: string, b: string): void {
  const ca = canonical(a), cb = canonical(b);
  if (overlaps(ca, cb)) throw new RunError('CHECKPOINT_OVERLAP', `${what}: ${a} (${ca}) and ${b} (${cb}) are the same directory or one contains the other`, 3);
}

function exclusive<T>(lock: string, fn: () => T): T {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const mine = JSON.stringify({ pid: process.pid, host: os.hostname(), at: now() });
  for (let i = 0; ; i++) {
    try { fs.writeFileSync(lock, mine, { flag: 'wx' }); break; } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      let owner: { pid?: number; host?: string; at?: string } = {};
      try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { /* being written */ }
      let alive = true;
      if (owner.host === os.hostname() && typeof owner.pid === 'number') { try { process.kill(owner.pid, 0); } catch (k: any) { alive = k.code === 'EPERM'; } }
      else if (owner.host && owner.at) alive = Date.now() - Date.parse(owner.at) < FOREIGN_LOCK_STALE_MS;
      if (alive || i > 3) throw new RunError('RUN_LOCKED', `${lock} is held by pid ${owner.pid ?? '?'} on ${owner.host ?? '?'} since ${owner.at ?? '?'}`, 3);
      fs.rmSync(lock, { force: true });
    }
  }
  try { return fn(); } finally { try { if (fs.readFileSync(lock, 'utf8') === mine) fs.unlinkSync(lock); } catch { /* gone */ } }
}

function runFiles(dir: string, rel = ''): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap(e => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return /^\.revise-v\d+$/.test(e.name) ? [] : runFiles(dir, r);
    return e.isFile() && r !== FILES.lock && !r.endsWith('.tmp') ? [r] : [];
  });
}
const copy = (from: string, to: string) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
const writeAtomic = (file: string, text: string) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); };

function restoreIndex(m: CheckpointManifest, collection: string): string {
  return [`# autoplan checkpoint: ${m.run}`, '',
    `Current generation written ${m.at} on ${m.host} at status=${m.status}, gate_rev=${m.gate_rev}, revision=${m.revision}; ${Object.keys(m.files).length} files, each listed with its sha256 in generations/<name>/checkpoint.json.`, '',
    'List the generations and their hash status, then restore the newest valid one on any machine (the target directory must not hold a run):', '',
    `    gstack-autoplan checkpoints --from ${collection}`,
    `    gstack-autoplan resume --out <new run dir> --from ${collection}`, '',
    'resume verifies every hash and the staged run, publishes the run directory, takes ownership and prints the next step.',
    ...(m.plan_input ? ['', `The owner's plan file was ${m.plan_input.original}; a copy is in plan-input/ and is restored into the run directory when the original is missing.`] : []), ''].join('\n');
}

/** The newest run revision any generation in the collection records (unreadable generations count as nothing). */
function newestRevision(collection: string): number {
  const dir = path.join(collection, GENERATIONS);
  if (!fs.existsSync(dir)) return -1;
  return Math.max(-1, ...fs.readdirSync(dir).map(g => { try { return Number(JSON.parse(fs.readFileSync(path.join(dir, g, MANIFEST), 'utf8')).revision); } catch { return -1; } }).filter(Number.isFinite));
}

/**
 * The private project-user Drive folder on a Capy machine (GSTACK_CAPY=1): `<drive>/autoplan-checkpoints` under the one
 * `~/.capy/drive/project-user-*` folder, or the one naming `repo` when there are several; undefined otherwise.
 */
export function capyDriveFolder(env: NodeJS.ProcessEnv = process.env, repo?: string): string | undefined {
  if (env.GSTACK_CAPY !== '1') return undefined;
  const drive = path.join(env.HOME || os.homedir(), '.capy', 'drive');
  let folders: string[];
  try { folders = fs.readdirSync(drive).filter(d => d.startsWith('project-user-') && fs.statSync(path.join(drive, d)).isDirectory()); } catch { return undefined; }
  if (folders.length > 1 && repo) folders = folders.filter(d => d.startsWith(`project-user-${repo}-`));
  return folders.length === 1 ? path.join(drive, folders[0]!, 'autoplan-checkpoints') : undefined;
}

/** Where checkpoints go: GSTACK_AUTOPLAN_CHECKPOINT_DIR, else the Capy Drive folder when `gstack-config set autoplan_checkpoint drive` opted in. */
export function checkpointRoot(env: NodeJS.ProcessEnv = process.env, repo?: string): string | undefined {
  if (env.GSTACK_AUTOPLAN_CHECKPOINT_DIR) return env.GSTACK_AUTOPLAN_CHECKPOINT_DIR;
  return readConfigKey('autoplan_checkpoint', env) === 'drive' ? capyDriveFolder(env, repo) : undefined;
}

/** On Capy with no checkpoint directory: the exact line that makes the run survive machine replacement. */
export function checkpointNotice(env: NodeJS.ProcessEnv, repo?: string): string | undefined {
  if (env.GSTACK_CAPY !== '1') return undefined;
  const dir = capyDriveFolder(env, repo);
  return `CHECKPOINT: unset; to survive machine replacement: export GSTACK_AUTOPLAN_CHECKPOINT_DIR=${dir ?? '<a private project-user Drive folder>'}${dir ? ' (or for every run: gstack-config set autoplan_checkpoint drive)' : ''}`;
}

/** A checkpoint beyond the at-rest ones: after a bound voice, after a phase transition, and the notice at the first next. */
export type CheckpointMoment = 'bound' | 'transition' | 'init';
const repoOf = (state: RunState) => { const input = state.plan_input ?? state.plan_source; const root = input ? repoRoot(path.dirname(input)) : undefined; return root ? path.basename(root) : undefined; };

/**
 * Publish a generation when a checkpoint directory is set (or Drive opted in) and the run is at rest, or at a
 * `moment` (a bound voice, a phase transition); returns the CHECKPOINT line, the unset notice on Capy, or nothing.
 */
export function checkpointRun(out: string, env: NodeJS.ProcessEnv = process.env, moment?: CheckpointMoment): string | undefined {
  if (!fs.existsSync(path.join(out, FILES.run))) return undefined;
  const state = readState(out);
  const atRest = AT_REST.includes(state.status);
  if (!atRest && !moment) return undefined;
  const root = checkpointRoot(env, repoOf(state));
  if (!root) return atRest || moment === 'init' ? checkpointNotice(env, repoOf(state)) : undefined;
  const collection = path.join(path.resolve(root), state.run);
  refuseOverlap('the checkpoint directory overlaps the run directory', collection, state.out);
  return exclusive(path.join(collection, '.lock'), () => {
    const newest = newestRevision(collection);
    if (newest > state.revision) return `CHECKPOINT: skipped ${collection}: it holds a newer checkpoint (revision ${newest} > ${state.revision}); nothing replaced`;
    const name = `g${String(state.revision).padStart(6, '0')}-${now().replace(/[-:.TZ]/g, '')}-${process.pid}`;
    const tmp = path.join(collection, `.tmp-${name}`);
    const files: Record<string, string> = {};
    for (const rel of runFiles(state.out)) { copy(path.join(state.out, rel), path.join(tmp, 'run', rel)); files[rel] = sha256File(path.join(tmp, 'run', rel)); }
    const input = state.plan_input && !inside(state.out, path.resolve(state.plan_input)) && fs.existsSync(state.plan_input) ? state.plan_input : undefined;
    const planFile = input ? `plan-input/${path.basename(input)}` : undefined;
    if (input) copy(input, path.join(tmp, planFile!));
    const m: CheckpointManifest = { schema_version: 1, run: state.run, status: state.status, gate_rev: state.gate_rev ?? 0, revision: state.revision, at: now(), host: os.hostname(),
      ...(state.gstack_version ? { gstack_version: state.gstack_version } : {}), files, ...(input ? { plan_input: { original: input, file: planFile!, sha256: sha256File(path.join(tmp, planFile!)) } } : {}) };
    fs.writeFileSync(path.join(tmp, 'restore.md'), restoreIndex(m, collection));
    fs.writeFileSync(path.join(tmp, MANIFEST), JSON.stringify(m, null, 2) + '\n');
    fs.mkdirSync(path.join(collection, GENERATIONS), { recursive: true });
    fs.renameSync(tmp, path.join(collection, GENERATIONS, name));
    if (env.GSTACK_AUTOPLAN_FAULT === 'checkpoint-before-pointer') throw new Error('fault injected: checkpoint interrupted before switching current.json (GSTACK_AUTOPLAN_FAULT, tests only)');
    let previous: string | undefined;
    try { previous = JSON.parse(fs.readFileSync(path.join(collection, CURRENT), 'utf8')).generation; } catch { /* first generation */ }
    writeAtomic(path.join(collection, CURRENT), JSON.stringify({ generation: name, run: m.run, status: m.status, gate_rev: m.gate_rev, revision: m.revision, at: m.at }, null, 2) + '\n');
    writeAtomic(path.join(collection, 'restore.md'), restoreIndex(m, collection));
    for (const g of fs.readdirSync(path.join(collection, GENERATIONS))) if (g !== name && g !== previous) fs.rmSync(path.join(collection, GENERATIONS, g), { recursive: true, force: true });
    for (const e of fs.readdirSync(collection)) if (e.startsWith('.tmp-')) fs.rmSync(path.join(collection, e), { recursive: true, force: true });
    return `CHECKPOINT: ${path.join(collection, GENERATIONS, name)} status=${m.status} gate_rev=${m.gate_rev} revision=${m.revision} files=${Object.keys(files).length}`;
  });
}

/** Verify one generation without throwing: manifest shape, containment by real path, regular files, hashes. */
export function verifyGeneration(dir: string): Generation {
  let m: CheckpointManifest;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')); } catch (e) { return { dir, problem: `no readable ${MANIFEST} (${(e as Error).message})` }; }
  if (m.schema_version !== 1 || typeof m.run !== 'string' || !m.files || typeof m.files !== 'object' || !m.files[FILES.run]) return { dir, manifest: m, problem: `${MANIFEST} is not a schema_version 1 checkpoint with run.json listed` };
  const check = (rel: string, sha: string, base: string): string | undefined => {
    if (typeof rel !== 'string' || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return `${rel} escapes the checkpoint`;
    const file = path.join(base, rel);
    let st: fs.Stats;
    try { st = fs.lstatSync(file); } catch { return `${rel} is listed but missing`; }
    if (!st.isFile()) return `${rel} is not a regular file`;
    if (!inside(fs.realpathSync(base), fs.realpathSync(file))) return `${rel} escapes the checkpoint through a symlinked directory`;
    if (sha256File(file) !== sha) return `${rel} does not match its sha256 in ${MANIFEST}`;
    return undefined;
  };
  for (const [rel, sha] of Object.entries(m.files)) { const problem = check(rel, sha, path.join(dir, 'run')); if (problem) return { dir, manifest: m, problem }; }
  if (m.plan_input) { const problem = check(m.plan_input.file, m.plan_input.sha256, dir); if (problem) return { dir, manifest: m, problem }; }
  return { dir, manifest: m };
}

/** Every generation `from` names: one generation, a run's collection, or a root of collections; newest first. */
export function listGenerations(from: string): Generation[] {
  const src = path.resolve(from);
  if (fs.existsSync(path.join(src, MANIFEST))) return [verifyGeneration(src)];
  const collections = fs.existsSync(path.join(src, GENERATIONS)) ? [src]
    : fs.existsSync(src) ? fs.readdirSync(src).map(e => path.join(src, e)).filter(c => fs.existsSync(path.join(c, GENERATIONS))) : [];
  const order = (g: Generation) => [g.manifest?.revision ?? -1, Date.parse(g.manifest?.at ?? '') || 0] as const;
  return collections.flatMap(c => fs.readdirSync(path.join(c, GENERATIONS)).map(g => verifyGeneration(path.join(c, GENERATIONS, g))))
    .sort((a, b) => order(b)[0] - order(a)[0] || order(b)[1] - order(a)[1]);
}

/** `gstack-autoplan checkpoints --from <dir>`: one line per generation, newest first. */
export function checkpointLines(from: string): string[] {
  const gens = listGenerations(from);
  if (!gens.length) throw new RunError('CHECKPOINT_INVALID', `${path.resolve(from)}: no checkpoint generations found`, 3);
  return gens.map(g => {
    const m = g.manifest;
    const collection = path.dirname(path.dirname(g.dir));
    let current = false;
    try { current = JSON.parse(fs.readFileSync(path.join(collection, CURRENT), 'utf8')).generation === path.basename(g.dir); } catch { /* no pointer */ }
    return `CHECKPOINT: ${g.dir} run=${m?.run ?? '?'} gate_rev=${m?.gate_rev ?? '?'} status=${m?.status ?? '?'} revision=${m?.revision ?? '?'} at=${m?.at ?? '?'} hash=${g.problem ? `bad (${g.problem})` : 'ok'}${current ? ' current' : ''}`;
  });
}

/** The generation to restore: the one named, or the newest that verifies in a collection or a root holding one run. */
function chooseGeneration(from: string): Generation {
  const gens = listGenerations(from);
  const runs = [...new Set(gens.map(g => g.manifest?.run).filter(Boolean))];
  if (runs.length > 1) throw new RunError('CHECKPOINT_INVALID', `${path.resolve(from)} holds checkpoints of ${runs.length} runs (${runs.join(', ')}); pass --from <dir>/<run>`, 3);
  const valid = gens.find(g => !g.problem);
  if (!valid) throw new RunError('CHECKPOINT_INVALID', `${path.resolve(from)}: ${gens.length ? gens.map(g => `${path.basename(g.dir)}: ${g.problem}`).join('; ') : 'no checkpoint generations found'}`, 3);
  return valid;
}

/** Verify a checkpoint and publish it as the run directory `out`. Nothing is written to `out` unless every check passes. */
export function restoreCheckpoint(from: string, out: string): string[] {
  const src = path.resolve(from);
  const target = path.resolve(out);
  const staging = `${target}.restore-${process.pid}`;
  refuseOverlap('the checkpoint and --out', src, target);
  refuseOverlap('the checkpoint and the restore staging directory', src, staging);
  const collectionLock = fs.existsSync(path.join(src, MANIFEST)) ? path.join(path.dirname(path.dirname(src)), '.lock') : path.join(src, '.lock');
  return exclusive(`${target}.lock`, () => exclusive(collectionLock, () => {
    if (fs.existsSync(target) && fs.readdirSync(target).length) throw new RunError('CHECKPOINT_TARGET_EXISTS', `${target} is not empty`, 3);
    const gen = chooseGeneration(src);
    const m = gen.manifest!;
    const skipped = listGenerations(src).filter(g => g.problem && (g.manifest?.revision ?? -1) >= m.revision).map(g => `CHECKPOINT: skipped ${g.dir} (${g.problem})`);
    fs.rmSync(staging, { recursive: true, force: true });
    try {
      for (const rel of Object.keys(m.files)) copy(path.join(gen.dir, 'run', rel), path.join(staging, rel));
      for (const [rel, sha] of Object.entries(m.files)) if (sha256File(path.join(staging, rel)) !== sha) throw new RunError('CHECKPOINT_INVALID', `${gen.dir}: ${rel} changed while it was copied`, 3);
      const lines: string[] = [];
      const runFile = path.join(staging, FILES.run);
      let state: RunState;
      try { state = JSON.parse(fs.readFileSync(runFile, 'utf8')); } catch (e) { throw new RunError('CHECKPOINT_INVALID', `${gen.dir}: run.json does not parse (${(e as Error).message})`, 3); }
      if (state.run !== m.run || typeof state.out !== 'string' || !state.phases || typeof state.phases !== 'object') throw new RunError('CHECKPOINT_INVALID', `${gen.dir}: run.json is not the run state of ${m.run}`, 3);
      if (m.plan_input && !fs.existsSync(m.plan_input.original)) {
        copy(path.join(gen.dir, m.plan_input.file), path.join(staging, m.plan_input.file));
        state.plan_input = path.join(state.out, m.plan_input.file);
        if (!fs.existsSync(state.plan_source)) state.plan_source = state.plan_input;
        fs.writeFileSync(runFile, JSON.stringify(state, null, 2) + '\n');
        lines.push(`PLAN_INPUT: ${m.plan_input.original} is missing; restored the checkpoint copy to ${path.join(target, m.plan_input.file)}`);
      } else if (m.plan_input && sha256File(m.plan_input.original) !== m.plan_input.sha256) lines.push(`PLAN_INPUT: ${m.plan_input.original} differs from the checkpoint copy; kept the file on disk`);
      const v = validateRun(runFile);
      // A mid-run generation (after a bound voice or a transition) is unfinished by design: only its integrity must hold.
      if (!AT_REST.includes(m.status)) v.errors = v.errors.filter(e => !['ARTIFACT_RUN_INTERRUPTED', 'ARTIFACT_REVIEWER_MISSING', 'ARTIFACT_GUARD_LINE_MISSING'].includes(e.code));
      v.valid = v.errors.length === 0;
      if (!v.valid) throw new RunError('CHECKPOINT_INVALID', `${gen.dir}: the staged run does not validate: ${v.errors.slice(0, 3).map(e => `${e.code} ${e.path}: ${e.message}`).join('; ')}`, 3);
      if (fs.existsSync(target)) fs.rmdirSync(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(staging, target);
      readState(target);
      journal(target, { event: 'restored', from: gen.dir, checkpoint_at: m.at, checkpoint_host: m.host, revision: m.revision, host: os.hostname(), files: Object.keys(m.files).length });
      return [...skipped, `RESTORED: run=${m.run} from=${gen.dir} status=${m.status} gate_rev=${m.gate_rev} revision=${m.revision} files=${Object.keys(m.files).length} (written ${m.at} on ${m.host})`, ...lines];
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }));
}
