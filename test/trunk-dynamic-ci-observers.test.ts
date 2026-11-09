/**
 * Trunk Dynamic CI observers (GST-1400, GST-1847; docs/TESTING_INTERNALS.md).
 *
 * Trunk keys its verdicts by workflow file, so every observed workflow carries
 * its own learning-only `trunk-dynamic-ci` job. Each one must stay an observer:
 * same-repository pull requests only, one pinned action, no checkout, no
 * GITHUB_TOKEN scopes, fail-open at step and job level, no outputs, and no job
 * that needs it or reads it. Then a mode change in Trunk's dashboard can never
 * skip, gate or fail a check, and the token never reaches fork pull requests or
 * pull-request code.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const OBSERVED: Record<string, string> = {
  'free-tests.yml': 'free-suite,macos-named-regressions',
  'windows-smoke.yml': 'windows-smoke',
  'windows-scoped-tests.yml': 'windows-scoped-shard',
  'windows-setup-e2e.yml': 'windows-setup,held-install-journey',
  'quality-gate.yml': 'quality',
  'evals.yml': 'build-image,eval-slices',
};
const SECRET_REF = /secrets\s*(?:\.|\[)\s*['"]?[A-Za-z0-9_-]*|toJSON\(\s*secrets\b/gi;

describe('Trunk Dynamic CI observers', () => {
  // Value: protects=the learning-only contract for every observed workflow; fails_when=an observer runs on forks or non-PR events, checks out or runs code, gains token scopes, loses fail-open, exports outputs, names a job its workflow lacks, or any job needs or reads it, or the action is unpinned; seam=.github/workflows/*.yml; no_claim=what Trunk recommends
  for (const [file, keys] of Object.entries(OBSERVED)) {
    test(`${file}: observes ${keys} and nothing reads it`, () => {
      const wf = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8')) as any;
      expect(Object.keys(wf.on)).toContain('pull_request');
      const trunk = wf.jobs['trunk-dynamic-ci'];
      expect(trunk.if).toBe("github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository");
      expect(trunk['runs-on']).toBe('ubuntu-24.04');
      expect(trunk.permissions).toEqual({});
      expect(trunk['continue-on-error']).toBe(true);
      expect(trunk['timeout-minutes']).toBe(5);
      expect(trunk.outputs).toBeUndefined();
      expect(trunk.needs).toBeUndefined();
      expect(trunk.env).toEqual({ TRUNK_API_TOKEN: '${{ secrets.TRUNK_API_TOKEN }}' });
      expect(trunk.steps).toHaveLength(1);
      const [step] = trunk.steps;
      expect(step.uses).toBe('trunk-io/dynamic-ci@5bcddbf3615c2b032c21eed1b514c91164bda4a8');
      expect(step.run).toBeUndefined();
      expect(step.if).toBe("env.TRUNK_API_TOKEN != ''");
      expect(step['continue-on-error']).toBe(true);
      expect(step['timeout-minutes']).toBe(3);
      expect(step.env).toEqual({ TRUNK_DISABLE_TELEMETRY: 'true' });
      expect(step.with).toEqual({ token: '${{ env.TRUNK_API_TOKEN }}', 'job-keys': keys, 'github-token': '', 'enable-annotation': 'true' });
      for (const key of keys.split(',')) expect([key, wf.jobs[key] !== undefined]).toEqual([key, true]);
      for (const [name, job] of Object.entries(wf.jobs as Record<string, any>).filter(([n]) => n !== 'trunk-dynamic-ci')) {
        expect([name, [job.needs ?? []].flat().includes('trunk-dynamic-ci')]).toEqual([name, false]);
        const text = JSON.stringify(job);
        const mentions = name === 'trunk-flaky-tests' && file === 'free-tests.yml' ? /dynamic-ci|TRUNK_API_TOKEN/i.test(text) : /trunk|dynamic-ci|TRUNK_API_TOKEN/i.test(text);
        expect([name, mentions]).toEqual([name, false]);
      }
      const trunkRefs = (JSON.stringify(wf.jobs).match(SECRET_REF) ?? []).filter(ref => ref === 'secrets.TRUNK_API_TOKEN');
      expect(trunkRefs).toEqual(['secrets.TRUNK_API_TOKEN']);
    });
  }
});
