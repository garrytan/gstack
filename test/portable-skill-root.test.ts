import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatePreambleBash } from '../scripts/resolvers/preamble/generate-preamble-bash';
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

describe('portable generated skill paths (#1882)', () => {
  test('preamble defines and exports every runtime path before its first binary call', () => {
    const bash = preambleBash();
    const rootAt = bash.indexOf('GSTACK_ROOT=');
    const firstCallAt = bash.indexOf('_UPD=$($GSTACK_BIN/gstack-update-check');
    expect(rootAt).toBeGreaterThanOrEqual(0);
    expect(firstCallAt).toBeGreaterThan(rootAt);
    expect(bash).toContain('GSTACK_MAKE_PDF="$GSTACK_ROOT/make-pdf/dist"');
    expect(bash).toContain('export GSTACK_ROOT GSTACK_BIN GSTACK_BROWSE GSTACK_DESIGN GSTACK_MAKE_PDF');
  });

  test('non-gstack install marker drives real preamble binary calls', () => {
    const home = tempDir('gstack-portable-home-');
    const install = path.join(home, '.claude', 'skills', 'i-gstack');
    const bin = path.join(install, 'bin');
    const calls = path.join(home, 'calls.log');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'skills', '.gstack-root'), `${install}\n`);

    const common = 'printf "%s %s\\n" "$0" "$*" >> "$CALLS"';
    writeExecutable(path.join(bin, 'gstack-update-check'), common);
    writeExecutable(path.join(bin, 'gstack-config'), `${common}\ncase "$*" in *telemetry*) echo off ;; *proactive*) echo false ;; *skill_prefix*) echo false ;; *explain_level*) echo default ;; *question_tuning*) echo false ;; *routing_declined*) echo true ;; *checkpoint_mode*) echo explicit ;; *checkpoint_push*) echo false ;; *) echo false ;; esac`);
    writeExecutable(path.join(bin, 'gstack-repo-mode'), `${common}\necho REPO_MODE=solo`);
    writeExecutable(path.join(bin, 'gstack-session-kind'), `${common}\necho headless`);
    writeExecutable(path.join(bin, 'gstack-slug'), `${common}\necho SLUG=portable-test`);
    for (const name of ['gstack-first-task-detect', 'gstack-learnings-search', 'gstack-timeline-log', 'gstack-telemetry-log']) {
      writeExecutable(path.join(bin, name), common);
    }

    const env = { ...process.env, HOME: home, CALLS: calls, GSTACK_HEADLESS: '1' } as Record<string, string>;
    delete env.GSTACK_ROOT;
    delete env.CLAUDE_PLUGIN_ROOT;
    const script = `${preambleBash()}\nprintf 'ROOT=%s\\nBIN=%s\\n' "$GSTACK_ROOT" "$GSTACK_BIN"\n`;
    const result = spawnSync('bash', ['-c', script], { cwd: home, env, encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`ROOT=${install}`);
    expect(result.stdout).toContain(`BIN=${bin}`);
    expect(fs.readFileSync(calls, 'utf8')).toContain(`${bin}/gstack-config get proactive`);
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
});

describe('setup portable root registration (#1882)', () => {
  const helpers = [
    extractSetupFunction('_link_or_copy'),
    extractSetupFunction('record_claude_runtime_root'),
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

    const script = `IS_WINDOWS=0\nlog() { :; }\n${helpers}\nrecord_claude_runtime_root "${source}" "${skills}"\nensure_claude_hook_runtime_root "${source}" "${skills}"\n`;
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
    const { result } = runSetupHelpers(true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('owned by a different install');
  });

  test('setup wires registration into both Claude install branches', () => {
    expect(SETUP.match(/record_claude_runtime_root "\$SOURCE_GSTACK_DIR" "\$INSTALL_SKILLS_DIR"/g)?.length).toBe(2);
    expect(SETUP.match(/ensure_claude_hook_runtime_root "\$SOURCE_GSTACK_DIR" "\$INSTALL_SKILLS_DIR"/g)?.length).toBe(2);
  });
});
