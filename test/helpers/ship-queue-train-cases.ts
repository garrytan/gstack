/** Train setups shared by the test/ship-queue-train*.test.ts files (moved from test/ship-queue-train.test.ts, GSTA-151). */
import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mergeChangelogs } from '../../lib/changelog-check';
import { EXIT } from '../../lib/headless-artifacts';
import { runBin } from './restamp-fixture';
import { GREEN_GATE, line, nonceOf, openPr, queue, readyReceipt, type Rule, type TrainFixture } from './ship-queue-train-fixture';

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

/** The lane's slot stamp on its pin (main merged in first from slot 2 on): gstack-restamp --next, then the stamp files committed and pushed as the PR head. */
export function laneStamp(fx: TrainFixture, pr: string, pin: string, o: { mergeMain?: boolean; dropStamp?: boolean } = {}): string {
  const { repo } = fx;
  repo.git('reset', '-q', '--hard');
  repo.git('fetch', '-q', 'origin');
  repo.git('checkout', '-q', '-B', `lane${pr}`, pin);
  if (o.mergeMain) {
    const m = spawnSync('git', ['merge', '--no-ff', '--no-commit', '-q', 'origin/main'], { cwd: repo.work, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...repo.env } });
    if (m.status !== 0) {
      const side = (n: number) => repo.git('show', `:${n}:CHANGELOG.md`) + '\n';
      fs.writeFileSync(path.join(repo.work, 'CHANGELOG.md'), mergeChangelogs(side(2), side(3), side(1))!);
      repo.git('add', 'CHANGELOG.md');
    }
  }
  const index = repo.git('write-tree');
  const stamp = runBin(repo, 'gstack-restamp', ['--next', '--base', 'main', '--allow-repo-commands'], fx.env);
  expect(stamp.status, stamp.err).toBe(EXIT.ok);
  const files = line(stamp.out, 'FILES:').slice('FILES: '.length).split(' ').filter(Boolean);
  if (o.dropStamp) repo.git('read-tree', index);
  else repo.git('add', '-A', '--', ...files);
  repo.git('commit', '-q', '--no-edit', '-m', `slot stamp #${pr}`);
  if (o.dropStamp) repo.git('checkout', '-q', '--', '.');
  const head = repo.git('rev-parse', 'HEAD');
  repo.git('push', '-q', '-f', 'origin', `${head}:refs/pull/${pr}/head`);
  return head;
}

/** GitHub reports the PR MERGED, which verify --train needs before it confirms a merge (#3531). */
export const markMerged = (fx: TrainFixture, pr: string) => fx.write(d => { (d.prs[pr] as any).state = 'MERGED'; });
