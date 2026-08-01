import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatePreambleBash } from '../scripts/resolvers/preamble/generate-preamble-bash';
import { generateBrowseSetup } from '../scripts/resolvers/browse';
import { generateDesignSetup } from '../scripts/resolvers/design';
import { generateMakePdfSetup } from '../scripts/resolvers/make-pdf';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function claudeContext(skillName = 'qa'): TemplateContext {
  return {
    skillName,
    tmplPath: path.join(ROOT, skillName, 'SKILL.md.tmpl'),
    host: 'claude',
    paths: HOST_PATHS.claude,
    preambleTier: 2,
  };
}

function preambleBash(skillName = 'qa'): string {
  const markdown = generatePreambleBash(claudeContext(skillName));
  const match = markdown.match(/```bash\n([\s\S]*?)\n```/);
  if (!match) throw new Error('generated preamble has no bash block');
  return match[1];
}

function extractSetupFunction(name: string): string {
  const start = SETUP.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`missing ${name}() in setup`);
  const end = SETUP.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`missing end of ${name}() in setup`);
  return SETUP.slice(start, end + 3);
}

function writeExecutable(file: string, body: string): void {
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

function createStubRuntime(home: string, name: string): string {
  const install = path.join(home, '.claude', 'skills', name);
  const bin = path.join(install, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const common = 'printf "%s %s\\n" "$0" "$*" >> "$CALLS"';
  writeExecutable(path.join(bin, 'gstack-update-check'), common);
  writeExecutable(path.join(bin, 'gstack-config'), `${common}\ncase "$*" in *telemetry*) echo off ;; *proactive*) echo false ;; *skill_prefix*) echo false ;; *explain_level*) echo default ;; *question_tuning*) echo false ;; *routing_declined*) echo true ;; *checkpoint_mode*) echo explicit ;; *checkpoint_push*) echo false ;; *) echo false ;; esac`);
  writeExecutable(path.join(bin, 'gstack-repo-mode'), `${common}\necho REPO_MODE=solo`);
  writeExecutable(path.join(bin, 'gstack-session-kind'), `${common}\necho headless`);
  writeExecutable(path.join(bin, 'gstack-slug'), `${common}\necho SLUG=portable-test`);
  for (const executable of ['gstack-first-task-detect', 'gstack-learnings-search', 'gstack-timeline-log', 'gstack-telemetry-log']) {
    writeExecutable(path.join(bin, executable), common);
  }
  return install;
}

function runPreamble(home: string, cwd: string, calls: string, overrides: Record<string, string | undefined> = {}) {
  const env = { ...process.env, HOME: home, CALLS: calls, GSTACK_HEADLESS: '1' } as Record<string, string>;
  delete env.GSTACK_ROOT;
  delete env.CLAUDE_PLUGIN_ROOT;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const script = `${preambleBash()}\nprintf 'ROOT=%s\\nBIN=%s\\n' "$GSTACK_ROOT" "$GSTACK_BIN"\n`;
  return spawnSync('bash', ['-c', script], { cwd, env, encoding: 'utf8' });
}

describe('portable generated skill paths (#1882)', () => {
  test('preamble defines and exports every runtime path before its first binary call', () => {
    const bash = preambleBash();
    const rootAt = bash.indexOf('GSTACK_ROOT=');
    const firstCallAt = bash.indexOf('_UPD=$("$GSTACK_BIN/gstack-update-check"');
    expect(rootAt).toBeGreaterThanOrEqual(0);
    expect(firstCallAt).toBeGreaterThan(rootAt);
    expect(bash).toContain('GSTACK_MAKE_PDF="$GSTACK_ROOT/make-pdf/dist"');
    expect(bash).toContain('export GSTACK_ROOT GSTACK_BIN GSTACK_BROWSE GSTACK_DESIGN GSTACK_MAKE_PDF');
  });

  test('non-gstack install marker drives real preamble binary calls', () => {
    const home = tempDir('gstack-portable-home-');
    const calls = path.join(home, 'calls.log');
    const install = createStubRuntime(home, 'renamed gstack');
    const bin = path.join(install, 'bin');
    fs.writeFileSync(path.join(home, '.claude', 'skills', '.gstack-root'), `${install}\n`);
    const result = runPreamble(home, home, calls);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`ROOT=${install}`);
    expect(result.stdout).toContain(`BIN=${bin}`);
    expect(fs.readFileSync(calls, 'utf8')).toContain(`${bin}/gstack-config get proactive`);
  });

  test('explicit and plugin roots take precedence over the user marker', () => {
    const home = tempDir('gstack-portable-precedence-');
    const calls = path.join(home, 'calls.log');
    const marker = createStubRuntime(home, 'marker root');
    const plugin = createStubRuntime(home, 'plugin root');
    const explicit = createStubRuntime(home, 'explicit root');
    fs.writeFileSync(path.join(home, '.claude', 'skills', '.gstack-root'), `${marker}\n`);

    const explicitResult = runPreamble(home, home, calls, { GSTACK_ROOT: explicit, CLAUDE_PLUGIN_ROOT: plugin });
    expect(explicitResult.stdout).toContain(`ROOT=${explicit}`);

    fs.writeFileSync(calls, '');
    const pluginResult = runPreamble(home, home, calls, { CLAUDE_PLUGIN_ROOT: plugin });
    expect(pluginResult.stdout).toContain(`ROOT=${plugin}`);
    expect(fs.readFileSync(calls, 'utf8')).toContain(`${plugin}/bin/gstack-config get proactive`);
  });

  test('invalid marker falls back to the canonical user install', () => {
    const home = tempDir('gstack-portable-fallback-');
    const calls = path.join(home, 'calls.log');
    const canonical = createStubRuntime(home, 'gstack');
    fs.writeFileSync(path.join(home, '.claude', 'skills', '.gstack-root'), `${path.join(home, 'missing')}\n`);

    const result = runPreamble(home, home, calls);
    expect(result.stdout).toContain(`ROOT=${canonical}`);
    expect(fs.readFileSync(calls, 'utf8')).toContain(`${canonical}/bin/gstack-config get proactive`);
  });

  test('repository marker cannot redirect a global skill to repo-controlled binaries', () => {
    const home = tempDir('gstack-portable-trust-');
    const repo = tempDir('gstack-portable-repo-');
    const calls = path.join(home, 'calls.log');
    const trusted = createStubRuntime(home, 'trusted root');
    const attacker = createStubRuntime(repo, 'attacker root');
    fs.mkdirSync(path.join(repo, '.claude', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'skills', '.gstack-root'), `${attacker}\n`);
    fs.writeFileSync(path.join(home, '.claude', 'skills', '.gstack-root'), `${trusted}\n`);

    const result = runPreamble(home, repo, calls);
    expect(result.stdout).toContain(`ROOT=${trusted}`);
    expect(fs.readFileSync(calls, 'utf8')).not.toContain(attacker);
  });

  test('Claude generated bodies contain no canonical self-path literals', () => {
    const generated: string[] = [path.join(ROOT, 'SKILL.md')];
    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const file = path.join(ROOT, entry.name, 'SKILL.md');
      if (fs.existsSync(file)) generated.push(file);
      const sections = path.join(ROOT, entry.name, 'sections');
      if (fs.existsSync(sections)) {
        for (const section of fs.readdirSync(sections)) {
          if (section.endsWith('.md') && !section.endsWith('.md.tmpl')) generated.push(path.join(sections, section));
        }
      }
    }

    for (const file of generated) {
      const content = fs.readFileSync(file, 'utf8');
      const fmEnd = content.startsWith('---\n') ? content.indexOf('\n---', 4) : -1;
      const body = fmEnd >= 0 ? content.slice(fmEnd + 4) : content;
      expect(body, path.relative(ROOT, file)).not.toContain('~/.claude/skills/gstack');
      expect(body, path.relative(ROOT, file)).not.toContain('$HOME/.claude/skills/gstack');
      expect(body, path.relative(ROOT, file)).not.toContain('$_ROOT/$GSTACK_ROOT');
      expect(body, path.relative(ROOT, file)).not.toContain('$HOME/$GSTACK_ROOT');
    }
  });

  test('hook frontmatter keeps the pre-preamble $HOME anchor', () => {
    for (const skill of ['careful', 'freeze', 'guard']) {
      const content = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf8');
      const fmEnd = content.indexOf('\n---', 4);
      const frontmatter = content.slice(0, fmEnd);
      expect(frontmatter).toContain('$HOME/.claude/skills/gstack/');
      expect(frontmatter).not.toContain('$GSTACK_ROOT');
    }
  });

  test('browse, design, and make-pdf setup resolve env-var paths without a $HOME prefix', () => {
    const ctx = claudeContext();
    const browse = generateBrowseSetup(ctx);
    const design = generateDesignSetup(ctx);
    const pdf = generateMakePdfSetup(ctx);
    expect(browse).toContain('B="$GSTACK_BROWSE/browse"');
    expect(design).toContain('D="$GSTACK_DESIGN/design"');
    expect(design).toContain('B="$GSTACK_BROWSE/browse"');
    expect(pdf).toContain('P="$GSTACK_MAKE_PDF/pdf"');
    for (const output of [browse, design, pdf]) {
      expect(output).not.toContain('$HOME$GSTACK_');
    }
  });
});

describe('setup portable root registration (#1882)', () => {
  const helpers = [
    extractSetupFunction('_link_or_copy'),
    extractSetupFunction('record_claude_runtime_root'),
    extractSetupFunction('validate_claude_hook_runtime_root'),
    extractSetupFunction('ensure_claude_hook_runtime_root'),
  ].join('\n');

  function runSetupHelpers(withCanonicalCollision = false) {
    const home = tempDir('gstack-setup-portable-');
    const skills = path.join(home, '.claude', 'skills');
    const source = path.join(skills, 'renamed gstack');
    fs.mkdirSync(path.join(source, 'careful', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(source, 'freeze', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(source, 'careful', 'bin', 'check-careful.sh'), 'careful\n');
    fs.writeFileSync(path.join(source, 'freeze', 'bin', 'check-freeze.sh'), 'freeze\n');
    if (withCanonicalCollision) fs.mkdirSync(path.join(skills, 'gstack'), { recursive: true });

    const script = `set -e\nIS_WINDOWS=0\nlog() { :; }\n${helpers}\nvalidate_claude_hook_runtime_root "${source}" "${skills}"\nensure_claude_hook_runtime_root "${source}" "${skills}"\nrecord_claude_runtime_root "${source}" "${skills}"\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    return { home, skills, source, result };
  }

  test('records renamed checkout and creates a narrow hook-only sidecar', () => {
    const { skills, source, result } = runSetupHelpers();
    const runtime = path.join(skills, 'gstack');
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(skills, '.gstack-root'), 'utf8').trim()).toBe(source);
    expect(fs.lstatSync(runtime).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(runtime, 'careful', 'bin', 'check-careful.sh'))).toBe(true);
    expect(fs.existsSync(path.join(runtime, 'freeze', 'bin', 'check-freeze.sh'))).toBe(true);
    expect(fs.existsSync(path.join(runtime, 'SKILL.md'))).toBe(false);
  });

  test('refuses to clobber a canonical install owned by someone else', () => {
    const { skills, result } = runSetupHelpers(true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('owned by a different install');
    expect(fs.existsSync(path.join(skills, '.gstack-root'))).toBe(false);
  });

  test('a checkout merely named gstack still gets a sidecar outside the canonical location', () => {
    const home = tempDir('gstack-setup-basename-');
    const skills = path.join(home, '.claude', 'skills');
    const source = path.join(home, 'checkout', 'gstack');
    fs.mkdirSync(path.join(source, 'careful', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(source, 'freeze', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(source, 'careful', 'bin', 'check-careful.sh'), 'careful\n');
    fs.writeFileSync(path.join(source, 'freeze', 'bin', 'check-freeze.sh'), 'freeze\n');
    fs.mkdirSync(skills, { recursive: true });
    const script = `IS_WINDOWS=0\nlog() { :; }\n${helpers}\nensure_claude_hook_runtime_root "${source}" "${skills}"\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(skills, 'gstack', 'careful', 'bin', 'check-careful.sh'))).toBe(true);
  });

  test('accepts a same-source canonical symlink and rejects a foreign one', () => {
    const home = tempDir('gstack-setup-symlink-');
    const skills = path.join(home, '.claude', 'skills');
    const source = path.join(home, 'renamed');
    const foreign = path.join(home, 'foreign');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(foreign, { recursive: true });
    fs.mkdirSync(skills, { recursive: true });
    fs.symlinkSync(source, path.join(skills, 'gstack'));
    let script = `IS_WINDOWS=0\nlog() { :; }\n${helpers}\nensure_claude_hook_runtime_root "${source}" "${skills}"\n`;
    expect(spawnSync('bash', ['-c', script]).status).toBe(0);
    fs.unlinkSync(path.join(skills, 'gstack'));
    fs.symlinkSync(foreign, path.join(skills, 'gstack'));
    script = `IS_WINDOWS=0\nlog() { :; }\n${helpers}\nensure_claude_hook_runtime_root "${source}" "${skills}"\n`;
    expect(spawnSync('bash', ['-c', script]).status).not.toBe(0);
    expect(fs.realpathSync(path.join(skills, 'gstack'))).toBe(fs.realpathSync(foreign));
  });

  test('refreshes an existing managed sidecar for a newly activated install', () => {
    const home = tempDir('gstack-setup-refresh-');
    const skills = path.join(home, '.claude', 'skills');
    const first = path.join(home, 'first');
    const second = path.join(home, 'second');
    for (const source of [first, second]) {
      fs.mkdirSync(path.join(source, 'careful', 'bin'), { recursive: true });
      fs.mkdirSync(path.join(source, 'freeze', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(source, 'careful', 'bin', 'owner'), path.basename(source));
      fs.writeFileSync(path.join(source, 'freeze', 'bin', 'owner'), path.basename(source));
    }
    fs.mkdirSync(skills, { recursive: true });
    const script = `IS_WINDOWS=0\nlog() { :; }\n${helpers}\nensure_claude_hook_runtime_root "${first}" "${skills}"\nensure_claude_hook_runtime_root "${second}" "${skills}"\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(skills, 'gstack', '.gstack-hook-runtime'), 'utf8').trim()).toBe(second);
    expect(fs.readFileSync(path.join(skills, 'gstack', 'careful', 'bin', 'owner'), 'utf8')).toBe('second');
  });

  test('setup wires registration into both Claude install branches', () => {
    expect(SETUP.match(/record_claude_runtime_root "\$SOURCE_GSTACK_DIR" "\$INSTALL_SKILLS_DIR"/g)?.length).toBe(2);
    expect(SETUP.match(/ensure_claude_hook_runtime_root "\$SOURCE_GSTACK_DIR" "\$INSTALL_SKILLS_DIR"/g)?.length).toBe(2);
    expect(SETUP.indexOf('validate_claude_hook_runtime_root "$SOURCE_GSTACK_DIR" "$INSTALL_SKILLS_DIR"')).toBeLessThan(
      SETUP.indexOf('link_claude_skill_dirs "$SOURCE_GSTACK_DIR" "$INSTALL_SKILLS_DIR"'),
    );
  });
});
