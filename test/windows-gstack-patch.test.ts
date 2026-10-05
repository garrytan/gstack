import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import copilot from '../hosts/copilot';

const ROOT = path.resolve(import.meta.dir, '..');
const SKILL_DIR = path.join(ROOT, 'contrib', 'skills', 'windows-gstack-patch');
const PATCH = path.join(SKILL_DIR, 'Apply-WindowsPatch.ps1');
const VERIFY = path.join(SKILL_DIR, 'Verify-WindowsPatch.ps1');
const PAYLOAD_PATH = path.join(SKILL_DIR, 'shell-execution.md');
const PAYLOAD = fs.readFileSync(PAYLOAD_PATH, 'utf8');
const BANNER = '<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->';
const BEGIN = '<!-- gstack:copilot-shell-execution:begin -->';
const END = '<!-- gstack:copilot-shell-execution:end -->';
const POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const GIT_BASH = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');

const tempRoots: string[] = [];
const invalidSkillCases: ReadonlyArray<readonly [caseName: string, content: string]> = [
  ['malformed frontmatter', `---\nname: gstack-bad\n${BANNER}\n## Broken\n`],
  ['duplicate markers', generatedSkill('gstack-bad', `${PAYLOAD}\n${PAYLOAD}\n## Broken\n`)],
  ['unbalanced markers', generatedSkill('gstack-bad', `${BEGIN}\n## Broken\n`)],
  ['misplaced markers', generatedSkill('gstack-bad', `\`\`\`bash\nprintf broken\n\`\`\`\n${PAYLOAD}`)],
];
const realBashStderrCases: ReadonlyArray<readonly [
  caseName: string,
  exitCode: number,
  expectedStatus: number,
  expectedDiagnostic: string,
]> = [
  ['accepts a warning from a successful startup', 0, 0, 'SUMMARY bash=ok startup=ok protocol=ok parent_pid=ok openwith=ok'],
  ['retains diagnostics from a failed startup', 23, 1, 'real Git Bash failure diagnostic'],
];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows gstack patch '));
  tempRoots.push(root);
  return root;
}

function generatedSkill(name: string, body = '## Existing\n\nKeep this body.\n'): string {
  return `---\nname: ${name}\ndescription: fixture\n---\n\n${BANNER}\n${body}`;
}

function writeSkill(skillsRoot: string, relativeDir: string, name: string, body?: string): string {
  const file = path.join(skillsRoot, relativeDir, 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, generatedSkill(name, body));
  return file;
}

function runPatch(skillsRoot: string, extraArgs: string[] = []) {
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    PATCH,
    '-SkillsRoot',
    skillsRoot,
  ];
  if (!extraArgs.some(argument => argument.toLowerCase() === '-backupdirectory')) {
    args.push('-BackupDirectory', path.join(path.dirname(skillsRoot), 'backups'));
  }
  return spawnSync(POWERSHELL, [
    ...args,
    ...extraArgs,
  ], {
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function runVerify(skillsRoot: string, bashPath: string, bashOnly = false) {
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    VERIFY,
    '-SkillsRoot',
    skillsRoot,
    '-BashPath',
    bashPath,
  ];
  if (bashOnly) args.push('-BashOnly');
  return spawnSync(POWERSHELL, args, {
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function backupMappings(output: string): Map<string, string> {
  const mappings = [...output.matchAll(/^BACKUP '(.*)' -> '(.*)'\.$/gm)]
    .map((match): [string, string] => {
      const [, original, backup] = match;
      if (original === undefined || backup === undefined) {
        throw new Error(`Malformed backup mapping: ${match[0]}`);
      }
      return [path.normalize(original).toLowerCase(), backup];
    });
  return new Map(mappings);
}

test('the bundled payload stays byte-for-byte equal to the Copilot host prefix', () => {
  expect(copilot.generation.bodyPrefix).toBe(PAYLOAD);
});

describe.skipIf(process.platform !== 'win32')('windows-gstack-patch behavior', () => {
  test('patches immediate and supported nested generated skills, replaces stale content, and reruns without writes', () => {
    const fixture = tempRoot();
    const skillsRoot = path.join(fixture, 'skills root');
    fs.mkdirSync(skillsRoot, { recursive: true });
    const rootSkill = writeSkill(skillsRoot, 'gstack', 'gstack');
    const reviewSkill = writeSkill(skillsRoot, 'gstack-review', 'gstack-review');
    const upgradeSkill = writeSkill(skillsRoot, path.join('gstack', 'gstack-upgrade'), 'gstack-upgrade');
    const officeHoursSkill = writeSkill(skillsRoot, path.join('gstack', 'office-hours'), 'gstack-office-hours');
    const ignoredNested = writeSkill(skillsRoot, path.join('gstack', 'not-a-runtime-copy'), 'gstack-not-a-runtime-copy');
    const stale = `${BEGIN}\n## stale\n${END}\n`;
    fs.writeFileSync(reviewSkill, generatedSkill('gstack-review', `${stale}\n## Existing\n\nKeep this body.\n`));
    const originals = new Map(
      [rootSkill, reviewSkill, upgradeSkill, officeHoursSkill]
        .map(file => [path.normalize(file).toLowerCase(), fs.readFileSync(file)]),
    );

    const first = runPatch(skillsRoot);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('SUMMARY changed=4 unchanged=0 skipped=0 planned=0');
    const backups = backupMappings(first.stdout);
    expect(backups.size).toBe(4);
    const runBackupDirectory = first.stdout.match(/^BACKUP-DIRECTORY '(.*)'\.\r?$/m)?.[1];
    expect(runBackupDirectory).toBeDefined();
    for (const original of [rootSkill, reviewSkill, upgradeSkill, officeHoursSkill]) {
      const backup = path.join(runBackupDirectory!, path.relative(skillsRoot, original));
      expect(fs.readFileSync(backup)).toEqual(originals.get(path.normalize(original).toLowerCase())!);
      expect(path.resolve(backup).startsWith(path.resolve(skillsRoot) + path.sep)).toBeFalse();
    }
    for (const file of [rootSkill, reviewSkill, upgradeSkill, officeHoursSkill]) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content.split(BEGIN)).toHaveLength(2);
      expect(content.split(END)).toHaveLength(2);
      expect(content.indexOf(PAYLOAD)).toBeGreaterThan(content.indexOf('\n---\n'));
      expect(content.indexOf(PAYLOAD)).toBeLessThan(content.indexOf('## Existing'));
      expect(content).toContain('## Existing\n\nKeep this body.\n');
      expect(content).not.toContain('## stale');
      expect(fs.readdirSync(path.dirname(file)).some(name => name.startsWith('.windows-gstack-patch-'))).toBeFalse();
    }
    for (const file of [rootSkill, upgradeSkill, officeHoursSkill]) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content.indexOf(PAYLOAD)).toBeLessThan(content.indexOf(BANNER));
    }
    expect(fs.readFileSync(ignoredNested, 'utf8')).toBe(generatedSkill('gstack-not-a-runtime-copy'));

    const fixedTime = new Date('2020-01-02T03:04:05.000Z');
    for (const file of [rootSkill, reviewSkill, upgradeSkill, officeHoursSkill]) fs.utimesSync(file, fixedTime, fixedTime);
    const bytesBefore = [rootSkill, reviewSkill, upgradeSkill, officeHoursSkill].map(file => fs.readFileSync(file));
    const second = runPatch(skillsRoot);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('SUMMARY changed=0 unchanged=4 skipped=0 planned=0');
    expect(second.stdout).not.toContain('BACKUP-DIRECTORY');
    [rootSkill, reviewSkill, upgradeSkill, officeHoursSkill].forEach((file, index) => {
      expect(fs.readFileSync(file)).toEqual(bytesBefore[index]);
      expect(fs.statSync(file).mtime.toISOString()).toBe(fixedTime.toISOString());
    });
  });

  test.each(invalidSkillCases)('rejects %s before mutating another valid skill', (_caseName, invalidContent) => {
    const skillsRoot = path.join(tempRoot(), 'skills root');
    fs.mkdirSync(skillsRoot, { recursive: true });
    const valid = writeSkill(skillsRoot, 'gstack-valid', 'gstack-valid');
    const invalid = path.join(skillsRoot, 'gstack-bad', 'SKILL.md');
    fs.mkdirSync(path.dirname(invalid), { recursive: true });
    fs.writeFileSync(invalid, invalidContent);
    const validBefore = fs.readFileSync(valid);

    const result = runPatch(skillsRoot);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Malformed generated SKILL\.md frontmatter|Duplicate shell-execution markers|Unbalanced shell-execution markers|Misplaced shell-execution prefix/);
    expect(fs.readFileSync(valid)).toEqual(validBefore);
    expect(fs.readFileSync(valid, 'utf8')).not.toContain(BEGIN);
  });

  test('skips user-owned gstack-prefixed directories and preserves their bytes', () => {
    const skillsRoot = path.join(tempRoot(), 'skills root');
    const file = path.join(skillsRoot, 'gstack-notes', 'SKILL.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const content = '---\nname: gstack-notes\ndescription: personal\n---\n\n# My notes\n';
    fs.writeFileSync(file, content);

    const result = runPatch(skillsRoot);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('SKIPPED user-owned');
    expect(result.stdout).toContain("gstack-notes\\SKILL.md': no generated banner.");
    expect(result.stdout).toContain('SUMMARY changed=0 unchanged=0 skipped=1 planned=0');
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
  });

  test('rejects a gstack junction ancestor with only a nested runtime copy before mutating another skill', () => {
    const fixture = tempRoot();
    const skillsRoot = path.join(fixture, 'skills root');
    const outside = path.join(fixture, 'outside');
    fs.mkdirSync(skillsRoot, { recursive: true });
    fs.mkdirSync(path.join(outside, 'office-hours'), { recursive: true });
    const valid = writeSkill(skillsRoot, 'gstack-valid', 'gstack-valid');
    const nested = path.join(outside, 'office-hours', 'SKILL.md');
    fs.writeFileSync(nested, generatedSkill('gstack-office-hours'));
    fs.symlinkSync(outside, path.join(skillsRoot, 'gstack'), 'junction');
    const validBefore = fs.readFileSync(valid);
    const nestedBefore = fs.readFileSync(nested);

    const result = runPatch(skillsRoot);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('Refusing reparse point in patch path');
    expect(fs.readFileSync(valid)).toEqual(validBefore);
    expect(fs.readFileSync(nested)).toEqual(nestedBefore);
  });

  test('-WhatIf plans changes without writing them', () => {
    const fixture = tempRoot();
    const skillsRoot = path.join(fixture, 'skills root');
    const file = writeSkill(skillsRoot, 'gstack-review', 'gstack-review');
    const before = fs.readFileSync(file);

    const result = runPatch(skillsRoot, ['-WhatIf']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('SUMMARY changed=0 unchanged=0 skipped=0 planned=1');
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.existsSync(path.join(fixture, 'backups'))).toBeFalse();
  });

  test('rejects a backup directory inside SkillsRoot before mutation', () => {
    const skillsRoot = path.join(tempRoot(), 'skills root');
    const file = writeSkill(skillsRoot, 'gstack-review', 'gstack-review');
    const before = fs.readFileSync(file);

    const result = runPatch(skillsRoot, ['-BackupDirectory', path.join(skillsRoot, 'backups')]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('BackupDirectory must be outside SkillsRoot');
    expect(fs.readFileSync(file)).toEqual(before);
  });

  test('preserves a UTF-8 BOM while installing the prefix', () => {
    const skillsRoot = path.join(tempRoot(), 'skills root');
    const file = writeSkill(skillsRoot, 'gstack-review', 'gstack-review');
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(file)]));

    const result = runPatch(skillsRoot);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(file).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).toContain(PAYLOAD);
  });

  test('the verifier proves Bash and the startup protocol with isolated state', () => {
    const fixture = tempRoot();
    const skillsRoot = path.join(fixture, 'skills root');
    const start = path.join(skillsRoot, 'gstack', 'bin', 'gstack-skill-start');
    const fakeBash = path.join(fixture, 'fake bash.ps1');
    fs.mkdirSync(path.dirname(start), { recursive: true });
    fs.writeFileSync(start, '');
    fs.writeFileSync(fakeBash, String.raw`
if ($args[0] -eq '--version') {
    Write-Output 'GNU bash, version test'
    exit 0
}
$parentIndex = [Array]::IndexOf([object[]]$args, '--parent-pid')
if ($parentIndex -lt 0) {
    exit 9
}
$sessionDirectory = Join-Path $env:GSTACK_STATE_ROOT 'sessions'
New-Item -ItemType Directory -Path $sessionDirectory -Force | Out-Null
New-Item -ItemType File -Path (Join-Path $sessionDirectory $args[$parentIndex + 1]) | Out-Null
Write-Output 'SKILL_START_PROTO: 1'
Write-Output 'MODEL_OVERLAY: none'
exit 0
`.trimStart());

    const result = runVerify(skillsRoot, fakeBash);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('EVIDENCE startup_exit=0.');
    expect(result.stdout).toContain("EVIDENCE protocol='SKILL_START_PROTO: 1'.");
    expect(result.stdout).toContain("EVIDENCE model_overlay='none'.");
    expect(result.stdout).toMatch(/EVIDENCE parent_pid=\d+ session='.*\\sessions\\\d+'\./);
    expect(result.stdout).toContain('EVIDENCE openwith_new=0.');
    expect(result.stdout).toContain('SUMMARY bash=ok startup=ok protocol=ok parent_pid=ok openwith=ok');
  });

  test.each(realBashStderrCases)('%s with real Git Bash', (_caseName, exitCode, expectedStatus, expectedDiagnostic) => {
    expect(fs.existsSync(GIT_BASH)).toBeTrue();
    const skillsRoot = path.join(tempRoot(), 'skills root');
    const start = path.join(skillsRoot, 'gstack', 'bin', 'gstack-skill-start');
    fs.mkdirSync(path.dirname(start), { recursive: true });
    fs.writeFileSync(start, `#!/usr/bin/env bash
parent_pid=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--parent-pid" ]; then
    parent_pid=$2
    shift 2
  else
    shift
  fi
done
if [ ${exitCode} -ne 0 ]; then
  printf '%s\n' 'real Git Bash failure diagnostic' >&2
  exit ${exitCode}
fi
mkdir -p "$GSTACK_STATE_ROOT/sessions"
: > "$GSTACK_STATE_ROOT/sessions/$parent_pid"
printf '%s\n' 'SKILL_START_PROTO: 1'
printf '%s\n' 'real Git Bash warning diagnostic' >&2
printf '%s\n' 'MODEL_OVERLAY: none'
`);

    const result = runVerify(skillsRoot, GIT_BASH);
    expect(result.status).toBe(expectedStatus);
    expect(`${result.stdout}\n${result.stderr}`).toContain(expectedDiagnostic);
    if (exitCode !== 0) {
      expect(`${result.stdout}\n${result.stderr}`).toContain(`gstack-skill-start failed with exit code ${exitCode}.`);
    }
  });

  test('the Bash preflight rejects a missing path without mutating skills', () => {
    const fixture = tempRoot();
    const skillsRoot = path.join(fixture, 'skills root');
    const file = writeSkill(skillsRoot, 'gstack-review', 'gstack-review');
    const before = fs.readFileSync(file);

    const result = runVerify(skillsRoot, path.join(fixture, 'missing bash.exe'), true);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('BashPath does not exist');
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(BEGIN);
  });
});
