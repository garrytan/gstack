/**
 * bin/gstack-outside-voice + lib/outside-voice-runner.ts (plan B3): one adapter
 * contract for codex-cli, api and host-subagent (capabilities, input digest,
 * model metadata, cancellation, terminal result, usage); the api runner is
 * labeled a supplied-input review; the same-family rule; a missing Codex CLI
 * is "unavailable; using <runner>" only when a fallback is configured. Pins
 * OUTSIDE_STATUS tokens, meta.json fields, codes and exit codes, not prose.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRunner, familyConflict, modelFamily, runnerTable, selectRunner, usageFromEvents } from '../lib/outside-voice-runner';
import { RESULT_FORMAT } from '../lib/autoplan-prompts';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-outside-voice');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-runner-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const REVIEW = `INPUT: ceo abc\n\n[P2] The install check lies by omission.\n\nRecommendation: revise because the premise is unmeasured.\nVERDICT: FINDINGS\n`;
const SHA = 'a'.repeat(64);
const AUTOPLAN_REVIEW = `INPUT: ceo ${SHA}\n\nThe premise is unmeasured, so the plan may solve the wrong problem.\n\n\`\`\`gstack-findings\n{"id":"F1","severity":"High","title":"premise unmeasured","fix":"measure the install check first"}\n\`\`\`\n`;
const promptFile = path.join(TMP, 'prompt.md');
fs.writeFileSync(promptFile, 'You are the outside CEO reviewer.\n');

/** Env with no provider keys and a PATH that holds only the fake bins. */
function cleanEnv(fakeBin: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(OPENAI|ANTHROPIC)_/.test(k) && k !== 'GSTACK_OUTSIDE_RUNNER') env[k] = v;
  env.PATH = `${fakeBin}:${path.dirname(Bun.which('bun')!)}:/usr/bin:/bin`;
  env.GSTACK_STATE_ROOT = path.join(TMP, 'state');
  return env;
}
function run(args: string[], env: Record<string, string>, cwd = ROOT) {
  return spawnSync('bun', [BIN, ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 });
}
/** Async form for tests that serve the provider from this process (a sync spawn would block the server). */
async function runAsync(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(['bun', BIN, ...args], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill('SIGKILL'), 60_000);
  const [status, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  clearTimeout(timer);
  return { status, stdout, stderr };
}
const emptyBin = path.join(TMP, 'empty-bin');
fs.mkdirSync(emptyBin, { recursive: true });

describe('model family rule', () => {
  test('ids classify by vendor prefix or model name; unknown ids are unknown', () => {
    expect(modelFamily('openai/gpt-6-astra')).toBe('openai');
    expect(modelFamily('gpt-5.4')).toBe('openai');
    expect(modelFamily('o3-pro')).toBe('openai');
    expect(modelFamily('anthropic/claude-opus-4-7')).toBe('anthropic');
    expect(modelFamily('claude-sonnet-5')).toBe('anthropic');
    expect(modelFamily('google/gemini-3.7-flash')).toBe('google');
    expect(modelFamily('xai/grok-4.7')).toBe('xai');
    expect(modelFamily('deepseek/deepseek-v4-pro')).toBe('deepseek');
    expect(modelFamily('qwen/qwen3.8-max')).toBe('qwen');
    expect(modelFamily('zai/glm-5.3')).toBe('zai');
    expect(modelFamily('moonshotai/kimi-k3')).toBe('moonshot');
    expect(modelFamily('meta/muse-spark-1.3')).toBe('meta');
    expect(modelFamily('mistral/codestral')).toBe('mistral');
    expect(modelFamily('astra')).toBe('unknown');
    expect(modelFamily('')).toBe('unknown');
  });
  test('familyConflict refuses same-family and unknown pairs, accepts cross-family', () => {
    expect(familyConflict('openai/gpt-6-astra', 'claude-opus-4-7')).toBeUndefined();
    expect(familyConflict('claude-sonnet-5', 'anthropic/claude-opus-4-7')).toMatch(/both anthropic/);
    expect(familyConflict('astra', 'claude-opus-4-7')).toMatch(/no recognized family/);
    expect(familyConflict('gpt-5.4', undefined)).toBeUndefined();
    const r = run(['run', '--runner', 'host-subagent', '--prompt', promptFile, '--out', path.join(TMP, 'x.md'), '--result', promptFile, '--model', 'claude-sonnet-5', '--native-model', 'claude-opus-4-7'], cleanEnv(emptyBin));
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/\(MODEL_FAMILY_CONFLICT\)$/m);
    expect(fs.existsSync(path.join(TMP, 'x.md'))).toBe(false);
  });
});

describe('the runner table', () => {
  test('every runner declares capabilities; api is a supplied-input review, host-subagent does not execute here', () => {
    const table = runnerTable({ env: cleanEnv(emptyBin) });
    expect(table.map(r => r.id)).toEqual(['codex-cli', 'api', 'host-subagent']);
    expect(table.find(r => r.id === 'api')!.capabilities).toEqual({ repository_access: 'none', executes_here: true, label: 'supplied-input review' });
    expect(table.find(r => r.id === 'codex-cli')!.capabilities).toEqual({ repository_access: 'read-only', executes_here: true, label: 'repository review' });
    expect(table.find(r => r.id === 'host-subagent')!.capabilities).toEqual({ repository_access: 'host', executes_here: false, label: 'host-dispatched review' });
    expect(table.every(r => r.available === false)).toBe(true);
    const r = run(['runners', '--json'], cleanEnv(emptyBin));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).map((x: any) => x.id)).toEqual(['codex-cli', 'api', 'host-subagent']);
  });
  test('--help prints the exit table', () => {
    const r = run(['--help'], cleanEnv(emptyBin));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Exit codes: 0 ok · 1 fail · 2 usage · 3 refused or needs a flag');
    expect(run([], cleanEnv(emptyBin)).status).toBe(2);
    expect(run(['run', '--runner', 'bogus', '--prompt', promptFile, '--out', 'x'], cleanEnv(emptyBin)).status).toBe(2);
  });
});

describe('host-subagent runner', () => {
  test('binds the subagent’s file, records the model, usage unknown, OUTSIDE_STATUS completed', () => {
    const result = path.join(TMP, 'host-result.md');
    fs.writeFileSync(result, REVIEW);
    const out = path.join(TMP, 'host-out', 'ceo-outside.md');
    const r = run(['run', '--runner', 'host-subagent', '--prompt', promptFile, '--out', out, '--result', result, '--model', 'openai/gpt-6-astra', '--native-model', 'claude-opus-4-7'], cleanEnv(emptyBin));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('OUTSIDE_STATUS: completed provider=host-subagent model=openai/gpt-6-astra family=openai');
    expect(r.stdout).not.toContain('single-model');
    expect(fs.readFileSync(out, 'utf8')).toBe(REVIEW);
    const meta = JSON.parse(fs.readFileSync(`${out}.meta.json`, 'utf8'));
    expect(meta).toMatchObject({ schema_version: 1, runner: 'host-subagent', status: 'completed', model: 'openai/gpt-6-astra', family: 'openai', usage: { usd: 'unknown' }, exit: 0 });
    expect(meta.capabilities.label).toBe('host-dispatched review');
    expect(meta.input_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.output_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.verdict.verdict).toBe('clean');
  });
  test('prints the shared FINDINGS label: a numbered finding with no P-tag is unspecified, never none (#3925)', () => {
    const result = path.join(ROOT, 'test', 'fixtures', 'outside-review-severity', 'codex-3925', 'nonblocking-numbered.txt');
    const r = run(['run', '--runner', 'host-subagent', '--gate', 'structured', '--prompt', promptFile, '--out', path.join(TMP, 'host-3925.md'), '--result', result, '--model', 'openai/gpt-6-astra', '--native-model', 'claude-opus-4-7'], cleanEnv(emptyBin));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('VERDICT: unverified\nFINDINGS: unspecified\n');
  });
  test('without --result or --model it is unavailable (exit 3, OUTSIDE_RUNNER_UNAVAILABLE)', () => {
    const r = run(['run', '--runner', 'host-subagent', '--prompt', promptFile, '--out', path.join(TMP, 'no.md'), '--model', 'gpt-5.4'], cleanEnv(emptyBin));
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/\(OUTSIDE_RUNNER_UNAVAILABLE\)$/m);
  });
});

describe('codex-cli runner', () => {
  const fakeBin = path.join(TMP, 'fake-bin');
  const gstackBin = path.join(TMP, 'fake-gstack-bin');
  beforeAll(() => {
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(gstackBin, { recursive: true });
    fs.writeFileSync(path.join(gstackBin, 'gstack-codex-probe'), `#!/usr/bin/env bash
[ "$1" = select-model ] || { echo "unexpected $1" >&2; exit 64; }
echo "CODEX_SEL: \${GSTACK_CODEX_MODEL:-gpt-6-astra}"
echo "CODEX_SEL_KIND: $2"
echo "CODEX_SANDBOX: read-only"
`, { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'codex'), `#!/usr/bin/env bash
# fake codex exec: records argv, reads stdin, writes the -o file and emits events on stdout
out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; esac; shift; done
printf '%s\\n' "$FAKE_ARGV_SINK" >/dev/null
cat >"$out.prompt"
if [ -n "\${FAKE_CODEX_SLEEP:-}" ]; then sleep "$FAKE_CODEX_SLEEP"; fi
if [ -n "\${FAKE_CODEX_EVENTS:-}" ]; then cat "$FAKE_CODEX_EVENTS"; printf '%s\\n' "\${FAKE_CODEX_STDERR:-}" >&2; : >"$out"; exit 1; fi
if [ -n "\${FAKE_CODEX_OWN:-}" ]; then
  own=$(sed -n 's/^3\\. Write the whole result to this file: //p' "$out.prompt")
  cat "$FAKE_CODEX_REVIEW" >"$own"
  printf '%s\\n' "\${FAKE_CODEX_LAST:-Wrote the review to the result file.}" >"$out"
else cat "$FAKE_CODEX_REVIEW" >"$out"; fi
echo '{"type":"item.completed","item":{"type":"command_execution","status":"completed","exit_code":0}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1200,"output_tokens":340}}'
`, { mode: 0o755 });
  });

  test('runs codex exec with the selected model and sandbox, classifies the text, records usage and the actual model', async () => {
    const review = path.join(TMP, 'codex-review.md');
    fs.writeFileSync(review, REVIEW);
    const env = { ...cleanEnv(fakeBin), FAKE_CODEX_REVIEW: review };
    const out = path.join(TMP, 'codex-out', 'ceo-outside.md');
    const runner = createRunner('codex-cli');
    const result = await runner.run({ promptFile, outFile: out, model: 'gpt-5.5', timeoutMs: 30_000, cwd: ROOT, gate: 'review', env, binDir: gstackBin });
    expect(result).toMatchObject({ runner: 'codex-cli', status: 'completed', model: 'gpt-5.5', family: 'openai', exit: 0, usage: { input_tokens: 1200, output_tokens: 340, usd: 'unknown' } });
    expect(result.verdict!.verdict).toBe('clean');
    expect(fs.readFileSync(`${out}.last-message.prompt`, 'utf8')).toBe(fs.readFileSync(promptFile, 'utf8'));
    expect(fs.readFileSync(out, 'utf8')).toBe(REVIEW);
    expect(usageFromEvents('{"usage":{"input_tokens":5}}\nnot json\n')).toEqual({ input_tokens: 5, usd: 'unknown' });
  });

  test('the reviewer\'s own result file survives Codex\'s closing message (-o goes to a separate file)', async () => {
    const review = path.join(TMP, 'own-review.md');
    fs.writeFileSync(review, AUTOPLAN_REVIEW);
    const out = path.join(TMP, 'own', 'ceo-outside.md');
    const prompt = path.join(TMP, 'own-prompt.md');
    fs.writeFileSync(prompt, `You are the outside CEO reviewer.\n${RESULT_FORMAT('ceo', SHA, out)}`);
    const result = await createRunner('codex-cli').run({ promptFile: prompt, outFile: out, timeoutMs: 30_000, cwd: ROOT, gate: 'autoplan', env: { ...cleanEnv(fakeBin), FAKE_CODEX_REVIEW: review, FAKE_CODEX_OWN: '1' }, binDir: gstackBin });
    expect(fs.readFileSync(out, 'utf8')).toBe(AUTOPLAN_REVIEW);
    expect(fs.readFileSync(`${out}.last-message`, 'utf8')).toBe('Wrote the review to the result file.\n');
    expect(result.reason).toBeUndefined();
    expect(result.status).toBe('completed');
  });

  test('when the reviewer\'s own file lacks the gate\'s markers and the closing message has them, the closing message is the result', async () => {
    const review = path.join(TMP, 'own-junk.md');
    fs.writeFileSync(review, 'draft notes, not the result\n');
    const out = path.join(TMP, 'own-junk', 'ceo-outside.md');
    const prompt = path.join(TMP, 'own-junk-prompt.md');
    fs.writeFileSync(prompt, `You are the outside CEO reviewer.\n${RESULT_FORMAT('ceo', SHA, out)}`);
    const result = await createRunner('codex-cli').run({ promptFile: prompt, outFile: out, timeoutMs: 30_000, cwd: ROOT, gate: 'autoplan', env: { ...cleanEnv(fakeBin), FAKE_CODEX_REVIEW: review, FAKE_CODEX_OWN: '1', FAKE_CODEX_LAST: AUTOPLAN_REVIEW.trimEnd() }, binDir: gstackBin });
    expect(fs.readFileSync(out, 'utf8')).toBe(AUTOPLAN_REVIEW);
    expect(result.status).toBe('completed');
  });

  test('a reviewer file with no final verdict loses to a closing message that has one (GST-3188)', async () => {
    const draft = path.join(TMP, 'own-draft.md');
    fs.writeFileSync(draft, 'No issues found.\nRecommendation: ship because the change is small.\n');
    const out = path.join(TMP, 'own-draft', 'review.md');
    const prompt = path.join(TMP, 'own-draft-prompt.md');
    fs.writeFileSync(prompt, `You are the outside reviewer.\n3. Write the whole result to this file: ${out}\n`);
    const result = await createRunner('codex-cli').run({ promptFile: prompt, outFile: out, timeoutMs: 30_000, cwd: ROOT, gate: 'review', env: { ...cleanEnv(fakeBin), FAKE_CODEX_REVIEW: draft, FAKE_CODEX_OWN: '1', FAKE_CODEX_LAST: REVIEW.trimEnd() }, binDir: gstackBin });
    expect(fs.readFileSync(out, 'utf8')).toBe(REVIEW);
    expect(result.status).toBe('completed');
  });

  test('a reviewer file whose receipt names another snapshot loses to a closing message that names this one (GST-3188)', async () => {
    const stale = path.join(TMP, 'own-stale.md');
    fs.writeFileSync(stale, AUTOPLAN_REVIEW.replace(SHA, 'b'.repeat(64)));
    const out = path.join(TMP, 'own-stale', 'ceo-outside.md');
    const prompt = path.join(TMP, 'own-stale-prompt.md');
    fs.writeFileSync(prompt, `You are the outside CEO reviewer.\n${RESULT_FORMAT('ceo', SHA, out)}`);
    const result = await createRunner('codex-cli').run({ promptFile: prompt, outFile: out, timeoutMs: 30_000, cwd: ROOT, gate: 'autoplan', env: { ...cleanEnv(fakeBin), FAKE_CODEX_REVIEW: stale, FAKE_CODEX_OWN: '1', FAKE_CODEX_LAST: AUTOPLAN_REVIEW.trimEnd() }, binDir: gstackBin });
    expect(fs.readFileSync(out, 'utf8')).toBe(AUTOPLAN_REVIEW);
    expect(result.status).toBe('completed');
  });

  test('a reviewer file whose own verdict says it is not ready is kept over a clean closing message (GST-3188 review)', async () => {
    const own = path.join(TMP, 'own-unready.md');
    const ownText = 'Verdict: ready, but I could not run the test suite.\nRecommendation: run the suite because nothing was executed.\n';
    fs.writeFileSync(own, ownText);
    const out = path.join(TMP, 'own-unready', 'review.md');
    const prompt = path.join(TMP, 'own-unready-prompt.md');
    fs.writeFileSync(prompt, `You are the outside reviewer.\n3. Write the whole result to this file: ${out}\n`);
    const clean = 'No issues found.\nRecommendation: ship because the change is small.\nVERDICT: CLEAN';
    const result = await createRunner('codex-cli').run({ promptFile: prompt, outFile: out, timeoutMs: 30_000, cwd: ROOT, gate: 'review', env: { ...cleanEnv(fakeBin), FAKE_CODEX_REVIEW: own, FAKE_CODEX_OWN: '1', FAKE_CODEX_LAST: clean }, binDir: gstackBin });
    expect(fs.readFileSync(out, 'utf8')).toBe(ownText);
    expect(result.verdict!.verdict).not.toBe('clean');
  });

  test('a reviewer draft with a finding and no verdict is not replaced by a closing message with no verdict (GST-3188 review)', async () => {
    const own = path.join(TMP, 'own-finding.md');
    const ownText = '[P2] The rollback docs are missing.\nRecommendation: add them because operators need them.\n';
    fs.writeFileSync(own, ownText);
    const out = path.join(TMP, 'own-finding', 'review.md');
    const prompt = path.join(TMP, 'own-finding-prompt.md');
    fs.writeFileSync(prompt, `You are the outside reviewer.\n3. Write the whole result to this file: ${out}\n`);
    await createRunner('codex-cli').run({ promptFile: prompt, outFile: out, timeoutMs: 30_000, cwd: ROOT, gate: 'review', env: { ...cleanEnv(fakeBin), FAKE_CODEX_REVIEW: own, FAKE_CODEX_OWN: '1', FAKE_CODEX_LAST: 'Recommendation: ship because everything looks fine.' }, binDir: gstackBin });
    expect(fs.readFileSync(out, 'utf8')).toBe(ownText);
  });

  test('a reviewer file for another snapshot is never reported clean when the closing message is not a result (GST-3188 review)', async () => {
    const stale = path.join(TMP, 'own-stale-only.md');
    fs.writeFileSync(stale, AUTOPLAN_REVIEW.replace(SHA, 'b'.repeat(64)).replace(/\{"id":"F1".*\}\n/, ''));
    const out = path.join(TMP, 'own-stale-only', 'ceo-outside.md');
    const prompt = path.join(TMP, 'own-stale-only-prompt.md');
    fs.writeFileSync(prompt, `You are the outside CEO reviewer.\n${RESULT_FORMAT('ceo', SHA, out)}`);
    const result = await createRunner('codex-cli').run({ promptFile: prompt, outFile: out, timeoutMs: 30_000, cwd: ROOT, gate: 'autoplan', env: { ...cleanEnv(fakeBin), FAKE_CODEX_REVIEW: stale, FAKE_CODEX_OWN: '1' }, binDir: gstackBin });
    expect(result.status).toBe('unavailable');
  });

  test('a prompt file that is one of the run\'s own output files is refused and left as it was (GST-3188)', async () => {
    const review = path.join(TMP, 'clash-review.md');
    fs.writeFileSync(review, REVIEW);
    const out = path.join(TMP, 'clash', 'review.md');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const prompt = `${out}.last-message`;
    const original = 'You are the outside reviewer.\n';
    fs.writeFileSync(prompt, original);
    const result = await createRunner('codex-cli').run({ promptFile: prompt, outFile: out, timeoutMs: 30_000, cwd: ROOT, gate: 'review', env: { ...cleanEnv(fakeBin), FAKE_CODEX_REVIEW: review }, binDir: gstackBin });
    expect(fs.readFileSync(prompt, 'utf8')).toBe(original);
    expect([result.status, result.reason]).toEqual(['failed', 'prompt_is_output']);
    const cli = run(['run', '--runner', 'codex-cli', '--prompt', prompt, '--out', out], { ...cleanEnv(fakeBin), FAKE_CODEX_REVIEW: review });
    expect(cli.status).toBe(2);
    expect(cli.stderr).toContain(`--prompt ${prompt}`);
    expect(fs.readFileSync(prompt, 'utf8')).toBe(original);
  });

  // Captured from codex-cli 0.170.0 against a local stub answering 402 (application/problem+json, a metering proxy's allowance) and 401.
  const REFUSAL_EVENTS = (status: string) => [
    '{"type":"thread.started","thread_id":"01a1f2ae-a04c-7583-8012-638cc20a388d"}',
    '{"type":"turn.started"}',
    JSON.stringify({ type: 'error', message: status }),
    JSON.stringify({ type: 'turn.failed', error: { message: status } }),
  ].join('\n') + '\n';
  const STATUS_402 = 'unexpected status 402 Payment Required: {"type":"https://meter.example/problems/allowance","title":"E_ALLOWANCE","status":402,"code":"E_ALLOWANCE","detail":"E_ALLOWANCE: metering proxy: the slot\'s allowance of $15 cannot hold this call\'s worst case"}, url: http://127.0.0.1:33037/v1/responses';
  const STATUS_401 = 'unexpected status 401 Unauthorized: Incorrect API key provided, url: http://127.0.0.1:45349/v1/responses';
  const STDERR = 'Reading additional input from stdin...';

  test('a 402 in Codex\'s JSON failure events is recorded as budget_exhausted with the cause, not "exit 1"', async () => {
    const events = path.join(TMP, 'refusal-402.jsonl');
    fs.writeFileSync(events, REFUSAL_EVENTS(STATUS_402));
    const result = await createRunner('codex-cli').run({ promptFile, outFile: path.join(TMP, 'r402', 'o.md'), timeoutMs: 30_000, cwd: ROOT, gate: 'review', env: { ...cleanEnv(fakeBin), FAKE_CODEX_EVENTS: events, FAKE_CODEX_STDERR: STDERR }, binDir: gstackBin });
    expect([result.status, result.exit, result.reason]).toEqual(['unavailable', 1, 'budget_exhausted']);
    expect(result.detail).toStartWith('unexpected status 402 Payment Required');
    expect(result.detail).toContain('E_ALLOWANCE');
  });

  test('a 401 in the same events stays execution_failed and keeps the 401 cause in its detail', async () => {
    const events = path.join(TMP, 'refusal-401.jsonl');
    fs.writeFileSync(events, REFUSAL_EVENTS(STATUS_401));
    const result = await createRunner('codex-cli').run({ promptFile, outFile: path.join(TMP, 'r401', 'o.md'), timeoutMs: 30_000, cwd: ROOT, gate: 'review', env: { ...cleanEnv(fakeBin), FAKE_CODEX_EVENTS: events, FAKE_CODEX_STDERR: STDERR }, binDir: gstackBin });
    expect([result.status, result.reason]).toEqual(['unavailable', 'execution_failed']);
    expect(result.detail).toBe(`exit 1: ${STATUS_401}`);
  });

  test('cancel() terminates the child and reports cancelled', async () => {
    const review = path.join(TMP, 'codex-review-2.md');
    fs.writeFileSync(review, REVIEW);
    const env = { ...cleanEnv(fakeBin), FAKE_CODEX_REVIEW: review, FAKE_CODEX_SLEEP: '20' };
    const runner = createRunner('codex-cli');
    const pending = runner.run({ promptFile, outFile: path.join(TMP, 'cancel', 'o.md'), timeoutMs: 60_000, cwd: ROOT, gate: 'review', env, binDir: gstackBin });
    await Bun.sleep(400);
    runner.cancel();
    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(result.wall_s).toBeLessThan(15);
  });

  test('missing codex with no fallback is refused as missing coverage; with --fallback it says "codex-cli unavailable; using api"', () => {
    const none = run(['run', '--runner', 'codex-cli', '--prompt', promptFile, '--out', path.join(TMP, 'nf.md')], cleanEnv(emptyBin));
    expect(none.status).toBe(3);
    expect(none.stderr).toMatch(/\(OUTSIDE_RUNNER_UNAVAILABLE\)$/m);
    expect(none.stderr).toContain('Missing coverage');
    const choice = selectRunner('codex-cli', { env: cleanEnv(emptyBin), model: 'gpt-5.4' }, 'api');
    expect(choice).toEqual({ runner: null, reason: expect.stringContaining('api unavailable (OPENAI_API_KEY is not set)') });
    const withKey = selectRunner('codex-cli', { env: { ...cleanEnv(emptyBin), OPENAI_API_KEY: 'sk-test' }, model: 'gpt-5.4' }, 'api');
    expect(withKey).toEqual({ runner: 'api', note: 'codex-cli unavailable; using api' });
  });
});

describe('api runner (supplied-input review)', () => {
  let server: ReturnType<typeof Bun.serve>;
  const seen: Array<{ url: string; auth: string | null; body: any }> = [];
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = await req.json();
        seen.push({ url: url.pathname, auth: req.headers.get('authorization') ?? req.headers.get('x-api-key'), body });
        if (url.pathname === '/v1/chat/completions') {
          if (body.model === 'gpt-broken') return new Response(JSON.stringify({ error: { message: 'insufficient_quota' } }), { status: 429 });
          return Response.json({ model: body.model + '-2026-10', choices: [{ message: { content: REVIEW } }], usage: { prompt_tokens: 900, completion_tokens: 210 } });
        }
        if (url.pathname === '/v1/messages') return Response.json({ model: body.model, content: [{ type: 'text', text: REVIEW }], usage: { input_tokens: 800, output_tokens: 150 } });
        return new Response('not found', { status: 404 });
      },
    });
  });
  afterAll(() => server.stop(true));

  test('openai: posts the prompt bytes, labels the record supplied-input, records the actual model and tokens', async () => {
    const env = { ...cleanEnv(emptyBin), OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1` };
    const out = path.join(TMP, 'api-out', 'ceo-outside.md');
    const r = await runAsync(['run', '--runner', 'api', '--prompt', promptFile, '--out', out, '--model', 'openai/gpt-6-astra', '--native-model', 'claude-opus-4-7', '--json'], env);
    expect(r.status, r.stderr).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result).toMatchObject({ runner: 'api', status: 'completed', model: 'gpt-6-astra-2026-10', family: 'openai', usage: { input_tokens: 900, output_tokens: 210, usd: 'unknown' } });
    expect(result.capabilities).toEqual({ repository_access: 'none', executes_here: true, label: 'supplied-input review' });
    expect(fs.readFileSync(out, 'utf8')).toBe(REVIEW);
    const call = seen.find(s => s.url === '/v1/chat/completions')!;
    expect(call.auth).toBe('Bearer sk-test');
    expect(call.body.messages[0].content).toBe(fs.readFileSync(promptFile, 'utf8'));
    expect(call.body.model).toBe('gpt-6-astra');
    const plain = await runAsync(['run', '--runner', 'api', '--prompt', promptFile, '--out', path.join(TMP, 'api-out', 'plain.md'), '--model', 'gpt-5.4'], env);
    expect(plain.stdout).toContain('OUTSIDE_STATUS: completed provider=api model=gpt-5.4-2026-10 family=openai label=supplied-input-review');
    expect(fs.existsSync(path.join(TMP, 'state', 'security', 'egress.jsonl'))).toBe(true);
  });

  test('anthropic: uses x-api-key and the messages endpoint', async () => {
    const env = { ...cleanEnv(emptyBin), ANTHROPIC_API_KEY: 'ak-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` };
    const r = await runAsync(['run', '--runner', 'api', '--prompt', promptFile, '--out', path.join(TMP, 'api-out', 'native.md'), '--model', 'claude-sonnet-5', '--json'], env);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'completed', model: 'claude-sonnet-5', family: 'anthropic', usage: { input_tokens: 800, output_tokens: 150 } });
    expect(seen.find(s => s.url === '/v1/messages')!.auth).toBe('ak-test');
  });

  test('a provider error is a failed terminal result (exit 1), never a completed voice; a missing key is unavailable (exit 3)', async () => {
    const env = { ...cleanEnv(emptyBin), OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1` };
    const r = await runAsync(['run', '--runner', 'api', '--prompt', promptFile, '--out', path.join(TMP, 'api-out', 'broken.md'), '--model', 'gpt-broken'], env);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('OUTSIDE_STATUS: failed provider=api');
    expect(JSON.parse(fs.readFileSync(path.join(TMP, 'api-out', 'broken.md.meta.json'), 'utf8'))).toMatchObject({ status: 'failed', reason: 'provider_error' });
    const nokey = run(['run', '--runner', 'api', '--prompt', promptFile, '--out', path.join(TMP, 'api-out', 'nokey.md'), '--model', 'gpt-5.4'], cleanEnv(emptyBin));
    expect(nokey.status).toBe(3);
    expect(nokey.stderr).toMatch(/OPENAI_API_KEY is not set.*\(OUTSIDE_RUNNER_UNAVAILABLE\)$/m);
  });
});

describe('api runner output limits (GBRA-223 claim 6)', () => {
  let server: ReturnType<typeof Bun.serve>;
  const bodies: Array<{ url: string; body: any }> = [];
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = await req.json();
        bodies.push({ url: url.pathname, body });
        const cut = String(body.model).includes('cut');
        if (url.pathname === '/v1/messages') return Response.json({ model: body.model, stop_reason: cut ? 'max_tokens' : 'end_turn', content: [{ type: 'text', text: cut ? 'INPUT: ceo abc\n\nA long review cut off mid-sent' : REVIEW }], usage: { input_tokens: 10, output_tokens: body.max_tokens } });
        return Response.json({ model: body.model, choices: [{ finish_reason: cut ? 'length' : 'stop', message: { content: cut ? 'INPUT: ceo abc\n\nA long review cut off' : REVIEW } }], usage: { prompt_tokens: 10, completion_tokens: 50 } });
      },
    });
  });
  afterAll(() => server.stop(true));
  const anthropic = () => ({ ...cleanEnv(emptyBin), ANTHROPIC_API_KEY: 'ak-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` });
  const openai = () => ({ ...cleanEnv(emptyBin), OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1` });
  const out = (name: string) => path.join(TMP, 'limits', name);

  test('anthropic asks for 16384 output tokens by default and --max-tokens sets it; openai sends max_completion_tokens only when set', async () => {
    expect((await runAsync(['run', '--runner', 'api', '--prompt', promptFile, '--out', out('a1.md'), '--model', 'claude-opus-5-5'], anthropic())).status).toBe(0);
    expect((await runAsync(['run', '--runner', 'api', '--prompt', promptFile, '--out', out('a2.md'), '--model', 'claude-opus-5-5', '--max-tokens', '4000'], anthropic())).status).toBe(0);
    expect(bodies.filter(b => b.url === '/v1/messages').map(b => b.body.max_tokens)).toEqual([16384, 4000]);
    expect((await runAsync(['run', '--runner', 'api', '--prompt', promptFile, '--out', out('o1.md'), '--model', 'gpt-6-astra'], openai())).status).toBe(0);
    expect((await runAsync(['run', '--runner', 'api', '--prompt', promptFile, '--out', out('o2.md'), '--model', 'gpt-6-astra', '--max-tokens', '4000'], openai())).status).toBe(0);
    expect(bodies.filter(b => b.url === '/v1/chat/completions').map(b => b.body.max_completion_tokens ?? null)).toEqual([null, 4000]);
  });

  test('a response stopped at the output limit is truncated (exit 1), never a completed or missing-markers review', async () => {
    for (const [model, env, tokens] of [['claude-cut', anthropic(), '16384'], ['gpt-cut', openai(), '50']] as const) {
      const file = out(`${model}.md`);
      const r = await runAsync(['run', '--runner', 'api', '--prompt', promptFile, '--out', file, '--model', model], env);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/api unavailable \(truncated\): .*output limit/);
      const meta = JSON.parse(fs.readFileSync(`${file}.meta.json`, 'utf8'));
      expect(meta).toMatchObject({ status: 'unavailable', reason: 'truncated' });
      expect(meta.detail).toContain(tokens);
    }
  });
});
