import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { seedCeoFindingProject } from './ceo-finding-fixture';

/** Give the two-test review an existing function to inspect before its first turn. */
export function seedCeoPairedProject(projectDir: string, plan: string): void {
  seedCeoFindingProject(projectDir, plan);
  const fixture = path.resolve(import.meta.dir, '../fixtures/paired-payment');
  fs.mkdirSync(path.join(projectDir, 'src'));
  for (const [source, target] of [['README.md', 'README.md'], ['src/payment.ts', 'src/payment.ts'],
    ['contract.test.ts.fixture', 'contract.test.ts']]) {
    fs.copyFileSync(path.join(fixture, source!), path.join(projectDir, target!));
  }
  const git = (args: string[]) => execFileSync('git', args, { cwd: projectDir, stdio: 'pipe', timeout: 10_000 });
  git(['add', 'README.md', 'src/payment.ts', 'contract.test.ts']);
  git(['-c', 'user.name=Finding fixture', '-c', 'user.email=fixture@gstack.test', 'commit', '-m', 'Seed existing payment contracts']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
}
