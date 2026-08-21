import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateAdversarialStep } from '../scripts/resolvers/review';
import { HOST_PATHS } from '../scripts/resolvers/types';

let tmp = '';
let repo = '';
let fakeBin = '';
let script = '';

function run(command: string, args: string[], cwd = repo) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr}`);
  }
  return result;
}

function writeExecutable(name: string, body: string): string {
  const target = path.join(fakeBin, name);
  fs.writeFileSync(target, body, { mode: 0o755 });
  return target;
}

function installClaudeStub(body: string): void {
  writeExecutable('claude', `#!/bin/sh\n${body}\n`);
}

function runAdversarial(extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', script], {
    cwd: repo,
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      ...extraEnv,
    },
  });
}

beforeAll(() => {
  if (process.platform === 'win32') return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-codex-adversarial-'));
  repo = path.join(tmp, 'repo');
  fakeBin = path.join(tmp, 'bin');
  fs.mkdirSync(repo);
  fs.mkdirSync(fakeBin);

  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.email', 'tests@gstack.local']);
  run('git', ['config', 'user.name', 'gstack tests']);
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const value = 1;\n');
  fs.mkdirSync(path.join(repo, 'tests'));
  fs.writeFileSync(path.join(repo, 'tests', 'app.test.ts'), 'expect(value).toBe(1);\n');
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'base']);
  run('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  run('git', ['checkout', '-b', 'feature']);

  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const value = 2; // SOURCE_CHANGE\n');
  fs.writeFileSync(
    path.join(repo, 'tests', 'app.test.ts'),
    'expect(value).toBe(2); // SECRET_FIXTURE_PAYLOAD\n',
  );
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'feature']);

  const rendered = generateAdversarialStep({
    skillName: 'review',
    tmplPath: 'review/SKILL.md.tmpl',
    host: 'codex',
    paths: HOST_PATHS.codex,
  });
  const block = rendered.match(/```bash\n([\s\S]*?)\n```/);
  expect(block).not.toBeNull();
  script = block![1].replaceAll('<base>', 'main');
});

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('Codex-host Claude Sonnet adversarial subprocess', () => {
  test('generated shell is valid Bash', () => {
    const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf-8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('pins Sonnet/high/tool-less flags and sends fixture content in summary mode', () => {
    const argsFile = path.join(tmp, 'claude-args');
    const promptFile = path.join(tmp, 'claude-prompt');
    installClaudeStub(
      'printf \'%s\\n\' "$@" > "$CLAUDE_ARGS_FILE"\n' +
      'cat > "$CLAUDE_PROMPT_CAPTURE"\n' +
      'printf \'%s\\n\' "$FAKE_CLAUDE_OUTPUT"',
    );
    fs.rmSync(path.join(fakeBin, 'gtimeout'), { force: true });

    const result = runAdversarial({
      CLAUDE_ARGS_FILE: argsFile,
      CLAUDE_PROMPT_CAPTURE: promptFile,
      FAKE_CLAUDE_OUTPUT: JSON.stringify({
        result: '[CRITICAL] app.ts:1 — value regression\nRecommendation: Fix the value regression because callers expect one',
        model: 'claude-sonnet',
        usage: { input_tokens: 12, output_tokens: 7 },
      }),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('[CRITICAL] app.ts:1');
    const args = fs.readFileSync(argsFile, 'utf-8').split('\n');
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
    expect(args).toContain('--effort');
    expect(args).toContain('high');
    expect(args).toContain('--tools');
    expect(args).toContain('--no-session-persistence');

    const prompt = fs.readFileSync(promptFile, 'utf-8');
    expect(prompt).toContain('SOURCE_CHANGE');
    expect(prompt).toContain('tests/app.test.ts');
    expect(prompt).not.toContain('SECRET_FIXTURE_PAYLOAD');
    expect(prompt).toContain('Fixture and test files');
  });

  test('reports authentication failures as missing coverage', () => {
    installClaudeStub('cat >/dev/null\necho "authentication required" >&2\nexit 1');
    fs.rmSync(path.join(fakeBin, 'gtimeout'), { force: true });

    const result = runAdversarial();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Claude authentication failed');
    expect(result.stdout).toContain('Missing adversarial coverage');
  });

  test('reports timeout as missing coverage', () => {
    installClaudeStub('cat >/dev/null\nprintf \'%s\\n\' \'should not run\'');
    writeExecutable('gtimeout', '#!/bin/sh\nexit 124\n');

    const result = runAdversarial();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('exceeded 9 minutes');
    expect(result.stdout).toContain('Missing adversarial coverage');
  });

  test('surfaces malformed JSON instead of treating it as a clean review', () => {
    installClaudeStub('cat >/dev/null\nprintf \'%s\\n\' \'not-json\'');
    fs.rmSync(path.join(fakeBin, 'gtimeout'), { force: true });

    const result = runAdversarial();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('CLAUDE_JSON_PARSE_ERROR');
    expect(result.stdout).toContain('Missing adversarial coverage');
    expect(result.stdout).toContain('not-json');
  });

  test('treats a JSON error envelope as missing coverage', () => {
    installClaudeStub('cat >/dev/null\nprintf \'%s\\n\' \'{"is_error":true,"result":"upstream unavailable"}\'');
    fs.rmSync(path.join(fakeBin, 'gtimeout'), { force: true });

    const result = runAdversarial();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('CLAUDE_ERROR');
    expect(result.stdout).toContain('Missing adversarial coverage');
    expect(result.stdout).toContain('upstream unavailable');
  });
});
