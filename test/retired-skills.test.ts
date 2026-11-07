/**
 * GST-1698: /plan-eng-review is cut. Its source stays as /autoplan's eng-phase
 * methodology, and no host registers it. setup and gstack-relink treat it as a
 * disabled skill that config cannot re-enable (GSTACK_RETIRED_SKILLS), so an
 * existing gstack-owned entry is removed on the next setup or upgrade and a
 * user's own same-name skill stays. External hosts carry the methodology beside
 * gstack-autoplan/SKILL.md as plan-eng-review.md (Codex and Copilot register
 * every nested SKILL.md).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RETIRED_SKILLS } from '../scripts/discover-skills';
import { runGeneration } from '../scripts/gen-skill-docs';

const ROOT = path.resolve(import.meta.dir, '..');
const REGISTRY = path.join(ROOT, 'bin', 'gstack-install-registry.sh');
const BINS = ['gstack-config', 'gstack-relink', 'gstack-patch-names', 'gstack-skill-name.sh', 'gstack-state-root.sh', 'gstack-install-registry.sh'];

test('setup and gstack-relink retire the same skills as the generator', () => {
  const r = spawnSync('bash', ['-c', '. "$1" && printf %s "$GSTACK_RETIRED_SKILLS"', '_', REGISTRY], { encoding: 'utf8', timeout: 10_000 });
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout.split(/\s+/).filter(Boolean)).toEqual(RETIRED_SKILLS);
  expect(RETIRED_SKILLS).toEqual(['plan-eng-review']);
});

describe('gstack-relink on an install that still has /plan-eng-review', () => {
  let tmp: string;
  let install: string;
  let skills: string;
  const relink = () => spawnSync('bash', [path.join(install, 'bin', 'gstack-relink')], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env, GSTACK_HOME: path.join(tmp, 'state'), GSTACK_STATE_ROOT: '', GSTACK_STATE_DIR: '',
      GSTACK_INSTALL_DIR: install, GSTACK_SKILLS_DIR: skills, GSTACK_SETUP_RUNNING: '',
    },
  });
  const setRegistry = (retired: string) => {
    const src = fs.readFileSync(REGISTRY, 'utf8');
    fs.writeFileSync(path.join(install, 'bin', 'gstack-install-registry.sh'), src.replace(/^GSTACK_RETIRED_SKILLS=.*$/m, `GSTACK_RETIRED_SKILLS="${retired}"`));
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-retired-'));
    install = path.join(tmp, 'gstack');
    skills = path.join(tmp, 'skills');
    fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
    for (const b of BINS) {
      fs.copyFileSync(path.join(ROOT, 'bin', b), path.join(install, 'bin', b));
      fs.chmodSync(path.join(install, 'bin', b), 0o755);
    }
    for (const skill of ['plan-eng-review', 'ship']) {
      fs.mkdirSync(path.join(install, skill));
      fs.writeFileSync(path.join(install, skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: test\n---\n# ${skill}\n`);
    }
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('an upgrade removes the old gstack-owned entry and keeps the methodology source', () => {
    setRegistry('');
    const before = relink();
    expect(before.status, before.stderr).toBe(0);
    expect(fs.existsSync(path.join(skills, 'plan-eng-review', 'SKILL.md'))).toBe(true);

    setRegistry('plan-eng-review');
    const after = relink();
    expect(after.status, after.stderr).toBe(0);
    expect(fs.lstatSync(path.join(skills, 'plan-eng-review'), { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.existsSync(path.join(skills, 'ship', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(install, 'plan-eng-review', 'SKILL.md'))).toBe(true);
    expect(after.stdout).not.toContain('Disabled (gstack-config disabled_skills');
  });

  test('a gstack-plan-eng-review entry from a prefixed install goes too', () => {
    fs.mkdirSync(path.join(skills, 'gstack-plan-eng-review'), { recursive: true });
    fs.symlinkSync(path.join(install, 'plan-eng-review', 'SKILL.md'), path.join(skills, 'gstack-plan-eng-review', 'SKILL.md'));
    const r = relink();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.lstatSync(path.join(skills, 'gstack-plan-eng-review'), { throwIfNoEntry: false })).toBeUndefined();
  });

  test("a user's own plan-eng-review skill is left alone", () => {
    fs.mkdirSync(path.join(skills, 'plan-eng-review'), { recursive: true });
    const own = '---\nname: plan-eng-review\ndescription: mine\n---\nmy own review\n';
    fs.writeFileSync(path.join(skills, 'plan-eng-review', 'SKILL.md'), own);
    const r = relink();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(skills, 'plan-eng-review', 'SKILL.md'), 'utf8')).toBe(own);
  });
});

describe('setup prunes external-host entries for a retired skill whose source still exists', () => {
  const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
  const extractFn = (name: string) => {
    const start = SETUP_SRC.indexOf(`${name}() {`);
    const end = SETUP_SRC.indexOf('\n}\n', start);
    if (start < 0 || end < 0) throw new Error(`Could not locate ${name}() in setup`);
    return SETUP_SRC.slice(start, end + 2);
  };

  test('the old gstack-plan-eng-review render and its host link are removed, live skills stay', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-prune-'));
    try {
      const src = path.join(t, 'src'), gen = path.join(t, 'gen'), host = path.join(t, 'host');
      for (const s of ['plan-eng-review', 'autoplan']) {
        fs.mkdirSync(path.join(src, s), { recursive: true });
        fs.writeFileSync(path.join(src, s, 'SKILL.md.tmpl'), `---\nname: ${s}\n---\nx\n`);
      }
      for (const g of ['gstack-plan-eng-review', 'gstack-autoplan']) {
        fs.mkdirSync(path.join(gen, g), { recursive: true });
        fs.writeFileSync(path.join(gen, g, 'SKILL.md'), `<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n# ${g}\n`);
      }
      fs.mkdirSync(host);
      for (const g of ['gstack-plan-eng-review', 'gstack-autoplan']) fs.symlinkSync(path.join(gen, g) + '/', path.join(host, g));
      const script = [
        'set -e', 'log() { echo "$@"; }', `. "${REGISTRY}"`,
        ...['_gstack_link_target_abs', '_gstack_target_is_ours', '_gstack_generated_header', '_backup_skill_md', '_cleanup_weak_dir',
          '_owned_for_windows_refresh', '_skill_source_exists', '_prune_stale_generated'].map(extractFn),
        `_prune_stale_generated "${src}" "${gen}" "${host}"`,
      ].join('\n');
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8', timeout: 30_000 });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('pruned retired skill: gstack-plan-eng-review');
      expect(fs.readdirSync(gen)).toEqual(['gstack-autoplan']);
      expect(fs.readdirSync(host)).toEqual(['gstack-autoplan']);
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  });
});

test('no host renders a plan-eng-review skill; external hosts get the methodology beside gstack-autoplan', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-gen-'));
  try {
    const result = await runGeneration({ host: 'all', outputRoot: out });
    expect(result.diagnostics.filter(d => d.kind === 'error'), JSON.stringify(result.diagnostics.filter(d => d.kind === 'error'))).toEqual([]);
    const paths = result.artifacts.map(a => a.relativePath);
    expect(paths.filter(p => /gstack-plan-eng-review\//.test(p))).toEqual([]);
    expect(paths).toContain('plan-eng-review/SKILL.md');
    const external = result.artifacts.filter(a => a.host && a.host !== 'claude' && a.kind === 'skill');
    const hosts = new Set(external.map(a => a.host));
    for (const host of hosts) {
      const copy = external.find(a => a.host === host && a.relativePath.endsWith('/skills/gstack-autoplan/plan-eng-review.md'));
      expect(copy, host).toBeDefined();
      expect(fs.readFileSync(path.join(out, copy!.relativePath), 'utf8')).toMatch(/^---\nname: (gstack-)?plan-eng-review\n/);
    }
    const router = fs.readFileSync(path.join(out, 'SKILL.md'), 'utf8');
    expect(router).not.toContain('/plan-eng-review');
    expect(fs.readFileSync(path.join(out, 'gstack', 'llms.txt'), 'utf8')).not.toContain('plan-eng-review');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}, 300_000);
