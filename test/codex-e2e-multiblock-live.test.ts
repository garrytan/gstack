/**
 * Live Codex multi-block check (E6, periodic, host-run Codex job).
 *
 * Codex runs every shell block of a skill in a fresh shell. This case runs
 * `./setup --host codex` once from the job's own checkout into a fresh HOME
 * and CODEX_HOME, then checks what a Codex user gets:
 *   1. `codex debug prompt-input` lists the `gstack` router, and the router
 *      it names is a real file (Codex skips a symlinked SKILL.md);
 *   2. `codex exec` running /learn's "Show recent" block, a later block that
 *      only its own prelude can root, runs the installed helper and prints the
 *      learning seeded before the run; no block reports a missing install or
 *      an unresolved gstack helper path.
 * Auth is the CI login home's auth.json only (scopeCodexAccess hands this
 * file the CLI on PATH and that home as CODEX_HOME).
 */
import { describe, test, afterAll, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { e2eTierEnabled } from './helpers/e2e-gate';
import { hermeticChildEnv } from './helpers/hermetic-env';
import { parseCodexJSONL, type CodexResult } from './helpers/codex-session-runner';
import { CODEX_EVAL_FINALIZE_MS, createCodexEvalCollector, runRecordedCodexEval } from './helpers/codex-eval';
import { MULTIBLOCK_SENTINEL_KEY, multiblockProblems, routerPathFromPromptInput } from './helpers/codex-multiblock';
import { CODEX_FRONTIER_MODEL } from '../scripts/resolvers/constants';

const ROOT = path.resolve(import.meta.dir, '..');
const CASE = 'codex-multiblock-live';
const SETUP_MS = 300_000;
const CODEX_AVAILABLE = spawnSync('which', ['codex'], { timeout: 30_000 }).status === 0;
const ENABLED = e2eTierEnabled('periodic') && CODEX_AVAILABLE;
if (e2eTierEnabled('periodic') && !CODEX_AVAILABLE) process.stderr.write(`\n${CASE}: SKIPPED: codex binary not on PATH\n`);

const collector = ENABLED ? createCodexEvalCollector('codex-e2e-multiblock-live') : null;
afterAll(async () => { await collector?.finalize(); });

/** `codex exec --json` with stdout/stderr in files (no pipe can outlive the process group), killed on abort. */
function codexExec(args: string[], env: NodeJS.ProcessEnv, cwd: string, scratch: string, signal: AbortSignal): Promise<CodexResult> {
  const started = Date.now();
  const outFile = path.join(scratch, 'exec.jsonl');
  const errFile = path.join(scratch, 'exec.stderr');
  const out = fs.openSync(outFile, 'w');
  const err = fs.openSync(errFile, 'w');
  const proc = spawn('codex', args, { cwd, env, stdio: ['ignore', out, err], detached: true });
  fs.closeSync(out);
  fs.closeSync(err);
  const kill = () => { try { process.kill(-proc.pid!, 'SIGKILL'); } catch { /* already gone */ } };
  signal.addEventListener('abort', kill, { once: true });
  return new Promise(resolve => {
    const finish = (exitCode: number) => {
      signal.removeEventListener('abort', kill);
      kill();
      const rawLines = fs.readFileSync(outFile, 'utf8').split('\n').filter(line => line.trim());
      resolve({ ...parseCodexJSONL(rawLines), rawLines, exitCode: signal.aborted ? 124 : exitCode,
        durationMs: Date.now() - started, stderr: fs.readFileSync(errFile, 'utf8') });
    };
    proc.once('error', () => finish(1));
    proc.once('exit', (code, sig) => finish(code ?? (sig ? 128 + (os.constants.signals[sig] ?? 0) : 1)));
  });
}

(ENABLED ? describe : describe.skip)('live Codex multi-block install (E6)', () => {
  test(CASE, async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'e6-'));
    try {
      const home = path.join(scratch, 'home');
      const codexHome = path.join(home, '.codex');
      const repo = path.join(scratch, 'repo');
      // Codex will not create its sandbox helper aliases under its temp dir, so TMPDIR sits beside CODEX_HOME.
      const tmp = path.join(home, 'tmp');
      for (const dir of [codexHome, repo, tmp]) fs.mkdirSync(dir, { recursive: true });
      const ciHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
      if (fs.existsSync(path.join(ciHome, 'auth.json'))) fs.copyFileSync(path.join(ciHome, 'auth.json'), path.join(codexHome, 'auth.json'));
      const env = hermeticChildEnv({ HOME: home, CODEX_HOME: codexHome, TMPDIR: tmp }, { extraAllow: ['OPENAI_API_KEY', 'CODEX_*'] });

      const setupStarted = Date.now();
      const setup = spawnSync('./setup', ['--host', 'codex'], { cwd: ROOT, env, encoding: 'utf8', timeout: SETUP_MS });
      console.log(`${CASE}: ./setup --host codex exit ${setup.status} in ${Math.round((Date.now() - setupStarted) / 1000)}s`);
      expect(setup.status, `${setup.stdout.slice(-2000)}\n${setup.stderr.slice(-2000)}`).toBe(0);

      const promptInput = spawnSync('codex', ['debug', 'prompt-input'], { cwd: repo, env, encoding: 'utf8', timeout: 60_000 });
      expect(promptInput.status, promptInput.stderr).toBe(0);
      const router = routerPathFromPromptInput(promptInput.stdout);
      expect(router, 'codex debug prompt-input does not list the gstack router').toBe(path.join(codexHome, 'skills', 'gstack', 'SKILL.md'));
      expect(fs.lstatSync(router!).isFile()).toBe(true);

      for (const args of [['init', '-q'], ['remote', 'add', 'origin', 'https://github.com/example/e6-fixture.git']]) {
        expect(spawnSync('git', args, { cwd: repo, env, timeout: 30_000 }).status).toBe(0);
      }
      const seed = spawnSync(path.join(codexHome, 'skills', 'gstack', 'bin', 'gstack-learnings-log'), [JSON.stringify({ skill: 'learn',
        type: 'pitfall', key: MULTIBLOCK_SENTINEL_KEY, insight: 'Seeded by the E6 live Codex check', confidence: 9, source: 'user-stated' })],
      { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
      expect(seed.status, seed.stderr).toBe(0);

      const result = await runRecordedCodexEval({
        name: CASE,
        suite: 'codex-e2e-multiblock-live',
        budgetMs: CAPTURE_MS,
        run: signal => codexExec(['exec', '--json', '-s', 'read-only', '--skip-git-repo-check',
          '--model', process.env.GSTACK_CODEX_MODEL ?? CODEX_FRONTIER_MODEL,
          'Use the gstack learn skill to show this project\'s recent learnings. Run its "Show recent" step, then list what it printed.'],
        env, repo, scratch, signal),
        validate: run => {
          const problems = multiblockProblems(run.rawLines);
          if (problems.length) throw new Error(problems.join('\n'));
        },
        record: entry => collector?.addTest(entry),
      });
      console.log(`${CASE}: ${result.toolCalls.length} commands, ${result.tokens} tokens, ${Math.round(result.durationMs / 1000)}s`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }, SETUP_MS + 120_000 + CAPTURE_MS + CODEX_EVAL_FINALIZE_MS);
});
