/**
 * GST-1775 (GBRA-347, gbrain#8730): /ship Step 16 stage 2.1 inserted a Step 9 for edits after the review bound on a gate-class
 * diff. `gstack-review-plan --post-review --pass 2 --last full` printed NEXT: voices with the voices' DISPATCH lines, and Step 11's
 * `gstack-review-dispatch pass --voices` with the same plan flags printed PASS: none, so the voices the plan asked for could not run.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';

setDefaultTimeout(180_000);
const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

function postReviewBranch(): { repo: FixtureRepo; flags: string[] } {
  const repo = makeFixtureRepo({ prefix: 'gst1775-voices-' });
  repos.push(repo);
  repo.git('checkout', '-q', '-b', 'feat');
  const edit = (code: string, msg: string) => {
    fs.mkdirSync(path.join(repo.work, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'src/charge.ts'), code);
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', msg);
    return repo.git('rev-parse', 'HEAD');
  };
  const rangeBase = edit('export const spend_cap_usd = 5;\n', 'feature');
  edit('export const spend_cap_usd = 5;\nexport const retries = 2;\n', 'edit after the review bound');
  return { repo, flags: ['--gate-tagged', '1', '--post-review', '--pass', '2', '--last', 'full', '--range-base', rangeBase, '--pass1-depth', 'full'] };
}
const dispatchLines = (out: string) => out.split('\n').filter(l => l.startsWith('DISPATCH: ')).map(l => l.split(' ')[1]);

describe('GST-1775: a post-review NEXT: voices plan dispatches through pass --voices', () => {
  // Value: protects=Step 11 renders exactly the voices a NEXT: voices plan lists, so plan and dispatch agree;
  //   fails_when=pass --voices prints PASS: none for NEXT: voices, or renders a reader the plan does not list;
  //   seam=gstack-review-plan --post-review and gstack-review-dispatch pass --voices; no_claim=the readers' replies
  test('pass --voices builds the voices manifest the NEXT: voices plan names; without --voices it is still no reviewer pass', () => {
    const { repo, flags } = postReviewBranch();
    const plan = runBin(repo, 'gstack-review-plan', ['--base', 'main', ...flags]);
    expect(plan.status, plan.err).toBe(0);
    expect(plan.out).toContain('NEXT: voices');
    const planned = dispatchLines(plan.out);
    expect(planned).toEqual(['adversarial-native', 'outside-voice', 'targeted']);

    const out = path.join(repo.root, 'p2-voices');
    const pass = runBin(repo, 'gstack-review-dispatch', ['pass', '--base', 'main', '--out', out, '--pass', 'p2-voices', '--voices', '--', ...flags]);
    expect(pass.status, pass.err).toBe(0);
    expect(pass.out).not.toContain('PASS: none');
    expect(pass.out).toMatch(/MANIFEST: file=\S+ pass=p2-voices readers=3 first=0 specialists=0 red-team=0 voices=3/);
    const m = JSON.parse(fs.readFileSync(pass.out.match(/MANIFEST: file=(\S+)/)![1]!, 'utf8'));
    expect(m.next).toBe('voices');
    expect(m.voices_only).toBe(true);
    expect(m.readers.map((r: any) => [r.role, r.stage]).sort()).toEqual(planned.map(r => [r, 'voices']).sort());

    const noVoices = runBin(repo, 'gstack-review-dispatch', ['pass', '--base', 'main', '--out', path.join(repo.root, 'p3'), '--pass', 'p3', '--', ...flags]);
    expect(noVoices.status, noVoices.err).toBe(0);
    expect(noVoices.out).toContain('PASS: none next=voices');
  });
});
