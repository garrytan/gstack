/**
 * gstack on Capy (crew/README.md): public CI runs the crew tests (crew/test)
 * only when a pull request changes crew/, a file crew code or its tests
 * import, or a root file they run or read by path (bin/, .github/workflows/). `scripts/test-free-shards.ts --ci-plan --crew-base <ref>` asks for
 * that check; without --crew-base every free file is planned, as on main
 * pushes and in local runs. Typecheck still covers crew/ on every pull request.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const CREW_TEST_ROOT = 'crew/test';
export const isCrewTestFile = (file: string): boolean => file.startsWith(CREW_TEST_ROOT + '/');

/** Root directories crew tests reach by path rather than import: the bin/ commands their fixtures spawn and the workflows they parse. */
const CREW_TEST_INPUTS = ['bin/', '.github/workflows/'];

const RELATIVE_SPEC = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm;

function resolveSpec(root: string, fromFile: string, spec: string): string | null {
  const base = path.normalize(path.join(path.dirname(fromFile), spec));
  for (const candidate of [base, base + '.ts', base + '.tsx', base + '.js', path.join(base, 'index.ts')]) {
    const full = path.join(root, candidate);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return candidate.split(path.sep).join('/');
  }
  return null;
}

/** crew/'s files plus every repo file they reach through relative imports, transitively. */
export function crewImportClosure(root: string, crewFiles: readonly string[]): Set<string> {
  const seen = new Set(crewFiles);
  const queue = [...crewFiles];
  while (queue.length) {
    const file = queue.pop()!;
    let source: string;
    try { source = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    for (const match of source.matchAll(RELATIVE_SPEC)) {
      const target = resolveSpec(root, file, match[1]);
      if (target && !seen.has(target)) { seen.add(target); queue.push(target); }
    }
  }
  return seen;
}

export interface CrewTestSelection { planned: boolean; reason: string }

/** Whether the change since `base` needs the crew tests. Any git failure plans them (fail open). */
export function crewTestSelection(root: string, base: string): CrewTestSelection {
  const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
  const diff = git(['diff', '--name-only', `${base}...HEAD`]);
  const listed = git(['ls-files', 'crew']);
  if (diff.status !== 0 || listed.status !== 0) return { planned: true, reason: `git could not diff against ${base}, so they run` };
  const changed = diff.stdout.split('\n').filter(Boolean);
  const closure = crewImportClosure(root, listed.stdout.split('\n').filter(Boolean));
  const hit = changed.find(file => file.startsWith('crew/') || CREW_TEST_INPUTS.some(dir => file.startsWith(dir)) || closure.has(file));
  return hit
    ? { planned: true, reason: `${hit} changed` }
    : { planned: false, reason: `nothing under crew/, bin/ or .github/workflows/, or in what crew code imports, changed since ${base}` };
}
