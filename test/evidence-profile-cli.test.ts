import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = []; const evidence = join(import.meta.dir, '..', 'bin/gstack-evidence');
const effectScope = join(import.meta.dir, '..', 'scripts/authority/effect-scope.ts');
const git = (cwd: string, args: string[]) => { const r = spawnSync('/usr/bin/git', args, { timeout: 30_000, cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(effect = 'read'): { cwd: string; home: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), 'evidence-profile-')); roots.push(root); const cwd = join(root, 'repo'); const home = join(root, 'home'); mkdirSync(cwd); mkdirSync(home); mkdirSync(join(root, 'config')); mkdirSync(join(cwd, '.gstack'));
  git(cwd, ['init', '-b', 'main']); git(cwd, ['config', 'user.name', 'Test']); git(cwd, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(cwd, '.gstack/work-profile.yaml'), `schema_version: harness.gstack.work-profile.v1\nsemantic_paths:\n  - glob: src/**\n    roles: [code]\ncapabilities:\n  focused: { version: "1" }\nvalidators:\n  focused:\n    capability: focused\n    execution_effect: ${effect}\n    argv: [/usr/bin/true]\n    required_by_surface: [code]\n    depends_on: [code]\nlanes:\n  docs_ux: { activation: legacy, required_capabilities: [], stage_requirements: {} }\n  single_repo_code: { activation: enforce, required_capabilities: [focused], stage_requirements: {} }\n  cross_repo_contract: { activation: legacy, required_capabilities: [focused], stage_requirements: {} }\nrelease: { mode: none, title_policy: free }\nmetadata_projections: []\ndeploy_targets:\n  none: { id: none, environment_class: none, trigger: none, binding: { adapter_id: none.v1 } }\nrecording:\n  response: response\n  artifact: receipt\n  local_change: session\n  review_receipt: session\n  pr_open: session\n  merged: release\n  deployed: release\n  verified: session\n  operation_result: session\n`); mkdirSync(join(cwd, 'src')); writeFileSync(join(cwd, 'src/a.ts'), 'export {}\n'); git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'base']); const base = git(cwd, ['rev-parse', 'HEAD']); git(cwd, ['switch', '-c', 'feature']);
  writeFileSync(join(root, 'config/workspace-registry.toml'), `[registry]\nversion = 2\n[[entry]]\nid = "fixture"\npath = "repo"\nkind = "repository"\nremote_required = false\ntrusted_base_ref = "refs/heads/main"\nactive = true\n`); return { cwd, home, base };
}
const run = (f: ReturnType<typeof fixture>, args: string[]) => spawnSync(evidence, args, { timeout: 30_000, cwd: f.cwd, env: { ...process.env, GSTACK_HOME: f.home }, encoding: 'utf8' });
describe('profile evidence CLI', () => {
  test('check is read-only and ensure runs only on a miss before reusing its v2 receipt', () => {
    const f = fixture(); expect(run(f, ['check', '--validator', 'focused', '--assert-target-sha', f.base, '--json']).status).toBe(1);
    const ensured = run(f, ['ensure', '--validator', 'focused', '--assert-target-sha', f.base, '--json']); expect(ensured.status).toBe(0); expect(JSON.parse(ensured.stdout).disposition).toBe('live_pass');
    const current = run(f, ['ensure', '--validator', 'focused', '--assert-target-sha', f.base, '--json']); expect(current.status).toBe(0); expect(JSON.parse(current.stdout).disposition).toBe('receipt_current'); expect(run(f, ['check', '--validator', 'focused', '--assert-target-sha', f.base, '--json']).status).toBe(0);
  });
  test('paid profile validators return grant_required without spawning', () => { const f = fixture('paid_model'); const result = run(f, ['ensure', '--validator', 'focused', '--assert-target-sha', f.base, '--json']); expect(result.status).toBe(3); expect(JSON.parse(result.stdout)).toMatchObject({ disposition: 'grant_required', spawned: false }); });
  test('the effect boundary consumes an explicit grant and calls shared check-first in the same process', () => {
    const f = fixture('paid_model');
    const args = [effectScope, 'ensure-paid-validator', '--skill', 'ship', '--validator-id', 'focused', '--lane', 'single_repo_code', '--assert-target-sha', f.base, '--json'];
    const first = spawnSync(process.execPath, args, { timeout: 30_000, cwd: f.cwd, env: { ...process.env, GSTACK_HOME: f.home, ECPE_PAID_MODEL_AUTHORIZED: '1' }, encoding: 'utf8' });
    expect({ status: first.status, stdout: first.stdout, stderr: first.stderr }).toMatchObject({ status: 0 }); expect(JSON.parse(first.stdout)).toMatchObject({ disposition: 'live_pass', spawned: true });
    const second = spawnSync(process.execPath, args, { timeout: 30_000, cwd: f.cwd, env: { ...process.env, GSTACK_HOME: f.home, ECPE_PAID_MODEL_AUTHORIZED: '1' }, encoding: 'utf8' });
    expect(second.status).toBe(0); expect(JSON.parse(second.stdout)).toMatchObject({ disposition: 'receipt_current', spawned: false });
  });
});
