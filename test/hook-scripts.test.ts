import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const CAREFUL_SCRIPT = path.join(ROOT, 'careful', 'bin', 'check-careful.sh');
const FREEZE_SCRIPT = path.join(ROOT, 'freeze', 'bin', 'check-freeze.sh');

function runHook(scriptPath: string, input: object, env?: Record<string, string>): { exitCode: number; output: any; raw: string } {
  const result = spawnSync('bash', [scriptPath], {
    input: JSON.stringify(input),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    timeout: 5000,
  });
  const raw = result.stdout.toString().trim();
  let output: any = {};
  try {
    output = JSON.parse(raw);
  } catch {}
  return { exitCode: result.status ?? 1, output, raw };
}

function runHookRaw(scriptPath: string, rawInput: string, env?: Record<string, string>): { exitCode: number; output: any; raw: string } {
  const result = spawnSync('bash', [scriptPath], {
    input: rawInput,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    timeout: 5000,
  });
  const raw = result.stdout.toString().trim();
  let output: any = {};
  try {
    output = JSON.parse(raw);
  } catch {}
  return { exitCode: result.status ?? 1, output, raw };
}

// The harness dispatches ONLY on hookSpecificOutput.permissionDecision; a bare
// top-level {"permissionDecision":...} is parsed and then ignored, so asserting
// the top-level field would keep passing while the hook blocks nothing.
// Assert the shape Claude Code actually reads.
function decisionOf(output: any): string | undefined {
  return output?.hookSpecificOutput?.permissionDecision;
}

function reasonOf(output: any): string {
  return output?.hookSpecificOutput?.permissionDecisionReason ?? '';
}

function carefulInput(command: string) {
  return { tool_input: { command } };
}

function freezeInput(filePath: string) {
  return { tool_input: { file_path: filePath } };
}

// check-freeze.sh resolves its state root the same way bin/gstack-paths does:
// CLAUDE_PLUGIN_DATA is honoured only when CLAUDE_PLUGIN_ROOT confirms gstack, so
// another plugin's data dir leaking into the session env cannot redirect where the
// freeze boundary is read from. Callers below therefore set both - which is also
// the only reachable real state, since cli.js sets CLAUDE_PLUGIN_ROOT first and
// only then CLAUDE_PLUGIN_DATA.
function withFreezeDir(freezePath: string, fn: (stateDir: string) => void) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-freeze-test-'));
  fs.writeFileSync(path.join(stateDir, 'freeze-dir.txt'), freezePath);
  try {
    fn(stateDir);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

// ============================================================
// check-careful.sh tests
// ============================================================
describe('check-careful.sh', () => {

  // --- Destructive rm commands ---

  describe('rm -rf / rm -r', () => {
    test('rm -rf /var/data warns with recursive delete message', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf /var/data'));
      expect(exitCode).toBe(0);
      expect(decisionOf(output)).toBe('ask');
      expect(reasonOf(output)).toContain('recursive delete');
    });

    test('rm -r ./some-dir warns', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -r ./some-dir'));
      expect(exitCode).toBe(0);
      expect(decisionOf(output)).toBe('ask');
      expect(reasonOf(output)).toContain('recursive delete');
    });

    test('rm -rf node_modules allows (safe exception)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf node_modules'));
      expect(exitCode).toBe(0);
      expect(decisionOf(output)).toBeUndefined();
    });

    test('rm -rf .next dist allows (multiple safe targets)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf .next dist'));
      expect(exitCode).toBe(0);
      expect(decisionOf(output)).toBeUndefined();
    });

    test('rm -rf node_modules /var/data warns (mixed safe+unsafe)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf node_modules /var/data'));
      expect(exitCode).toBe(0);
      expect(decisionOf(output)).toBe('ask');
      expect(reasonOf(output)).toContain('recursive delete');
    });

    // The safe exception matches the COMPLETE command against an anchored
    // whitelist shape — anything else (chains, comments, substitution) falls
    // through to the destructive-pattern warning.
    test('rm -rf /; rm -rf node_modules warns (semicolon chain, dangerous first)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf /; rm -rf node_modules'));
      expect(exitCode).toBe(0);
      expect(output.permissionDecision).toBe('ask');
      expect(output.message).toContain('recursive delete');
    });

    test('rm -rf /etc/data && rm -rf dist warns (&& chain, dangerous first)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf /etc/data && rm -rf dist'));
      expect(exitCode).toBe(0);
      expect(output.permissionDecision).toBe('ask');
      expect(output.message).toContain('recursive delete');
    });

    test('rm -rf node_modules; rm -rf /home/user/data warns (safe first, dangerous last)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf node_modules; rm -rf /home/user/data'));
      expect(exitCode).toBe(0);
      expect(output.permissionDecision).toBe('ask');
      expect(output.message).toContain('recursive delete');
    });

    // Command substitution can end in a whitelisted suffix while running
    // anything inside $(...) or backticks — the whitelist's target tokens
    // exclude `(` and backtick so these cannot ride the safe exception.
    test('rm -rf $(./wipe-all)/node_modules warns (command substitution)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf $(./wipe-all)/node_modules'));
      expect(exitCode).toBe(0);
      expect(output.permissionDecision).toBe('ask');
      expect(output.message).toContain('recursive delete');
    });

    test('rm -rf `./wipe-all`/node_modules warns (backtick substitution)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf `./wipe-all`/node_modules'));
      expect(exitCode).toBe(0);
      expect(output.permissionDecision).toBe('ask');
      expect(output.message).toContain('recursive delete');
    });

    // Capital -R is the documented recursive flag on BSD rm (macOS) and accepted
    // by GNU rm. Both greps previously required a lowercase r, so `rm -R /`
    // silently allowed.
    test('rm -R / warns (capital -R recursive)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -R /'));
      expect(exitCode).toBe(0);
      expect(output.permissionDecision).toBe('ask');
      expect(output.message).toContain('recursive delete');
    });

    test('rm -fR /home/user warns (capital R in flag cluster)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -fR /home/user'));
      expect(exitCode).toBe(0);
      expect(output.permissionDecision).toBe('ask');
      expect(output.message).toContain('recursive delete');
    });

    test('rm -Rf node_modules allows (capital R, single safe target)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -Rf node_modules'));
      expect(exitCode).toBe(0);
      expect(output.permissionDecision).toBeUndefined();
    });

    // JSON-escaped newline (literal two-char \n surviving the grep extraction
    // path) breaks the anchored whitelist shape → falls through to the warn.
    test('newline-chained rm warns (escaped-newline separator branch)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf /etc/x\nrm -rf node_modules'));
      expect(exitCode).toBe(0);
      expect(output.permissionDecision).toBe('ask');
      expect(output.message).toContain('recursive delete');
    });

    // Deliberate false positive, pinned: a safe-prefix chain ending in a safe rm
    // is indistinguishable from the dangerous-first exploit shape without real
    // shell parsing, so warn-on-all-chains is the designed fail-closed direction.
    // A future per-segment parser must consciously change this test.
    test('cd app && rm -rf node_modules asks (fail-closed on chains, by design)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('cd app && rm -rf node_modules'));
      expect(exitCode).toBe(0);
      expect(output.permissionDecision).toBe('ask');
      expect(output.message).toContain('recursive delete');
    });

    test.each([
      'rm -rf /; rm -rf node_modules',
      'rm -rf / && rm -rf node_modules',
      'rm -rf / # rm -rf node_modules',
      'rm -rf node_modules; rm -rf /',
      'rm -rf node_modules || rm -rf /',
      'echo ok && rm -rf /',
      'rm -rf node_modules\nrm -rf /',
    ])('never lets a safe-looking target hide a destructive command: %s', (command) => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(command));
      expect(exitCode).toBe(0);
      expect(output.permissionDecision).toBe('ask');
      expect(output.message).toContain('recursive delete');
    });
  });

  // --- SQL destructive commands ---
  // Note: SQL commands that contain embedded double quotes (e.g., psql -c "DROP TABLE")
  // get their command value truncated by the grep-based JSON extractor because \"
  // terminates the [^"]* match. We use commands WITHOUT embedded quotes so the grep
  // extraction works and the SQL keywords are visible to the pattern matcher.

  describe('SQL destructive commands', () => {
    test('psql DROP TABLE warns with DROP in message', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('psql -c DROP TABLE users;'));
      expect(exitCode).toBe(0);
      expect(decisionOf(output)).toBe('ask');
      expect(reasonOf(output)).toContain('DROP');
    });

    test('mysql drop database warns (case insensitive)', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('mysql -e drop database mydb'));
      expect(exitCode).toBe(0);
      expect(decisionOf(output)).toBe('ask');
      expect(reasonOf(output).toLowerCase()).toContain('drop');
    });

    test('psql TRUNCATE warns', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('psql -c TRUNCATE orders;'));
      expect(exitCode).toBe(0);
      expect(decisionOf(output)).toBe('ask');
      expect(reasonOf(output)).toContain('TRUNCATE');
    });
  });

  // --- Git destructive commands ---

  describe('git destructive commands', () => {
    test('git push --force warns with force-push', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git push --force origin main'));
      expect(exitCode).toBe(0);
      expect(decisionOf(output)).toBe('ask');
      expect(reasonOf(output)).toContain('force-push');
    });

    test('git push -f warns', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git push -f origin main'));
      expect(exitCode).toBe(0);
      expect(decisionOf(output)).toBe('ask');
      expect(reasonOf(output)).toContain('force-push');
    });

    test('git reset --hard warns with uncommitted', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git reset --hard HEAD~3'));
      expect(exitCode).toBe(0);
      expect(decisionOf(output)).toBe('ask');
      expect(reasonOf(output)).toContain('uncommitted');
    });

    test('git checkout . warns', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git checkout .'));
      expect(exitCode).toBe(0);
      expect(decisionOf(output)).toBe('ask');
      expect(reasonOf(output)).toContain('uncommitted');
    });

    test('git restore . warns', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git restore .'));
      expect(exitCode).toBe(0);
      expect(decisionOf(output)).toBe('ask');
      expect(reasonOf(output)).toContain('uncommitted');
    });
  });

  // --- Container / infra destructive commands ---

  describe('container and infra commands', () => {
    test('kubectl delete warns with kubectl in message', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('kubectl delete pod my-pod'));
      expect(exitCode).toBe(0);
      expect(decisionOf(output)).toBe('ask');
      expect(reasonOf(output)).toContain('kubectl');
    });

    test('docker rm -f warns', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('docker rm -f container123'));
      expect(exitCode).toBe(0);
      expect(decisionOf(output)).toBe('ask');
      expect(reasonOf(output)).toContain('Docker');
    });

    test('docker system prune -a warns', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('docker system prune -a'));
      expect(exitCode).toBe(0);
      expect(decisionOf(output)).toBe('ask');
      expect(reasonOf(output)).toContain('Docker');
    });
  });

  // --- Safe commands ---

  describe('safe commands allow without warning', () => {
    const safeCmds = [
      'ls -la',
      'git status',
      'npm install',
      'cat README.md',
      'echo hello',
    ];

    for (const cmd of safeCmds) {
      test(`"${cmd}" allows`, () => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(cmd));
        expect(exitCode).toBe(0);
        expect(decisionOf(output)).toBeUndefined();
      });
    }
  });

  // --- Edge cases ---

  describe('edge cases', () => {
    test('empty command allows gracefully', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(''));
      expect(exitCode).toBe(0);
      expect(decisionOf(output)).toBeUndefined();
    });

    test('missing command field allows gracefully', () => {
      const { exitCode, output } = runHook(CAREFUL_SCRIPT, { tool_input: {} });
      expect(exitCode).toBe(0);
      expect(decisionOf(output)).toBeUndefined();
    });

    test('malformed JSON input allows gracefully (exit 0, output {})', () => {
      const { exitCode, raw } = runHookRaw(CAREFUL_SCRIPT, 'this is not json at all{{{{');
      expect(exitCode).toBe(0);
      expect(raw).toBe('{}');
    });

    test('Python fallback: grep fails on multiline JSON, Python parses it', () => {
      // Construct JSON where "command": and the value are on separate lines.
      // grep works line-by-line, so it cannot match "command"..."value" across lines.
      // This forces CMD to be empty, triggering the Python fallback which handles
      // the full JSON correctly.
      const rawJson = '{"tool_input":{"command":\n"rm -rf /tmp/important"}}';
      const { exitCode, output } = runHookRaw(CAREFUL_SCRIPT, rawJson);
      expect(exitCode).toBe(0);
      expect(decisionOf(output)).toBe('ask');
      expect(reasonOf(output)).toContain('recursive delete');
    });
  });
});

// ============================================================
// check-freeze.sh tests
// ============================================================
describe('check-freeze.sh', () => {

  describe('edits inside freeze boundary', () => {
    test('edit inside freeze boundary allows', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/Users/dev/project/src/index.ts'),
          { CLAUDE_PLUGIN_DATA: stateDir, CLAUDE_PLUGIN_ROOT: '/plugins/gstack' },
        );
        expect(exitCode).toBe(0);
        expect(decisionOf(output)).toBeUndefined();
      });
    });

    test('edit in subdirectory of freeze path allows', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/Users/dev/project/src/components/Button.tsx'),
          { CLAUDE_PLUGIN_DATA: stateDir, CLAUDE_PLUGIN_ROOT: '/plugins/gstack' },
        );
        expect(exitCode).toBe(0);
        expect(decisionOf(output)).toBeUndefined();
      });
    });
  });

  describe('edits outside freeze boundary', () => {
    test('edit outside freeze boundary denies', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/Users/dev/other-project/index.ts'),
          { CLAUDE_PLUGIN_DATA: stateDir, CLAUDE_PLUGIN_ROOT: '/plugins/gstack' },
        );
        expect(exitCode).toBe(0);
        expect(decisionOf(output)).toBe('deny');
        expect(reasonOf(output)).toContain('freeze');
        expect(reasonOf(output)).toContain('outside');
      });
    });

    test('write outside freeze boundary denies', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/etc/hosts'),
          { CLAUDE_PLUGIN_DATA: stateDir, CLAUDE_PLUGIN_ROOT: '/plugins/gstack' },
        );
        expect(exitCode).toBe(0);
        expect(decisionOf(output)).toBe('deny');
        expect(reasonOf(output)).toContain('freeze');
        expect(reasonOf(output)).toContain('outside');
      });
    });
  });

  describe('trailing slash prevents prefix confusion', () => {
    test('freeze at /src/ denies /src-old/ (trailing slash prevents prefix match)', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/Users/dev/project/src-old/index.ts'),
          { CLAUDE_PLUGIN_DATA: stateDir, CLAUDE_PLUGIN_ROOT: '/plugins/gstack' },
        );
        expect(exitCode).toBe(0);
        expect(decisionOf(output)).toBe('deny');
        expect(reasonOf(output)).toContain('outside');
      });
    });
  });

  describe('no freeze file exists', () => {
    test('allows everything when no freeze file present', () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-freeze-test-'));
      try {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/anywhere/at/all.ts'),
          { CLAUDE_PLUGIN_DATA: stateDir, CLAUDE_PLUGIN_ROOT: '/plugins/gstack' },
        );
        expect(exitCode).toBe(0);
        expect(decisionOf(output)).toBeUndefined();
      } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    });
  });

  describe('edge cases', () => {
    test('missing file_path field allows gracefully', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          { tool_input: {} },
          { CLAUDE_PLUGIN_DATA: stateDir, CLAUDE_PLUGIN_ROOT: '/plugins/gstack' },
        );
        expect(exitCode).toBe(0);
        expect(decisionOf(output)).toBeUndefined();
      });
    });
  });
});

describe('harness output contract', () => {
  // Regression guard for the failure these scripts shipped with: both emitted a
  // bare top-level {"permissionDecision":...}. That is valid JSON and is parsed,
  // but Claude Code dispatches on hookSpecificOutput.permissionDecision, so the
  // decision was silently discarded and the tool call proceeded. Every assertion
  // in this file passed throughout, because running a script directly never
  // exercises the harness's dispatch rule.
  test('careful nests the decision and omits the legacy top-level field', () => {
    const { output, raw } = runHook(CAREFUL_SCRIPT, {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /var/data' },
    });
    expect(output.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
    expect(output.permissionDecision).toBeUndefined();
    expect(raw.trimStart().startsWith('{"hookSpecificOutput"')).toBe(true);
  });

  test('freeze nests the decision and omits the legacy top-level field', () => {
    withFreezeDir('/tmp/frozen', (stateDir) => {
      const { output, raw } = runHook(
        FREEZE_SCRIPT,
        { tool_name: 'Edit', tool_input: { file_path: '/tmp/elsewhere/evil.ts' } },
        { CLAUDE_PLUGIN_DATA: stateDir, CLAUDE_PLUGIN_ROOT: '/plugins/gstack' },
      );
      expect(output.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
      expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(output.permissionDecision).toBeUndefined();
      expect(raw.trimStart().startsWith('{"hookSpecificOutput"')).toBe(true);
    });
  });

  test('allow path stays an empty object (no opinion)', () => {
    const { raw } = runHook(CAREFUL_SCRIPT, {
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
    });
    expect(raw.trim()).toBe('{}');
  });
});
