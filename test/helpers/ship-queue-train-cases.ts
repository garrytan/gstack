/** Train setups shared by the test/ship-queue-train*.test.ts files (moved from test/ship-queue-train.test.ts, GSTA-151). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GREEN_GATE, nonceOf, openPr, queue, readyReceipt, type Rule, type TrainFixture } from './ship-queue-train-fixture';

export function twoPrTrain(fx: TrainFixture, gate: Rule = GREEN_GATE) {
  const h1 = openPr(fx, '1');
  const h2 = openPr(fx, '2');
  readyReceipt(fx, '1', h1);
  readyReceipt(fx, '2', h2);
  fx.write(d => { d.rules['evals.yml'] = gate; });
  const r = queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`]);
  return { h1, h2, r, nonce: nonceOf(r.out) };
}

/** A main commit with a prefix's tree plus a VERSION stamp, the way stamp-at-merge publishes it. */
export function publishMain(fx: TrainFixture, prefixCommit: string, version: string, extra?: { file: string; text: string }): string {
  const { repo } = fx;
  repo.git('checkout', '-q', '-B', 'mainsim', 'origin/main');
  repo.git('rm', '-rq', '.');
  repo.git('checkout', prefixCommit, '--', '.');
  fs.writeFileSync(path.join(repo.work, 'VERSION'), version + '\n');
  if (extra) fs.writeFileSync(path.join(repo.work, extra.file), extra.text);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', `merge to ${version}`);
  repo.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
  repo.git('fetch', '-q', 'origin');
  return repo.git('rev-parse', 'HEAD');
}
