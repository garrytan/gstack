/**
 * Windows/Codex CI is a privileged boundary: a fork PR runs on a fresh
 * Windows machine, so this static gate prevents a future workflow edit from
 * quietly reusing a developer profile, credentials, or an unpinned toolchain.
 *
 * The hosted runner executes the lifecycle itself. This test pins the parts
 * that are not observable locally: least-privilege workflow configuration and
 * the required clean-install sequence.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_WORKFLOW = path.join(ROOT, '.github', 'workflows', 'windows-setup-e2e.yml');
const FREE_WORKFLOW = path.join(ROOT, '.github', 'workflows', 'windows-free-tests.yml');

function readWorkflow(file: string): string {
  return fs.readFileSync(file, 'utf-8');
}

function expectSafePullRequestWorkflow(name: string, workflow: string): void {
  expect(workflow, `${name} must not receive the base-repo token for fork code`).not.toMatch(/\bpull_request_target\b/);
  expect(workflow, `${name} must use read-only repository permissions`).toMatch(/^permissions:\s*\n\s+contents:\s*read\s*$/m);
  expect(workflow, `${name} must not pass provider secrets into its steps`).not.toMatch(/\bsecrets\./);
  expect(workflow, `${name} must not import browser cookies`).not.toMatch(/setup-browser-cookies|cookie-import|cookies?/i);
  expect(workflow, `${name} checkout must not retain a usable GitHub credential`).toMatch(
    /uses:\s*actions\/checkout@v4\s*\n\s+with:\s*\n\s+persist-credentials:\s*false/,
  );
}

describe('Windows workflows: clean Codex compatibility gate', () => {
  const setup = readWorkflow(SETUP_WORKFLOW);
  const free = readWorkflow(FREE_WORKFLOW);

  test('both Windows workflows keep fork PRs read-only and credential-free', () => {
    expectSafePullRequestWorkflow('windows-setup-e2e.yml', setup);
    expectSafePullRequestWorkflow('windows-free-tests.yml', free);
  });

  test('both Windows workflows pin the Node and Bun toolchains', () => {
    for (const [name, workflow] of [
      ['windows-setup-e2e.yml', setup],
      ['windows-free-tests.yml', free],
    ] as const) {
      expect(workflow, `${name} must install a declared Node version`).toMatch(
        /uses:\s*actions\/setup-node@v4\s*\n\s+with:\s*\n\s+node-version:\s*['"]?\d+\.\d+\.\d+['"]?/,
      );
      expect(workflow, `${name} must install a declared Bun version`).toMatch(
        /uses:\s*oven-sh\/setup-bun@v1\s*\n\s+with:\s*\n\s+bun-version:\s*['"]?\d+\.\d+\.\d+['"]?/,
      );
      expect(workflow, `${name} must not silently float Bun to latest`).not.toMatch(/bun-version:\s*latest/);
    }
  });

  test('setup E2E isolates every user-owned runtime directory', () => {
    expect(setup).toContain('cygpath -m "$RUNNER_TEMP"');
    expect(free).toContain('cygpath -m "$RUNNER_TEMP"');
    for (const variable of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'GSTACK_HOME', 'GSTACK_STATE_ROOT', 'BROWSE_STATE_FILE', 'CHROMIUM_PROFILE']) {
      expect(setup, `windows-setup-e2e.yml must isolate ${variable}`).toMatch(new RegExp(`^\\s*${variable}:`, 'm'));
    }
  });

  test('setup E2E validates canonical output before installing prefixed Codex skills', () => {
    const generator = setup.indexOf('bun run gen:skill-docs --host all');
    const check = setup.indexOf('bun run skill:check');
    const install = setup.indexOf('bash ./setup --host codex --prefix --no-plan-tune-hooks');

    expect(generator).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(generator);
    expect(install).toBeGreaterThan(check);
  });

  test('setup E2E runs whenever its installer or generated-skill inputs change', () => {
    for (const input of [
      "'bun.lock'",
      "'bin/gstack-patch-names'",
      "'bin/gstack-relink'",
      "'scripts/gen-skill-docs.ts'",
      "'scripts/skill-check.ts'",
      "'hosts/**'",
      "'**/SKILL.md.tmpl'",
    ]) {
      expect(setup, `windows-setup-e2e.yml must watch ${input}`).toContain(input);
    }
  });

  test('setup E2E verifies the installed Codex runtime, metadata, and local browser lifecycle', () => {
    expect(setup).toContain('npm install --global @openai/codex@0.146.0');
    expect(setup).toContain('export PATH="$NPM_CONFIG_PREFIX:$PATH"');
    expect(setup).toContain('bash bin/gstack-doctor --json --strict');
    expect(setup).toContain('for skill in gstack-qa gstack-review gstack-ship; do');
    expect(setup).toContain('$CODEX_HOME/skills/$skill');
    expect(setup).not.toContain('goto about:blank');
    expect(setup).toContain('pathToFileURL');
    expect(setup).toContain('$GITHUB_WORKSPACE/.gstack-ci-blank.html');
    expect(setup).toContain('goto "$PAGE_URL"');
    expect(setup).toContain('rm -f "$PAGE_PATH"');
    for (const command of [' status', ' restart', ' stop']) {
      expect(setup).toContain(command);
    }
    expect(setup).toContain('BROWSE_STATE_FILE');
    expect(setup).toMatch(/state file.*removed|state file.*cleanup|cleanup.*state/i);
    expect(setup).toContain('process.kill(pid, 0)');
    expect(setup).toContain('"$after_pid"');
  });
});
