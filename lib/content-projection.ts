import { spawnSync } from 'node:child_process';
import * as os from 'node:os';

export interface ContentProjection { path: string; format: 'plain_text' | 'json' | 'toml'; selector: string }
export interface ProjectionComparison { matches: boolean; reasons: Array<'malformed' | 'projection_mismatch'> }

function git(cwd: string, args: string[]): string | undefined {
  const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8', timeout: 20_000, env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), LC_ALL: 'C' } });
  return result.status === 0 ? result.stdout : undefined;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') { const row = value as Record<string, unknown>; return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`; }
  return JSON.stringify(value);
}
function withoutPointer(value: unknown, selector: string): unknown {
  if (!selector.startsWith('/') || selector === '/') throw new Error('projection_selector_invalid');
  const copy = structuredClone(value) as Record<string, unknown>;
  const parts = selector.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  let cursor: unknown = copy;
  for (const part of parts.slice(0, -1)) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || !Object.hasOwn(cursor as object, part)) throw new Error('projection_selector_missing');
    cursor = (cursor as Record<string, unknown>)[part];
  }
  const leaf = parts.at(-1)!;
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || !Object.hasOwn(cursor as object, leaf)) throw new Error('projection_selector_missing');
  delete (cursor as Record<string, unknown>)[leaf];
  return copy;
}
function parseProjected(text: string, projection: ContentProjection): unknown {
  if (projection.selector === 'whole_file') return null;
  const parsed = projection.format === 'json' ? JSON.parse(text) : projection.format === 'toml' ? Bun.TOML.parse(text) : (() => { throw new Error('projection_format_invalid'); })();
  return withoutPointer(parsed, projection.selector);
}

export function compareContentProjection(cwd: string, oldTree: string, newTree: string, projections: ContentProjection[]): ProjectionComparison {
  if (!/^[0-9a-f]{40}$/i.test(oldTree) || !/^[0-9a-f]{40}$/i.test(newTree)) return { matches: false, reasons: ['malformed'] };
  const changedRaw = git(cwd, ['diff', '--name-only', oldTree, newTree]);
  if (changedRaw === undefined) return { matches: false, reasons: ['malformed'] };
  const changed = changedRaw.split('\n').filter(Boolean);
  const byPath = new Map(projections.map((projection) => [projection.path, projection]));
  if (changed.some((file) => !byPath.has(file))) return { matches: false, reasons: ['projection_mismatch'] };
  try {
    for (const file of changed) {
      const projection = byPath.get(file)!;
      if (projection.selector === 'whole_file') {
        if (projection.format !== 'plain_text' || !['VERSION', 'CHANGELOG.md'].includes(file)) return { matches: false, reasons: ['projection_mismatch'] };
        if (git(cwd, ['show', `${oldTree}:${file}`]) === undefined || git(cwd, ['show', `${newTree}:${file}`]) === undefined) return { matches: false, reasons: ['malformed'] };
        continue;
      }
      const before = git(cwd, ['show', `${oldTree}:${file}`]); const after = git(cwd, ['show', `${newTree}:${file}`]);
      if (before === undefined || after === undefined) return { matches: false, reasons: ['malformed'] };
      if (canonical(parseProjected(before, projection)) !== canonical(parseProjected(after, projection))) return { matches: false, reasons: ['projection_mismatch'] };
    }
  } catch { return { matches: false, reasons: ['malformed'] }; }
  return { matches: true, reasons: [] };
}
