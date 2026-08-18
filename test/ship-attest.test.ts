import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gitIn, makeScratchRepo } from './helpers/scratch-repo';

const ROOT = path.resolve(import.meta.dir, '..');
const HELPER = path.join(ROOT, 'bin', 'gstack-ship-attest');

let repoDir: string;
let fakeBinDir: string;
let callLog: string;

beforeEach(() => {
  repoDir = makeScratchRepo('gstack-ship-attest-');
  fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ship-attest-bin-'));
  callLog = path.join(fakeBinDir, 'gh-calls.log');

  const fakeGh = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"

if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\t%s\\t%s\\n' "$FAKE_PR_HEAD" "$FAKE_PR_URL" "\${FAKE_PR_STATE:-OPEN}"
  exit 0
fi

if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  printf '%s\\n' "\${FAKE_REPO:-acme/widget}"
  exit 0
fi

if [ "$1" = "api" ]; then
  if [ "\${FAKE_API_FAIL:-0}" = "1" ]; then
    echo "status API denied" >&2
    exit 1
  fi

  state=""
  context=""
  while [ "$#" -gt 0 ]; do
    arg="$1"
    shift
    if [ "$arg" = "-f" ] && [ "$#" -gt 0 ]; then
      field="$1"
      shift
      case "$field" in
        state=*) state="\${field#state=}" ;;
        context=*) context="\${field#context=}" ;;
      esac
    fi
  done
  printf '%s|%s|%s\\n' "$state" "$context" "$FAKE_PR_HEAD"
  exit 0
fi

echo "unexpected gh invocation: $*" >&2
exit 9
`;
  fs.writeFileSync(path.join(fakeBinDir, 'gh'), fakeGh, { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(fakeBinDir, { recursive: true, force: true });
});

function run(
  args: string[],
  overrides: Record<string, string> = {},
): { status: number; stdout: string; stderr: string; calls: string } {
  const head = gitIn(repoDir, 'rev-parse HEAD').trim();
  const result = spawnSync(HELPER, args, {
    cwd: repoDir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
      FAKE_GH_LOG: callLog,
      FAKE_PR_HEAD: head,
      FAKE_PR_URL: 'https://github.com/acme/widget/pull/7',
      ...overrides,
    },
  });

  return {
    status: result.status ?? -1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    calls: fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf-8') : '',
  };
}

describe('gstack-ship-attest', () => {
  test('posts success on the exact open PR head', () => {
    const head = gitIn(repoDir, 'rev-parse HEAD').trim();
    const result = run(['--state', 'success']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`gstack/ship success attested on ${head}`);
    expect(result.calls).toContain(`api -X POST repos/acme/widget/statuses/${head}`);
    expect(result.calls).toContain('state=success');
    expect(result.calls).toContain('context=gstack/ship');
    expect(result.calls).toContain('target_url=https://github.com/acme/widget/pull/7');
  });

  test('posts a failure status when the documentation phase failed', () => {
    const result = run([
      '--state',
      'failure',
      '--description',
      'Documentation sync failed',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gstack/ship failure attested');
    expect(result.calls).toContain('state=failure');
    expect(result.calls).toContain('description=Documentation sync failed');
  });

  test('refuses to attest when local HEAD differs from the PR head', () => {
    const result = run(['--state', 'success'], { FAKE_PR_HEAD: '0'.repeat(40) });

    expect(result.status).toBe(4);
    expect(result.stderr).toContain('does not match open PR head');
    expect(result.calls).not.toContain('api -X POST');
  });

  test('refuses to attest a closed PR', () => {
    const result = run(['--state', 'success'], { FAKE_PR_STATE: 'CLOSED' });

    expect(result.status).toBe(3);
    expect(result.stderr).toContain('PR is not open');
    expect(result.calls).not.toContain('api -X POST');
  });

  test('fails when GitHub rejects the commit status', () => {
    const result = run(['--state', 'success'], { FAKE_API_FAIL: '1' });

    expect(result.status).toBe(5);
    expect(result.stderr).toContain('could not post gstack/ship');
  });

  test('rejects unsupported states', () => {
    const result = run(['--state', 'pending']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('state must be success or failure');
    expect(result.calls).toBe('');
  });
});
