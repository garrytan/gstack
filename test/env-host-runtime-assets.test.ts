/**
 * Env-var hosts reach gstack's runtime files only through their installed
 * runtime root (found in Codex integration, lane W, 2026-10-04).
 *
 * Templates that quoted "$HOME/.claude/skills/gstack/..." were rewritten to
 * "$HOME/.agents/skills/gstack/..." on Codex, a directory a global install
 * does not have, and the runtime roots setup builds had no freeze/bin, so
 * /freeze, /guard, /unfreeze and /investigate's edit boundary failed on every
 * env-var host. Fences now use $GSTACK_ROOT (with the runtime prelude) and
 * setup links freeze/bin plus the careful/bin helper it sources.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ALL_HOST_CONFIGS } from '../hosts';
import { runGeneration } from '../scripts/gen-skill-docs';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
const ENV_HOSTS = ALL_HOST_CONFIGS.filter(h => h.usesEnvVars);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-runtime-assets-'));
const renderDir = path.join(tmp, 'render');

// Lookups that probe Claude-layout installs on purpose and fall through when
// absent: /gstack-upgrade's install-type detection and the optional Chrome
// extension path. design-html's vendored pretext.js is an optional probe too.
const PROBE_FILES = /[\\/]gstack-(?:upgrade|open-gstack-browser|connect-chrome)[\\/]SKILL\.md$/;
const OPTIONAL_ROOT_PATHS = ['design-html/vendor'];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.md') ? [path.join(dir, e.name)] : []);
}
const fences = (text: string) => [...text.matchAll(/```bash\n([\s\S]*?)\n```/g)].map(m => m[1]!);

function extractFunction(name: string): string {
  const start = SETUP_SRC.indexOf(`\n${name}() {`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Could not locate ${name}() in setup`);
  return SETUP_SRC.slice(start + 1, end + 2);
}

beforeAll(async () => {
  const result = await runGeneration({ host: 'all', outputRoot: renderDir });
  if (result.exitCode !== 0) throw new Error(result.diagnostics.filter(d => d.kind === 'error').map(d => d.message).join('\n'));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('env-var host fences reach runtime files through their runtime root', () => {
  test('no fence guesses a $HOME/<dir>/skills/gstack path', () => {
    const problems: string[] = [];
    for (const host of ENV_HOSTS) {
      const base = path.join(renderDir, host.hostSubdir, 'skills');
      for (const file of walk(base).filter(f => !PROBE_FILES.test(f))) {
        for (const body of fences(fs.readFileSync(file, 'utf8'))) {
          for (const m of body.matchAll(/\$(?:HOME|\{HOME\})\/\.[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/skills\/gstack\/[^\s"']*/g)) {
            problems.push(`${host.name}: ${path.relative(renderDir, file)}: ${m[0]}`);
          }
        }
      }
    }
    expect(problems.slice(0, 20)).toEqual([]);
  });

  test("every $GSTACK_ROOT path a fence uses is in the host's runtime root", () => {
    const problems: string[] = [];
    for (const host of ENV_HOSTS) {
      const provided = [...host.runtimeRoot.globalSymlinks,
        ...Object.entries(host.runtimeRoot.globalFiles ?? {}).flatMap(([dir, files]) => files.map(f => `${dir}/${f}`))];
      const base = path.join(renderDir, host.hostSubdir, 'skills');
      for (const file of walk(base)) {
        for (const body of fences(fs.readFileSync(file, 'utf8'))) {
          for (const m of body.matchAll(/\$\{?GSTACK_ROOT\}?\/([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/g)) {
            const rel = m[1]!;
            const covered = [...provided, ...OPTIONAL_ROOT_PATHS].some(p => rel === p || rel.startsWith(`${p}/`));
            if (!covered) problems.push(`${host.name}: ${path.relative(renderDir, file)}: $GSTACK_ROOT/${rel}`);
          }
        }
      }
    }
    expect([...new Set(problems)].slice(0, 20)).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('Codex global install: the freeze boundary works from a fresh shell', () => {
  test('setup links freeze/bin and careful/bin, and /freeze then /unfreeze run as installed', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-codex-freeze-'));
    try {
      const home = path.join(sandbox, 'home');
      const codexHome = path.join(home, '.codex');
      const rootDir = path.join(codexHome, 'skills', 'gstack');
      const project = path.join(sandbox, 'project', 'src');
      fs.mkdirSync(project, { recursive: true });
      const functions = ['_link_or_copy', '_link_runtime_dists', '_copy_runtime_skill_refs', '_copy_skill_md', '_gstack_generated_header', 'create_codex_runtime_root']
        .filter(name => SETUP_SRC.includes(`\n${name}() {`)).map(extractFunction).join('\n');
      const built = spawnSync('bash', ['-c', `IS_WINDOWS=0\n_CODEX_RENDER_ROOT="${renderDir}"\n${functions}\ncreate_codex_runtime_root "${ROOT}" "${rootDir}"`],
        { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home } });
      expect(built.stderr).toBe('');
      expect(built.status).toBe(0);
      for (const rel of ['freeze/bin/freeze-state.sh', 'freeze/bin/check-freeze.sh', 'careful/bin/hook-extract.sh']) {
        expect(fs.existsSync(path.join(rootDir, rel)), rel).toBe(true);
      }
      expect(fs.existsSync(path.join(rootDir, 'freeze', 'SKILL.md'))).toBe(false);

      const skill = (name: string) => fs.readFileSync(path.join(renderDir, '.agents', 'skills', name, 'SKILL.md'), 'utf8');
      const fence = (name: string, marker: string) => fences(skill(name)).find(body => body.includes(marker))!;
      const run = (script: string) => spawnSync('bash', ['-c', script], {
        cwd: path.dirname(project), encoding: 'utf8', timeout: 30_000,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CODEX_HOME: codexHome },
      });
      const set = run(fence('gstack-freeze', 'freeze-state.sh" set').replace('<user-provided-path>', project));
      expect(set.stderr).toBe('');
      expect(set.status).toBe(0);
      expect(set.stdout).toContain(`FREEZE_DIR=${fs.realpathSync(project)}`);
      const clear = run(fence('gstack-unfreeze', 'freeze-state.sh" clear'));
      expect(clear.status, clear.stderr).toBe(0);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
