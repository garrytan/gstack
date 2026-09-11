import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { beginReview, finishReview } from '../lib/review-session';
import { readCurrentReview } from '../lib/review-reader';

const roots: string[] = []; const git = (cwd: string, args: string[]) => { const r = spawnSync('/usr/bin/git', args, { timeout: 30_000, cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() { const root = mkdtempSync(join(tmpdir(), 'review-session-')); roots.push(root); const cwd = join(root, 'repo'), state = join(root, 'state'); mkdirSync(cwd); mkdirSync(state); mkdirSync(join(root, 'config')); mkdirSync(join(cwd, '.gstack')); git(cwd, ['init', '-b', 'main']); git(cwd, ['config', 'user.name', 'T']); git(cwd, ['config', 'user.email', 't@e']); writeFileSync(join(cwd, '.gstack/work-profile.yaml'), readFileSync(join(import.meta.dir, 'fixtures/work-profile/shadow.yaml'))); writeFileSync(join(cwd, 'src.txt'), 'x'); git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'base']); const sha = git(cwd, ['rev-parse', 'HEAD']); git(cwd, ['switch', '-c', 'feature']); writeFileSync(join(root, 'config/workspace-registry.toml'), `[registry]\nversion=2\n[[entry]]\nid="fixture"\npath="repo"\nkind="repository"\nremote_required=false\ntrusted_base_ref="refs/heads/main"\nactive=true\n`); return { cwd, state, sha }; }
describe('atomic review begin/finish', () => {
  test('local-only begin uses registry SHA and finish stamps one protected clean row', () => { const f = fixture(); let fetches = 0; const begun = beginReview({ cwd: f.cwd, stateRoot: f.state, skill: 'review', assertTargetSha: f.sha, onFetch: () => fetches++ }); expect(fetches).toBe(0); expect(begun.trusted_base_source).toBe('registry_pinned_commit'); const finished = finishReview({ cwd: f.cwd, stateRoot: f.state, runId: begun.run_id, payload: { skill: 'review', status: 'clean', tree: 'forged' } }); expect(finished.status).toBe('clean'); expect(finished.tree).not.toBe('forged'); });
  test('movement between begin and finish records stale and never clean', () => { const f = fixture(); const begun = beginReview({ cwd: f.cwd, stateRoot: f.state, skill: 'review', assertTargetSha: f.sha }); writeFileSync(join(f.cwd, 'src.txt'), 'moved'); const finished = finishReview({ cwd: f.cwd, stateRoot: f.state, runId: begun.run_id, payload: { skill: 'review', status: 'clean' } }); expect(finished.status).toBe('stale'); expect(finished.stale_reasons).toContain('subject_changed'); });
  test('wrong assertion kind fails before writing', () => { const f = fixture(); expect(() => beginReview({ cwd: f.cwd, stateRoot: f.state, skill: 'review', assertTargetRef: 'main' })).toThrow('trusted_base_assertion_kind_mismatch'); });
  test('current-capability reads select the protected clean review and explain later movement', () => {
    const f = fixture();
    const begun = beginReview({ cwd: f.cwd, stateRoot: f.state, skill: 'review', assertTargetSha: f.sha });
    finishReview({ cwd: f.cwd, stateRoot: f.state, runId: begun.run_id, payload: { skill: 'review', status: 'clean', capability_id: 'review.code' } });
    expect(readCurrentReview({ cwd: f.cwd, stateHome: f.state, capability: 'review.code', assertTargetSha: f.sha })).toMatchObject({ current: true, reasons: [] });
    writeFileSync(join(f.cwd, 'src.txt'), 'moved');
    expect(readCurrentReview({ cwd: f.cwd, stateHome: f.state, capability: 'review.code', assertTargetSha: f.sha })).toMatchObject({ current: false, primary_reason: 'subject_changed' });
  });
});
