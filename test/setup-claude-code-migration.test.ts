/** Full setup ordering: repair another installed host before build/link/prune. */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const BANNER = '<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->';
const oldSkill = (name: string) => `---\nname: ${name}\n---\n${BANNER}\nold working installation\n`;
function put(file: string, text: string, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
}

function fixture(copy: boolean) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-setup-rename-'));
  const root = path.join(temp, 'checkout');
  const home = path.join(temp, 'home');
  const codexHome = path.join(home, '.codex');
  const skills = path.join(codexHome, 'skills');
  const events = path.join(temp, 'events.log');
  const shims = path.join(temp, 'shims');
  // Real setup, generator, resolver and migration code; only dependency
  // installation and binary compilation are stubbed to keep this test free.
  for (const dir of ['scripts', 'hosts', 'lib', 'model-overlays', 'browse/src', 'design/src', 'openclaw/templates']) {
    fs.cpSync(path.join(ROOT, dir), path.join(root, dir), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, 'setup'), path.join(root, 'setup'));
  put(path.join(root, 'VERSION'), '2.0.0.0\n');
  put(path.join(root, 'ETHOS.md'), 'Fixture ethos\n');
  put(path.join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { 'gen:skill-docs': 'bun run scripts/gen-skill-docs.ts' } }));
  for (const bin of ['gstack-config', 'gstack-patch-names', 'gstack-relink', 'gstack-migrate-claude-code', 'gstack-claude-code']) {
    const target = path.join(root, 'bin', bin);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'bin', bin), target);
  }
  // Include the required versioned hook too: it runs after host linking and
  // must be idempotent with the early setup repair, including failed retries.
  const migrationDir = path.join(ROOT, 'gstack-upgrade/migrations');
  for (const file of fs.readdirSync(migrationDir).filter(name => name.endsWith('.sh'))) {
    const content = fs.readFileSync(path.join(migrationDir, file), 'utf8');
    if (content.includes('gstack-migrate-claude-code')) put(path.join(root, 'gstack-upgrade/migrations', file), content, 0o755);
  }
  put(path.join(home, '.gstack/.last-setup-version'), '1.0.0.0\n');
  // Limit the fixture's skills, retaining real resolver calls and real native
  // lazy sections without copying unrelated skills' runtime data.
  put(path.join(root, 'SKILL.md.tmpl'), '---\nname: gstack\ndescription: Fixture router.\n---\n{{OUTSIDE_VOICE_ROUTING}}\n');
  for (const skill of ['review', 'claude-code', 'codex']) {
    fs.mkdirSync(path.join(root, skill), { recursive: true });
    fs.copyFileSync(path.join(ROOT, skill, 'SKILL.md.tmpl'), path.join(root, skill, 'SKILL.md.tmpl'));
    const sections = path.join(ROOT, skill, 'sections');
    if (fs.existsSync(sections)) {
      for (const file of fs.readdirSync(sections).filter(name => name.endsWith('.tmpl') || name === 'manifest.json')) {
        put(path.join(root, skill, 'sections', file), fs.readFileSync(path.join(sections, file), 'utf8'));
      }
    }
  }
  put(path.join(root, 'open-gstack-browser/SKILL.md.tmpl'), '---\nname: open-gstack-browser\ndescription: Fixture browser.\n---\nBrowser fixture.\n');
  // Observe actual isolated/live generation and inject only an isolated
  // generation failure. Later setup generation still runs the real generator.
  const generator = path.join(root, 'scripts/gen-skill-docs.ts');
  const source = fs.readFileSync(generator, 'utf8').replace(/^#![^\n]*\n/, '');
  fs.writeFileSync(generator, `const fixtureIsolated = process.argv.includes('--out-dir');
(await import('node:fs')).appendFileSync(process.env.FIXTURE_EVENTS!, 'generate:' + (fixtureIsolated ? 'isolated' : 'live') + ':defer=' + (process.env.GSTACK_DEFER_CLAUDE_RENAME_PRUNE ?? '0') + '\\n');
if (fixtureIsolated && process.env.FIXTURE_RENAME_FAIL === '1') { console.error('fixture isolated generation failure'); process.exit(70); }
${source}`);
  put(path.join(shims, 'bun'), `#!/usr/bin/env bash
set -e
case "$1" in
  install) exit 0 ;;
esac
if [ "$1" = run ] && [ "$2" = build ]; then
  printf 'build\\n' >> "$FIXTURE_EVENTS"
  "$FIXTURE_REAL_BUN" run scripts/gen-skill-docs.ts --host all
  for target in browse/dist/browse design/dist/design make-pdf/dist/pdf; do
    mkdir -p "$(dirname "$target")"
    printf '#!/usr/bin/env bash\\nexit 0\\n' > "$target"
    chmod +x "$target"
  done
  exit 0
fi
if [ "$1" = run ] && [ "$2" = gen:skill-docs ]; then
  shift 2
  exec "$FIXTURE_REAL_BUN" run scripts/gen-skill-docs.ts "$@"
fi
exec "$FIXTURE_REAL_BUN" "$@"
`, 0o755);
  const oldRender = path.join(root, '.agents/skills/gstack-claude');
  put(path.join(oldRender, 'SKILL.md'), oldSkill('gstack-claude'));
  fs.mkdirSync(skills, { recursive: true });
  if (copy) put(path.join(skills, 'gstack-claude/SKILL.md'), oldSkill('gstack-claude'));
  else fs.symlinkSync(oldRender, path.join(skills, 'gstack-claude'));
  put(path.join(skills, 'gstack-review/SKILL.md'), oldSkill('gstack-review'));
  put(path.join(skills, 'gstack-review/notes.md'), 'user notes\n');
  put(path.join(codexHome, 'config.toml'), 'model = "gpt-5.6-sol"\n');
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome,
    GSTACK_HOME: path.join(home, '.gstack'), GSTACK_STATE_ROOT: path.join(home, '.gstack'),
    GSTACK_SKIP_PLAYWRIGHT: '1', GSTACK_SKIP_FONTS: '1', GSTACK_SKIP_COREUTILS: '1', GSTACK_SKIP_ASIDE: '1',
    GSTACK_SKIP_GBRAIN_REGEN: '1', GSTACK_PLAN_TUNE_HOOKS: 'no', GSTACK_TIMELINE_STOP_HOOK: 'no',
    PATH: `${shims}${path.delimiter}${process.env.PATH}`, FIXTURE_REAL_BUN: process.execPath, FIXTURE_EVENTS: events,
  };
  const run = (failure = false) => spawnSync('bash', [path.join(root, 'setup'), '--host', 'claude', '--no-prefix', '--no-team'], {
    cwd: root, env: { ...env, FIXTURE_RENAME_FAIL: failure ? '1' : '0' }, encoding: 'utf8', timeout: 30_000,
  });
  return { temp, root, home, skills, events, oldRender, run };
}

describe.skipIf(process.platform === 'win32')('full setup repairs the installed Claude wrapper through another host', () => {
  for (const copy of [false, true]) {
    test(`Claude-only setup migrates existing Codex, survives later generation/linking, and repeats safely (copy=${copy})`, () => {
      const f = fixture(copy);
      try {
        // The real generator runs before the stubbed dependency-install step.
        // Exercise that ordering with no node_modules in the source checkout.
        expect(fs.existsSync(path.join(f.root, 'node_modules'))).toBe(false);
        const result = f.run();
        expect({ code: result.status, stderr: result.stderr }).toMatchObject({ code: 0 });
        expect(result.stdout).toContain('gstack ready (claude)');
        expect(result.stderr).toContain('/claude is now /claude-code');
        const next = path.join(f.skills, 'gstack-claude-code/SKILL.md');
        expect(fs.readFileSync(next, 'utf8')).toContain('name: claude-code');
        expect(fs.existsSync(path.join(f.skills, 'gstack-claude/SKILL.md'))).toBe(false);
        expect(fs.existsSync(f.oldRender)).toBe(false);
        expect(fs.readFileSync(path.join(f.skills, 'gstack-review/SKILL.md'), 'utf8')).toContain('gstack-claude-code');
        expect(fs.readFileSync(path.join(f.skills, 'gstack-review/notes.md'), 'utf8')).toBe('user notes\n');
        expect(fs.readFileSync(path.join(f.root, '.agents/skills/gstack-review/SKILL.md'), 'utf8')).toContain('Model-Specific Behavioral Patch (gpt-5.6-sol)');
        expect(fs.existsSync(path.join(f.skills, 'gstack/bin/gstack-claude-code'))).toBe(true);
        expect(fs.existsSync(path.join(f.skills, 'gstack/lib/outside-review-result.ts'))).toBe(true);
        const fakeCli = path.join(f.temp, 'fake-reviewer.ts');
        put(fakeCli, "await Bun.stdin.text(); console.log(JSON.stringify({result:'NO_FINDINGS',session_id:'installed-session'}));\n");
        const installed = spawnSync(process.execPath, [path.join(f.skills, 'gstack/bin/gstack-claude-code'),
          '--cwd', f.root, '--access', 'none', '--timeout-ms', '3000'], {
          env: { ...process.env, GSTACK_CLAUDE_BIN: process.execPath, GSTACK_CLAUDE_BIN_ARGS: JSON.stringify([fakeCli]) },
          input: 'Review through the migrated runtime.', encoding: 'utf8', timeout: 5000,
        });
        expect({ code: installed.status, stderr: installed.stderr }).toMatchObject({ code: 0 });
        expect(JSON.parse(installed.stdout)).toMatchObject({ status: 'completed', provider: 'claude-code', session_id: 'installed-session' });
        expect(fs.existsSync(path.join(f.home, '.claude/skills/review/SKILL.md'))).toBe(true);
        expect(fs.existsSync(path.join(f.home, '.claude/skills/claude-code/SKILL.md'))).toBe(false);
        expect(fs.readFileSync(f.events, 'utf8')).toMatch(/generate:isolated:defer=1\nbuild\ngenerate:live:defer=0/);
        const repeated = f.run();
        expect(repeated.status).toBe(0);
        expect(repeated.stderr).not.toContain('/claude is now');
        expect(fs.readFileSync(next, 'utf8')).toContain('name: claude-code');
      } finally { fs.rmSync(f.temp, { recursive: true, force: true }); }
    }, 60_000);
  }

  test('failed rename keeps the working Codex entry through later build/prune and succeeds on retry', () => {
    const f = fixture(false);
    try {
      const failed = f.run(true);
      expect({ code: failed.status, stderr: failed.stderr }).toMatchObject({ code: 0 });
      expect(failed.stdout).toContain('gstack ready (claude)');
      expect(failed.stderr).toContain('fixture isolated generation failure');
      expect(fs.readFileSync(path.join(f.skills, 'gstack-claude/SKILL.md'), 'utf8')).toContain('old working installation');
      expect(fs.readFileSync(f.events, 'utf8')).toMatch(/generate:isolated:defer=1\nbuild\ngenerate:live:defer=1/);
      const retry = f.run();
      expect(retry.status).toBe(0);
      expect(fs.existsSync(path.join(f.skills, 'gstack-claude/SKILL.md'))).toBe(false);
      expect(fs.readFileSync(path.join(f.skills, 'gstack-claude-code/SKILL.md'), 'utf8')).toContain('name: claude-code');
    } finally { fs.rmSync(f.temp, { recursive: true, force: true }); }
  }, 60_000);
});
