import * as fs from 'node:fs';
import * as path from 'node:path';

/** Both reviews use the real repository; Eng's loading/completion case proposes
 * a bounded batch-read API, while DX retains its existing cache scenario. */
export function repositoryPlanFixtures(plan: string, skill: 'plan-eng-review' | 'plan-devex-review'): Record<string, string> {
  const dir = path.resolve(import.meta.dir, '../fixtures/carve-existing-repository');
  const companion = skill === 'plan-devex-review' ? 'plan-devex-review/dx-hall-of-fame.md' : 'review/TODOS-format.md';
  const baseline = Object.fromEntries(['README.md', 'src/repository.ts', 'example.ts'].map(file => [file, fs.readFileSync(path.join(dir, file), 'utf8')]));
  if (skill === 'plan-eng-review') {
    // Only the proposed-work label differs; current API/error contracts stay intact.
    baseline['README.md'] = baseline['README.md'].replace('The cache in PLAN.md is proposed work.', 'The batch-read method in PLAN.md is proposed work.');
  }
  return {
    'PLAN.md': skill === 'plan-eng-review'
      ? fs.readFileSync(path.join(dir, 'engineering-batch-read-plan.md'), 'utf8')
      : plan + '\n## Existing project\nRead `README.md` and `src/repository.ts` for the current API and runtime.\nThe change adds the cache to that repository; the existing example must keep working.\n',
    ...baseline,
    [companion]: fs.readFileSync(path.resolve(import.meta.dir, '../..', companion), 'utf8'),
  };
}
