/**
 * gstack-modules install (GSTA-161, PR 1b): a non-full loadout published as a
 * complete, immutable skill tree beside the full install, for Capy's
 * SKILL_ROOT. The checkout itself always stays the full render.
 *
 * Identity: sha256 over the effective selection (loadout, sorted exclusions,
 * tier cap), the bound model and full root baked into each start line, the
 * host, the overlay model, plan mode and the source tree (the git HEAD tree,
 * plus a digest of uncommitted and untracked changes; a source git cannot read
 * gets a one-off nonce, so it never reuses a folder). Folder: <store>/<loadout>-<identity12>.
 * A folder is reused only when its lock names the same full identity and every
 * listed file still hashes to its recorded sha256.
 *
 * Publish: render into a staging folder (section links already name the final
 * folder), refuse dangling references, copy the source's tracked runtime assets
 * the render lacks (templates, references, scripts; never *.tmpl, test/ or the
 * skill's own SKILL.md), add gstack/SKILL.md for the router, write
 * loadout.lock.json last, then rename the staging folder into place. A rename
 * that loses a race to the same identity reuses the winner; a published folder
 * is never replaced. Folders this installer published for the same loadout
 * (name, digest and an install lock) beyond the newest KEEP by last use are
 * removed once unused for PRUNE_GRACE_MS.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGeneration } from './gen-skill-docs';
import { resolveModel } from './models';
import { ModuleError, type ModuleSelection } from './modules';
import { LOCK_FILE, danglingReferences } from './modules-render';
import type { Host } from './resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');
const KEEP = 3;
const PRUNE_GRACE_MS = 24 * 60 * 60 * 1000;

export interface InstallRequest {
  selection: ModuleSelection;
  /** Validated model id the selection was made for, or null for an explicit loadout. */
  boundModel: string | null;
  fullRoot: string;
  store: string;
  host?: Host;
  planMode?: boolean;
}

export interface InstallLock {
  schema_version: 1;
  kind: 'install';
  identity_sha256: string;
  identity: Record<string, unknown>;
  loadout: string;
  loadout_model: string | null;
  full_root: string;
  gstack_version: string;
  excluded: string[];
  total_bytes: number;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

export interface InstallResult { root: string; lock: InstallLock; reused: boolean }

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

function git(root: string, args: string[]): string | null {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/** The git HEAD tree, plus a digest of uncommitted and untracked changes when there are any; a nonce when git cannot say. */
export function sourceTree(root: string): string {
  const tree = git(root, ['rev-parse', 'HEAD^{tree}'])?.trim();
  const diff = git(root, ['diff', '--no-ext-diff', '--binary', 'HEAD']);
  const untracked = git(root, ['ls-files', '-z', '--others', '--exclude-standard']);
  if (!tree || diff === null || untracked === null) return `unpinned-${randomBytes(8).toString('hex')}`;
  if (!diff && !untracked) return tree;
  const extra = untracked.split('\0').filter(Boolean).sort().map(rel => {
    try { return `${rel}:${sha256(fs.readFileSync(path.join(root, rel)))}`; } catch { return `${rel}:unreadable`; }
  });
  return `${tree}+${sha256(diff + '\0' + extra.join('\n')).slice(0, 16)}`;
}

function walk(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, base);
    return entry.isFile() ? [path.relative(base, full).split(path.sep).join('/')] : [];
  }).sort();
}

function hashFiles(dir: string) {
  return walk(dir).filter(rel => rel !== LOCK_FILE).map(rel => {
    const bytes = fs.readFileSync(path.join(dir, rel));
    return { path: rel, bytes: bytes.length, sha256: sha256(bytes) };
  });
}

function intact(dir: string, identity: string): InstallLock | null {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf-8')) as InstallLock;
    if (lock.kind !== 'install' || lock.identity_sha256 !== identity) return null;
    const actual = new Map(hashFiles(dir).map(f => [f.path, f.sha256]));
    if (actual.size !== lock.files.length || lock.files.some(f => actual.get(f.path) !== f.sha256)) return null;
    return lock;
  } catch {
    return null;
  }
}

/** Copy each tracked runtime asset of a rendered skill directory that the render did not write. */
function copyRuntimeAssets(source: string, stage: string): void {
  const listed = git(source, ['ls-files', '-z']);
  if (listed === null) throw new ModuleError('RENDER_FAILED', `cannot list the tracked files of ${source}`, 'install from a git checkout of gstack');
  for (const rel of listed.split('\0').filter(Boolean)) {
    const [dir, ...rest] = rel.split('/');
    if (!rest.length || !fs.existsSync(path.join(stage, dir, 'SKILL.md'))) continue;
    if (rel.endsWith('.tmpl') || rel === `${dir}/SKILL.md` || rest.some(seg => seg === 'test' || seg === 'node_modules' || seg === 'dist')) continue;
    const to = path.join(stage, rel);
    if (fs.existsSync(to)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(source, rel), to);
  }
}

function ownedInstall(dir: string): boolean {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf-8')).kind === 'install';
  } catch {
    return false;
  }
}

function prune(store: string, loadout: string, keep: string): void {
  const name = new RegExp(`^${loadout}-[0-9a-f]{12}$`);
  const cutoff = Date.now() - PRUNE_GRACE_MS;
  const siblings = fs.readdirSync(store, { withFileTypes: true })
    .filter(e => e.isDirectory() && name.test(e.name) && path.join(store, e.name) !== keep && ownedInstall(path.join(store, e.name)))
    .map(e => ({ dir: path.join(store, e.name), mtime: fs.statSync(path.join(store, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { dir, mtime } of siblings.slice(KEEP - 1)) if (mtime < cutoff) fs.rmSync(dir, { recursive: true, force: true });
}

export async function installLoadout(request: InstallRequest): Promise<InstallResult> {
  const source = ROOT;
  const host = request.host ?? 'claude';
  const planMode = request.planMode ?? true;
  const model = request.boundModel ? resolveModel(request.boundModel) : null;
  const selection: ModuleSelection = { ...request.selection, boundModel: request.boundModel ?? undefined, fullRoot: request.boundModel ? request.fullRoot : undefined };
  const identity = {
    loadout: selection.name,
    excluded: [...selection.excluded].sort(),
    preamble_tier_max: selection.preambleTierMax ?? null,
    loadout_model: request.boundModel,
    full_root: request.fullRoot,
    host,
    overlay_model: model,
    plan_mode: planMode,
    source_tree: sourceTree(source),
  };
  const identitySha = sha256(JSON.stringify(identity));
  const store = path.resolve(request.store);
  const final = path.join(store, `${selection.name}-${identitySha.slice(0, 12)}`);
  fs.mkdirSync(store, { recursive: true });
  const existing = intact(final, identitySha);
  if (existing) {
    const used = new Date();
    fs.utimesSync(final, used, used);
    return { root: final, lock: existing, reused: true };
  }
  if (fs.existsSync(final)) {
    throw new ModuleError('RENDER_DEST_NOT_OWNED', `${final} exists but its ${LOCK_FILE} does not match this render`, `remove ${final} and rerun; nothing else was changed`);
  }
  const stage = `${final}.stage-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    const result = await runGeneration({ host, outputRoot: stage, contentLinkRoot: final, installRoot: request.fullRoot && request.fullRoot !== path.join(os.homedir(), '.claude/skills') ? path.join(request.fullRoot, 'gstack') : null, model, planMode, modules: selection });
    const errors = result.diagnostics.filter(d => d.kind === 'error').map(d => d.message);
    if (result.exitCode !== 0 || errors.length) {
      throw new ModuleError('RENDER_FAILED', `gen-skill-docs failed: ${errors.join('; ') || 'exit 1'}`, 'fix the named template or module, then rerun; side effects: none, safe to retry');
    }
    const dangling = danglingReferences(stage, selection);
    if (dangling.length) throw new ModuleError('MODULE_EXCLUSION_UNSAFE', dangling.slice(0, 5).join('; '), 'exclude the referencing module too, or guard the reference with {{IF_SECTION:id}}');
    copyRuntimeAssets(source, stage);
    fs.mkdirSync(path.join(stage, 'gstack'), { recursive: true });
    fs.copyFileSync(path.join(stage, 'SKILL.md'), path.join(stage, 'gstack', 'SKILL.md'));
    const files = hashFiles(stage);
    const lock: InstallLock = {
      schema_version: 1,
      kind: 'install',
      identity_sha256: identitySha,
      identity,
      loadout: selection.name,
      loadout_model: request.boundModel,
      full_root: request.fullRoot,
      gstack_version: fs.readFileSync(path.join(source, 'VERSION'), 'utf-8').trim(),
      excluded: identity.excluded,
      total_bytes: files.reduce((sum, f) => sum + f.bytes, 0),
      files,
    };
    fs.writeFileSync(path.join(stage, LOCK_FILE), JSON.stringify(lock, null, 2) + '\n');
    try {
      fs.renameSync(stage, final);
    } catch (error) {
      const winner = intact(final, identitySha);
      if (!winner) throw error;
      return { root: final, lock: winner, reused: true };
    }
    prune(store, selection.name, final);
    return { root: final, lock, reused: false };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
