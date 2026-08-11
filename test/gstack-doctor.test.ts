import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const DOCTOR = path.join(ROOT, 'bin', 'gstack-doctor');
const BASH = process.platform === 'win32'
  ? spawnSync('where.exe', ['bash'], { encoding: 'utf-8' }).stdout.split(/\r?\n/, 1)[0]
  : 'bash';

type DoctorCheck = {
  id: string;
  required: boolean;
  status: 'pass' | 'fail' | 'unsupported';
};

type DoctorReport = {
  schema_version: 1;
  source: { version: string };
  checks: DoctorCheck[];
};

let tmp = '';
let toolBin = '';
let bashEnv = '';

function commandPath(name: string): string {
  const result = spawnSync(BASH, ['-lc', `command -v ${name}`], { encoding: 'utf-8' });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Required test command is unavailable: ${name}`);
  }
  return result.stdout.trim();
}

function writeCommandShim(name: string, target?: string): void {
  const shim = path.join(toolBin, name);
  fs.writeFileSync(shim, target
    ? `#!/usr/bin/env bash\nexec "${target}" "$@"\n`
    : '#!/usr/bin/env bash\nexit 0\n');
  fs.chmodSync(shim, 0o755);
}

function treeDigest(root: string): string {
  const hash = createHash('sha256');
  const entries = fs.readdirSync(root, { recursive: true }).sort();
  for (const entry of entries) {
    const file = path.join(root, entry);
    const stat = fs.lstatSync(file);
    hash.update(entry);
    hash.update(stat.isDirectory() ? 'directory' : 'file');
    if (stat.isFile()) hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex');
}

function doctorWithVersion(version: string): string {
  const root = path.join(tmp, `source-${version.replace(/[^a-z0-9]/gi, '_')}`);
  const doctor = path.join(root, 'bin', 'gstack-doctor');
  fs.mkdirSync(path.dirname(doctor), { recursive: true });
  fs.mkdirSync(path.join(root, 'browse', 'dist'), { recursive: true });
  fs.copyFileSync(DOCTOR, doctor);
  fs.writeFileSync(path.join(root, 'VERSION'), `${version}\n`);
  fs.writeFileSync(path.join(root, 'browse', 'dist', 'server-node.mjs'), 'test browser runtime\n');
  return doctor;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-doctor-'));
  toolBin = path.join(tmp, 'tools');
  bashEnv = path.join(tmp, 'bash-env');
  fs.mkdirSync(toolBin);
  for (const name of ['git', 'bun', 'node', 'codex']) writeCommandShim(name, commandPath(name));
  fs.writeFileSync(
    path.join(toolBin, 'uname'),
    '#!/usr/bin/env bash\nprintf "%s\\n" "${GSTACK_DOCTOR_TEST_UNAME:-MINGW64_NT}"\n',
  );
  fs.chmodSync(path.join(toolBin, 'uname'), 0o755);
  fs.writeFileSync(
    bashEnv,
    [
      'command() {',
      '  if [ "${1:-}" = "-v" ] && [ "${2:-}" = "${GSTACK_DOCTOR_MISSING_TOOL:-}" ] && [ -n "${GSTACK_DOCTOR_MISSING_TOOL:-}" ]; then',
      '    return 1',
      '  fi',
      '  builtin command "$@"',
      '}',
      'uname() { printf "%s\\n" "${GSTACK_DOCTOR_TEST_UNAME:-MINGW64_NT}"; }',
      '',
    ].join('\n'),
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function installSkill(name: string): void {
  const skillDir = path.join(tmp, 'codex', 'skills', name);
  fs.mkdirSync(path.join(skillDir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`);
  fs.writeFileSync(
    path.join(skillDir, 'agents', 'openai.yaml'),
    `interface:\n  display_name: "${name}"\n  default_prompt: "Use ${name}"\n`,
  );
}

function runDoctor(
  args: string[] = [],
  missingTool?: string,
  options: { platform?: 'windows' | 'macos'; doctor?: string } = {},
) {
  const env = { ...process.env };
  return spawnSync(BASH, [options.doctor ?? DOCTOR, ...args], {
    env: {
      ...env,
      HOME: path.join(tmp, 'home'),
      USERPROFILE: path.join(tmp, 'home'),
      GSTACK_HOME: path.join(tmp, 'state'),
      CODEX_HOME: path.join(tmp, 'codex'),
      BASH_ENV: bashEnv,
      GSTACK_DOCTOR_MISSING_TOOL: missingTool ?? '',
      PATH: `${toolBin.replaceAll('\\', '/') }:/usr/bin:/bin`,
      GSTACK_DOCTOR_TEST_UNAME: options.platform === 'macos' ? 'Darwin' : 'MINGW64_NT',
      GH_TOKEN: 'do-not-report-this-token',
      GITHUB_TOKEN: 'do-not-report-this-token-either',
    },
    encoding: 'utf-8',
    timeout: 10_000,
  });
}

function parseReport(stdout: string): DoctorReport {
  return JSON.parse(stdout) as DoctorReport;
}

describe('gstack-doctor', () => {
  test('reports the read-only JSON schema and all required Codex skills', () => {
    installSkill('gstack-qa');
    installSkill('gstack-review');
    installSkill('gstack-ship');

    const before = treeDigest(tmp);
    const result = runDoctor(['--json', '--strict']);
    const after = treeDigest(tmp);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(after).toBe(before);
    expect(result.stdout).not.toContain('do-not-report-this-token');

    const report = parseReport(result.stdout);
    expect(report.schema_version).toBe(1);
    expect(report.source.version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(report.checks).toEqual(expect.any(Array));
    for (const name of ['gstack-qa', 'gstack-review', 'gstack-ship']) {
      expect(report.checks).toContainEqual({ id: `codex-skill-${name}`, required: true, status: 'pass' });
    }
    expect(report.checks).toContainEqual({ id: 'ios-workflows', required: false, status: 'unsupported' });
  });

  test('strict rejects malformed source versions and accepts exactly four numeric components', () => {
    installSkill('gstack-qa');
    installSkill('gstack-review');
    installSkill('gstack-ship');

    const valid = runDoctor(['--json', '--strict'], undefined, { doctor: doctorWithVersion('1.2.3.4') });
    expect(valid.status).toBe(0);
    expect(parseReport(valid.stdout).checks)
      .toContainEqual({ id: 'source-version', required: true, status: 'pass' });

    for (const version of ['1..2', '.1.2.3', '1.2.3.', '1.2.3', '1.2.3.4.5']) {
      const result = runDoctor(['--json', '--strict'], undefined, { doctor: doctorWithVersion(version) });
      expect(result.status).toBe(1);
      expect(parseReport(result.stdout).checks)
        .toContainEqual({ id: 'source-version', required: true, status: 'fail' });
    }
  });

  test('strict fails only missing required checks while normal mode remains informational', () => {
    installSkill('gstack-qa');
    installSkill('gstack-review');

    const normal = runDoctor(['--json']);
    const strict = runDoctor(['--json', '--strict']);
    const human = runDoctor();

    expect(normal.status).toBe(0);
    expect(strict.status).toBe(1);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain('codex-skill-gstack-ship: fail');
    expect(human.stdout).not.toContain('"id"');
    expect(parseReport(strict.stdout).checks)
      .toContainEqual({ id: 'codex-skill-gstack-ship', required: true, status: 'fail' });
  });

  test('strict fails when each required local tool is unavailable', () => {
    installSkill('gstack-qa');
    installSkill('gstack-review');
    installSkill('gstack-ship');

    for (const toolName of ['git', 'bun', 'node', 'codex']) {
      const result = runDoctor(['--json', '--strict'], toolName);
      const report = parseReport(result.stdout);

      expect(result.status).toBe(1);
      expect(report.checks).toContainEqual({ id: `tool-${toolName}`, required: true, status: 'fail' });
    }
  });

  test('optional tools remain informational when they are unavailable', () => {
    installSkill('gstack-qa');
    installSkill('gstack-review');
    installSkill('gstack-ship');

    for (const toolName of ['python', 'gh', 'jq']) {
      const result = runDoctor(['--json', '--strict'], toolName);
      const report = parseReport(result.stdout);

      expect(result.status).toBe(0);
      expect(report.checks).toContainEqual({ id: `tool-${toolName}`, required: false, status: 'fail' });
    }
  });

  test('reports iOS workflows as optional and available only with Apple tooling on macOS', () => {
    installSkill('gstack-qa');
    installSkill('gstack-review');
    installSkill('gstack-ship');

    const missingAppleTools = runDoctor(['--json', '--strict'], undefined, { platform: 'macos' });
    expect(missingAppleTools.status).toBe(0);
    expect(parseReport(missingAppleTools.stdout).checks)
      .toContainEqual({ id: 'ios-workflows', required: false, status: 'fail' });

    for (const tool of ['xcodebuild', 'xcrun', 'devicectl']) writeCommandShim(tool);
    const ready = runDoctor(['--json', '--strict'], undefined, { platform: 'macos' });
    expect(ready.status).toBe(0);
    expect(parseReport(ready.stdout).checks)
      .toContainEqual({ id: 'ios-workflows', required: false, status: 'pass' });
  });

  test('does not contain network, authentication, setup, or build commands', () => {
    const source = fs.readFileSync(DOCTOR, 'utf-8').split('\n').slice(1).join('\n');

    expect(source).not.toMatch(/\b(?:curl|wget|Invoke-WebRequest|git clone|gh auth|gh api)\b/i);
    expect(source).not.toMatch(/(?:\.\/setup|bun run build|BROWSE_STATE_FILE|printenv|\benv\b)/);
  });
});
