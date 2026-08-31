/**
 * Empty `find | xargs ls -t` must not fall through to cwd (#2483).
 *
 * GNU xargs runs `ls -t` once even on EMPTY input, and `ls -t` with no
 * operands lists the CURRENT DIRECTORY — so on a fresh install (no
 * ceo-plans / checkpoints / plans yet) a random cwd .md becomes "the plan"
 * or "the latest checkpoint". `xargs -r` pins the BSD skip-on-empty
 * behavior on both GNU and BSD (same shape as the landed
 * bin/gstack-codex-session-import fix, #2482).
 *
 * Re-derived from community PR #2483 by @tranthanhnhatkhoa.
 */
import { describe, test, expect } from 'bun:test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HOST_PATHS } from '../scripts/resolvers/types';
import type { TemplateContext } from '../scripts/resolvers/types';
import { generateContextRecovery } from '../scripts/resolvers/preamble/generate-context-recovery';

const ROOT = path.join(import.meta.dir, '..');

function makeCtx(): TemplateContext {
  return {
    skillName: 'test-skill',
    tmplPath: 'test.tmpl',
    host: 'claude',
    paths: HOST_PATHS.claude,
    preambleTier: 2,
  };
}

describe('empty find must not fall through to cwd (#2483)', () => {
  test('no resolver emits a bare `xargs ls -t` (must be `xargs -r ls -t`)', () => {
    const out = execSync(
      `grep -rn "xargs ls -t" "${path.join(ROOT, 'scripts')}" "${path.join(ROOT, 'bin')}" || true`,
      { encoding: 'utf-8', timeout: 30_000 },
    );
    expect(out.trim()).toBe('');
  });

  test('rendered Context Recovery uses the guarded form at both find sites', () => {
    const rendered = generateContextRecovery(makeCtx());
    const bareSites = rendered.split('xargs ls -t').length - 1;
    expect(bareSites).toBe(0);
    const guardedSites = rendered.split('xargs -r ls -t').length - 1;
    expect(guardedSites).toBe(2);
  });

  test('live block: empty checkpoints dir yields NO checkpoint, not a cwd file', () => {
    const rendered = generateContextRecovery(makeCtx());
    const m = rendered.match(/_LATEST_CP=\$\(.*\)/);
    expect(m).not.toBeNull();
    const line = m![0];

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cwd-'));
    try {
      // Fresh install shape: the checkpoints dir exists but is EMPTY,
      // and the cwd holds a decoy markdown file.
      const proj = path.join(home, 'projects', 'unknown');
      fs.mkdirSync(path.join(proj, 'checkpoints'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'DECOY.md'), '# not a checkpoint\n');

      const script = `_PROJ="${proj}"\n${line.replace(/\$\{_PROJ\}|"\$_PROJ"/g, '"$_PROJ"')}\necho "LATEST_CP=[$_LATEST_CP]"`;
      const out = execSync(`bash -c '${script.replace(/'/g, `'\\''`)}'`, {
        cwd,
        encoding: 'utf-8',
        timeout: 30_000,
      });
      expect(out).toContain('LATEST_CP=[]');
      expect(out).not.toContain('DECOY.md');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('no generated SKILL.md carries the unguarded form', () => {
    const out = execSync(
      `grep -rln "xargs ls -t" --include=SKILL.md "${ROOT}" || true`,
      { encoding: 'utf-8', timeout: 30_000 },
    );
    // node_modules and vendored trees are not generated output; nothing in
    // the repo's generated skills may carry the unguarded form.
    const hits = out
      .split('\n')
      .filter(Boolean)
      .filter((f) => !f.includes('node_modules'))
    // The workspace-local .claude/ install is not generated output and can
    // carry dangling symlinks from unrelated sessions.
    .filter((f) => !f.includes('/.claude/'));
    expect(hits).toEqual([]);
  });
});
