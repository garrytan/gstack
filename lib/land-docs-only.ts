/**
 * land.docs_only_skip (R81; docs/pregate.md#docs-only). Its own module: lib/land-merged-checks.ts is imported by
 * lib/ship-policy.ts, which lib/docs-only.ts imports, so the classifier cannot be imported there.
 */
import { spawnSync } from 'node:child_process';
import { classifyDocsOnly, directoryReaders, readDiff, readRepoDocs, referencesTo } from './docs-only';

/**
 * The merged checks for `pin`: land.merged_checks without the commands land.docs_only_skip names when lib/docs-only.ts
 * calls the pin's change since its merge base with `base` human docs only (R81; docs/pregate.md#docs-only), and no
 * non-docs file at `base` names a changed path or reads its directory without doing so at the pin: land merges onto
 * `base`, so a reader the base gained after the pin branched keeps the checks. Any git or classifier failure keeps every check.
 */
export function mergedChecksFor(root: string, land: { merged_checks?: string[]; docs_only_skip?: string[] } | null | undefined, base: string, pin: string): string[] {
  const checks = land?.merged_checks ?? [];
  const skip = land?.docs_only_skip ?? [];
  if (!skip.length) return checks;
  const mb = spawnSync('git', ['merge-base', base, pin], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  try {
    if (mb.status !== 0 || !classifyDocsOnly({ root, base: mb.stdout.trim(), head: pin, policyRef: base }).docsOnly) return checks;
    const changed = readDiff(root, mb.stdout.trim(), pin).flatMap(e => [e.path, ...(e.from ? [e.from] : [])]);
    const repo = readRepoDocs(root, base);
    if ('error' in repo) return checks;
    const untied = { ...repo, tests: [] };
    const atPin = new Set(changed.flatMap(p => directoryReaders(root, p, untied, pin)));
    if (changed.some(p => referencesTo(root, p, base, repo).length || directoryReaders(root, p, untied, base).some(f => !atPin.has(f)))) return checks;
  } catch { return checks; }
  return checks.filter(c => !skip.includes(c));
}
