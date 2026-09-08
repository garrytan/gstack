/** Periodic paid workflow E2Es: real host -> real outside CLI -> seeded defect. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { e2eTierEnabled } from './helpers/e2e-gate';
import { runSkillTest } from './helpers/session-runner';
import { runCodexSkill } from './helpers/codex-session-runner';
import { EvalCollector } from './helpers/eval-store';
import { installOutsideReviewFixture } from './helpers/outside-voice-fixture';
import { claudeOutsideExecutions, codexOutsideExecutions, foundInvoiceAuthorizationDefect, outsideExecutionTranscript } from './helpers/outside-voice-evidence';
import { CAPTURE_LONG_MS } from './helpers/eval-budgets';

const ROOT = path.resolve(import.meta.dir, '..');
const periodic = e2eTierEnabled('periodic');
const missing = ['claude', 'codex'].filter(cli => !Bun.which(cli));
const enabled = periodic && missing.length === 0;
if (periodic && missing.length) process.stderr.write(`Outside-review E2Es: SKIPPED — missing CLI: ${missing.join(', ')}. No outside review was completed.\n`);
// Read the shared diff/tier selection only when a live test is possible. Its
// connectivity preflight must not turn a missing-CLI skip into a model request.
const selected = enabled ? (await import('./helpers/e2e-helpers')).selectedTests : [];
const collector = enabled ? new EvalCollector('e2e-outside-voice') : null;
const describeLive = enabled ? describe : describe.skip;
let fixtureRoot: string;
let rendered: string;

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]}: ${result.stderr.toString()}`);
}

function createRepo(host: 'claude' | 'codex'): string {
  const dir = path.join(fixtureRoot, host);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'eval@example.com');
  git(dir, 'config', 'user.name', 'Outside Voice Eval');
  const safe = `export async function readPrivateInvoice(db, actor, invoiceId) {
  const invoice = await db.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return null;
  if (invoice.ownerId !== actor.id) throw new Error('Forbidden');
  return { amount: invoice.amount, bankAccount: invoice.bankAccount };
}
`;
  fs.writeFileSync(path.join(dir, 'invoice.ts'), safe);
  git(dir, 'add', 'invoice.ts');
  git(dir, 'commit', '-m', 'Protect private invoices by owner');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'checkout', '-b', 'feature/invoice-lookup');
  fs.writeFileSync(path.join(dir, 'invoice.ts'), safe.replace("  if (invoice.ownerId !== actor.id) throw new Error('Forbidden');\n", ''));
  git(dir, 'add', 'invoice.ts');
  git(dir, 'commit', '-m', 'Simplify invoice lookup');
  return dir;
}


function prompt(skill: string): string {
  return `Run the installed ${skill} skill on this branch. The base branch is main (origin/main exists locally). Complete its adversarial review workflow and report the outside provider's actual findings separately from the native review. Review only; leave source files unchanged. All reviewer calls in this skill are authorized. If a native subagent tool is unavailable, report that and continue the independent outside CLI pass. Do not claim success if the outside CLI cannot complete.`;
}

function testIfSelected(name: string, fn: () => Promise<void>) {
  const run = selected === null || selected.includes(name);
  (run ? test : test.skip)(name, fn, CAPTURE_LONG_MS + 30_000);
}

describeLive('Installed workflows dispatch outside their host harness', () => {
  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-outside-live-'));
    rendered = path.join(fixtureRoot, 'render');
    const result = Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'all', '--out-dir', rendered], {
      cwd: ROOT, stdout: 'pipe', stderr: 'pipe', timeout: 120_000,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  });

  testIfSelected('outside-voice-codex-to-claude-code', async () => {
    const repo = createRepo('codex');
    const skillDir = installOutsideReviewFixture(rendered, 'codex', repo, ROOT);
    const result = await runCodexSkill({
      skillDir, skillName: 'gstack-review', cwd: repo, prompt: prompt('gstack-review'),
      // Reviewer scratch files and review logs need writes; this is an isolated
      // disposable fixture, and the prompt keeps repository source unchanged.
      sandbox: 'danger-full-access', timeoutMs: CAPTURE_LONG_MS,
    });
    const executions = codexOutsideExecutions(result.rawLines);
    const dispatched = foundInvoiceAuthorizationDefect(executions, 'claude-code');
    const passed = result.exitCode === 0 && dispatched;
    collector?.addTest({ name: 'outside-voice-codex-to-claude-code', suite: 'outside-voice', tier: 'e2e', passed,
      duration_ms: result.durationMs, cost_usd: 0, output: result.output.slice(0, 2000),
      transcript: outsideExecutionTranscript(executions, 'claude-code'),
      turns_used: result.toolCalls.length, exit_reason: result.exitCode === 0 ? 'success' : `exit_${result.exitCode}` });
    expect(result.exitCode).toBe(0);
    expect(dispatched).toBe(true);
    expect(Bun.spawnSync(['git', 'diff', '--exit-code', 'HEAD', '--', 'invoice.ts'], { cwd: repo, timeout: 10_000 }).exitCode).toBe(0);
  });

  testIfSelected('outside-voice-claude-code-to-codex', async () => {
    const repo = createRepo('claude');
    installOutsideReviewFixture(rendered, 'claude', repo, ROOT);
    const env: Record<string, string> = {};
    // Admit only Codex authentication/config location, never the operator's
    // session/harness markers or unrelated credentials.
    for (const key of ['OPENAI_API_KEY', 'CODEX_HOME']) if (process.env[key]) env[key] = process.env[key]!;
    const result = await runSkillTest({
      workingDirectory: repo, prompt: prompt('/review'), timeout: CAPTURE_LONG_MS, maxTurns: 30,
      allowedTools: ['Bash', 'Read', 'Write', 'Grep', 'Glob', 'Agent', 'Skill'], env,
      testName: 'outside-voice-claude-code-to-codex',
    });
    const executions = claudeOutsideExecutions(result.transcript);
    const dispatched = foundInvoiceAuthorizationDefect(executions, 'codex');
    const passed = result.exitReason === 'success' && dispatched;
    collector?.addTest({ name: 'outside-voice-claude-code-to-codex', suite: 'outside-voice', tier: 'e2e', passed,
      duration_ms: result.duration, cost_usd: result.costEstimate.estimatedCost, output: result.output.slice(0, 2000),
      transcript: outsideExecutionTranscript(executions, 'codex'),
      turns_used: result.costEstimate.turnsUsed, exit_reason: result.exitReason });
    expect(result.exitReason).toBe('success');
    expect(dispatched).toBe(true);
    expect(Bun.spawnSync(['git', 'diff', '--exit-code', 'HEAD', '--', 'invoice.ts'], { cwd: repo, timeout: 10_000 }).exitCode).toBe(0);
  });
});

afterAll(async () => {
  if (collector) await collector.finalize();
  if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
});
