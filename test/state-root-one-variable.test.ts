/**
 * One variable moves every store (W1). With only GSTACK_HOME, only
 * GSTACK_STATE_ROOT or only GSTACK_STATE_DIR pointing at a temp dir, the
 * config, egress ledger, trust-policy store, telemetry and analytics log, hook
 * error log, and the root uninstall reports all resolve under that directory,
 * and nothing lands in $HOME/.gstack.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveStateRoot } from '../lib/state-root';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');

for (const variable of ['GSTACK_HOME', 'GSTACK_STATE_ROOT', 'GSTACK_STATE_DIR'] as const) {
  describe(`only ${variable} set`, () => {
    test('every store resolves under it', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-one-var-'));
      try {
        const root = path.join(tmp, 'root');
        const home = path.join(tmp, 'home');
        const cwd = path.join(tmp, 'cwd');
        for (const d of [root, home, cwd]) fs.mkdirSync(d, { recursive: true });
        const env: Record<string, string> = {
          ...(process.env as Record<string, string>),
          HOME: home, GSTACK_HOME: '', GSTACK_STATE_ROOT: '', GSTACK_STATE_DIR: '', CLAUDE_PLUGIN_DATA: '',
          GSTACK_TEST_LEGACY_ROOT: '', [variable]: root,
          GSTACK_SUPABASE_URL: 'https://telemetry.fixture.invalid', GSTACK_SUPABASE_ANON_KEY: 'fixture-anon-key',
        };
        expect(resolveStateRoot(env)).toBe(root);
        const run = (cmd: string, args: string[], input?: string) =>
          spawnSync(cmd, args, { cwd, env, input, encoding: 'utf-8', timeout: 30_000 });

        // config
        expect(run('bash', [path.join(BIN, 'gstack-config'), 'set', 'telemetry', 'anonymous']).status).toBe(0);
        expect(fs.readFileSync(path.join(root, 'config.yaml'), 'utf-8')).toContain('telemetry: anonymous');
        // telemetry + analytics log
        expect(run('bash', [path.join(BIN, 'gstack-telemetry-log'), '--skill', 'qa', '--duration', '1', '--outcome', 'success', '--session-id', 'one-var-1', '--no-sweep']).status).toBe(0);
        expect(fs.readFileSync(path.join(root, 'analytics', 'skill-usage.jsonl'), 'utf-8')).toContain('"skill":"qa"');
        // egress ledger
        const receipt = run('bun', [path.join(BIN, 'gstack-egress-receipt'), 'write', '--sink', 'test', '--host', 'example.invalid', '--class', 'test', '--no-payload', '--consent', 'test']);
        expect(receipt.status).toBe(0);
        expect(fs.existsSync(path.join(root, 'security', 'egress.jsonl'))).toBe(true);
        // trust-policy store
        expect(run('bash', [path.join(BIN, 'gstack-gbrain-repo-policy'), 'set', 'https://github.com/a/b', 'deny']).status).toBe(0);
        expect(fs.existsSync(path.join(root, 'gbrain-repo-policy.json'))).toBe(true);
        // hook error log
        const hook = run('bash', [path.join(ROOT, 'hosts', 'claude', 'hooks', 'question-log-hook')], '{not json');
        expect(hook.status).toBe(0);
        expect(fs.readFileSync(path.join(root, 'hook-errors.log'), 'utf-8')).toContain('question-log-hook');
        // uninstall target: a non-default root is reported, never deleted
        const skillsGstack = path.join(home, '.claude', 'skills', 'gstack');
        fs.mkdirSync(path.dirname(skillsGstack), { recursive: true });
        const un = run('bash', [path.join(BIN, 'gstack-uninstall'), '--force']);
        expect(un.status).toBe(0);
        expect(un.stderr).toContain(`left in place: ${root} (selected by ${variable}=${root})`);
        expect(un.stderr).toContain(`fix: after checking it, remove it with rm -rf -- '${root}'`);
        expect(fs.existsSync(path.join(root, 'config.yaml'))).toBe(true);

        expect(fs.existsSync(path.join(home, '.gstack'))).toBe(false);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
}
