import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeRuntimeRootBashCompact, generatePreambleBash } from '../scripts/resolvers/preamble/generate-preamble-bash';
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
  fs.writeFileSync(path.join(install, 'VERSION'), 'test\n');
  const common = 'printf "%s %s\\n" "$0" "$*" >> "$CALLS"';
  writeExecutable(path.join(bin, 'gstack-update-check'), common);
  writeExecutable(path.join(bin, 'gstack-runtime-env'), `root="\${GSTACK_RUNTIME_ROOT_OVERRIDE:-$(cd "$(dirname "$0")/.." && pwd -P)}"\nprintf 'GSTACK_ROOT=%q\\nGSTACK_BIN=%q\\nGSTACK_BROWSE=%q\\nGSTACK_DESIGN=%q\\nGSTACK_MAKE_PDF=%q\\n' "$root" "$root/bin" "$root/browse/dist" "$root/design/dist" "$root/make-pdf/dist"\necho 'export GSTACK_ROOT GSTACK_BIN GSTACK_BROWSE GSTACK_DESIGN GSTACK_MAKE_PDF'`);
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
    expect(bash).toContain('echo "GSTACK_ROOT: $GSTACK_ROOT"');
  });

  test('the real runtime-env helper self-locates and shell-quotes overrides', () => {
    const helper = path.join(ROOT, 'bin', 'gstack-runtime-env');
    const self = spawnSync('bash', ['-c', `eval "$(${JSON.stringify(helper)})"; printf '%s\n' "$GSTACK_ROOT"`], {
      encoding: 'utf8',
    });
    expect(self.status).toBe(0);
    expect(self.stdout.trim()).toBe(fs.realpathSync(ROOT));

    const home = tempDir('gstack-runtime-env-quote-');
    const pwned = path.join(home, 'pwned');
    const override = path.join(home, `runtime with spaces;touch ${pwned}`);
    const quoted = spawnSync('bash', ['-c', `eval "$(${JSON.stringify(helper)})"; printf '%s\n' "$GSTACK_ROOT"`], {
      env: { ...process.env, GSTACK_RUNTIME_ROOT_OVERRIDE: override },
      encoding: 'utf8',
    });
    expect(quoted.status).toBe(0);
    expect(quoted.stdout.trim()).toBe(override);
    expect(fs.existsSync(pwned)).toBe(false);
  });

  test('compact bootstrap fails closed and clears inherited derived paths', () => {
    const home = tempDir('gstack-runtime-missing-');
    const script = `${generateClaudeRuntimeRootBashCompact(claudeContext())}\n"$GSTACK_BIN/echo" SHOULD_NOT_RUN\n`;
    const result = spawnSync('bash', ['-c', script], {
      env: { ...process.env, HOME: home, GSTACK_ROOT: '', CLAUDE_PLUGIN_ROOT: '', GSTACK_BIN: '/bin' },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('SHOULD_NOT_RUN');
  });

  test('compact bootstrap reaches canonical fallback under set -e when marker is absent', () => {
    const home = tempDir('gstack-runtime-strict-shell-');
    const install = createStubRuntime(home, 'gstack');
    const script = `set -e\n${generateClaudeRuntimeRootBashCompact(claudeContext())}\nprintf '%s\n' "$GSTACK_ROOT"\n`;
    const result = spawnSync('bash', ['-c', script], {
      env: { ...process.env, HOME: home, GSTACK_ROOT: '', CLAUDE_PLUGIN_ROOT: '' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(install);
    expect(result.stderr).toBe('');
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

  test('foreign plugin roots are ignored and cannot trigger a repository-local fallback', () => {
    const home = tempDir('gstack-portable-foreign-plugin-');
    const repo = tempDir('gstack-portable-foreign-repo-');
    const calls = path.join(home, 'calls.log');
    const trusted = createStubRuntime(home, 'trusted root');
    const foreign = path.join(home, 'foreign-plugin');
    fs.mkdirSync(path.join(foreign, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.claude', 'skills', 'gstack', 'bin'), { recursive: true });
    writeExecutable(
      path.join(repo, '.claude', 'skills', 'gstack', 'bin', 'gstack-update-check'),
      'echo repo-fallback >> "$CALLS"',
    );
    fs.writeFileSync(path.join(home, '.claude', 'skills', '.gstack-root'), `${trusted}\n`);

    const result = runPreamble(home, repo, calls, { CLAUDE_PLUGIN_ROOT: foreign });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`ROOT=${trusted}`);
    expect(fs.readFileSync(calls, 'utf8')).not.toContain('repo-fallback');
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
      const withoutPerBlockBootstrap = body.replace(/^_(?:gv|r=|e=).*$/gm, '');
      expect(withoutPerBlockBootstrap, path.relative(ROOT, file)).not.toContain('~/.claude/skills/gstack');
      expect(withoutPerBlockBootstrap, path.relative(ROOT, file)).not.toContain('$HOME/.claude/skills/gstack');
      expect(withoutPerBlockBootstrap, path.relative(ROOT, file)).not.toContain('$_ROOT/$GSTACK_ROOT');
      expect(withoutPerBlockBootstrap, path.relative(ROOT, file)).not.toContain('$HOME/$GSTACK_ROOT');
      expect(withoutPerBlockBootstrap, path.relative(ROOT, file)).not.toMatch(
        /(^|[^"'])\$(?:GSTACK_ROOT|GSTACK_BIN|GSTACK_BROWSE|GSTACK_DESIGN|GSTACK_MAKE_PDF)\//m,
      );
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

  test('every generated skill using portable paths defines them first', () => {
    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const file = path.join(ROOT, entry.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, 'utf8');
      if (/\$GSTACK_(?:ROOT|BIN|BROWSE|DESIGN|MAKE_PDF)\b/.test(content)) {
        expect(content, entry.name).toMatch(/_GSTACK_ROOT_MARKER=|_gv\(\)/);
        const prose = content.replace(/```(?:bash|sh|shell)\n[\s\S]*?\n```/g, '');
        if (/\$GSTACK_(?:ROOT|BIN|BROWSE|DESIGN|MAKE_PDF)\b/.test(prose)) {
          expect(content, entry.name).toContain('For non-shell');
        }
      }
    }
  });

  test('every shell block using portable paths bootstraps its own shell', () => {
    const files: string[] = [];
    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const skill = path.join(ROOT, entry.name, 'SKILL.md');
      if (fs.existsSync(skill)) files.push(skill);
      const sections = path.join(ROOT, entry.name, 'sections');
      if (fs.existsSync(sections)) {
        for (const file of fs.readdirSync(sections)) {
          if (file.endsWith('.md') && !file.endsWith('.md.tmpl')) files.push(path.join(sections, file));
        }
      }
    }
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      for (const match of content.matchAll(/```(?:bash|sh|shell)\n([\s\S]*?)\n```/g)) {
        if (/\$GSTACK_(?:ROOT|BIN|BROWSE|DESIGN|MAKE_PDF)\b/.test(match[1])) {
          expect(match[1], path.relative(ROOT, file)).toMatch(/_GSTACK_ROOT_MARKER=|gstack-runtime-env/);
        }
      }
    }
  });

  test('a later generated Bash block resolves the runtime in a fresh shell', () => {
    const home = tempDir('gstack-portable-separate-shell-');
    const calls = path.join(home, 'calls.log');
    const install = createStubRuntime(home, 'renamed gstack');
    fs.writeFileSync(path.join(home, '.claude', 'skills', '.gstack-root'), `${install}\n`);
    const upgrade = fs.readFileSync(path.join(ROOT, 'gstack-upgrade', 'SKILL.md'), 'utf8');
    const block = [...upgrade.matchAll(/```bash\n([\s\S]*?)\n```/g)]
      .map(match => match[1])
      .find(body => body.includes('get auto_upgrade'));
    expect(block).toContain('gstack-runtime-env');

    const env = { ...process.env, HOME: home, CALLS: calls } as Record<string, string>;
    delete env.GSTACK_ROOT;
    delete env.GSTACK_BIN;
    delete env.CLAUDE_PLUGIN_ROOT;
    const result = spawnSync('bash', ['-c', block!], { env, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(fs.readFileSync(calls, 'utf8')).toContain(`${install}/bin/gstack-config get auto_upgrade`);
  });

  test('a later shell block never executes a foreign plugin runtime helper', () => {
    const home = tempDir('gstack-portable-shell-foreign-plugin-');
    const calls = path.join(home, 'calls.log');
    const pwned = path.join(home, 'pwned');
    const trusted = createStubRuntime(home, 'trusted runtime');
    const foreign = path.join(home, 'foreign-plugin');
    fs.mkdirSync(path.join(foreign, 'bin'), { recursive: true });
    writeExecutable(path.join(foreign, 'bin', 'gstack-runtime-env'), `touch "${pwned}"`);
    fs.writeFileSync(path.join(home, '.claude', 'skills', '.gstack-root'), `${trusted}\n`);

    const upgrade = fs.readFileSync(path.join(ROOT, 'gstack-upgrade', 'SKILL.md'), 'utf8');
    const block = [...upgrade.matchAll(/```bash\n([\s\S]*?)\n```/g)]
      .map(match => match[1])
      .find(body => body.includes('get auto_upgrade'));
    const env = { ...process.env, HOME: home, CALLS: calls, CLAUDE_PLUGIN_ROOT: foreign } as Record<string, string>;
    delete env.GSTACK_ROOT;
    delete env.GSTACK_BIN;
    const result = spawnSync('bash', ['-c', block!], { env, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(fs.existsSync(pwned)).toBe(false);
    expect(fs.readFileSync(calls, 'utf8')).toContain(`${trusted}/bin/gstack-config get auto_upgrade`);
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

  test('a generated body command executes from a runtime root containing whitespace', () => {
    const home = tempDir('gstack-portable-body-');
    const install = path.join(home, 'renamed gstack body');
    const executable = path.join(install, 'bin', 'gstack-paths');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    writeExecutable(executable, 'echo GSTACK_STATE_ROOT=portable-body');

    const freeze = fs.readFileSync(path.join(ROOT, 'freeze', 'SKILL.md'), 'utf8');
    const command = freeze.split('\n').find(line => line.includes('gstack-paths)"'));
    expect(command).toBe('eval "$("$GSTACK_ROOT"/bin/gstack-paths)"');

    const result = spawnSync('bash', ['-c', `${command}\nprintf '%s\\n' "$GSTACK_STATE_ROOT"`], {
      env: { ...process.env, GSTACK_ROOT: install },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('portable-body');
  });

  test('a generated GSTACK_BIN body command executes when the runtime root contains whitespace', () => {
    const home = tempDir('gstack-portable-bin-body-');
    const bin = path.join(home, 'renamed gstack body', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    writeExecutable(path.join(bin, 'gstack-telemetry-log'), 'echo portable-bin-body');

    const setupDeploy = fs.readFileSync(path.join(ROOT, 'setup-deploy', 'SKILL.md'), 'utf8');
    const command = setupDeploy.split('\n').find(line => line.startsWith('"$GSTACK_BIN"/gstack-telemetry-log '));
    expect(command).toStartWith('"$GSTACK_BIN"/gstack-telemetry-log ');

    const result = spawnSync('bash', ['-c', command!], {
      env: { ...process.env, GSTACK_BIN: bin },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('portable-bin-body');
  });
});

describe('setup portable root registration (#1882)', () => {
  const helpers = [
    extractSetupFunction('_link_or_copy'),
    extractSetupFunction('record_claude_runtime_root'),
    extractSetupFunction('is_canonical_claude_runtime_root'),
    extractSetupFunction('validate_claude_hook_runtime_root'),
    extractSetupFunction('ensure_claude_hook_runtime_root'),
  ].join('\n');

  function runSetupHelpers(withCanonicalCollision = false) {
    const home = tempDir('gstack-setup-portable-');
    const skills = path.join(home, '.claude', 'skills');
    const source = path.join(skills, 'renamed gstack');
    fs.mkdirSync(path.join(source, 'careful', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(source, 'freeze', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(source, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(source, 'careful', 'bin', 'check-careful.sh'), 'careful\n');
    fs.writeFileSync(path.join(source, 'freeze', 'bin', 'check-freeze.sh'), 'freeze\n');
    fs.writeFileSync(path.join(source, 'bin', 'gstack-runtime-env'), 'runtime\n');
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
    expect(fs.existsSync(path.join(runtime, 'bin', 'gstack-runtime-env'))).toBe(true);
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
    const outside = SETUP.indexOf('# Preflight the complete mutation set before replacing the canonical link.');
    const canonicalMutation = SETUP.indexOf('_link_or_copy "$SOURCE_GSTACK_DIR" "$CLAUDE_GSTACK_LINK"', outside);
    expect(outside).toBeGreaterThan(0);
    expect(SETUP.indexOf('validate_claude_hook_runtime_root "$SOURCE_GSTACK_DIR" "$CLAUDE_SKILLS_DIR"', outside))
      .toBeLessThan(canonicalMutation);
    expect(SETUP.indexOf('validate_claude_skill_targets "$SOURCE_GSTACK_DIR" "$CLAUDE_SKILLS_DIR"', outside))
      .toBeLessThan(canonicalMutation);
    expect(SETUP.indexOf('_validate_claude_cleanup_targets "$SOURCE_GSTACK_DIR" "$CLAUDE_SKILLS_DIR"', outside))
      .toBeLessThan(canonicalMutation);
  });

  test('skill registration refuses a foreign non-empty target before overwriting it', () => {
    const home = tempDir('gstack-setup-skill-collision-');
    const source = path.join(home, 'renamed gstack');
    const skills = path.join(home, '.claude', 'skills');
    const target = path.join(skills, 'gstack-qa');
    fs.mkdirSync(path.join(source, 'qa'), { recursive: true });
    fs.writeFileSync(path.join(source, 'qa', 'SKILL.md'), '---\nname: qa\n---\nsource\n');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'foreign\n');
    fs.writeFileSync(path.join(target, 'USER_FILE'), 'preserve\n');

    const script = `set -e\nIS_WINDOWS=0\nSKILL_PREFIX=1\n_print_windows_copy_note_once() { :; }\n${extractSetupFunction('_link_or_copy')}\n${extractSetupFunction('_validate_claude_skill_target')}\n${extractSetupFunction('_claude_post_patch_skill_name')}\n${extractSetupFunction('validate_claude_skill_targets')}\n${extractSetupFunction('link_claude_skill_dirs')}\nlink_claude_skill_dirs "${source}" "${skills}"\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('owned by another skill install');
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe('foreign\n');
    expect(fs.readFileSync(path.join(target, 'USER_FILE'), 'utf8')).toBe('preserve\n');
  });

  test('flat-mode preflight validates the post-patch alias name before cleanup', () => {
    const home = tempDir('gstack-setup-post-patch-name-');
    const source = path.join(home, 'renamed gstack');
    const skills = path.join(home, '.claude', 'skills');
    const target = path.join(skills, 'qa');
    fs.mkdirSync(path.join(source, 'qa'), { recursive: true });
    fs.writeFileSync(path.join(source, 'qa', 'SKILL.md'), '---\nname: gstack-qa\n---\nsource\n');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'foreign\n');

    const script = `set -e\nIS_WINDOWS=0\nSKILL_PREFIX=0\n${extractSetupFunction('_validate_claude_skill_target')}\n${extractSetupFunction('_claude_post_patch_skill_name')}\n${extractSetupFunction('validate_claude_skill_targets')}\nvalidate_claude_skill_targets "${source}" "${skills}"\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('owned by another skill install');
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe('foreign\n');
  });

  test('Unix preflight does not claim an unmarked byte-identical skill directory', () => {
    const home = tempDir('gstack-setup-identical-collision-');
    const source = path.join(home, 'renamed gstack');
    const skills = path.join(home, '.claude', 'skills');
    const target = path.join(skills, 'gstack-qa');
    fs.mkdirSync(path.join(source, 'qa'), { recursive: true });
    fs.writeFileSync(path.join(source, 'qa', 'SKILL.md'), '---\nname: qa\n---\nsame\n');
    fs.mkdirSync(path.join(target, 'sections'), { recursive: true });
    fs.copyFileSync(path.join(source, 'qa', 'SKILL.md'), path.join(target, 'SKILL.md'));
    fs.writeFileSync(path.join(target, 'sections', 'CUSTOM'), 'preserve\n');

    const script = `set -e\nIS_WINDOWS=0\nSKILL_PREFIX=1\n${extractSetupFunction('_validate_claude_skill_target')}\n${extractSetupFunction('_claude_post_patch_skill_name')}\n${extractSetupFunction('validate_claude_skill_targets')}\nvalidate_claude_skill_targets "${source}" "${skills}"\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(path.join(target, 'sections', 'CUSTOM'), 'utf8')).toBe('preserve\n');
  });

  test('Windows preflight migrates a stale generated legacy copy', () => {
    const home = tempDir('gstack-setup-windows-legacy-');
    const source = path.join(home, 'renamed gstack');
    const skills = path.join(home, '.claude', 'skills');
    const target = path.join(skills, 'gstack-qa');
    fs.mkdirSync(path.join(source, 'qa'), { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(skills, '.gstack-root'), `${source}\n`);
    const generated = '<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->';
    fs.writeFileSync(path.join(source, 'qa', 'SKILL.md'), `---\nname: qa\n---\n${generated}\nnew\n`);
    fs.writeFileSync(path.join(target, 'SKILL.md'), `---\nname: gstack-qa\n---\n${generated}\nold\n`);

    const script = `set -e\nIS_WINDOWS=1\nSKILL_PREFIX=1\n${extractSetupFunction('_claude_legacy_windows_skill_copy_owned')}\n${extractSetupFunction('_validate_claude_skill_target')}\n${extractSetupFunction('_claude_post_patch_skill_name')}\n${extractSetupFunction('validate_claude_skill_targets')}\nvalidate_claude_skill_targets "${source}" "${skills}"\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(result.status).toBe(0);
  });

  test('Windows preflight rejects a generated copy not owned by the active runtime', () => {
    const home = tempDir('gstack-setup-windows-foreign-copy-');
    const source = path.join(home, 'source');
    const foreign = path.join(home, 'foreign');
    const skills = path.join(home, '.claude', 'skills');
    const target = path.join(skills, 'gstack-qa');
    fs.mkdirSync(path.join(source, 'qa'), { recursive: true });
    fs.mkdirSync(foreign, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(skills, '.gstack-root'), `${foreign}\n`);
    const generated = '<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->';
    fs.writeFileSync(path.join(source, 'qa', 'SKILL.md'), `---\nname: qa\n---\n${generated}\nnew\n`);
    fs.writeFileSync(path.join(target, 'SKILL.md'), `---\nname: gstack-qa\n---\n${generated}\nforeign\n`);

    const script = `set -e\nIS_WINDOWS=1\nSKILL_PREFIX=1\n${extractSetupFunction('_claude_legacy_windows_skill_copy_owned')}\n${extractSetupFunction('_validate_claude_skill_target')}\n${extractSetupFunction('_claude_post_patch_skill_name')}\n${extractSetupFunction('validate_claude_skill_targets')}\nvalidate_claude_skill_targets "${source}" "${skills}"\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toContain('foreign');
  });

  test('Windows hook preflight rejects an unmarked foreign canonical runtime', () => {
    const home = tempDir('gstack-setup-windows-foreign-runtime-');
    const source = path.join(home, 'source');
    const skills = path.join(home, '.claude', 'skills');
    const runtime = path.join(skills, 'gstack');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(runtime, { recursive: true });

    const script = `set -e\nIS_WINDOWS=1\n${extractSetupFunction('is_canonical_claude_runtime_root')}\n${extractSetupFunction('validate_claude_hook_runtime_root')}\nvalidate_claude_hook_runtime_root "${source}" "${skills}"\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(runtime)).toBe(true);
  });

  test('Windows recognizes and marks a fresh canonical runtime copy', () => {
    const home = tempDir('gstack-setup-windows-runtime-copy-');
    const source = path.join(home, 'source');
    const runtime = path.join(home, '.claude', 'skills', 'gstack');
    for (const dir of [source, runtime]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const script = `set -e\nIS_WINDOWS=1\n${extractSetupFunction('mark_claude_windows_runtime_copy')}\nmark_claude_windows_runtime_copy "${source}" "${runtime}"\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(runtime, '.gstack-hook-runtime'), 'utf8').trim()).toBe(source);
  });

  test('Windows recognizes only the exact source as owner of a marked runtime copy', () => {
    const home = tempDir('gstack-setup-windows-runtime-owner-');
    const source = path.join(home, 'source');
    const foreign = path.join(home, 'foreign');
    const runtime = path.join(home, '.claude', 'skills', 'gstack');
    for (const dir of [source, foreign, runtime]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(runtime, '.gstack-hook-runtime'), `${source}\n`);

    const helper = extractSetupFunction('claude_windows_runtime_copy_owned_by');
    const owned = spawnSync('bash', ['-c', `IS_WINDOWS=1\n${helper}\nclaude_windows_runtime_copy_owned_by "${source}" "${runtime}"`]);
    const rejected = spawnSync('bash', ['-c', `IS_WINDOWS=1\n${helper}\nclaude_windows_runtime_copy_owned_by "${foreign}" "${runtime}"`]);
    expect(owned.status).toBe(0);
    expect(rejected.status).not.toBe(0);
  });

  test('accepts legacy SKILL.md aliases through a logical canonical path', () => {
    const home = tempDir('gstack-setup-logical-alias-');
    const source = path.join(home, 'renamed gstack');
    const skills = path.join(home, '.claude', 'skills');
    const target = path.join(skills, 'qa');
    fs.mkdirSync(path.join(source, 'qa'), { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(source, 'qa', 'SKILL.md'), 'source\n');
    fs.symlinkSync(source, path.join(skills, 'gstack'));
    fs.symlinkSync(path.join(skills, 'gstack', 'qa', 'SKILL.md'), path.join(target, 'SKILL.md'));

    const script = `set -e\nIS_WINDOWS=0\n${extractSetupFunction('_claude_legacy_windows_skill_copy_owned')}\n${extractSetupFunction('_validate_claude_skill_target')}\n${extractSetupFunction('_claude_skill_target_owned')}\n_validate_claude_skill_target "${source}" "${source}/qa/SKILL.md" "${target}"\n_claude_skill_target_owned "${source}" "${source}/qa/SKILL.md" "${target}"\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(result.status).toBe(0);
  });

  test('setup failure releases its owned registration lock', () => {
    const home = tempDir('gstack-setup-lock-release-');
    const skills = path.join(home, '.claude', 'skills');
    const lock = path.join(skills, '.gstack-registration.lock');
    fs.mkdirSync(skills, { recursive: true });
    const library = path.join(ROOT, 'bin', 'gstack-registration-lock');
    const script = `set -e\nsource "${library}"\ncleanup_copied_bun(){ gstack_registration_lock_release; }\n${extractSetupFunction('_acquire_claude_registration_lock')}\n_acquire_claude_registration_lock "${skills}"\nfalse\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(lock)).toBe(false);
  });

  test('connect-chrome resolves directly into a renamed runtime', () => {
    const home = tempDir('gstack-setup-connect-chrome-');
    const source = path.join(home, '.claude', 'skills', 'renamed gstack');
    const skills = path.dirname(source);
    const browserSkill = path.join(source, 'open-gstack-browser');
    fs.mkdirSync(browserSkill, { recursive: true });
    fs.writeFileSync(path.join(browserSkill, 'SKILL.md'), 'browser\n');

    const script = `set -e\nIS_WINDOWS=0\nSKILL_PREFIX=0\n${extractSetupFunction('_link_or_copy')}\n${extractSetupFunction('link_claude_connect_chrome_alias')}\nlink_claude_connect_chrome_alias "${source}" "${skills}"\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    const alias = path.join(skills, 'connect-chrome');
    expect(result.status).toBe(0);
    expect(fs.realpathSync(alias)).toBe(fs.realpathSync(browserSkill));
    expect(fs.readFileSync(path.join(alias, 'SKILL.md'), 'utf8')).toBe('browser\n');
  });

  test('prefix cleanup rejects a foreign legacy-looking target before mutation', () => {
    const home = tempDir('gstack-setup-cleanup-collision-');
    const source = path.join(home, 'renamed gstack');
    const skills = path.join(home, '.claude', 'skills');
    const foreignSource = path.join(home, 'foreign-gstack-pack', 'qa');
    const target = path.join(skills, 'qa');
    fs.mkdirSync(path.join(source, 'qa'), { recursive: true });
    fs.writeFileSync(path.join(source, 'qa', 'SKILL.md'), 'source\n');
    fs.mkdirSync(foreignSource, { recursive: true });
    fs.writeFileSync(path.join(foreignSource, 'SKILL.md'), 'foreign\n');
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(path.join(foreignSource, 'SKILL.md'), path.join(target, 'SKILL.md'));
    fs.writeFileSync(path.join(target, 'USER_FILE'), 'preserve\n');

    const script = `set -e\nIS_WINDOWS=0\n${extractSetupFunction('_claude_skill_target_owned')}\n${extractSetupFunction('_validate_claude_cleanup_targets')}\n_validate_claude_cleanup_targets "${source}" "${skills}" ""\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not owned by this gstack install');
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe('foreign\n');
    expect(fs.readFileSync(path.join(target, 'USER_FILE'), 'utf8')).toBe('preserve\n');
  });
});
