import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const HOOK_DIR = path.join(ROOT, 'hosts', 'claude', 'hooks');
const HELPER = path.join(HOOK_DIR, 'spawn-bin.ts');

/** Every hook entrypoint, excluding the helper itself. */
function hookFiles(): string[] {
  return fs
    .readdirSync(HOOK_DIR)
    .filter((f) => f.endsWith('.ts') && f !== 'spawn-bin.ts')
    .map((f) => path.join(HOOK_DIR, f));
}

describe('claude hooks: Windows path + bin-spawn invariants', () => {
  test('spawn-bin helper exists and exports the resolution surface', () => {
    expect(fs.existsSync(HELPER)).toBe(true);
    const src = fs.readFileSync(HELPER, 'utf-8');
    expect(src).toContain('export function repoRoot');
    expect(src).toContain('export function binPath');
    expect(src).toContain('export function runBin');
    expect(src).toContain('fileURLToPath');
  });

  // `new URL(import.meta.url).pathname` yields `/C:/Users/...` on Windows;
  // path.resolve then rebases it onto the drive root as `C:\C:\Users\...`,
  // so every subsequent spawn/read hits ENOENT. fileURLToPath is the fix.
  test('no hook uses URL.pathname to locate itself on disk', () => {
    const offending: string[] = [];
    for (const file of [...hookFiles(), HELPER]) {
      const src = fs.readFileSync(file, 'utf-8');
      src.split('\n').forEach((line, idx) => {
        if (line.trim().startsWith('*') || line.trim().startsWith('//')) return;
        if (/new URL\(import\.meta\.url\)\.pathname/.test(line)) {
          offending.push(`${path.basename(file)}:${idx + 1}`);
        }
      });
    }
    expect(offending).toEqual([]);
  });

  // bin/gstack-* are extensionless bash scripts. Windows has no shebang
  // support, so they must be handed to bash — which runBin() does.
  test('no hook spawns a bin directly; all route through runBin', () => {
    const offending: string[] = [];
    for (const file of hookFiles()) {
      const src = fs.readFileSync(file, 'utf-8');
      src.split('\n').forEach((line, idx) => {
        if (line.trim().startsWith('*') || line.trim().startsWith('//')) return;
        if (/\bspawnSync\s*\(/.test(line)) {
          offending.push(`${path.basename(file)}:${idx + 1}`);
        }
      });
    }
    expect(offending).toEqual([]);
  });

  test('repoRoot resolves to the install root; binPath finds a real bin', async () => {
    const { repoRoot, binPath } = await import(HELPER);
    expect(fs.existsSync(path.join(repoRoot(), 'bin'))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot(), 'scripts', 'question-registry.ts'))).toBe(true);
    expect(fs.existsSync(binPath('gstack-question-log'))).toBe(true);
  });
});

// Behavioral proof: drive question-log-hook exactly the way Claude Code does
// (hook JSON on stdin) against an isolated GSTACK_STATE_ROOT, and assert the
// event actually lands. Pre-fix this wrote nothing on Windows and appended to
// hook-errors.log instead, silently, on every question.
describe('question-log-hook: end-to-end capture', () => {
  test('an AskUserQuestion fire is written to question-log.jsonl', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-hook-'));
    try {
      const payload = {
        session_id: 'test-session',
        hook_event_name: 'PostToolUse',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'toolu_hook_e2e',
        cwd: tmp,
        tool_input: {
          questions: [
            {
              question: 'Ship it?',
              options: [{ label: 'Ship now (recommended)' }, { label: 'Hold' }],
            },
          ],
        },
        tool_response: { answers: [{ option_label: 'Ship now' }] },
      };

      const res = spawnSync('bun', [path.join(HOOK_DIR, 'question-log-hook.ts')], {
        input: JSON.stringify(payload),
        encoding: 'utf-8',
        timeout: 20000,
        cwd: tmp,
        env: {
          ...process.env,
          GSTACK_STATE_ROOT: tmp,
          GSTACK_QUESTION_LOG_NO_DERIVE: '1',
        },
      });
      expect(res.status).toBe(0);

      // Slug depends on cwd, so find the log rather than guessing the project dir.
      const projects = path.join(tmp, 'projects');
      expect(fs.existsSync(projects)).toBe(true);
      const logs = fs
        .readdirSync(projects)
        .map((slug) => path.join(projects, slug, 'question-log.jsonl'))
        .filter((p) => fs.existsSync(p));
      expect(logs.length).toBe(1);

      const event = JSON.parse(fs.readFileSync(logs[0], 'utf-8').trim().split('\n')[0]);
      expect(event.source).toBe('hook');
      expect(event.user_choice).toBe('Ship now');
      expect(event.recommended).toBe('Ship now');
      expect(event.followed_recommendation).toBe(true);
      expect(event.tool_use_id).toBe('toolu_hook_e2e');

      // The failure mode this guards against was silent: the hook exited 0
      // while only ever appending to the error log.
      const errLog = path.join(tmp, 'hook-errors.log');
      expect(fs.existsSync(errLog) ? fs.readFileSync(errLog, 'utf-8') : '').toBe('');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
