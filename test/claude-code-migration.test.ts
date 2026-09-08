import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { migrateClaudeCodeSkills } from '../lib/claude-code-migration';

const ROOT = path.resolve(import.meta.dir, '..');
const banner = '<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->';
const skill = (name: string, host = '') => `---\nname: ${name}\n---\n${banner}\n${host}\n`;
function put(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-rename-test-'));
  const root = path.join(dir, 'checkout'); const home = path.join(dir, 'home');
  const codex = path.join(home, 'custom-codex', 'skills');
  const kiro = path.join(home, '.kiro', 'skills');
  for (const rel of ['bin/gstack-claude-code', 'lib/claude-code.ts', 'lib/claude-code-windows-job.ts', 'lib/claude-bin.ts', 'lib/outside-review-result.ts']) put(path.join(root, rel), rel);
  const oldRender = path.join(root, '.agents', 'skills', 'gstack-claude');
  put(path.join(oldRender, 'SKILL.md'), skill('gstack-claude'));
  fs.mkdirSync(codex, { recursive: true }); fs.mkdirSync(kiro, { recursive: true });
  const calls: string[] = []; const messages: string[] = [];
  const render = (host: string, out: string) => {
    calls.push(host);
    const subdir = host === 'codex' ? '.agents' : `.${host}`;
    // Native generation keeps the unprefixed frontmatter name even though
    // the installed directory is namespaced (gstack-claude-code).
    put(path.join(out, subdir, 'skills', 'gstack-claude-code', 'SKILL.md'), skill('claude-code', host));
    put(path.join(out, subdir, 'skills', 'gstack-review', 'SKILL.md'), skill('gstack-review', `${host} native outside provider`));
    put(path.join(out, subdir, 'skills', 'gstack-review', 'sections', 'gate.md'), `${banner}\n${host} native gate`);
    put(path.join(out, subdir, 'skills', 'gstack', 'SKILL.md'), skill('gstack', host));
    put(path.join(out, subdir, 'skills', 'gstack-office-hours', 'SKILL.md'), skill('gstack-office-hours', `${host} native consultation`));
    put(path.join(out, subdir, 'skills', 'gstack-upgrade', 'SKILL.md'), skill('gstack-upgrade', `./setup --host ${host}`));
  };
  const run = (overrides: Partial<Parameters<typeof migrateClaudeCodeSkills>[0]> = {}) => migrateClaudeCodeSkills({
    installDir: root, home, env: { CODEX_HOME: path.dirname(codex) }, render,
    log: line => messages.push(line), ...overrides,
  });
  return { dir, root, home, codex, kiro, oldRender, calls, messages, render, run };
}

describe('Claude wrapper installed-name migration', () => {
  test('migrates existing Codex and Kiro installs independently of the selected setup host', () => {
    const f = fixture();
    try {
      fs.symlinkSync(f.oldRender, path.join(f.codex, 'gstack-claude'));
      put(path.join(f.kiro, 'gstack-claude', 'SKILL.md'), skill('gstack-claude'));
      put(path.join(f.kiro, 'gstack-claude', 'notes.md'), 'user notes');
      put(path.join(f.kiro, 'gstack-review', 'SKILL.md'), skill('gstack-review', 'old Codex-shaped Kiro output'));
      put(path.join(f.kiro, 'gstack-review', 'sections', 'gate.md'), `${banner}\nold Codex gate`);
      put(path.join(f.kiro, 'gstack-review', 'sections', 'notes.md'), 'user section notes');
      put(path.join(f.kiro, 'gstack', 'office-hours', 'SKILL.md'), skill('gstack-office-hours', 'old consultation'));
      put(path.join(f.kiro, 'gstack', 'gstack-upgrade', 'SKILL.md'), skill('gstack-upgrade', 'old upgrade'));
      const result = f.run({ copy: true, render: (host, out) => {
        // Both old installations remain readable until that replacement renders.
        const old = path.join(host === 'codex' ? f.codex : f.kiro, 'gstack-claude', 'SKILL.md');
        expect(fs.existsSync(old)).toBe(true);
        f.render(host, out);
      } });
      expect(result).toEqual({ migrated: 2, pending: [] });
      expect(f.calls).toEqual(['codex', 'kiro']);
      for (const [host, dir] of [['codex', f.codex], ['kiro', f.kiro]]) {
        expect(fs.readFileSync(path.join(dir, 'gstack-claude-code', 'SKILL.md'), 'utf8')).toContain(host);
        expect(fs.existsSync(path.join(dir, 'gstack-claude', 'SKILL.md'))).toBe(false);
        expect(fs.readFileSync(path.join(dir, 'gstack', 'bin', 'gstack-claude-code'), 'utf8')).toBe('bin/gstack-claude-code');
      }
      expect(fs.readFileSync(path.join(f.kiro, 'gstack-claude', 'notes.md'), 'utf8')).toBe('user notes');
      expect(fs.readFileSync(path.join(f.kiro, 'gstack-review', 'SKILL.md'), 'utf8')).toContain('kiro native outside provider');
      expect(fs.readFileSync(path.join(f.kiro, 'gstack-review', 'SKILL.md.before-claude-code'), 'utf8')).toContain('old Codex-shaped');
      expect(fs.readFileSync(path.join(f.kiro, 'gstack-review', 'sections', 'gate.md'), 'utf8')).toContain('kiro native gate');
      expect(fs.readFileSync(path.join(f.kiro, 'gstack-review', 'sections', 'notes.md'), 'utf8')).toBe('user section notes');
      expect(fs.readFileSync(path.join(f.kiro, 'gstack', 'office-hours', 'SKILL.md'), 'utf8')).toContain('kiro native consultation');
      expect(fs.readFileSync(path.join(f.kiro, 'gstack', 'gstack-upgrade', 'SKILL.md'), 'utf8')).toContain('./setup --host kiro');
      expect(fs.existsSync(path.join(f.codex, 'gstack-review'))).toBe(false); // no new installs
      expect(fs.existsSync(f.oldRender)).toBe(false);
      expect(f.messages).toHaveLength(1);
      expect(f.run()).toEqual({ migrated: 0, pending: [] });
      expect(f.messages).toHaveLength(1); // notice is emitted only for a migration
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('repairs dangling owned links after a standalone build and leaves unrelated Codex output unchanged', () => {
    const f = fixture();
    try {
      fs.symlinkSync(f.oldRender, path.join(f.codex, 'gstack-claude'));
      fs.rmSync(f.oldRender, { recursive: true });
      const other = path.join(f.root, '.agents', 'skills', 'gstack-review', 'SKILL.md');
      put(other, 'Codex Sol profile');
      expect(f.run().migrated).toBe(1);
      expect(fs.lstatSync(path.join(f.codex, 'gstack-claude-code')).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(other, 'utf8')).toBe('Codex Sol profile');
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('failed generation preserves the old installed skill and shared render for retry', () => {
    const f = fixture();
    try {
      fs.symlinkSync(f.oldRender, path.join(f.codex, 'gstack-claude'));
      const result = f.run({ render: () => { throw new Error('fixture generation failure'); } });
      expect(result.pending).toEqual([f.codex]);
      expect(fs.readFileSync(path.join(f.codex, 'gstack-claude', 'SKILL.md'), 'utf8')).toContain('gstack-claude');
      expect(fs.existsSync(path.join(f.codex, 'gstack-claude-code'))).toBe(false);
      expect(f.run().migrated).toBe(1);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('foreign old/replacement skills, links, runtime directories and render links are preserved', () => {
    for (const conflict of ['old', 'old-one-line-banner', 'old-escaped-link', 'replacement', 'replacement-link', 'runtime', 'render-link']) {
      const f = fixture();
      try {
        const foreign = path.join(f.dir, 'foreign');
        put(path.join(foreign, 'SKILL.md'), 'my skill');
        const old = path.join(f.codex, 'gstack-claude');
        if (conflict === 'old') fs.symlinkSync(foreign, old);
        else if (conflict === 'old-one-line-banner') put(path.join(old, 'SKILL.md'), '<!-- AUTO-GENERATED from my own tool -->');
        else if (conflict === 'old-escaped-link') {
          fs.rmSync(f.oldRender, { recursive: true });
          fs.symlinkSync(foreign, f.oldRender);
          fs.symlinkSync(f.oldRender, old);
        }
        else fs.symlinkSync(f.oldRender, old);
        if (conflict === 'replacement') put(path.join(f.codex, 'gstack-claude-code', 'SKILL.md'), 'my skill');
        if (conflict === 'replacement-link') fs.symlinkSync(foreign, path.join(f.codex, 'gstack-claude-code'));
        if (conflict === 'runtime') put(path.join(f.codex, 'gstack', 'SKILL.md'), 'my skill');
        if (conflict === 'render-link') fs.symlinkSync(foreign, path.join(f.root, '.agents', 'skills', 'gstack-claude-code'));
        const result = f.run();
        expect(result.migrated).toBe(0);
        expect(fs.existsSync(path.join(old, 'SKILL.md'))).toBe(true);
        expect(fs.readFileSync(path.join(foreign, 'SKILL.md'), 'utf8')).toBe('my skill');
      } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
    }
  });

  test('a missing runtime or malformed replacement cannot retire the original', () => {
    for (const failure of ['runtime', 'render']) {
      const f = fixture();
      try {
        fs.symlinkSync(f.oldRender, path.join(f.codex, 'gstack-claude'));
        if (failure === 'runtime') fs.rmSync(path.join(f.root, 'lib/claude-code.ts'));
        const result = f.run(failure === 'render' ? { render: (_host, out) => put(path.join(out, '.agents/skills/gstack-claude-code/SKILL.md'), skill('wrong')) } : {});
        expect(result.pending).toEqual([f.codex]);
        expect(fs.existsSync(path.join(f.codex, 'gstack-claude', 'SKILL.md'))).toBe(true);
      } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
    }
  });

  test('retirement preserves customized copied content without retaining the old command', () => {
    const f = fixture();
    try {
      const old = path.join(f.kiro, 'gstack-claude');
      const customized = skill('gstack-claude', 'my extra instructions');
      put(path.join(old, 'SKILL.md'), customized);
      put(path.join(old, 'SKILL.md.before-claude-code'), 'earlier backup');
      expect(f.run().migrated).toBe(1);
      expect(fs.existsSync(path.join(old, 'SKILL.md'))).toBe(false);
      expect(fs.readFileSync(path.join(old, 'SKILL.md.before-claude-code'), 'utf8')).toBe('earlier backup');
      expect(fs.readFileSync(path.join(old, 'SKILL.md.before-claude-code.1'), 'utf8')).toBe(customized);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('setup runs migration before its first build and defers only the retired Claude render', () => {
    const setup = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');
    const migration = setup.indexOf('GSTACK_RENAME_COPY="$IS_WINDOWS" bun_cmd');
    expect(migration).toBeGreaterThan(-1);
    expect(migration).toBeLessThan(setup.indexOf('bun_cmd run build'));
    expect(setup).toContain('export GSTACK_DEFER_CLAUDE_RENAME_PRUNE=1');
    expect(setup).toContain('unset GSTACK_DEFER_CLAUDE_RENAME_PRUNE');
    expect(setup).toContain('[ "$n" = "gstack-claude" ]');
    const version = path.join(ROOT, 'gstack-upgrade/migrations/v1.83.0.0.sh');
    expect(fs.statSync(version).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(version, 'utf8')).toContain('gstack-migrate-claude-code');
  });
});
