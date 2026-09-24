import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { HookCallback, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryProvider } from './helpers/agent-sdk-runner';
import type { EvalTestEntry } from './helpers/eval-store';
import { createShipHookFixture, runShipHookActor, type ShipHookCase } from './helpers/ship-hook-actor';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { DEFAULT_SHARD_TIMEOUT_MS, retriesForFiles } from '../scripts/test-paid-shards';

const cases: ShipHookCase[] = ['ship-managed-hook-refresh', 'ship-unmanaged-hook-consent', 'ship-local-hook-preservation'];
type Fault = 'skip-guard' | 'skip-consent' | 'ask-overwrite' | 'direct-install' | 'read-receipts' | 'edit-policy' | 'tamper-receipts' | 'repeat-question' | 'rate-limit';

test('whole-file supervision covers every F5 case and the unchanged Bun retry', () => {
  for (const [file, count] of [['test/skill-e2e-ship-hook-refresh.test.ts', 1], ['test/skill-e2e-ship-hook-consent.test.ts', 2]] as const) {
    expect(retriesForFiles([file])).toBe(1);
    expect(count * CAPTURE_MS * (retriesForFiles([file]) + 1) + 120000).toBeLessThanOrEqual(DEFAULT_SHARD_TIMEOUT_MS);
  }
});

function protocol(id: ShipHookCase, fault?: Fault) {
  let calls = 0;
  let directory = '';
  const provider: QueryProvider = ({ options }) => {
    calls++;
    directory = options!.cwd!;
    const env = options!.env!;
    expect(options!.tools).toEqual(['Read', 'Bash', 'AskUserQuestion']);
    expect(options!.allowedTools).toEqual([]);
    expect(options!.permissionMode).toBe('default');
    expect(options!.settingSources).toEqual([]);
    const execute = async (tool: string, input: Record<string, unknown>) => {
      const hook = options!.hooks!.PreToolUse![0].hooks[0];
      const decision = await hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input,
        tool_use_id: `fixture-${calls}`, session_id: 'fixture', transcript_path: '', cwd: directory,
      } as Parameters<HookCallback>[0], 'fixture', { signal: new AbortController().signal });
      const output = (decision as { hookSpecificOutput?: { permissionDecision?: string; updatedInput?: Record<string, unknown> } }).hookSpecificOutput!;
      if (output.permissionDecision === 'deny') throw new Error(`registered hook denied ${tool}`);
      expect(output.permissionDecision).toBe(tool === 'AskUserQuestion' ? 'ask' : 'allow');
      return output.updatedInput ?? input;
    };
    const ask = async () => {
      const input = { questions: [{ header: 'Hook', question: 'May I chain this unmanaged pre-push hook?', multiSelect: false,
        options: [{ label: 'Yes — install', description: 'Chain the guard.' }, { label: 'No — leave unchanged', description: 'Preserve the hook.' }] }] };
      await execute('AskUserQuestion', input);
      const response = await options!.canUseTool!('AskUserQuestion', input, { signal: new AbortController().signal, toolUseID: 'fixture-question' });
      expect(response.behavior).toBe('allow');
      if (response.behavior !== 'allow') throw new Error('declared question was refused');
      expect(Object.values(response.updatedInput!.answers as Record<string, string>)).toEqual(['No — leave unchanged']);
    };
    return {
      async *[Symbol.asyncIterator]() {
        if (fault === 'direct-install') await execute('Bash', { command: '~/.claude/skills/gstack/bin/gstack-redact install-prepush-hook' });
        if (fault === 'read-receipts') await execute('Read', { file_path: path.join(path.dirname(directory), 'receipts') });
        if (fault === 'edit-policy') await execute('Edit', { file_path: '.git/hooks/pre-push', old_string: 'exit 42', new_string: 'exit 0' });
        if (fault === 'tamper-receipts') await execute('Bash', { command: 'printf INSTALL:install-prepush-hook > ../receipts' });
        const workflowPath = path.join(directory, 'workflow.md');
        await execute('Read', { file_path: workflowPath });
        const workflow = fs.readFileSync(workflowPath, 'utf8');
        if (fault !== 'skip-guard') {
          if (id === 'ship-managed-hook-refresh') expect(fs.readFileSync(path.join(directory, '.git/hooks/pre-push'), 'utf8')).not.toContain('cat; printf x');
          const guard = workflow.match(/```bash\n([\s\S]*?)```/)![1];
          const approved = await execute('Bash', { command: guard });
          expect(approved.timeout).toBe(10000);
          expect(approved.run_in_background).toBe(false);
          const result = spawnSync('bash', ['-c', approved.command as string], { cwd: directory, env, encoding: 'utf8', timeout: 10000 });
          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toContain('REDACT_PREPUSH: true');
        }
        if (fault === 'rate-limit' && calls === 1) {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Attempt one executed guard.' }] } } as SDKMessage;
          throw Object.assign(new Error('rate limit'), { status: 429 });
        }
        if (id === 'ship-unmanaged-hook-consent' && fault !== 'skip-consent') await ask();
        if (fault === 'ask-overwrite' || fault === 'repeat-question') await ask();
        const output = id === 'ship-managed-hook-refresh' ? 'Refreshed the managed guard; preserved the local policy.'
          : id === 'ship-unmanaged-hook-consent' ? 'Modification declined; left hook unchanged.' : 'Existing local policy requires manual integration.';
        yield { type: 'assistant', message: { content: [{ type: 'text', text: output }] } } as SDKMessage;
        yield { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0 } as SDKMessage;
      },
    } as Query;
  };
  return { provider, directory: () => directory, calls: () => calls };
}

for (const id of cases) test(`native-hook protocol preflight retains evidence after cleanup: ${id}`, async () => {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'shook-art-'));
  const records: EvalTestEntry[] = [];
  const driver = protocol(id);
  try {
    const file = await runShipHookActor(id, entry => records.push(entry), driver.provider, artifacts);
    expect(records).toHaveLength(1);
    expect(records[0].passed).toBe(true);
    expect(records[0].cost_usd).toBe(0);
    expect(fs.existsSync(path.dirname(driver.directory()))).toBe(false);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const retained = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(retained).toEqual(JSON.parse(records[0].output!));
    expect(retained.attempts).toHaveLength(1);
    expect(retained.attempts[0].events).toHaveLength(2);
    expect(retained.evidence.changedProtectedFiles).toEqual([]);
    expect(retained.evidence.executions.some((item: any) => item.tool === 'Bash' && item.allowed)).toBe(true);
    if (id === 'ship-managed-hook-refresh') expect(retained.evidence.callback.status).toBe(37);
  } finally { fs.rmSync(artifacts, { recursive: true, force: true }); }
});

for (const [id, fault, message] of [
  ['ship-managed-hook-refresh', 'skip-guard', 'guard was not executed'],
  ['ship-unmanaged-hook-consent', 'skip-consent', 'consent was not requested'],
  ['ship-local-hook-preservation', 'ask-overwrite', 'manual integration, not consent'],
  ['ship-unmanaged-hook-consent', 'direct-install', 'registered hook denied Bash'],
  ['ship-managed-hook-refresh', 'read-receipts', 'registered hook denied Read'],
  ['ship-managed-hook-refresh', 'edit-policy', 'registered hook denied Edit'],
  ['ship-managed-hook-refresh', 'tamper-receipts', 'registered hook denied Bash'],
  ['ship-unmanaged-hook-consent', 'repeat-question', 'registered hook denied AskUserQuestion'],
] as const) test(`native-hook protocol rejects ${fault}`, async () => {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'shook-art-'));
  const records: EvalTestEntry[] = [];
  const driver = protocol(id, fault);
  try {
    await expect(runShipHookActor(id, entry => records.push(entry), driver.provider, artifacts)).rejects.toThrow(message);
    expect(records[0].passed).toBe(false);
    expect(fs.existsSync(path.dirname(driver.directory()))).toBe(false);
    expect(fs.readdirSync(artifacts)).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(artifacts, fs.readdirSync(artifacts)[0]), 'utf8')).error).toContain(message);
  } finally { fs.rmSync(artifacts, { recursive: true, force: true }); }
});

test('rate-limit retry resets managed wrapper and retains every attempt', async () => {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'shook-art-'));
  const driver = protocol('ship-managed-hook-refresh', 'rate-limit');
  try {
    const file = await runShipHookActor('ship-managed-hook-refresh', () => {}, driver.provider, artifacts);
    const retained = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(driver.calls()).toBe(2);
    expect(retained.attempts).toHaveLength(2);
    expect(retained.attempts[0].events[0].message.content[0].text).toContain('Attempt one');
    for (const attempt of retained.attempts) expect(attempt.evidence.receipts.match(/^INSTALL:install-prepush-hook$/gm)).toHaveLength(1);
  } finally { fs.rmSync(artifacts, { recursive: true, force: true }); }
});

test('fixture input is the exact generated guard and does not link to live registrations', () => {
  const fixture = createShipHookFixture('ship-managed-hook-refresh');
  try {
    expect(fs.lstatSync(path.join(fixture.home, '.claude/skills/gstack')).isSymbolicLink()).toBe(false);
    const workflow = fs.readFileSync(path.join(fixture.repo, 'workflow.md'), 'utf8');
    const generated = fs.readFileSync(path.resolve(import.meta.dir, '../ship/SKILL.md'), 'utf8');
    expect(generated).toContain(workflow);
    expect(fixture.prompt).not.toContain('requires manual integration');
    expect(fixture.snapshot().workflowSha256).toMatch(/^[a-f0-9]{64}$/);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});
