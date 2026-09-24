/** Live Codex periodic coverage of the generated standalone skill's read-only audit. */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCodexSkill, type CodexResult } from './helpers/codex-session-runner';
import { CAPTURE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { e2eTierEnabled } from './helpers/e2e-gate';
import { EvalCollector } from './helpers/eval-store';
import { detectBaseBranch, E2E_TOUCHFILES, getChangedFiles, GLOBAL_TOUCHFILES, selectTests } from './helpers/touchfiles';
import {
  createSharedLibsFixture, installHostileGitConfig, installSourceShims, readRequests,
  seedOpportunitySources, sharedReadOnlyViolations, SHARED_LIBS_ROOT, snapshotFixture,
} from './helpers/shared-libs-eval-fixture';

const TEST_ID = 'shared-libs-codex-read-only';
const enabled = e2eTierEnabled('periodic');
const available = Boolean(Bun.which('codex'));
const describeCodex = enabled && available ? describe : describe.skip;
const collector = enabled && available ? new EvalCollector('e2e') : null;
afterAll(async () => { await collector?.finalize(); });

if (enabled && !available) process.stderr.write('\nShared-libs Codex E2E: SKIPPED — codex binary unavailable\n');

// Derive selection from the canonical registry, never maintain a second dependency list.
let selected = true;
if (enabled && !process.env.EVALS_ALL) {
  const dependencies = E2E_TOUCHFILES[TEST_ID];
  if (!dependencies) throw new Error(`Missing canonical E2E_TOUCHFILES entry: ${TEST_ID}`);
  const base = process.env.EVALS_BASE || detectBaseBranch(SHARED_LIBS_ROOT) || 'main';
  const changed = getChangedFiles(base, SHARED_LIBS_ROOT);
  if (changed.length > 0) {
    selected = selectTests(changed, { [TEST_ID]: dependencies }, GLOBAL_TOUCHFILES).selected.includes(TEST_ID);
  }
}

function testIfSelected(name: string, fn: () => Promise<void>, timeout: number) {
  (selected ? test : test.skip)(name, fn, timeout);
}

describeCodex('Shared-code audit on live Codex (periodic)', () => {
  testIfSelected('shared-libs-codex-read-only', async () => {
    const fixture = createSharedLibsFixture('codex-read-only');
    let result: CodexResult | undefined;
    let passed = false;
    let failure: unknown;
    try {
      seedOpportunitySources(fixture);
      installHostileGitConfig(fixture);
      installSourceShims(fixture);
      const before = snapshotFixture(fixture.root);
      const environment = Object.entries(fixture.env)
        .map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ');

      result = await runCodexSkill({
        skillDir: path.join(SHARED_LIBS_ROOT, '.agents/skills/gstack-deslop-shared-libs'),
        skillName: 'deslop-shared-libs',
        // Extract the actual generated Codex workflow, retaining all standalone rules
        // and its common rubric without importing an unrelated parent preamble.
        sections: [
          'Scope and read-only boundary', 'Establish the reviewed source',
          'Start with recent work', 'Evaluate candidates', 'Output',
        ],
        // Start outside the target repo: host startup Git probes must not execute
        // the hostile hooks before the generated skill has been read.
        cwd: fixture.root,
        // This private fixture follows the existing outside-voice eval: the VM cannot
        // mount bubblewrap's /proc. Full access also makes snapshots/canaries prove
        // the skill stayed read-only instead of a sandbox merely denying its writes.
        sandbox: 'danger-full-access',
        // Match the existing GPT provider harness: login/profile startup resets
        // PATH on this host and bypasses our Git/GitHub source instrumentation.
        configOverrides: ['allow_login_shell=false',
          'shell_environment_policy.experimental_use_profile=false',
          `shell_environment_policy.set={${environment}}`],
        timeoutMs: CAPTURE_MS,
        prompt: `Use the deslop-shared-libs skill to audit ${fixture.repo}. Include relevant uncommitted source and return the skill's recommendations in conversation. The Git and GitHub commands supplied in PATH are fixture source providers; use their responses as repository evidence.`,
      });

      expect(result.exitCode, `stderr:\n${result.stderr}\noutput:\n${result.output}`).toBe(0);
      expect(result.stderr).not.toMatch(/Skipped loading|invalid skill/i);
      expect(result.toolCalls.length).toBeGreaterThan(0);
      expect(result.toolCalls.length).toBeLessThanOrEqual(50);
      const requests = readRequests(fixture);
      expect(sharedReadOnlyViolations(result.toolCalls.map(command => ({ tool: 'Bash', input: { command } })), requests)).toEqual([]);
      const after = snapshotFixture(fixture.root);
      // Provider instrumentation is the only permitted fixture write. Include the
      // outer directory so an unsolicited report beside the repository also fails.
      delete before[path.relative(fixture.root, fixture.trace)];
      delete after[path.relative(fixture.root, fixture.trace)];
      expect(after).toEqual(before);
      expect(fs.existsSync(fixture.hookTrace) ? fs.readFileSync(fixture.hookTrace, 'utf8') : '').toBe('');
      expect(fs.readdirSync(fixture.state)).toEqual([]);
      // The runner's command list omits native patch events; inspect those separately.
      expect(result.rawLines.some(line => {
        try { return JSON.parse(line).item?.type === 'file_change'; } catch { return false; }
      })).toBe(false);
      const commands = result.toolCalls.join('\n');
      expect(commands).not.toMatch(/\bgstack-(?:review-read|wtree|skill-start|learnings-log)\b/);
      expect(commands).not.toMatch(/\b(?:node\s+bootstrap\.js|npm\s+install|bun\s+(?:install|test|run\s+test))\b/);

      const insideTarget = (directory: string) => directory === fixture.repo || directory.startsWith(fixture.repo + path.sep);
      const git = requests.filter(row => row.tool === 'git' && (insideTarget(row.cwd) ||
        row.args.some((arg, index) => arg === '-C' && row.args[index + 1] &&
          insideTarget(path.resolve(row.cwd, row.args[index + 1])))));
      expect(git.length).toBeGreaterThan(0);
      expect(git.some(request => request.args.includes('--no-lazy-fetch') &&
        request.args.includes('rev-parse') && request.args.includes('--is-inside-work-tree'))).toBe(true);
      for (const request of git) {
        // A version-only diagnostic never substitutes for the actual protected probe.
        if (request.args.length === 1 && request.args[0] === '--version') continue;
        for (const forbidden of ['status', 'fetch', 'ls-remote', 'pull', 'push', 'clone', 'add', 'write-tree', 'hash-object', 'checkout', 'reset']) {
          expect(request.args).not.toContain(forbidden);
        }
        expect(request.args).toContain('--no-lazy-fetch');
        expect(request.args).toContain('core.fsmonitor=false');
        expect(request.args).toContain('log.showSignature=false');
      }
      const apiReads = requests.filter(row => (row.tool === 'gh' && row.args[0] === 'api') || row.tool === 'curl');
      expect(apiReads.length).toBeGreaterThan(0);
      for (const request of apiReads) {
        expect(request.method).toBe('GET');
      }

      expect(result.output).toContain(fixture.tip.slice(0, 7));
      expect(result.output).toMatch(/uncommitted|overlay|raw/i);
      expect(result.output).toContain('retry-worker.ts');
      expect(result.output).toContain('retry-route.ts');
      expect(result.output).toContain('lib/retry-after.ts');
      expect(result.output).toMatch(/estimated?|savings|saved|removed/i);
      expect(result.output).toMatch(/tests?|coverage|contract/i);
      passed = true;
    } catch (cause) {
      failure = cause;
      throw cause;
    } finally {
      collector?.addTest({
        name: TEST_ID, suite: 'codex-shared-libs', tier: 'e2e', passed,
        duration_ms: result?.durationMs ?? 0, cost_usd: 0,
        output: result?.output ?? '', tokens_used: result?.tokens ?? 0,
        transcript: [...(result?.rawLines ?? []).map(line => {
          try { return JSON.parse(line); } catch { return { raw: line }; }
        }), { fixture_requests: readRequests(fixture) }],
        turns_used: result?.toolCalls.length ?? 0,
        exit_reason: !result ? 'capture_threw' : result.exitCode === 0 ? (passed ? 'success' : 'assertion_failed')
          : result.exitCode === 124 ? 'timeout' : `exit_code_${result.exitCode}`,
        last_tool_call: result?.toolCalls.at(-1),
        error: [failure ? String(failure) : '', result?.stderr || ''].filter(Boolean).join('\n') || undefined,
      });
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }, CAPTURE_LONG_MS);
});
