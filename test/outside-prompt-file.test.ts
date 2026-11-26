/**
 * Private prompt files for second-model reviews stay inside the project and clean up without a careful ask.
 *
 * #4841: /codex challenge and consult deleted their prompt with rm -f "$PROMPT_FILE". The assignment above it
 * holds a $, so careful/bin/check-careful.sh cannot resolve it and asks about a delete "through a variable that
 * may be empty" on every run. The cleanup now reads "${PROMPT_FILE:?}", which careful treats as guarded.
 *
 * #4842: /plan-ceo-review and /plan-eng-review created the prompt with mktemp under $TMPDIR, outside the project.
 * Claude Code's plan mode refuses a Write there, so Codex never started. The prompt now goes in the session folder's
 * .gstack/tmp/ (refusing a symlinked .gstack or .gstack/tmp), and its cleanup removes that one path without an ask.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { usePrivateStateRoot } from './helpers/private-state-root';

const ROOT = path.resolve(import.meta.dir, '..');
const CHECK = path.join(ROOT, 'careful', 'bin', 'check-careful.sh');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-prompt-file-')));
usePrivateStateRoot();
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

function bashFences(file: string): string[] {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return [...text.matchAll(/^```bash\n([\s\S]*?)\n```$/gm)].map(m => m[1]);
}

function careful(command: string, cwd: string): string {
  const r = spawnSync('bash', [CHECK], {
    cwd, encoding: 'utf8', timeout: 30_000,
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    env: { ...process.env, GSTACK_HOOK_CWD: cwd },
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

describe.skipIf(process.platform === 'win32')('/codex prompt cleanup passes careful (#4841)', () => {
  for (const file of ['codex/sections/challenge-mode.md', 'codex/sections/consult-mode.md']) {
    test(file, () => {
      const block = bashFences(file).find(b => /^PROMPT_FILE=/m.test(b) && /^rm -f .*PROMPT_FILE/m.test(b));
      expect(block).toBeDefined();
      const lines = block!.split('\n');
      const cleanup = lines.find(l => /^rm -f .*PROMPT_FILE/.test(l))!;
      const names = new Set([...cleanup.matchAll(/\$\{?([A-Z_]+)/g)].map(m => m[1]));
      const assignments = lines.filter(l => names.has(l.split('=')[0]));
      expect(assignments.some(l => l.startsWith('PROMPT_FILE='))).toBe(true);
      expect(careful([...assignments, cleanup].join('\n'), scratch)).toBe('{}');
      expect(cleanup).toContain('"${PROMPT_FILE:?}"');
      expect(careful(block!, scratch)).toBe('{}');
    });
  }
});

describe.skipIf(process.platform === 'win32')('plan-review prompt file lives in the project (#4842)', () => {
  for (const skill of ['plan-ceo-review', 'plan-eng-review']) {
    test(skill, () => {
      const text = fs.readFileSync(path.join(ROOT, skill, 'sections', 'review-sections.md'), 'utf8');
      const spans = [...text.matchAll(/`([^`\n]+)`/g)].map(m => m[1]);
      const create = spans.filter(s => s.includes('gstack-plan-prompt'));
      expect(create).toHaveLength(1);
      expect(create[0]).not.toContain('TMPDIR');
      const cleanup = spans.filter(s => s.startsWith('rm ') && s.includes('<prepared-prompt-file>'));
      expect(cleanup).toEqual(["rm -- '<prepared-prompt-file>'"]);

      const project = path.join(scratch, skill);
      fs.mkdirSync(project);
      git(project, 'init', '-q');
      const made = spawnSync('bash', ['-c', create[0]], { cwd: project, encoding: 'utf8', timeout: 30_000 });
      expect(made.status, made.stderr).toBe(0);
      const prompt = made.stdout.trim();
      expect(path.dirname(prompt)).toBe(path.join(project, '.gstack', 'tmp'));
      expect(path.basename(prompt).startsWith('gstack-plan-prompt.')).toBe(true);
      expect(fs.statSync(prompt).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(prompt)).mode & 0o777).toBe(0o700);
      fs.writeFileSync(prompt, 'review this plan');

      const remove = cleanup[0].replace('<prepared-prompt-file>', prompt);
      expect(careful(remove, project)).toBe('{}');
      const removed = spawnSync('bash', ['-c', remove], { cwd: project, encoding: 'utf8', timeout: 30_000 });
      expect(removed.status, removed.stderr).toBe(0);
      expect(fs.existsSync(prompt)).toBe(false);

      // A cloned repo can commit .gstack or .gstack/tmp as a symlink; the prompt must never land where it points.
      for (const link of ['.gstack', '.gstack/tmp']) {
        const linked = path.join(scratch, skill + '-link-' + link.replace(/\W/g, ''));
        const outside = path.join(linked, 'outside');
        fs.mkdirSync(outside, { recursive: true });
        fs.mkdirSync(path.join(linked, 'repo', path.dirname(link)), { recursive: true });
        fs.symlinkSync(outside, path.join(linked, 'repo', link));
        const refused = spawnSync('bash', ['-c', create[0]], { cwd: path.join(linked, 'repo'), encoding: 'utf8', timeout: 30_000 });
        expect(refused.status, link).not.toBe(0);
        expect(refused.stdout.trim(), link).toBe('');
        expect(fs.readdirSync(outside), link).toEqual([]);
      }
    });
  }
});
