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

function carefulInput(command: string) {
  return { tool_input: { command } };
}

function freezeInput(filePath: string) {
  return { tool_input: { file_path: filePath } };
}

/** Extract permissionDecision from the hookSpecificOutput envelope (or legacy flat format). */
function getPermissionDecision(output: any): string | undefined {
  if (output?.hookSpecificOutput?.permissionDecision !== undefined) {
    return output.hookSpecificOutput.permissionDecision;
  }
  return output?.permissionDecision;
}

/** Extract the deny/ask reason from the hookSpecificOutput envelope (or legacy flat format). */
function getReason(output: any): string | undefined {
  if (output?.hookSpecificOutput?.permissionDecisionReason !== undefined) {
    return output.hookSpecificOutput.permissionDecisionReason;
  }
  return output?.message;
}

function withFreezeDir(freezePath: string, fn: (stateDir: string) => void) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-freeze-test-'));
  fs.writeFileSync(path.join(stateDir, 'freeze-dir.txt'), freezePath);
  try {
    fn(stateDir);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

function withCarefulActive(fn: (stateDir: string) => void) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-careful-test-'));
  fs.writeFileSync(path.join(stateDir, 'careful-active.txt'), '');
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

  describe('no-op without careful-active.txt', () => {
    test('allows everything when careful is not active (no state file)', () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-careful-test-'));
      try {
        const { exitCode, output } = runHook(
          CAREFUL_SCRIPT,
          carefulInput('rm -rf /var/important'),
          { CLAUDE_PLUGIN_DATA: stateDir },
        );
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBeUndefined();
      } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    });
  });

  // --- Destructive rm commands ---

  describe('rm -rf / rm -r', () => {
    test('rm -rf /var/data warns with recursive delete message', () => {
      withCarefulActive((stateDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf /var/data'), { CLAUDE_PLUGIN_DATA: stateDir });
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBe('ask');
        expect(getReason(output)).toContain('recursive delete');
      });
    });

    test('rm -r ./some-dir warns', () => {
      withCarefulActive((stateDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -r ./some-dir'), { CLAUDE_PLUGIN_DATA: stateDir });
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBe('ask');
        expect(getReason(output)).toContain('recursive delete');
      });
    });

    test('rm -rf node_modules allows (safe exception)', () => {
      withCarefulActive((stateDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf node_modules'), { CLAUDE_PLUGIN_DATA: stateDir });
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBeUndefined();
      });
    });

    test('rm -rf .next dist allows (multiple safe targets)', () => {
      withCarefulActive((stateDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf .next dist'), { CLAUDE_PLUGIN_DATA: stateDir });
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBeUndefined();
      });
    });

    test('rm -rf node_modules /var/data warns (mixed safe+unsafe)', () => {
      withCarefulActive((stateDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('rm -rf node_modules /var/data'), { CLAUDE_PLUGIN_DATA: stateDir });
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBe('ask');
        expect(getReason(output)).toContain('recursive delete');
      });
    });
  });

  // --- SQL destructive commands ---
  // Note: SQL commands that contain embedded double quotes (e.g., psql -c "DROP TABLE")
  // get their command value truncated by the grep-based JSON extractor because \"
  // terminates the [^"]* match. We use commands WITHOUT embedded quotes so the grep
  // extraction works and the SQL keywords are visible to the pattern matcher.

  describe('SQL destructive commands', () => {
    test('psql DROP TABLE warns with DROP in message', () => {
      withCarefulActive((stateDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('psql -c DROP TABLE users;'), { CLAUDE_PLUGIN_DATA: stateDir });
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBe('ask');
        expect(getReason(output)).toContain('DROP');
      });
    });

    test('mysql drop database warns (case insensitive)', () => {
      withCarefulActive((stateDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('mysql -e drop database mydb'), { CLAUDE_PLUGIN_DATA: stateDir });
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBe('ask');
        expect(getReason(output)!.toLowerCase()).toContain('drop');
      });
    });

    test('psql TRUNCATE warns', () => {
      withCarefulActive((stateDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('psql -c TRUNCATE orders;'), { CLAUDE_PLUGIN_DATA: stateDir });
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBe('ask');
        expect(getReason(output)).toContain('TRUNCATE');
      });
    });
  });

  // --- Git destructive commands ---

  describe('git destructive commands', () => {
    test('git push --force warns with force-push', () => {
      withCarefulActive((stateDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git push --force origin main'), { CLAUDE_PLUGIN_DATA: stateDir });
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBe('ask');
        expect(getReason(output)).toContain('force-push');
      });
    });

    test('git push -f warns', () => {
      withCarefulActive((stateDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git push -f origin main'), { CLAUDE_PLUGIN_DATA: stateDir });
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBe('ask');
        expect(getReason(output)).toContain('force-push');
      });
    });

    test('git reset --hard warns with uncommitted', () => {
      withCarefulActive((stateDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git reset --hard HEAD~3'), { CLAUDE_PLUGIN_DATA: stateDir });
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBe('ask');
        expect(getReason(output)).toContain('uncommitted');
      });
    });

    test('git checkout . warns', () => {
      withCarefulActive((stateDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git checkout .'), { CLAUDE_PLUGIN_DATA: stateDir });
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBe('ask');
        expect(getReason(output)).toContain('uncommitted');
      });
    });

    test('git restore . warns', () => {
      withCarefulActive((stateDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('git restore .'), { CLAUDE_PLUGIN_DATA: stateDir });
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBe('ask');
        expect(getReason(output)).toContain('uncommitted');
      });
    });
  });

  // --- Container / infra destructive commands ---

  describe('container and infra commands', () => {
    test('kubectl delete warns with kubectl in message', () => {
      withCarefulActive((stateDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('kubectl delete pod my-pod'), { CLAUDE_PLUGIN_DATA: stateDir });
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBe('ask');
        expect(getReason(output)).toContain('kubectl');
      });
    });

    test('docker rm -f warns', () => {
      withCarefulActive((stateDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('docker rm -f container123'), { CLAUDE_PLUGIN_DATA: stateDir });
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBe('ask');
        expect(getReason(output)).toContain('Docker');
      });
    });

    test('docker system prune -a warns', () => {
      withCarefulActive((stateDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput('docker system prune -a'), { CLAUDE_PLUGIN_DATA: stateDir });
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBe('ask');
        expect(getReason(output)).toContain('Docker');
      });
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
        withCarefulActive((stateDir) => {
          const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(cmd), { CLAUDE_PLUGIN_DATA: stateDir });
          expect(exitCode).toBe(0);
          expect(getPermissionDecision(output)).toBeUndefined();
        });
      });
    }
  });

  // --- Edge cases ---

  describe('edge cases', () => {
    test('empty command allows gracefully', () => {
      withCarefulActive((stateDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, carefulInput(''), { CLAUDE_PLUGIN_DATA: stateDir });
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBeUndefined();
      });
    });

    test('missing command field allows gracefully', () => {
      withCarefulActive((stateDir) => {
        const { exitCode, output } = runHook(CAREFUL_SCRIPT, { tool_input: {} }, { CLAUDE_PLUGIN_DATA: stateDir });
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBeUndefined();
      });
    });

    test('malformed JSON input allows gracefully (exit 0, output {})', () => {
      withCarefulActive((stateDir) => {
        const { exitCode, raw } = runHookRaw(CAREFUL_SCRIPT, 'this is not json at all{{{{', { CLAUDE_PLUGIN_DATA: stateDir });
        expect(exitCode).toBe(0);
        expect(raw).toBe('{}');
      });
    });

    test('Python fallback: grep fails on multiline JSON, Python parses it', () => {
      // Construct JSON where "command": and the value are on separate lines.
      // grep works line-by-line, so it cannot match "command"..."value" across lines.
      // This forces CMD to be empty, triggering the Python fallback which handles
      // the full JSON correctly.
      withCarefulActive((stateDir) => {
        const rawJson = '{"tool_input":{"command":\n"rm -rf /tmp/important"}}';
        const { exitCode, output } = runHookRaw(CAREFUL_SCRIPT, rawJson, { CLAUDE_PLUGIN_DATA: stateDir });
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBe('ask');
        expect(getReason(output)).toContain('recursive delete');
      });
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
          { CLAUDE_PLUGIN_DATA: stateDir },
        );
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBeUndefined();
      });
    });

    test('edit in subdirectory of freeze path allows', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/Users/dev/project/src/components/Button.tsx'),
          { CLAUDE_PLUGIN_DATA: stateDir },
        );
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBeUndefined();
      });
    });
  });

  describe('edits outside freeze boundary', () => {
    test('edit outside freeze boundary denies', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/Users/dev/other-project/index.ts'),
          { CLAUDE_PLUGIN_DATA: stateDir },
        );
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBe('deny');
        expect(getReason(output)).toContain('freeze');
        expect(getReason(output)).toContain('outside');
      });
    });

    test('write outside freeze boundary denies', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/etc/hosts'),
          { CLAUDE_PLUGIN_DATA: stateDir },
        );
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBe('deny');
        expect(getReason(output)).toContain('freeze');
        expect(getReason(output)).toContain('outside');
      });
    });
  });

  describe('trailing slash prevents prefix confusion', () => {
    test('freeze at /src/ denies /src-old/ (trailing slash prevents prefix match)', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { exitCode, output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/Users/dev/project/src-old/index.ts'),
          { CLAUDE_PLUGIN_DATA: stateDir },
        );
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBe('deny');
        expect(getReason(output)).toContain('outside');
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
          { CLAUDE_PLUGIN_DATA: stateDir },
        );
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBeUndefined();
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
          { CLAUDE_PLUGIN_DATA: stateDir },
        );
        expect(exitCode).toBe(0);
        expect(getPermissionDecision(output)).toBeUndefined();
      });
    });
  });

  describe('hookSpecificOutput format', () => {
    test('deny response uses hookSpecificOutput envelope', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/Users/dev/other/index.ts'),
          { CLAUDE_PLUGIN_DATA: stateDir },
        );
        expect(output.hookSpecificOutput).toBeDefined();
        expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
        expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
        expect(output.hookSpecificOutput.permissionDecisionReason).toBeDefined();
        expect(output.permissionDecision).toBeUndefined();
      });
    });

    test('allow response is plain {} (no hookSpecificOutput)', () => {
      withFreezeDir('/Users/dev/project/src/', (stateDir) => {
        const { output } = runHook(
          FREEZE_SCRIPT,
          freezeInput('/Users/dev/project/src/file.ts'),
          { CLAUDE_PLUGIN_DATA: stateDir },
        );
        expect(output.hookSpecificOutput).toBeUndefined();
      });
    });
  });
});
