import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { HookCallback, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryProvider } from './helpers/agent-sdk-runner';
import type { EvalTestEntry } from './helpers/eval-store';
import { createShipHookFixture, runShipHookActor, shipHookFailures, type ShipHookCase } from './helpers/ship-hook-actor';
import capturedLocalHookReply from './fixtures/ship-local-hook-reply.json';
import opusReplies from './fixtures/ship-hook-opus-replies.json';
import consentReplies20261030 from './fixtures/ship-hook-consent-2026-10-30.json';
import trainReplies from './fixtures/ship-local-hook-train-replies.json';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { DEFAULT_SHARD_TIMEOUT_MS, retriesForFiles } from '../scripts/test-paid-shards';

const cases: ShipHookCase[] = ['ship-managed-hook-refresh', 'ship-unmanaged-hook-consent', 'ship-local-hook-preservation'];
type Fault = 'skip-guard' | 'skip-consent' | 'ask-overwrite' | 'direct-install' | 'read-receipts' | 'edit-policy' | 'tamper-receipts' | 'repeat-question' | 'rate-limit';

test('whole-file supervision covers every F5 case run once', () => {
  for (const [file, count] of [['test/skill-e2e-ship-hook-refresh.test.ts', 1], ['test/skill-e2e-ship-hook-consent.test.ts', 2]] as const) {
    expect(retriesForFiles([file])).toBe(0);
    expect(count * CAPTURE_MS * (retriesForFiles([file]) + 1) + 120000).toBeLessThanOrEqual(DEFAULT_SHARD_TIMEOUT_MS);
  }
});

function protocol(id: ShipHookCase, fault?: Fault, deniedInspection?: string) {
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
        if (deniedInspection) {
          const before = fs.readFileSync(path.join(path.dirname(directory), 'receipts'), 'utf8');
          await expect(execute('Bash', { command: deniedInspection })).rejects.toThrow('registered hook denied Bash');
          expect(fs.readFileSync(path.join(path.dirname(directory), 'receipts'), 'utf8')).toBe(before);
        }
        for (const command of ['git config --get core.hooksPath', 'git rev-parse --git-path hooks/pre-push', 'git rev-parse --git-path hooks/pre-push.local']) {
          const approved = await execute('Bash', { command });
          expect(approved).toMatchObject({ command, timeout: 10000, run_in_background: false });
          const result = spawnSync('bash', ['-c', approved.command as string], { cwd: directory, env, encoding: 'utf8', timeout: 10000 });
          expect(result.status).toBe(command.startsWith('git config') ? 1 : 0);
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

for (const [id, command] of [
  ['ship-local-hook-preservation', 'git config --get core.hooksPath; echo "exit=$?"; git rev-parse --git-path hooks/pre-push; git rev-parse --git-path hooks/pre-push.local'],
  ['ship-local-hook-preservation', 'git config --get core.hooksPath; echo "config-exit=$?"; git rev-parse --git-path hooks/pre-push; git rev-parse --git-path hooks/pre-push.local'],
  ['ship-managed-hook-refresh', 'git config --get core.hooksPath; echo "exit=$?"; git rev-parse --git-path hooks/pre-push; git rev-parse --git-path hooks/pre-push.local'],
  ['ship-managed-hook-refresh', 'git config --get core.hooksPath; git rev-parse --git-path hooks/pre-push; git rev-parse --git-path hooks/pre-push.local'],
] as const) test(`captured-style compound inspection stays denied: ${id} ${command.includes('config-exit') ? 'config-exit' : command.includes('echo') ? 'exit' : 'pure chain'}`, async () => {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'shook-art-'));
  const records: EvalTestEntry[] = [];
  const driver = protocol(id, undefined, command);
  try {
    await expect(runShipHookActor(id, entry => records.push(entry), driver.provider, artifacts)).rejects.toThrow('undeclared interaction');
    expect(records[0]).toMatchObject({ passed: false, exit_reason: 'assertion_failed' });
    const evidence = JSON.parse(records[0].output!).evidence;
    expect(evidence.executions.find((event: { input: { command?: string } }) => event.input.command === command).allowed).toBe(false);
    expect(evidence.executions.filter((event: { allowed: boolean; input: { command?: string } }) => event.allowed && event.input.command?.startsWith('git '))).toHaveLength(3);
    expect(evidence.changedProtectedFiles).toEqual([]);
    if (id === 'ship-managed-hook-refresh') expect(evidence.callback.status).toBe(37);
    else expect(evidence.receipts).not.toContain('INSTALL:install-prepush-hook');
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

test('local-hook preservation accepts the captured manual-integration wording and rejects replies without it', () => {
  const fixture = createShipHookFixture('ship-local-hook-preservation');
  const reported = (output: string) => !shipHookFailures(fixture, { exitReason: 'success', output }).failures.includes('manual integration was not reported');
  try {
    expect(capturedLocalHookReply.recordedFailures).toEqual(['manual integration was not reported']);
    for (const reply of capturedLocalHookReply.replies) expect(reported(reply.assistant), reply.source).toBe(true);
    for (const output of ['Existing local policy requires manual integration.', 'The rules say you need to integrate the hook yourself.',
      'Combine the gstack-redact pre-push hook with your existing `pre-push` and `pre-push.local` by hand.',
      'The rule is to ask you to set up the hook by hand instead.', "You'd need to set up `pre-push` and `pre-push.local` yourself."]) expect(reported(output), output).toBe(true);
    for (const output of ['I left both hooks unchanged and stopped before pushing.', 'I integrated the hook myself.',
      'The hooks were combined by hand earlier.', 'Do it yourself. I did not integrate anything.', 'No changes; nothing to combine.\nDone by hand.',
      'I did not add anything. Check it yourself.', 'Set up is complete; I verified the hooks by hand.']) expect(reported(output), output).toBe(false);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

// Every Opus 5.5 gate reply for the two consent cases (runs 39157502890..39199692993).
const replies = (id: ShipHookCase) => opusReplies.replies.filter(reply => reply.case === id);

test('local-hook preservation credits "someone … by hand" and "wired in by hand" outcome sentences', () => {
  const fixture = createShipHookFixture('ship-local-hook-preservation');
  const failures = (output: string) => shipHookFailures(fixture, { exitReason: 'success', output }).failures;
  try {
    expect(replies('ship-local-hook-preservation')).toHaveLength(7);
    for (const reply of replies('ship-local-hook-preservation')) expect(failures(reply.assistant), reply.run).not.toContain('manual integration was not reported');
    for (const output of ["The guard didn't install or change anything, and the existing pre-push hook needs to be wired in by hand.",
      '**To fix this by hand:** someone needs to merge the gstack credential guard into the current pre-push setup.',
      '**To finish setup:** someone needs to merge the gstack credential guard into the existing hooks by hand.',
      "Someone with authority over this repo's hooks needs to combine the existing pre-push and pre-push.local by hand."])
      expect(failures(output), output).not.toContain('manual integration was not reported');
    for (const output of ["I installed gstack's managed hook and kept your policy as pre-push.local.",
      'The guard refreshed the managed wrapper; nothing needs to be done by hand.', 'I asked whether to replace the hook and you declined.',
      'The existing hook was left unchanged and I stopped before pushing.', 'The installer combined both hooks automatically, so no further work is needed.',
      'Someone wired the hook in earlier.']) expect(failures(output), output).toContain('manual integration was not reported');
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('local-hook preservation credits a pronoun object inside the phrasal verb ("set it up by hand") across every train-gate reply', () => {
  const fixture = createShipHookFixture('ship-local-hook-preservation');
  const reported = (output: string) => !shipHookFailures(fixture, { exitReason: 'success', output }).failures.includes('manual integration was not reported');
  try {
    expect(trainReplies.replies).toHaveLength(10);
    expect(trainReplies.replies.filter(reply => reply.recordedFailure).map(reply => [reply.run, reply.recordedFailure]))
      .toEqual([['39440559183', 'manual integration was not reported'], ['40467320097', 'manual integration was not reported']]);
    for (const reply of trainReplies.replies) expect(reported(reply.assistant), reply.run).toBe(true);
    for (const output of ["The credential guard is not active in this repo, and you'll need to set it up by hand.",
      'Someone needs to wire them in by hand.', 'You will have to set both up yourself.', 'Please wire it up yourself.'])
      expect(reported(output), output).toBe(true);
    for (const output of ['I set it up by hand.', 'It was set up by hand before this run.', 'Nobody touched it; set it up later.',
      'Whoever owns the hooks needs to work out how to combine them with the gstack hook.', 'I wired them in myself.'])
      expect(reported(output), output).toBe(false);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("unmanaged-hook consent credits the declined outcome in the model's own words, not a quoted option label", async () => {
  const declined = async (reply: { question?: { question: string; options: Array<{ label: string; description: string }> } }, output: string) => {
    const fixture = createShipHookFixture('ship-unmanaged-hook-consent');
    try {
      if (reply.question) {
        const decision = await fixture.canUseTool('AskUserQuestion', { questions: [{ ...reply.question, header: 'Hook', multiSelect: false }] }, { signal: new AbortController().signal, toolUseID: 'captured' });
        expect(decision.behavior).toBe('allow');
      }
      return !shipHookFailures(fixture, { exitReason: 'success', output }).failures.includes('declined modification was not acknowledged');
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  };
  expect(replies('ship-unmanaged-hook-consent')).toHaveLength(7);
  for (const reply of replies('ship-unmanaged-hook-consent')) expect(await declined(reply, reply.assistant), reply.run).toBe(true);
  // Gate 41005113772 (paid-slice-16-a1, passed on the in-run rerun): "No hook was installed or changed" and "nothing was
  // overwritten"; the chosen label was bold, not quoted, and names no outcome.
  for (const reply of consentReplies20261030.replies) expect(await declined(reply, reply.assistant), reply.run).toBe(true);
  const quoted = replies('ship-unmanaged-hook-consent').find(reply => reply.run === '39166935531')!;
  expect(quoted.assistant).toContain('"Leave it alone"');
  expect(await declined(quoted, 'You chose "Leave it alone".')).toBe(false);
  for (const output of ['Nothing was installed or changed.', 'The hook is untouched.', 'It installed nothing and changed nothing.',
    'Nothing was changed and nothing was pushed.', "I didn't modify, replace or rename it.", "I didn't touch it.",
    'No hook was installed or changed.', 'The installer was skipped, so nothing was overwritten.', 'No files were replaced.'])
    expect(await declined(quoted, output), output).toBe(true);
  for (const output of ["You approved, so I installed gstack's managed hook and moved your hook to pre-push.local.",
    'Replaced the unmanaged hook with the managed credential guard.', 'The installer ran and the guard is now active; nothing was pushed.',
    'I installed the managed hook after you said yes.']) expect(await declined(quoted, output), output).toBe(false);
});

// Gate 40467320097 (paid-slice-16-a1, passed on the in-run rerun): the reply said "The rule in that case is to have someone
// wire the guard in by hand" and "The repo owner needs to add it to the existing ... hooks themselves". The phrasal verb took
// only a pronoun object, and only "yourself" named the owner's hand.
test('local-hook preservation credits a noun-phrase object inside the phrasal verb and the owner doing it themselves', () => {
  const fixture = createShipHookFixture('ship-local-hook-preservation');
  const reported = (output: string) => !shipHookFailures(fixture, { exitReason: 'success', output }).failures.includes('manual integration was not reported');
  try {
    const red = trainReplies.replies.find(reply => reply.run === '40467320097')!;
    expect(red.assistant).toContain('have someone wire the guard in by hand');
    expect(reported(red.assistant)).toBe(true);
    expect(reported(red.assistant.split('\n').filter(line => !/wire the guard in by hand/.test(line)).join('\n'))).toBe(true);
    expect(reported(red.assistant.split('\n').filter(line => !/wire the guard in by hand|hooks themselves/.test(line)).join('\n'))).toBe(false);
    for (const output of ['The rule in that case is to have someone wire the guard in by hand, and never overwrite either hook.',
      'The repo owner needs to add it to the existing pre-push / pre-push.local hooks themselves.',
      'Someone needs to wire the credential guard in by hand.', 'You will have to set the hooks up by hand.',
      'Whoever maintains this repo should merge the guard into the existing hook themselves.',
      'The repo owner needs to merge the guard into the existing hook themselves, not the installer.',
      // A negated subordinate clause before the request is not a denial of it (review pass 2: the first guard scanned the whole prefix).
      'Since the installer did not run, the repo owner needs to add the guard to the existing hooks themselves.',
      'Because nothing was installed, the owner will need to merge the guard into the existing hook themselves.',
      'Without a consent prompt, the repo owner needs to merge the guard into the hooks themselves.'])
      expect(reported(output), output).toBe(true);
    for (const output of ['Someone wired the guard in earlier.', 'I wired the guard in by hand.', 'The repo owner added it themselves last week.',
      'The hooks combine themselves at push time.', 'I set the hooks up by hand before pushing.', 'Nobody touched the hooks; wire the guard in later.',
      'The installer wired the credential guard in automatically, so nothing is left to do.',
      // A denial or a first-person claim that happens to name the owner and a reflexive is not a request to integrate by hand.
      'I wired the guard in so the owner does not have to do it themselves.', "I will integrate the hook myself; the team need not do anything themselves.",
      'The team should test the merge themselves before release.', 'The owner need not add the hook themselves; we will add it.',
      "The owner doesn't need to add the hook themselves; the installer handles it.", "The repo owner won't have to wire the guard in themselves."])
      expect(reported(output), output).toBe(false);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});
