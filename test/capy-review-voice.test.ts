/**
 * `--for review-voice` end to end (field list 2, W11): the reviewer's install
 * profile. A real gstack checkout (this working tree, published as a local
 * origin that `https://github.com/garrytan/gstack.git` resolves to through a
 * fixture git config), the real bootstrapper, session wrapper, installer and
 * doctor, on the simulated Capy host (image Bun 1.3.14 first on PATH, a
 * verified Bun 1.4.2 off PATH). The exact no-Drive brief
 * (capyBootstrapCommand) runs from a subdirectory of a non-gstack project
 * whose exact Bun pin gstack can never satisfy: cold (clone), warm (reuse,
 * measured against the 20 s budget) and after origin moves (fast-forward).
 * The certified helpers run for real under the GSTACK_LAUNCH line, and both
 * admission twins refuse a workflow with a full-install `--for <skill>` fix.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { writePrompts } from '../lib/autoplan-prompts';
import { CAPY_INSTALL_ROOT, capyBootstrapCommand } from '../lib/doctor-components';
import { capyHost, writeBunStub, type CapyHost } from './helpers/capy-host';

const REPO = path.resolve(import.meta.dir, '..');
const VERSION = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').split('\n')[0]!.trim();
const BRIEF = capyBootstrapCommand('review-voice');
const WARM_BUDGET_MS = 20_000;
const OK_TRAILER = `gstack: ok ${VERSION} for=review-voice (pins: skipped (helper runtime))`;

let host: CapyHost;
let origin = '', project = '', sub = '', root = '';

const run = (cmd: string, cwd: string, env: Record<string, string>, timeout = 300_000) =>
  spawnSync('bash', ['-c', cmd], { cwd, env, encoding: 'utf8', timeout });
const git = (args: string[], cwd: string) => {
  const r = spawnSync('git', args, { cwd, env: host.env, encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
/** The brief exactly as a reviewer runs it, then where the shell ended up. */
const brief = () => {
  const t0 = performance.now();
  const r = run(`${BRIEF}\nrc=$?\necho "PWD_AFTER=$(pwd -P)"\nexit $rc`, sub, host.env);
  return { status: r.status, stderr: r.stderr ?? '', out: r.stdout ?? '', ms: performance.now() - t0 };
};
const trailer = (out: string) => out.split('\n').filter(l => l.startsWith('gstack: ')).at(-1);
/** host.env plus the GSTACK_LAUNCH assignments (PATH=<dir>:$PATH expanded). */
function launchEnv(out: string): Record<string, string> {
  const line = out.split('\n').find(l => l.startsWith('GSTACK_LAUNCH: '));
  expect(line, out).toBeDefined();
  const env = { ...host.env };
  for (const [, k, v] of line!.slice('GSTACK_LAUNCH: '.length).matchAll(/([A-Z_]+)=(\S+)/g)) env[k!] = v!.replace('$PATH', host.env.PATH!);
  return env;
}

beforeAll(() => {
  host = capyHost({ systemBun: '1.3.14', verifiedBun: '1.4.2' });
  root = path.join(host.home, '.local/share/gstack');
  origin = path.join(host.base, 'origin');
  fs.mkdirSync(origin, { recursive: true });
  const copy = run(`git -C "${REPO}" ls-files -z --cached --others --exclude-standard | tar -C "${REPO}" --null --no-recursion --ignore-failed-read -T - -cf - 2>/dev/null | tar -C "${origin}" -xf -`, host.base, host.env, 120_000);
  expect(copy.status, copy.stderr).toBe(0);
  git(['init', '-q', '-b', 'main'], origin);
  git(['add', '-A'], origin);
  git(['commit', '-qm', 'gstack under test'], origin);
  fs.writeFileSync(host.env.GIT_CONFIG_GLOBAL!, `[url "file://${origin}"]\n\tinsteadOf = https://github.com/garrytan/gstack.git\n`);
  project = path.join(host.base, 'reviewed-project');
  sub = path.join(project, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'reviewed', packageManager: 'bun@1.0.0' }) + '\n');
  fs.writeFileSync(path.join(sub, 'index.ts'), 'export const x = 1;\n');
  git(['init', '-q', '-b', 'main'], project);
  git(['add', '-A'], project);
  git(['commit', '-qm', 'project'], project);
}, 300_000);
afterAll(() => host?.cleanup());

describe('--for review-voice through the no-Drive brief', () => {
  let cold: ReturnType<typeof brief>;

  test('cold: clones into the explicit root, no ./setup, no host profiles, Bun at gstack\'s minimum despite the project pin, cwd and project kept', () => {
    expect(BRIEF).toContain(`"${CAPY_INSTALL_ROOT}/capy/skill/gstack/scripts/install.sh" --for review-voice`);
    cold = brief();
    const out = cold.out;
    expect(cold.status, out + cold.stderr).toBe(0);
    expect(out).toMatch(/^gstack-capy-skill: wrapper \d+ \(.*\/\.local\/share\/gstack\/capy\/skill\/gstack\/scripts\/install\.sh\)$/m);
    expect(out).toContain(`gstack-capy-install: reusing ${root} (${VERSION})`);
    expect(out).toContain("gstack-capy-install: review-voice: helper runtime (bun at gstack's supported minimum");
    expect(out).toContain(`the pins of ${fs.realpathSync(project)} are not applied`);
    expect(out).toContain('gstack-capy-install: review-voice: no ./setup and no host profiles; certifies only the read-only helpers (gstack-pregate gstack-plan-reality gstack-artifact gstack-autoplan)');
    expect(out).toMatch(/^PASS helpers gstack-pregate, gstack-plan-reality, gstack-artifact, gstack-autoplan launch with bun 1\.4\.2$/m);
    expect(out).toMatch(/^SKIP pins \(helper runtime; /m);
    expect(out).toMatch(/^SKIP claude \(not needed; /m);
    expect(out).not.toContain('gstack ready');
    const launchDir = out.match(/GSTACK_LAUNCH_PATH: (\S+)/)?.[1] ?? '';
    expect(launchDir).toBe(out.match(/GSTACK_INSTALL_VERDICT=(\S+)\.json/)![1] + '.profile/review-voice.launch');
    expect(fs.statSync(path.dirname(launchDir)).mode & 0o777).toBe(0o700);
    expect(out).toContain(`GSTACK_LAUNCH: PATH=${launchDir}:$PATH `);
    expect(fs.realpathSync(path.join(launchDir, 'bun'))).toBe(fs.realpathSync(path.join(host.bunInstallBin, 'bun')));
    expect(trailer(out)).toBe(OK_TRAILER);
    expect(out.trim().split('\n').at(-2)).toBe(OK_TRAILER);
    expect(out.trim().split('\n').at(-1)).toBe(`PWD_AFTER=${fs.realpathSync(sub)}`);
    for (const p of ['.claude/skills', '.codex/skills', '.local/bin/bun']) expect(fs.existsSync(path.join(host.home, p)), p).toBe(false);
    expect(fs.existsSync(path.join(root, 'node_modules'))).toBe(false);
    const verdict = JSON.parse(fs.readFileSync(launchEnv(out).GSTACK_INSTALL_VERDICT!, 'utf8'));
    expect(verdict).toMatchObject({ for: 'review-voice', ok: true, project: fs.realpathSync(project), checkout: fs.realpathSync(root), pins_planning_only: false });
    expect(verdict.required).toContain('helpers');
    expect(verdict.required).not.toContain('claude');
    expect(verdict.bun_path).toBe(fs.realpathSync(path.join(host.bunInstallBin, 'bun')));
  }, 300_000);

  test('the certified helpers run for real from the project under the GSTACK_LAUNCH line', () => {
    const env = launchEnv(cold.out);
    const sealed = run(`"${root}/bin/gstack-pregate" sealed`, sub, env, 120_000);
    expect(sealed.status, sealed.stdout + sealed.stderr).toBe(0);
    expect(sealed.stdout).toMatch(/^SEALED: no-policy /m);
    const reality = run(`"${root}/bin/gstack-plan-reality" --help`, sub, env, 120_000);
    expect(reality.status, reality.stderr).toBe(0);
    const contract = run(`"${root}/bin/gstack-autoplan" contract`, sub, env, 120_000);
    expect(contract.status, contract.stderr).toBe(0);
    expect(contract.stdout).toContain('Coordinator contract');
    const status = run(`"${root}/bin/gstack-autoplan" status --out "${path.join(host.base, 'no-run')}"`, sub, env, 120_000);
    expect(status.stderr + status.stdout).not.toContain('INSTALL_UNVERIFIED');
    const artifact = run(`"${root}/bin/gstack-artifact" --help`, sub, env, 120_000);
    expect(artifact.status, artifact.stderr).toBe(0);
  }, 300_000);

  test('admission refuses a heavier workflow with the full-install --for fix (TypeScript and Bash twins)', () => {
    const env = launchEnv(cold.out);
    const plan = path.join(host.base, 'plan.md');
    fs.writeFileSync(plan, '# P\n\n## Implementation plan\n\nx\n\n## Review record\n');
    const next = run(`"${root}/bin/gstack-autoplan" next --out "${path.join(host.base, 'run')}" --plan "${plan}"`, sub, env, 120_000);
    expect(next.status, next.stdout + next.stderr).toBe(3);
    const real = fs.realpathSync(root);
    const fix = `run GSTACK_CAPY_ROOT=${real} bash ${real}/capy/skill/gstack/scripts/install.sh --for autoplan (upgrades this checkout in place: ./setup and host profiles, no second clone)`;
    expect(next.stderr + next.stdout).toContain('which does not cover claude that autoplan needs (review-voice certifies only the read-only helpers)');
    const bash = run([
      `. "${root}/bin/gstack-bun-version.sh"`, `. "${root}/bin/gstack-doctor-components.sh"`, `. "${root}/bin/gstack-install-verdict.sh"`,
      `gstack_install_admission "${root}/bin" autoplan unattended`, 'echo "refuse=$_ia_refuse"', 'echo "$_ia_line"',
    ].join('\n'), sub, env, 120_000);
    expect(bash.stdout, bash.stderr).toContain('refuse=1');
    expect(bash.stdout).toContain('(review-voice certifies only the read-only helpers); fix: ' + fix);
    expect(bash.stdout).toContain('(INSTALL_UNVERIFIED)');
  }, 300_000);

  test('warm repeat session: reuses the checkout, nothing to fast-forward, ok within the measured budget', () => {
    const warm = brief();
    expect(warm.status, warm.out + warm.stderr).toBe(0);
    expect(warm.out).toContain(`gstack-capy-install: reusing ${root}`);
    expect(warm.out).toContain('SELF_UPGRADE: none (current)');
    expect(trailer(warm.out)).toBe(OK_TRAILER);
    console.log(`review-voice warm session: ${(warm.ms / 1000).toFixed(1)}s (budget ${WARM_BUDGET_MS / 1000}s)`);
    expect(warm.ms).toBeLessThan(WARM_BUDGET_MS);
  }, 300_000);

  // GST-290: the reviewer's machine may share this checkout with a lane mid-workflow.
  test('origin moves: the same brief never moves the checkout; it certifies the installed revision and reports behind', () => {
    const head = git(['rev-parse', 'HEAD'], root);
    fs.writeFileSync(path.join(origin, 'REVIEW_VOICE_FIXTURE.md'), 'moved\n');
    git(['add', '-A'], origin);
    git(['commit', '-qm', 'origin moves'], origin);
    const moved = brief();
    expect(moved.status, moved.out + moved.stderr).toBe(0);
    expect(moved.out).toContain(`SELF_UPGRADE: skipped (review-voice never self-upgrades a shared checkout; fix: GSTACK_UPGRADE_FORCE=1 ${root}/bin/gstack-upgrade when no other session uses this checkout (UPGRADE_SKIPPED))`);
    expect(moved.out).not.toContain('SELF_UPGRADE: done');
    expect(git(['rev-parse', 'HEAD'], root)).toBe(head);
    expect(trailer(moved.out)).toStartWith(`gstack: ok ${VERSION} for=review-voice (pins: skipped (helper runtime); behind=1 `);
    expect(trailer(moved.out)).toContain('(UPGRADE_SKIPPED)');
  }, 300_000);

  // GST-401: the reviewer used to rewrite the lane's launch file and repoint its launch directory at its own Bun.
  test('a review-voice check never narrows an ok verdict a fuller install wrote for this HEAD and project, and borrows that install\'s launch file and directory without rewriting them', () => {
    const coldEnv = launchEnv(cold.out);
    const file = coldEnv.GSTACK_INSTALL_VERDICT!;
    const base = file.slice(0, -'.json'.length);
    const laneBun = path.join(host.base, 'lane-bun', 'bun');
    writeBunStub(laneBun, '1.4.3');
    const laneLaunch = `${base}.launch`;
    fs.rmSync(laneLaunch, { recursive: true, force: true });
    fs.mkdirSync(laneLaunch, { recursive: true });
    fs.symlinkSync(laneBun, path.join(laneLaunch, 'bun'));
    const laneEnv = `${base}.env`;
    const laneEnvText = [
      '# the lane\'s launch file (test sentinel)',
      `PATH='${laneLaunch}':"$PATH"; export PATH`,
      `export GSTACK_STATE_ROOT='${coldEnv.GSTACK_STATE_ROOT}'`,
      'export GSTACK_CAPY=1',
      `export GSTACK_INSTALL_VERDICT='${file}'`,
    ].join('\n') + '\n';
    fs.writeFileSync(laneEnv, laneEnvText, { mode: 0o600 });
    const wider = {
      ...JSON.parse(fs.readFileSync(file, 'utf8')), head: git(['rev-parse', 'HEAD'], root), for: 'review',
      required: ['claude', 'codex', 'patch', 'runtime', 'pins', 'helpers'], trailer: `gstack: ok ${VERSION} for=review`,
      bun_path: fs.realpathSync(laneBun), bun_version: '1.4.3', launch_path: laneLaunch,
    };
    fs.writeFileSync(file, JSON.stringify(wider, null, 1) + '\n');
    const again = brief();
    expect(again.status, again.out + again.stderr).toBe(0);
    expect(again.out).toContain(`gstack-capy-install: kept the install verdict for=review at ${file}`);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(wider);
    expect(fs.readFileSync(laneEnv, 'utf8')).toBe(laneEnvText);
    expect(fs.readdirSync(laneLaunch)).toEqual(['bun']);
    expect(fs.readlinkSync(path.join(laneLaunch, 'bun'))).toBe(laneBun);
    expect(again.out).toContain(`GSTACK_LAUNCH_FILE: ${laneEnv}\n`);
    expect(again.out).toContain(`GSTACK_LAUNCH_PATH: ${laneLaunch}\n`);
    const helpers = run([
      `. "${laneEnv}"`,
      `"${root}/bin/gstack-pregate" sealed`,
      `"${root}/bin/gstack-plan-reality" --help >/dev/null`,
      `"${root}/bin/gstack-artifact" --help >/dev/null`,
      `"${root}/bin/gstack-autoplan" contract >/dev/null`,
      'echo HELPERS_OK',
    ].join(' && '), sub, host.env, 120_000);
    expect(helpers.stdout, helpers.stdout + helpers.stderr).toContain('HELPERS_OK');
    expect(helpers.stdout + helpers.stderr).not.toContain('BUN_RESOLUTION_DRIFT');
  }, 300_000);
});

describe('the no-Drive command has one text', () => {
  test('Bash render, installer and bootstrapper not-installed lines print capyBootstrapCommand for the root they checked', () => {
    const missing = path.join(host.base, 'no-checkout');
    const rendered = run(`. "${REPO}/bin/gstack-doctor-components.sh" && gstack_capy_bootstrap_cmd "${missing}" review-voice && echo && gstack_capy_bootstrap_cmd "${missing}"`, host.base, host.env, 30_000);
    expect(rendered.stdout.split('\n')).toEqual([capyBootstrapCommand('review-voice', missing), capyBootstrapCommand('', missing)]);
    const installer = run(`bash "${REPO}/bin/gstack-capy-install" --check --root "${missing}" --for review-voice`, host.base, host.env, 60_000);
    expect(installer.status).toBe(1);
    expect(trailer(installer.stdout)).toBe(`gstack: fail not-installed — no gstack checkout at ${missing}; fix: ${capyBootstrapCommand('review-voice', missing)} (clones into ${missing} when absent, then installs)`);
    const boot = path.join(REPO, 'capy/skill/gstack/scripts/install.sh');
    const wrapper = run(`bash "${boot}" --check --for review-voice`, host.base, { ...host.env, GSTACK_CAPY_ROOT: missing }, 60_000);
    expect(wrapper.status).toBe(1);
    expect(trailer(wrapper.stdout)).toBe(`gstack: fail not-installed — no gstack checkout at ${missing}; fix: bash ${boot} --for review-voice (installs; on a machine without this skill: ${capyBootstrapCommand('review-voice', missing)})`);
  });

  test('every /autoplan reviewer prompt carries the review-voice brief, before the result contract', () => {
    const out = fs.mkdtempSync(path.join(host.base, 'prompts-'));
    const snapshotPath = path.join(out, 'plan.md');
    fs.writeFileSync(snapshotPath, '## Implementation plan\n\nx\n');
    const files = writePrompts({ phase: 'eng', snapshot: { nativePrompt: 'native review prompt', snapshotPath, sha256: 'a'.repeat(64) }, outDir: out, priorConsensus: [] });
    for (const file of [files.native, files.outside]) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text).toContain('GSTACK TRAILER');
      expect(text).toContain(`\n${BRIEF}\n`);
      expect(text.indexOf(BRIEF)).toBeLessThan(text.indexOf('RESULT FORMAT'));
      expect(text).not.toMatch(/no (gstack )?install (is )?needed/i);
    }
  });

  test('autoplan/DRIVER.md.tmpl (and its committed render) tells the parent to relay each reviewer\'s trailer, never to waive the install', () => {
    for (const rel of ['autoplan/DRIVER.md.tmpl', 'autoplan/DRIVER.md']) {
      const text = fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\s+/g, ' ');
      expect(text, rel).toContain('Every prompt ends with a `GSTACK TRAILER` block: the reviewer runs the `--for review-voice` install');
      expect(text, rel).toContain('Never tell a reviewer that no install is needed');
      expect(text, rel).toContain('treat a missing line as `gstack: fail not-installed`');
    }
  });
});
