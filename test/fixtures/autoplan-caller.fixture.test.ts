// Child-only free control: never launch a provider when discovered by Bun.
import { afterAll, describe, expect, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AUTOPLAN_CHAIN_BUDGET } from '../helpers/eval-budgets';
import * as runner from '../helpers/claude-pty-runner';
import * as nativeTranscript from '../helpers/plan-count-transcript';
import * as methodAudit from '../helpers/autoplan-method-read-audit';
import { ownedNativeReviewStateRoot } from '../helpers/plan-count-fixture';
import phaseEntry from './autoplan-phase-entry-cf74.json';

if (process.env.AUTOPLAN_CALLER_SCENARIO) {
  const root = path.resolve(import.meta.dir, '../..');
  const runnerExports = { ...runner };
  const transcriptExports = { ...nativeTranscript };
  const methodAuditExports = { ...methodAudit };
  const mode = process.env.AUTOPLAN_CALLER_SCENARIO;
  const entryScenario = mode.startsWith('entry-');
  let fixtureCwd = '';
  const facts = { inputs: [] as string[], closed: false, startedAt: 0, elapsedMs: 0, approvalStartedAt: 0,
    captured: [] as Array<{ state: string; prematurePhaseEntry: unknown }> };
  let clock = 0;
  let complete = false;
  Date.now = () => clock;
  Bun.sleep = (async (ms: number) => {
    clock += ms;
    if (mode === 'deadline' && facts.startedAt) clock = facts.startedAt + AUTOPLAN_CHAIN_BUDGET.workMs;
  }) as typeof Bun.sleep;
  mock.module(path.join(root, 'test/helpers/e2e-gate.ts'), () => ({ describeE2ETier: () => describe }));
  mock.module(path.join(root, 'test/helpers/claude-pty-runner.ts'), () => ({
    ...runnerExports,
    isPlanReadyVisible: () => false,
    isPermissionDialogVisible: (text: string) => text.includes('Permission'),
    isNumberedOptionListVisible: (text: string) => text.includes('1. Yes'),
    selectPtyNumberedOption: async (session: {send(input: string): void}, index: number) => session.send(`${index}\r`),
    launchClaudePty: async (opts: any) => {
      const cwd = fs.realpathSync(opts.cwd);
      fixtureCwd = cwd;
      if (mode === 'entry-alias' || mode === 'entry-foreign-alias') {
        const alias = path.join(cwd, '.native', 'skills', 'gstack', 'autoplan', 'sections', 'design-phase.md');
        fs.mkdirSync(path.dirname(alias), { recursive: true });
        let target = path.join(root, 'autoplan', 'sections', 'design-phase.md');
        if (mode === 'entry-foreign-alias') {
          const foreign = path.join(cwd, 'foreign-design-phase.md');
          fs.copyFileSync(target, foreign); target = foreign;
        }
        fs.symlinkSync(target, alias);
      }
      const git = (file: string) => execFileSync('git', ['show', `HEAD:${file}`], { cwd, encoding: 'utf8', timeout: 5000 });
      expect(git('.claude/plans/ui-heavy-feature.md')).toBe(fs.readFileSync(path.join(root, 'test/fixtures/plans/autoplan-dashboard.md'), 'utf8'));
      expect(git('CLAUDE.md')).toContain('## Skill routing');
      expect(git('docs/designs/dashboard-context.md')).toContain('## Existing product and application contracts');
      expect(opts).toMatchObject({ permissionMode: 'plan', timeoutMs: AUTOPLAN_CHAIN_BUDGET.sessionMs,
        seedSkills: true, observeScreen: true, observeSetupQuestions: true,
        observeAutoplanArtifacts: true, approveAutoplanArtifactEdits: true });
      return {
        hermeticConfigDir: path.join(cwd, '.native'),
        autoplanArtifactStateRoot: ownedNativeReviewStateRoot(opts.autoplanArtifactState, opts.env),
        mark: () => 0, exited: () => false, exitCode: () => null,
        rawOutput: () => '', visibleText: () => '', visibleSince: () => '',
        startAutoplanArtifactEditApproval: (at: number) => { facts.approvalStartedAt = at; },
        currentScreen: async () => {
          if (mode === 'deadline') return 'Permission\n1. Yes\n2. No';
          clock = facts.startedAt + (entryScenario ? 15000 : mode === 'progress' ? 900001 : AUTOPLAN_CHAIN_BUDGET.workMs);
          complete = true;
          return 'Four native reviews have completed.';
        },
        send: (input: string) => {
          facts.inputs.push(input);
          if (input === '/autoplan\r') facts.startedAt = clock;
        },
        close: async () => { facts.closed = true; facts.elapsedMs = clock - facts.startedAt; },
      };
    },
  }));
  mock.module(path.join(root, 'test/helpers/plan-count-transcript.ts'), () => ({
    ...transcriptExports,
    readPlanCountTranscript: (config: string, cwd: string, onPublicToolEvent: (event: nativeTranscript.NativePublicToolEvent) => void) => {
      if (!entryScenario) return { status: 'ready', calls: [], assistantMessages: complete
        ? [1, 2, 2.5, 3].map((phase, i) => ({sessionId: 'owned', timestamp: new Date(facts.startedAt + i + 1).toISOString(), text: `Phase ${phase} complete.`})) : [] };
      const entryAt = facts.startedAt + 14000;
      const sessionId = phaseEntry.events[0]!.sessionId;
      const canonical = path.join(root, 'autoplan', 'sections', 'design-phase.md');
      const readPath = mode === 'entry-foreign' ? path.join(fixtureCwd, 'foreign', 'design-phase.md')
        : mode === 'entry-alias' || mode === 'entry-foreign-alias'
          ? path.join(config, 'skills', 'gstack', 'autoplan', 'sections', 'design-phase.md') : canonical;
      const content = fs.readFileSync(canonical, 'utf8');
      const use = phaseEntry.events[0]!, result = phaseEntry.events[1]!;
      const reportAt = entryAt + (mode === 'entry-valid' || mode === 'entry-alias' ? -1 : mode === 'entry-equal' ? 0 : 1);
      const message = (timestamp: number, text: string) => ({ cwd, sessionId, isSidechain: false,
        timestamp: new Date(timestamp).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } });
      const records: any[] = [message(entryAt - 5000, phaseEntry.assistantMessages.at(-1)!.text)];
      if (mode !== 'entry-omission') records.push({ ...message(reportAt, 'Phase 1 complete.'),
        ...(mode === 'entry-foreign-report' ? { isSidechain: true } : {}) });
      records.push({ cwd, sessionId, isSidechain: mode === 'entry-child', timestamp: new Date(entryAt).toISOString(),
        message: { role: 'assistant', content: [{ type: 'tool_use', id: use.toolUseId, name: 'Read', input: { file_path: readPath } }] } });
      if (mode !== 'entry-missing-ack') records.push({ cwd, sessionId, isSidechain: mode === 'entry-child', timestamp: new Date(entryAt + 2).toISOString(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: result.toolUseId,
          is_error: mode === 'entry-error', content: '' }] },
        toolUseResult: { file: { filePath: readPath, content, startLine: 1,
          numLines: content.split('\n').length, totalLines: content.split('\n').length } } });
      records.push(...[2, 2.5, 3].map((phase, i) => message(entryAt + 3 + i, `Phase ${phase} complete.`)));
      records.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      const project = path.join(config, 'projects', 'fixture'); fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(path.join(project, `${sessionId}.jsonl`), records.map(row => JSON.stringify(row)).join('\n') + '\n');
      return transcriptExports.readPlanCountTranscript(config, cwd, onPublicToolEvent);
    },
  }));
  mock.module(path.join(root, 'test/helpers/plan-count-pending-question.ts'), () => ({
    readPendingQuestion: () => undefined, pendingQuestionRecorderStatus: () => ({status: 'idle'}),
  }));
  mock.module(path.join(root, 'test/helpers/autoplan-artifact-recorder.ts'), () => ({
    readPendingAutoplanArtifact: () => undefined, autoplanArtifactRecorderStatus: () => ({status: 'idle'}),
    autoplanArtifactApprovalBoundary: () => 'clear',
  }));
  // Method delivery has independent native positive/negative controls. Supply
  // successful delivery here so only the caller's deadline decides acceptance.
  mock.module(path.join(root, 'test/helpers/autoplan-method-read-audit.ts'), () => ({
    ...methodAuditExports,
    auditAutoplanMethodReads: () => complete ? ['ceo', 'design', 'dx', 'eng'].map(phase => ({phase, passed: true})) : [],
    loadAutoplanMethodologyBinding: () => undefined,
  }));
  mock.module(path.join(root, 'test/helpers/plan-count-artifacts.ts'), () => ({createPlanCountSnapshotWriter: () => (input: any) => {
    facts.captured.push({ state: input.observation.state, prematurePhaseEntry: input.observation.prematurePhaseEntry }); return {};
  }}));
  afterAll(() => fs.writeFileSync(process.env.AUTOPLAN_CALLER_FACTS!, JSON.stringify(facts)));
  await import('../skill-e2e-autoplan-chain.test');
}
