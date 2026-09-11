import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runBashScript } from './helpers/bash-script';

const setup = fs.readFileSync(path.resolve(import.meta.dir, '../setup'), 'utf8');
const banner = '<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->';
const skill = (name: string, body: string) => `---\nname: ${name}\n---\n${banner}\n${body}\n`;
const put = (file: string, value: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const fn = (name: string) => {
  const start = setup.indexOf(`${name}() {`);
  const end = setup.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`missing setup helper: ${name}`);
  return setup.slice(start, end + 2);
};
const blockStart = setup.indexOf('# 6. Install for Kiro CLI');
const block = setup.slice(blockStart, setup.indexOf('# 6b.', blockStart));
const helpers = [
  '_link_or_copy', '_sidecar_root_user_owned', '_claude_entry_is_ours',
  '_claude_entry_owned_strongly', '_gstack_link_target_abs', '_gstack_target_is_ours',
  '_gstack_generated_header', '_backup_skill_md', '_prune_stale_generated',
  '_skill_source_exists', '_owned_for_windows_refresh', '_cleanup_weak_dir',
].map(fn).join('\n');

describe.skipIf(process.platform === 'win32')('native Kiro setup installation', () => {
  for (const windowsCopy of [0, 1]) {
    test(`installs native skills/sections and leaves live Codex output unchanged (copy=${windowsCopy})`, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-kiro-native-'));
      const root = path.join(tmp, 'payload');
      const home = path.join(tmp, 'home');
      const installed = path.join(home, '.kiro/skills');
      const generated = path.join(root, '.kiro/skills');
      try {
        for (const rel of ['bin/tool', 'lib/helper.ts', 'browse/dist/browse', 'browse/bin/helper', 'supabase/config.sh']) put(path.join(root, rel), rel);
        for (const name of ['gstack', 'gstack-upgrade', 'gstack-office-hours', 'gstack-review', 'gstack-autoplan', 'gstack-codex', 'gstack-claude-code']) {
          put(path.join(generated, name, 'SKILL.md'), skill(name, 'kiro native; ./setup --host kiro'));
          if (name !== 'gstack') put(path.join(root, name.replace(/^gstack-/, ''), 'SKILL.md.tmpl'), `name: ${name}`);
        }
        put(path.join(generated, 'gstack-autoplan/sections/ceo.md'), `${banner}\nKiro native phase`);
        put(path.join(installed, 'gstack-autoplan/SKILL.md'), skill('gstack-autoplan', 'old Codex output'));
        put(path.join(installed, 'gstack-autoplan/sections/ceo.md'), `${banner}\nold Codex phase`);
        put(path.join(installed, 'gstack-autoplan/sections/notes.md'), 'user notes');
        put(path.join(installed, 'gstack-review/SKILL.md'), 'a foreign review skill');
        const codex = path.join(root, '.agents/skills/gstack-review/SKILL.md');
        put(codex, 'unchanged Codex Sol output');
        const log = path.join(tmp, 'bun.log');
        const result = runBashScript([
          'set -e', helpers, 'log() { :; }', '_browser_hint() { :; }',
          'bun_cmd() { printf "%s\\n" "$*" >> "$BUN_LOG"; }',
          'INSTALL_KIRO=1', `IS_WINDOWS=${windowsCopy}`, 'BROWSE_BIN=unused',
          '_BACKED_UP_SKILL_MDS=()', '_SKILL_BACKUP_ROOT="$HOME/backups"',
          'KIRO_SKILLS="$HOME/.kiro/skills"', block,
        ].join('\n'), {
          env: { ...process.env, HOME: home, SOURCE_GSTACK_DIR: root, BUN_LOG: log }, timeout: 30_000,
        });
        expect(result.stderr).not.toContain('command not found');
        expect(result.status).toBe(0);
        expect(fs.readFileSync(log, 'utf8')).toBe('run gen:skill-docs --host kiro\n');
        expect(fs.readFileSync(codex, 'utf8')).toBe('unchanged Codex Sol output');
        for (const name of ['gstack-codex', 'gstack-claude-code', 'gstack-autoplan']) {
          expect(fs.readFileSync(path.join(installed, name, 'SKILL.md'), 'utf8')).toContain('kiro native');
        }
        expect(fs.readFileSync(path.join(installed, 'gstack/gstack-upgrade/SKILL.md'), 'utf8')).toContain('./setup --host kiro');
        expect(fs.readFileSync(path.join(installed, 'gstack/office-hours/SKILL.md'), 'utf8')).toContain('kiro native');
        expect(fs.readFileSync(path.join(installed, 'gstack-autoplan/sections/ceo.md'), 'utf8')).toContain('Kiro native phase');
        expect(fs.readFileSync(path.join(installed, 'gstack-autoplan/sections/notes.md'), 'utf8')).toBe('user notes');
        expect(fs.readFileSync(path.join(installed, 'gstack-review/SKILL.md'), 'utf8')).toBe('a foreign review skill');
        expect(fs.existsSync(path.join(installed, 'gstack/bin/tool'))).toBe(true);
        expect(fs.existsSync(path.join(installed, 'gstack/lib/helper.ts'))).toBe(true);
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    });
  }
});
