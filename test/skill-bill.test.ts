import { describe, test, expect, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const BIN = path.resolve(import.meta.dir, '..', 'bin', 'gstack-skill-bill');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-bill-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(home);

function sh(cwd: string, cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf-8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function bill(cwd: string, args: string[]) {
  return spawnSync(BIN, args, { cwd, encoding: 'utf-8', timeout: 30_000, env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex') } });
}

function skill(dir: string, name: string, body: string, file = 'SKILL.md') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), `---\nname: ${name}\ndescription: |\n  Does ${name} things.\n---\n${body}`);
}

function gstackRepo(): string {
  const root = path.join(tmp, 'gstack');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'SKILL.md.tmpl'), 'router');
  fs.writeFileSync(path.join(root, 'VERSION'), '1.0.0');
  skill(path.join(root, 'demo'), 'demo', 'x'.repeat(1000) + '\n', 'SKILL.md.tmpl');
  fs.writeFileSync(path.join(root, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Does demo things.\n---\n<!-- AUTO-GENERATED from SKILL.md.tmpl -->\nbody\n');
  fs.mkdirSync(path.join(root, 'demo', 'references'));
  fs.writeFileSync(path.join(root, 'demo', 'references', 'deep.md'), 'deep\n');
  sh(root, 'git', ['init', '-q', '-b', 'main']);
  sh(root, 'git', ['config', 'user.email', 'test@example.com']);
  sh(root, 'git', ['config', 'user.name', 'Test']);
  sh(root, 'git', ['add', '-A']);
  sh(root, 'git', ['commit', '-qm', 'diet demo\n\nSkill-Diet: demo']);
  return root;
}

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('gstack-skill-bill', () => {
  const root = gstackRepo();

  test('a gstack checkout skill reports every level and its last diet', () => {
    const r = bill(root, ['./demo']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('SKILL: demo (gstack-checkout)');
    expect(r.stdout).toMatch(/template\s+SKILL\.md\.tmpl/);
    expect(r.stdout).toMatch(/on-demand\s+references\/deep\.md/);
    expect(r.stdout).toContain('BASELINE: ');
    expect(r.stdout).not.toContain('DUE');
  });

  test('growth over 10% since the Skill-Diet commit prints DUE, and an unrendered template is RENDER_STALE', () => {
    fs.appendFileSync(path.join(root, 'demo', 'SKILL.md.tmpl'), 'y'.repeat(200));
    const r = bill(root, ['./demo', '--json']);
    const report = JSON.parse(r.stdout);
    expect(report.baseline.status).toBe('found');
    expect(report.baseline.due).toBe(true);
    expect(report.warnings.join('\n')).toContain('RENDER_STALE');
    sh(root, 'git', ['checkout', '--', 'demo/SKILL.md.tmpl']);
  });

  test('a shallow clone says the baseline is unknown instead of none', () => {
    const shallow = path.join(tmp, 'shallow');
    sh(root, 'git', ['commit', '-q', '--allow-empty', '-m', 'later']);
    sh(tmp, 'git', ['clone', '-q', '--depth', '1', 'file://' + root, shallow]);
    const report = JSON.parse(bill(shallow, ['demo', '--json']).stdout);
    expect(report.baseline.status).toBe('unknown');
    expect(report.baseline.reason).toContain('shallow');
  });

  test('a standalone folder outside git is a user skill with an unknown baseline', () => {
    const own = path.join(tmp, 'mine', 'deploy');
    skill(own, 'deploy', 'steps\n');
    const r = bill(tmp, ['./mine/deploy']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('SKILL: deploy (user)');
    expect(r.stdout).toContain('not a git folder');
  });

  test('names resolve exactly: an installed gstack copy yields to the user skill, a near miss lists the closest names', () => {
    skill(path.join(home, '.claude', 'skills', 'deploy'), 'deploy', 'mine\n');
    skill(path.join(home, '.agents', 'skills', 'deploy'), 'deploy', 'also mine\n');
    skill(path.join(home, '.claude', 'skills', 'gstack', 'ship'), 'ship', '<!-- AUTO-GENERATED from SKILL.md.tmpl -->\n');
    const amb = bill(tmp, ['deploy']);
    expect(amb.status).toBe(2);
    expect(amb.stderr).toContain('(SKILL_AMBIGUOUS)');
    const installed = bill(tmp, ['ship']);
    expect(installed.status).toBe(0);
    expect(installed.stdout).toContain('(gstack-install)');
    expect(installed.stdout).toContain('INSTALLED_GSTACK_SKILL');
    const miss = bill(tmp, ['shp']);
    expect(miss.status).toBe(2);
    expect(miss.stderr).toContain('(SKILL_NOT_FOUND)');
    expect(miss.stderr).toContain('closest: ship');
  });

  test('a folder without SKILL.md and an unknown flag are errors with a fix line', () => {
    fs.mkdirSync(path.join(tmp, 'empty-dir'));
    const missing = bill(tmp, ['./empty-dir']);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('(SKILL_MD_MISSING)');
    expect(missing.stderr).toContain('fix:');
    const flag = bill(tmp, ['demo', '--jsno']);
    expect(flag.status).toBe(2);
    expect(flag.stderr).toContain("unknown argument '--jsno'");
    expect(bill(tmp, ['--help']).stdout).toContain('Usage: gstack-skill-bill');
  });
});

describe('gstack-skill-bill EVIDENCE line (docs/inventory/evidence.json)', () => {
  const root = path.join(tmp, 'evidence-repo');
  const ledger = (parts: Record<string, unknown>) => {
    fs.mkdirSync(path.join(root, 'docs', 'inventory'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'inventory', 'evidence.json'), JSON.stringify({ schema_version: 1, parts }));
  };
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'SKILL.md.tmpl'), 'router');
  fs.writeFileSync(path.join(root, 'VERSION'), '1.0.0');
  skill(path.join(root, 'demo'), 'demo', 'body\n', 'SKILL.md.tmpl');

  test('each status prints its source, plan or reason; a skill with no row says so', () => {
    ledger({ demo: { status: 'untested', grandfathered: true, plan: 'none' } });
    expect(bill(root, ['./demo']).stdout).toContain('EVIDENCE: untested plan: none (grandfathered)');
    ledger({ demo: { status: 'untested', reason: 'r', plan: 'test/fixtures/skill-evals/demo/tasks.json', owner: 'GSTA-1', measure_by: '2026-12-01' } });
    expect(bill(root, ['./demo']).stdout).toContain('EVIDENCE: untested plan: test/fixtures/skill-evals/demo/tasks.json (owner GSTA-1, measure by 2026-12-01)');
    ledger({ demo: { status: 'helps', sources: ['run-9/results.json'], models: ['claude-opus-5-5'], prompt: 'preset', scope: 's', masked: true } });
    expect(bill(root, ['./demo']).stdout).toContain('EVIDENCE: helps sources: run-9/results.json');
    ledger({ demo: { status: 'safety', reason: 'blocks rm -rf' } });
    expect(bill(root, ['./demo']).stdout).toContain('EVIDENCE: safety reason: blocks rm -rf');
    ledger({});
    expect(bill(root, ['./demo']).stdout).toContain('EVIDENCE: missing: no demo row in docs/inventory/evidence.json');
    expect(JSON.parse(bill(root, ['./demo', '--json']).stdout).evidence).toMatchObject({ key: 'demo', status: 'missing' });
    fs.writeFileSync(path.join(root, 'docs', 'inventory', 'evidence.json'), '{bad');
    const broken = bill(root, ['./demo']).stdout;
    expect(broken).toContain('EVIDENCE: unreadable: cannot read docs/inventory/evidence.json');
    expect(broken).not.toContain('add one');
  });

  test('the real checkout: a guard prints its safety reason', () => {
    const r = spawnSync(BIN, ['careful'], { cwd: path.resolve(import.meta.dir, '..'), encoding: 'utf-8', timeout: 30_000 });
    expect(r.stdout).toMatch(/^EVIDENCE: safety reason: .+/m);
  });
});

describe('gstack-skill-bill baselines and the root skill', () => {
  test('the gstack root skill is a checkout skill, and Skill-Diet: gstack-upgrade is not its diet', () => {
    const root = path.join(tmp, 'gstack-root');
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    skill(root, 'gstack', 'router\n', 'SKILL.md.tmpl');
    fs.writeFileSync(path.join(root, 'SKILL.md'), '---\nname: gstack\ndescription: Does gstack things.\n---\n<!-- AUTO-GENERATED from SKILL.md.tmpl -->\nrouter\n');
    fs.writeFileSync(path.join(root, 'VERSION'), '1.0.0');
    skill(path.join(root, 'gstack-upgrade'), 'gstack-upgrade', 'up\n');
    sh(root, 'git', ['init', '-q', '-b', 'main']);
    sh(root, 'git', ['config', 'user.email', 'test@example.com']);
    sh(root, 'git', ['config', 'user.name', 'Test']);
    sh(root, 'git', ['add', '-A']);
    sh(root, 'git', ['commit', '-qm', 'diet upgrade\n\nSkill-Diet: gstack-upgrade']);
    const report = JSON.parse(bill(root, ['.', '--json']).stdout);
    expect(report.kind).toBe('gstack-checkout');
    expect(report.baseline.status).toBe('none');
  });

  test('the baseline measures the committed bytes exactly, trailing blank lines included', () => {
    const repo = path.join(tmp, 'blank-lines');
    skill(path.join(repo, 'notes'), 'notes', 'body\n\n\n');
    sh(repo, 'git', ['init', '-q', '-b', 'main']);
    sh(repo, 'git', ['config', 'user.email', 'test@example.com']);
    sh(repo, 'git', ['config', 'user.name', 'Test']);
    sh(repo, 'git', ['add', '-A']);
    sh(repo, 'git', ['commit', '-qm', 'diet notes\n\nSkill-Diet: notes']);
    const report = JSON.parse(bill(repo, ['./notes', '--json']).stdout);
    expect(report.baseline.status).toBe('found');
    expect(report.baseline.bytes).toBe(fs.statSync(path.join(repo, 'notes', 'SKILL.md')).size);
    expect(report.baseline.growthPct).toBe(0);
  });
});
