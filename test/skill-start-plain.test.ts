/**
 * GST-882: the skill-start fence must be plain shell a static resolver can
 * follow. Hermes's Tirith 0.4.2 blocks a grouped fallback
 * (`[ -d … ]||{ …; exit 1;}`) and any variable-selected command with HIGH
 * "Nested executable body could not be resolved", which no allowlist entry can
 * clear, so every gstack skill start was denied. An install-root render names
 * the literal start path; every render keeps a loud failure when gstack is
 * missing.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ALL_HOST_CONFIGS } from '../hosts';
import { generatePreambleBash } from '../scripts/resolvers/preamble/generate-preamble-bash';
import { insertRuntimePreludes, runtimeRootPrelude } from '../scripts/resolvers/runtime-root';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gst882-'));
const ctx = (host: string, installRoot: string | null) =>
  ({ host, paths: HOST_PATHS[host], skillName: 'ship', tmplPath: '', model: 'claude', installRoot }) as TemplateContext;
const startFence = (c: TemplateContext) => insertRuntimePreludes(generatePreambleBash(c), c).match(/```bash\n([\s\S]*?)\n```/)![1];
const GROUPED = /(?:^|[;&|]\s*)\{\s|exit 1;\s*\}/m;
const sh = (body: string, env: Record<string, string>, cwd = tmp) =>
  spawnSync('bash', ['-uc', body], { cwd, encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin', ...env } });
function stubStart(root: string) {
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'gstack-skill-start'), '#!/bin/sh\necho "STARTED $0 $*"\n', { mode: 0o755 });
}

describe('skill-start fence is plain shell on every host (GST-882)', () => {
  for (const host of ALL_HOST_CONFIGS) {
    for (const installRoot of [null, path.join(tmp, `${host.name}-install`)]) {
      const label = `${host.name} ${installRoot ? 'install-root' : 'checked-in'} render`;
      test(`${label}: no grouped fallback`, () => {
        expect(startFence(ctx(host.name, installRoot))).not.toMatch(GROUPED);
      });
      if (!host.usesEnvVars) continue;
      test(`${label}: a missing install fails loudly`, () => {
        const r = sh(startFence(ctx(host.name, installRoot)), { HOME: path.join(tmp, 'empty-home') });
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain('gstack: no install found');
        expect(r.stderr).toContain(`./setup --host ${host.name}`);
      });
    }
    if (!host.usesEnvVars) continue;
    test(`${host.name} install-root render: the start command is a literal path that runs`, () => {
      const root = path.join(tmp, `${host.name}-literal`);
      const fence = startFence(ctx(host.name, root));
      const command = fence.split('\n').at(-1)!;
      expect(command).toStartWith(`"${root}/bin/gstack-skill-start" --skill "ship"`);
      expect(fence).not.toContain('$');
      stubStart(root);
      const r = sh(fence, { HOME: path.join(tmp, 'empty-home') });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(`STARTED ${root}/bin/gstack-skill-start --skill ship`);
    });
    test(`${host.name} checked-in render: finds the global install`, () => {
      const home = path.join(tmp, `${host.name}-home`);
      const global = path.join(home, host.name === 'codex' ? '.codex/skills/gstack' : host.globalRoot);
      stubStart(global);
      const r = sh(startFence(ctx(host.name, null)), { HOME: home });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('STARTED ');
      expect(r.stdout).toContain('--skill ship');
    });
    test(`${host.name} checked-in render: the start lookup picks the root later fences pick`, () => {
      const base = path.join(tmp, `${host.name}-parity`);
      const home = path.join(base, 'home');
      const repo = path.join(base, 'repo');
      const exported = path.join(base, 'exported');
      stubStart(path.join(home, host.name === 'codex' ? '.codex/skills/gstack' : host.globalRoot));
      fs.mkdirSync(repo, { recursive: true });
      spawnSync('git', ['init', '-q', repo], { timeout: 10_000 });
      const c = ctx(host.name, null);
      const lookup = startFence(c).split('\n').slice(0, -1).join('\n');
      const root = (body: string, env: Record<string, string>) => sh(`${body}\necho "ROOT=$GSTACK_ROOT"`, env, repo).stdout.trim().split('\n').at(-1);
      for (const layout of ['global', 'repo-local', 'exported']) {
        if (layout === 'repo-local') stubStart(path.join(repo, host.localSkillRoot));
        if (layout === 'exported') stubStart(exported);
        const env = layout === 'exported' ? { HOME: home, GSTACK_ROOT: exported } : { HOME: home };
        expect(root(lookup, env)).toBe(root(runtimeRootPrelude(c), env));
        if (layout === 'exported') expect(root(lookup, env)).toBe(`ROOT=${exported}`);
      }
    });
  }
});
