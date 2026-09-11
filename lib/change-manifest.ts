import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalProfileJson, SEMANTIC_ROLES, type ParsedWorkProfile, type SemanticRole } from './work-profile';

export interface ChangeManifest {
  schema_version: 1;
  target_base_ref?: string;
  target_base_sha?: string;
  merge_base_sha?: string;
  head_sha?: string;
  wtree: string;
  changed: Array<{ path: string; roles: SemanticRole[]; source: 'committed' | 'staged' | 'unstaged' | 'untracked' }>;
  roles: SemanticRole[];
  fallback_paths: string[];
  declaration_required_paths: string[];
  classification_state: 'complete' | 'semantic_declaration_required';
  manifest_hash: string;
}

function run(cwd: string, args: string[], allowFailure = false): Buffer {
  const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'buffer', timeout: 20_000, env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), LC_ALL: 'C' } });
  if (result.status !== 0 && !allowFailure) throw new Error('change_manifest_git_failure');
  return result.status === 0 ? result.stdout : Buffer.alloc(0);
}
function text(cwd: string, args: string[], allowFailure = false): string { return run(cwd, args, allowFailure).toString('utf8').trim(); }
function nul(cwd: string, args: string[], allowFailure = false): string[] { return run(cwd, args, allowFailure).toString('utf8').split('\0').filter(Boolean); }
function matches(glob: string, value: string): boolean { try { return new Bun.Glob(glob).match(value); } catch { throw new Error('semantic_glob_invalid'); } }
function sha(value: unknown): string { return new Bun.CryptoHasher('sha256').update(canonicalProfileJson(value)).digest('hex'); }
function worktreeFingerprint(cwd: string): string {
  const moduleRoot = path.basename(import.meta.dir) === 'authority' && path.basename(path.dirname(import.meta.dir)) === 'dist' ? path.resolve(import.meta.dir, '..', '..') : path.resolve(import.meta.dir, '..');
  const result = spawnSync(path.join(moduleRoot, 'bin', 'gstack-wtree'), [], { cwd, encoding: 'utf8', timeout: 20_000, shell: false, env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), LC_ALL: 'C' } });
  const value = result.stdout?.trim() ?? ''; if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(value)) throw new Error('change_manifest_wtree_failed');
  return value;
}
function packageRoles(cwd: string, base: string): SemanticRole[] {
  const beforeRaw = run(cwd, ['show', `${base}:package.json`], true).toString('utf8');
  let before: Record<string, unknown>; let after: Record<string, unknown>;
  try { before = JSON.parse(beforeRaw); after = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')); } catch { return ['runtime']; }
  const versionChanged = before.version !== after.version;
  const beforeWithout = structuredClone(before); const afterWithout = structuredClone(after); delete beforeWithout.version; delete afterWithout.version;
  const otherChanged = canonicalProfileJson(beforeWithout) !== canonicalProfileJson(afterWithout);
  return [...(versionChanged ? ['release_metadata' as const] : []), ...(otherChanged || !versionChanged ? ['runtime' as const] : [])].sort() as SemanticRole[];
}

export function buildChangeManifest(input: { cwd?: string; profile: Pick<ParsedWorkProfile, 'semantic_paths' | 'prose_only_surfaces'>; targetBaseRef?: string; targetBaseSha?: string; mergeBaseSha: string }): ChangeManifest {
  const cwd = fs.realpathSync(path.resolve(input.cwd ?? process.cwd()));
  const head = text(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']); if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('change_manifest_head_invalid');
  const source = new Map<string, ChangeManifest['changed'][number]['source']>();
  for (const file of nul(cwd, ['diff', '-z', '--name-only', `${input.mergeBaseSha}...HEAD`])) source.set(file, 'committed');
  for (const file of nul(cwd, ['diff', '-z', '--cached', '--name-only'])) source.set(file, 'staged');
  for (const file of nul(cwd, ['diff', '-z', '--name-only'])) source.set(file, 'unstaged');
  for (const file of nul(cwd, ['ls-files', '-z', '--others', '--exclude-standard'])) source.set(file, 'untracked');
  const added = new Set<string>([
    ...nul(cwd, ['diff', '-z', '--diff-filter=A', '--name-only', `${input.mergeBaseSha}...HEAD`]),
    ...nul(cwd, ['diff', '-z', '--cached', '--diff-filter=A', '--name-only']),
    ...nul(cwd, ['ls-files', '-z', '--others', '--exclude-standard']),
  ]);
  const fallback: string[] = []; const declaration: string[] = [];
  const changed = [...source.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, changeSource]) => {
    let roles = file === 'package.json' ? packageRoles(cwd, input.mergeBaseSha) : [...new Set(input.profile.semantic_paths.filter((entry) => matches(entry.glob, file)).flatMap((entry) => entry.roles))].sort() as SemanticRole[];
    if (!roles.length) { roles = ['runtime']; fallback.push(file); }
    const soft = roles.every((role) => ['docs', 'ui', 'release_metadata'].includes(role));
    const prose = (input.profile.prose_only_surfaces ?? []).some((glob) => matches(glob, file));
    const literal = input.profile.semantic_paths.some((entry) => entry.glob === file && !/[*?\[\]{}]/.test(entry.glob));
    if (added.has(file) && soft && !prose && !literal) declaration.push(file);
    return { path: file, roles, source: changeSource };
  });
  const roles = [...new Set(changed.flatMap((entry) => entry.roles))].sort((a, b) => SEMANTIC_ROLES.indexOf(a) - SEMANTIC_ROLES.indexOf(b));
  const body = { schema_version: 1 as const, ...(input.targetBaseRef ? { target_base_ref: input.targetBaseRef } : {}), ...(input.targetBaseSha ? { target_base_sha: input.targetBaseSha } : {}), merge_base_sha: input.mergeBaseSha, head_sha: head, wtree: worktreeFingerprint(cwd), changed, roles, fallback_paths: fallback.sort(), declaration_required_paths: declaration.sort(), classification_state: declaration.length ? 'semantic_declaration_required' as const : 'complete' as const };
  return { ...body, manifest_hash: sha(body) };
}
