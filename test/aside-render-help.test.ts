import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EngineChoice, RenderResult } from '../lib/aside-render';

const LIB = path.resolve(import.meta.dir, '../lib/aside-render.ts');
// Isolate the platform override and import-time help text; neither path starts a browser.
const SCRIPT = `
Object.defineProperty(process, 'platform', { value: process.argv[1] });
const M = await import(${JSON.stringify(LIB)});
const choice = M.pickEngine(true, {
  probe: () => ({ ok: false, reason: 'NEEDS_ASIDE', detail: 'unavailable in fixture' }),
  resolveBin: () => null,
});
const fallback = await M.renderWithBrowse({ file: '/nonexistent/help.html', steps: [] }, null);
console.log(JSON.stringify({ help: M.NO_BROWSER_HELP, choice, fallback }));
`;

// Value: protects=missing-browser remedies offer Aside only on macOS and retain the headless-browser setup path;
//   fails_when=shared help recommends Aside on every host or drops a supported remedy;
//   why_new=existing renderer/setup tests require setup advice but not platform-specific remedies; seam=none
test.each(['linux', 'win32', 'darwin'])('missing-browser advice offers only supported remedies on %s', platform => {
  const r = spawnSync(process.execPath, ['--no-env-file', '--no-load-bunfig', '-e', SCRIPT, platform], {
    cwd: os.tmpdir(), encoding: 'utf8', timeout: 10_000,
  });
  expect(r.status, r.stderr).toBe(0);
  const result = JSON.parse(r.stdout) as { help: string; choice: EngineChoice; fallback: RenderResult };
  expect(result.choice.engine).toBeNull();
  if (result.choice.engine !== null) return;
  expect(result.fallback.ok).toBe(false);
  for (const [surface, message] of Object.entries({
    help: result.help, pickEngine: result.choice.error, renderWithBrowse: result.fallback.error ?? '',
  })) {
    expect(message, surface).toContain('./setup');
    expect(message, surface).toContain('GSTACK_BROWSE_BIN');
    expect(/\bopen\b[^\n]*\bAside\b/i.test(message), surface).toBe(platform === 'darwin');
  }
}, 15_000);
