/**
 * Module loadouts (GSTA-140, PR 1a): the toggleable units of gstack and the
 * named sets of them a render can load.
 *
 * A module is a skill (`skill:<dir>`), one carved section
 * (`section:<skill>/<id>`, from <skill>/sections/manifest.json), one model
 * overlay (`overlay:<name>`, from model-overlays/) or one preamble piece
 * (`preamble:<id>`, from PREAMBLE_PIECES). The catalog is derived from those
 * sources; modules/loadouts.json is the only hand-written file and holds the
 * rungs, the model-id to rung table, the pinned ids and the loadouts.
 *
 * Every error is a ModuleError with a stable code, a fix line and a
 * docs/troubleshooting.md anchor. Nothing here ever falls back to `full` on
 * bad input: an eval arm that silently rendered `full` would measure the
 * control.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverTemplates } from './discover-skills';
import { PREAMBLE_MODULE_IDS } from './resolvers/preamble';
import type { ModuleFilter } from './resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');
export const LOADOUTS_FILE = 'modules/loadouts.json';
export const RUNGS = ['frontier', 'strong', 'mid', 'light'] as const;
export type Rung = (typeof RUNGS)[number] | 'unknown';
export const FULL = 'full';
/** The router and the way back can never be left out (same rule as --disabled-skills). */
export const IMPLICIT_PINS = ['skill:gstack', 'skill:gstack-upgrade', 'preamble:bash'];
const NAME_RE = /^[a-z0-9-]+$/;

export type ModuleKind = 'skill' | 'section' | 'overlay' | 'preamble';
export interface ModuleEntry {
  id: string;
  kind: ModuleKind;
  /** Repository-relative source file. */
  source: string;
  pinned: boolean;
}

export interface LoadoutDef {
  base?: string;
  include?: '*' | string[];
  exclude?: string[];
  preamble_tier_max?: number;
  note?: string;
}

export interface LoadoutsManifest {
  version: 1;
  aliases: Record<string, Rung>;
  rungs: Record<(typeof RUNGS)[number], string[]>;
  pinned: string[];
  loadouts: Record<string, LoadoutDef>;
  default: Record<Rung, string>;
}

export type ModuleErrorCode =
  | 'LOADOUTS_INVALID'
  | 'LOADOUT_UNKNOWN'
  | 'MODULE_SPEC_INVALID'
  | 'MODULE_UNKNOWN'
  | 'MODULE_PINNED'
  | 'MODULE_EXCLUSION_UNSAFE'
  | 'RENDER_FAILED'
  | 'RENDER_DEST_NOT_OWNED';

export class ModuleError extends Error {
  constructor(readonly code: ModuleErrorCode, problem: string, readonly fix: string) {
    super(`${problem}; fix: ${fix} (${code}; docs/troubleshooting.md#${code.toLowerCase().replaceAll('_', '-')})`);
  }
}

const clamp = (value: string) => JSON.stringify(value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120));

export function loadLoadouts(root = ROOT): LoadoutsManifest {
  const file = path.join(root, LOADOUTS_FILE);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as LoadoutsManifest;
  } catch (error) {
    throw new ModuleError('LOADOUTS_INVALID', `${LOADOUTS_FILE} is unreadable or not JSON (${(error as Error).message})`, `restore it with git checkout -- ${LOADOUTS_FILE}`);
  }
}

/** Every module id with its kind and source, derived from the files that define them. */
export function moduleCatalog(manifest: LoadoutsManifest, root = ROOT): ModuleEntry[] {
  const pinned = new Set([...manifest.pinned, ...IMPLICIT_PINS]);
  const entries: Omit<ModuleEntry, 'pinned'>[] = [];
  for (const { tmpl } of discoverTemplates(root)) {
    const dir = path.dirname(tmpl);
    entries.push({ id: `skill:${dir === '.' ? 'gstack' : dir}`, kind: 'skill', source: tmpl });
    const manifestPath = path.join(root, dir, 'sections', 'manifest.json');
    if (dir === '.' || !fs.existsSync(manifestPath)) continue;
    const sections = (JSON.parse(fs.readFileSync(manifestPath, 'utf-8')).sections ?? []) as Array<{ id: string; file: string }>;
    for (const s of sections) entries.push({ id: `section:${dir}/${s.id}`, kind: 'section', source: `${dir}/sections/${s.file}.tmpl` });
  }
  for (const file of fs.readdirSync(path.join(root, 'model-overlays')).filter(f => f.endsWith('.md')).sort()) {
    entries.push({ id: `overlay:${file.slice(0, -3)}`, kind: 'overlay', source: `model-overlays/${file}` });
  }
  for (const id of PREAMBLE_MODULE_IDS) entries.push({ id, kind: 'preamble', source: 'scripts/resolvers/preamble.ts' });
  return entries.map(e => ({ ...e, pinned: pinned.has(e.id) }));
}

export function normalizeModelId(raw: string): string {
  return raw.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').trim().replace(/^[a-z0-9-]+\//, '');
}

const matches = (pattern: string, id: string) => (pattern.endsWith('*') ? id.startsWith(pattern.slice(0, -1)) : id === pattern);

/** The rung a model id belongs to: aliases first, then the first rung whose pattern matches. */
export function rungFor(manifest: LoadoutsManifest, raw: string): Rung {
  const id = normalizeModelId(raw);
  if (Object.hasOwn(manifest.aliases, id)) return manifest.aliases[id];
  for (const rung of RUNGS) if (manifest.rungs[rung].some(p => matches(p, id))) return rung;
  return 'unknown';
}

/** Every problem with the manifest, or [] (free test and gstack-modules validate). */
export function validateLoadouts(manifest: LoadoutsManifest, catalog: ModuleEntry[], corpus: string[] = []): string[] {
  const problems: string[] = [];
  const ids = new Set(catalog.map(e => e.id));
  const pinned = new Set([...(manifest.pinned ?? []), ...IMPLICIT_PINS]);
  if (manifest.version !== 1) problems.push(`version must be 1 (got ${clamp(String(manifest.version))})`);
  for (const rung of RUNGS) if (!Array.isArray(manifest.rungs?.[rung])) problems.push(`rungs.${rung} must be a list of model-id patterns`);
  for (const [alias, rung] of Object.entries(manifest.aliases ?? {})) {
    if (!(RUNGS as readonly string[]).includes(rung)) problems.push(`aliases.${alias} names no rung (${clamp(rung)})`);
  }
  for (const id of manifest.pinned ?? []) if (!ids.has(id)) problems.push(`pinned id ${clamp(id)} is not a module`);
  const loadouts = manifest.loadouts ?? {};
  const has = (name: string | undefined) => name !== undefined && Object.hasOwn(loadouts, name);
  if (!has(FULL) || loadouts[FULL].include !== '*') problems.push('loadouts.full must exist with include "*"');
  for (const [name, def] of Object.entries(loadouts)) {
    if (!NAME_RE.test(name)) problems.push(`loadout name ${clamp(name)} must match ^[a-z0-9-]+$`);
    if (def.base !== undefined && !has(def.base)) problems.push(`loadouts.${name}.base names no loadout (${clamp(def.base)})`);
    for (const id of [...(def.exclude ?? []), ...(Array.isArray(def.include) ? def.include : [])]) {
      if (!ids.has(id)) problems.push(`loadouts.${name} names ${clamp(id)}, which is not a module`);
    }
    for (const id of def.exclude ?? []) {
      if (pinned.has(id)) problems.push(`loadouts.${name} excludes pinned ${id}`);
      const child = id.startsWith('skill:') ? [...pinned].find(p => p.startsWith(`section:${id.slice('skill:'.length)}/`)) : undefined;
      if (child) problems.push(`loadouts.${name} excludes ${id}, which holds pinned ${child}`);
    }
    if (def.preamble_tier_max !== undefined && ![1, 2, 3, 4].includes(def.preamble_tier_max)) problems.push(`loadouts.${name}.preamble_tier_max must be 1-4`);
    const seen = new Set<string>();
    for (let at: string | undefined = name; at && has(at); at = loadouts[at].base) {
      if (seen.has(at)) { problems.push(`loadouts.${name} has a base cycle through ${at}`); break; }
      seen.add(at);
    }
  }
  for (const rung of [...RUNGS, 'unknown'] as const) {
    if (!has(manifest.default?.[rung])) problems.push(`default.${rung} names no loadout (${clamp(String(manifest.default?.[rung]))})`);
  }
  for (const raw of corpus) {
    const id = normalizeModelId(raw);
    const hits = RUNGS.filter(rung => manifest.rungs[rung]?.some(p => matches(p, id)));
    if (hits.length > 1) problems.push(`model ${id} matches more than one rung (${hits.join(', ')})`);
  }
  return problems;
}

function assertValid(manifest: LoadoutsManifest, catalog: ModuleEntry[]): void {
  const problems = validateLoadouts(manifest, catalog);
  if (problems.length) throw new ModuleError('LOADOUTS_INVALID', `${LOADOUTS_FILE}: ${problems.join('; ')}`, 'fix the named entries, then run gstack-modules validate');
}

function excludedBy(manifest: LoadoutsManifest, name: string): { excluded: Set<string>; tierMax?: number } {
  const def = manifest.loadouts[name];
  const inherited = def.base ? excludedBy(manifest, def.base) : { excluded: new Set<string>() };
  const excluded = new Set([...inherited.excluded, ...(def.exclude ?? [])]);
  if (Array.isArray(def.include)) for (const id of def.include) excluded.delete(id);
  return { excluded, tierMax: def.preamble_tier_max ?? inherited.tierMax };
}

export interface ModuleSelection extends ModuleFilter {
  /** The normalized spec (`<loadout>` or `<base>,-id,+id`) and its sha256, for the lock file. */
  spec: string;
  specSha256: string;
}

/**
 * Resolve `--loadout <name>` or `--modules <base>,-id,+id` to a filter.
 * Returns null for the plain `full` loadout, which renders today's bytes.
 */
export function selectModules(input: { loadout?: string; modules?: string }, root = ROOT): ModuleSelection | null {
  if (input.loadout !== undefined && input.modules !== undefined) {
    throw new ModuleError('MODULE_SPEC_INVALID', '--loadout and --modules were both given', 'pass one: --loadout <name> or --modules <base>,-id,+id');
  }
  const text = (input.modules ?? input.loadout ?? '').trim();
  if (!text) return null;
  const manifest = loadLoadouts(root);
  const catalog = moduleCatalog(manifest, root);
  assertValid(manifest, catalog);
  const [base, ...edits] = text.split(',').map(t => t.trim());
  const names = Object.keys(manifest.loadouts).sort().join(', ');
  if (!Object.hasOwn(manifest.loadouts, base)) {
    throw new ModuleError('LOADOUT_UNKNOWN', `${clamp(base)} is not a loadout (valid: ${names})`, 'gstack-modules list');
  }
  if (input.loadout !== undefined && edits.length) {
    throw new ModuleError('MODULE_SPEC_INVALID', `--loadout takes one name (got ${clamp(text)})`, 'use --modules <base>,-id,+id for edits');
  }
  const { excluded, tierMax } = excludedBy(manifest, base);
  const ids = new Map(catalog.map(e => [e.id, e]));
  for (const edit of edits) {
    const op = edit[0];
    const id = edit.slice(1);
    if ((op !== '-' && op !== '+') || !id) {
      throw new ModuleError('MODULE_SPEC_INVALID', `${clamp(edit)} is not -<module id> or +<module id>`, 'write the spec as <loadout>,-<id>,+<id>; list ids with gstack-modules list');
    }
    const entry = ids.get(id);
    if (!entry) throw new ModuleError('MODULE_UNKNOWN', `${clamp(id)} is not a module`, 'gstack-modules list');
    if (op === '-' && entry.pinned) {
      throw new ModuleError('MODULE_PINNED', `${id} is pinned and can never be excluded`, `drop -${id} from the spec (pinned ids: gstack-modules list --pinned)`);
    }
    const pinnedChild = op === '-' && id.startsWith('skill:') ? catalog.find(e => e.pinned && e.id.startsWith(`section:${id.slice('skill:'.length)}/`)) : undefined;
    if (pinnedChild) {
      throw new ModuleError('MODULE_PINNED', `${id} holds pinned ${pinnedChild.id} and can never be excluded`, `drop -${id} from the spec (pinned ids: gstack-modules list --pinned)`);
    }
    if (op === '-') excluded.add(id); else excluded.delete(id);
  }
  if (excluded.size === 0 && tierMax === undefined && base === FULL) return null;
  const spec = edits.length ? [base, ...edits].join(',') : base;
  return {
    name: edits.length ? 'adhoc' : base,
    excluded,
    pinned: new Set(catalog.filter(e => e.pinned).map(e => e.id)),
    preambleTierMax: tierMax,
    spec,
    specSha256: createHash('sha256').update(spec).digest('hex'),
  };
}

/** Skill directories a selection leaves out (`skill:gstack` is the root template). */
export function excludedSkillDirs(filter: ModuleFilter | null | undefined): string[] {
  return [...(filter?.excluded ?? [])].filter(id => id.startsWith('skill:')).map(id => id.slice('skill:'.length));
}
