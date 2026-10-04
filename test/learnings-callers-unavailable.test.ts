/**
 * B5 (#2790): generated learnings-search callers used `2>/dev/null || true`, so
 * a missing bun or a failed search read as "no learnings recorded". Every
 * caller fence now keeps stdout, and on failure prints
 * `LEARNINGS: unavailable (<first stderr line>)`. Executed with a stub search
 * binary on Claude (full mode) and Codex (basic mode, fresh-shell prelude).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runGeneration } from '../scripts/gen-skill-docs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-learnings-callers-'));
const out = path.join(tmp, 'render');
const BUN_MISSING = 'gstack-learnings-search: bun not found on PATH, so learnings could not be read. Fix: install Bun (https://bun.sh), then re-run ./setup.';

const CALLERS: Array<{ name: string; file: (host: string) => string; hosts: string[] }> = [
  { name: 'Prior Learnings (review)', file: h => (h === 'claude' ? 'review/SKILL.md' : '.agents/skills/gstack-review/SKILL.md'), hosts: ['claude', 'codex'] },
  { name: 'investigate hypothesis refresh', file: h => (h === 'claude' ? 'investigate/SKILL.md' : '.agents/skills/gstack-investigate/SKILL.md'), hosts: ['claude', 'codex'] },
  { name: 'qa fix-loop search', file: h => (h === 'claude' ? 'qa/SKILL.md' : '.agents/skills/gstack-qa/SKILL.md'), hosts: ['claude', 'codex'] },
  { name: 'ship adversarial search', file: h => (h === 'claude' ? 'ship/sections/adversarial.md' : '.agents/skills/gstack-ship/sections/adversarial.md'), hosts: ['claude', 'codex'] },
  { name: 'review army specialist search', file: () => 'review/sections/review-army.md', hosts: ['claude'] },
];

function searchFences(file: string): string[] {
  return [...fs.readFileSync(path.join(out, file), 'utf8').matchAll(/^```bash\n([\s\S]*?)\n```$/gm)]
    .map(m => m[1]).filter(body => body.includes('gstack-learnings-search'));
}

function run(fence: string, host: string, stub: string) {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const root = path.join(home, host === 'claude' ? '.claude/skills/gstack' : '.codex/skills/gstack');
  for (const dir of ['bin', 'lib']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'gstack-learnings-search'), `#!/bin/sh\n${stub}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'bin', 'gstack-config'), '#!/bin/sh\necho false\n', { mode: 0o755 });
  const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
  return spawnSync('env', ['-i', `HOME=${home}`, 'PATH=/usr/bin:/bin', 'bash', '-c', fence], { cwd, encoding: 'utf8', timeout: 10_000 });
}

beforeAll(async () => {
  const r = await runGeneration({ host: 'all', outputRoot: out });
  if (r.exitCode !== 0) throw new Error(r.diagnostics.filter(d => d.kind === 'error').map(d => d.message).join('\n'));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('B5: learnings callers report a failed search', () => {
  for (const caller of CALLERS) {
    for (const host of caller.hosts) {
      test(`${host}: ${caller.name}`, () => {
        const fences = searchFences(caller.file(host));
        expect(fences.length).toBeGreaterThan(0);
        for (const fence of fences) {
          const missing = run(fence, host, `echo "${BUN_MISSING}" >&2\necho "second line" >&2\nexit 127`);
          expect(missing.stdout, missing.stderr).toContain(`LEARNINGS: unavailable (${BUN_MISSING})`);
          expect(missing.stdout).not.toContain('second line');

          const silentFail = run(fence, host, 'exit 3');
          expect(silentFail.stdout).toContain('LEARNINGS: unavailable (exit 3)');

          const found = run(fence, host, 'echo "LEARNING: retry-backoff (confidence 8)"');
          expect(found.stdout).toContain('LEARNING: retry-backoff (confidence 8)');
          expect(found.stdout).not.toContain('LEARNINGS: unavailable');

          const none = run(fence, host, 'exit 0');
          expect(none.status).toBe(0);
          expect(none.stdout).not.toContain('LEARNINGS: unavailable');
        }
      });
    }
  }
});
