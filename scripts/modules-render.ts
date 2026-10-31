/**
 * gstack-modules render (GSTA-140, PR 1a): one loadout rendered into a
 * directory GSTA-2 can preregister, published only when complete.
 *
 * Order: render into an owned staging directory beside --out-dir (Claude
 * section links already name the final path), refuse dangling references to
 * an excluded module, hash every file into loadout.lock.json (written last),
 * then swap the staging directory into place. Any failure leaves the previous
 * --out-dir untouched and removes the staging directory.
 */
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runGeneration } from './gen-skill-docs';
import { ModuleError, type ModuleSelection } from './modules';
import type { Host } from './resolvers/types';
import { getHostConfig } from '../hosts/index';
import type { Model } from './models';

export const LOCK_FILE = 'loadout.lock.json';
const ROOT = path.resolve(import.meta.dir, '..');

export interface RenderRequest {
  host: Host;
  /** null = the full loadout. */
  selection: ModuleSelection | null;
  outDir: string;
  installRoot?: string | null;
  model?: Model | null;
  planMode?: boolean;
}

export interface LoadoutLock {
  schema_version: 1;
  loadout: string;
  spec: string;
  spec_sha256: string | null;
  host: Host;
  model: string | null;
  install_root: string | null;
  plan_mode: boolean;
  gstack_version: string;
  excluded: string[];
  total_bytes: number;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

function walk(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, base);
    return entry.isFile() ? [path.relative(base, full).split(path.sep).join('/')] : [];
  }).sort();
}

/**
 * References an excluded module leaves behind in the rendered text. A section
 * counts as referenced by: its absolute path (`/<skill>/sections/<file>`, any
 * file, so resolver-inlined cross-skill pointers count), an installed-relative
 * pointer naming its skill, or, inside its own skill's directory, a bare
 * `sections/<file>` or the inline-host "section inlined" phrase. An excluded
 * skill counts as referenced by another skill naming its SKILL.md or one of
 * its section files.
 */
export function danglingReferences(stage: string, selection: ModuleSelection): string[] {
  const checks: Array<{ id: string; scope: string | null; test: (line: string) => boolean }> = [];
  for (const id of selection.excluded) {
    if (id.startsWith('section:')) {
      const [skill, sectionId] = id.slice('section:'.length).split('/');
      const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, skill, 'sections', 'manifest.json'), 'utf-8'));
      const file = (manifest.sections as Array<{ id: string; file: string }>).find(entry => entry.id === sectionId)!.file;
      const stem = file.replace(/\.md$/, '');
      checks.push(
        { id, scope: null, test: line => line.includes(`/${skill}/sections/${file}`) },
        { id, scope: null, test: line => line.includes(`sections/${file}\` relative to the installed`) && line.includes(`${skill}\``) },
        { id, scope: skill, test: line => line.includes(`sections/${file}`) || line.includes(`the \`${stem}\` section inlined`) },
      );
    } else if (id.startsWith('skill:')) {
      const skill = id.slice('skill:'.length);
      checks.push({ id, scope: null, test: line => line.includes(`/${skill}/SKILL.md`) || line.includes(`gstack-${skill}/SKILL.md`) });
      const manifestPath = path.join(ROOT, skill, 'sections', 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        for (const { file } of JSON.parse(fs.readFileSync(manifestPath, 'utf-8')).sections as Array<{ file: string }>) {
          checks.push(
            { id, scope: null, test: line => line.includes(`/${skill}/sections/${file}`) },
            { id, scope: null, test: line => line.includes(`sections/${file}\` relative to the installed`) && line.includes(`${skill}\``) },
          );
        }
      }
    }
  }
  if (!checks.length) return [];
  const found = new Set<string>();
  for (const rel of walk(stage)) {
    if (!rel.endsWith('.md')) continue;
    const dirs = rel.split('/');
    const lines = fs.readFileSync(path.join(stage, rel), 'utf-8').split('\n');
    lines.forEach((line, index) => {
      for (const check of checks) {
        if (check.scope && !dirs.includes(check.scope) && !dirs.includes(`gstack-${check.scope}`)) continue;
        if (check.test(line)) found.add(`${check.id}: referenced by ${rel}:${index + 1}`);
      }
    });
  }
  return [...found];
}

function owned(dir: string): boolean {
  if (!fs.existsSync(dir)) return true;
  return fs.readdirSync(dir).length === 0 || fs.existsSync(path.join(dir, LOCK_FILE));
}

export async function renderLoadout(request: RenderRequest): Promise<LoadoutLock> {
  const final = path.resolve(request.outDir);
  if (!owned(final)) {
    throw new ModuleError('RENDER_DEST_NOT_OWNED', `${final} exists and holds no ${LOCK_FILE}, so it is not a gstack-modules render`, 'pass an empty or new --out-dir, or one an earlier gstack-modules render wrote');
  }
  const tag = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const stage = `${final}.stage-${tag}`;
  const retired = `${final}.old-${tag}`;
  fs.mkdirSync(path.dirname(final), { recursive: true });
  try {
    const result = await runGeneration({
      host: request.host,
      outputRoot: stage,
      contentLinkRoot: final,
      installRoot: request.installRoot ?? null,
      model: request.model ?? null,
      planMode: request.planMode ?? true,
      modules: request.selection,
    });
    const errors = result.diagnostics.filter(d => d.kind === 'error').map(d => d.message);
    if (result.exitCode !== 0 || errors.length) {
      throw new ModuleError('RENDER_FAILED', `gen-skill-docs failed: ${errors.join('; ') || 'exit 1'}`, 'fix the named template or module, then rerun; side effects: none, safe to retry');
    }
    if (request.selection) {
      const dangling = danglingReferences(stage, request.selection);
      if (dangling.length) {
        throw new ModuleError('MODULE_EXCLUSION_UNSAFE', dangling.slice(0, 5).join('; ') + (dangling.length > 5 ? ` (+${dangling.length - 5} more)` : ''), 'exclude the referencing module too, or guard the reference with {{IF_SECTION:id}} in its template; side effects: none, safe to retry');
      }
    }
    const files = walk(stage).map(rel => {
      const bytes = fs.readFileSync(path.join(stage, rel));
      return { path: rel, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    const lock: LoadoutLock = {
      schema_version: 1,
      loadout: request.selection?.name ?? 'full',
      spec: request.selection?.spec ?? 'full',
      spec_sha256: request.selection?.specSha256 ?? null,
      host: request.host,
      model: request.model ?? getHostConfig(request.host).defaultModel ?? null,
      install_root: request.installRoot ?? null,
      plan_mode: request.planMode ?? true,
      gstack_version: fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf-8').trim(),
      excluded: [...(request.selection?.excluded ?? [])].sort(),
      total_bytes: files.reduce((sum, f) => sum + f.bytes, 0),
      files,
    };
    fs.writeFileSync(path.join(stage, LOCK_FILE), JSON.stringify(lock, null, 2) + '\n');
    if (!owned(final)) {
      throw new ModuleError('RENDER_DEST_NOT_OWNED', `${final} changed during the render and now holds no ${LOCK_FILE}`, 'pass an empty or new --out-dir, or one an earlier gstack-modules render wrote');
    }
    if (fs.existsSync(final)) fs.renameSync(final, retired);
    try {
      fs.renameSync(stage, final);
    } catch (error) {
      if (fs.existsSync(retired)) fs.renameSync(retired, final);
      throw error;
    }
    fs.rmSync(retired, { recursive: true, force: true });
    return lock;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
