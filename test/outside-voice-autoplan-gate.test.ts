/**
 * GST-3051: an autoplan outside review run the DRIVER.md way (no --gate) is
 * judged by autoplan's own result contract, the INPUT receipt and the
 * gstack-findings fence (lib/autoplan-prompts.ts RESULT_FORMAT), never by the
 * /review gate's Recommendation line, so a review that ran is not labeled
 * unavailable (missing_markers). A reply without that contract, or an empty
 * one, still is. And --help never prints a line that starts like a real
 * OUTSIDE_STATUS or VERDICT result.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writePrompts } from '../lib/autoplan-prompts';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-outside-voice');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-autoplan-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const SHA = 'a'.repeat(64);
const snapshotPath = path.join(TMP, 'snapshot.md');
fs.writeFileSync(snapshotPath, '# Plan\n\n## Implementation plan\n\n- Add a flag.\n');
const prompts = writePrompts({ phase: 'ceo', snapshot: { nativePrompt: 'native\n', snapshotPath, sha256: SHA }, outDir: TMP, priorConsensus: [] });

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(OPENAI|ANTHROPIC)_/.test(k) && k !== 'GSTACK_OUTSIDE_RUNNER') env[k] = v;
env.GSTACK_STATE_ROOT = path.join(TMP, 'state');

function run(args: string[]) {
  return spawnSync('bun', [BIN, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
}
/** The DRIVER.md:29 form: host-subagent binding the reviewer's file, no --gate. */
function review(name: string, text: string, extra: string[] = [], prompt = prompts.outside) {
  const result = path.join(TMP, name + '.result.md');
  fs.writeFileSync(result, text);
  const out = path.join(TMP, name + '.out.md');
  const r = run(['run', '--runner', 'host-subagent', '--prompt', prompt, '--out', out, '--result', result, '--model', 'openai/gpt-6-astra', '--native-model', 'claude-opus-5-5', ...extra]);
  const meta = JSON.parse(fs.readFileSync(out + '.meta.json', 'utf8'));
  return { ...r, meta };
}
const fence = (rows: string[]) => '\x60\x60\x60gstack-findings\n' + rows.join('\n') + (rows.length ? '\n' : '') + '\x60\x60\x60\n';
const HIGH = '{"id":"F1","severity":"High","title":"The premise is unmeasured","fix":"Measure it first"}';
const MEDIUM = '{"id":"F2","severity":"Medium","title":"Name the flag plainly"}';
const receipt = 'INPUT: ceo ' + SHA + '\n\n';

describe('autoplan outside review without --gate', () => {
  test('a review that follows the RESULT FORMAT is completed with its findings, not missing_markers', () => {
    const r = review('high', receipt + 'The plan assumes demand it never measured.\n\n' + fence([HIGH, MEDIUM]));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('VERDICT: findings\nFINDINGS: P1\n');
    expect(r.stdout).toMatch(/^OUTSIDE_STATUS: completed provider=host-subagent model=openai\/gpt-6-astra family=openai/m);
    expect(r.meta.status).toBe('completed');
    expect(r.meta.verdict).toMatchObject({ execution: { state: 'ran' }, verdict: 'findings', findings: { highest: 'P1' } });
    expect(r.meta.reason).toBeUndefined();
  });

  test('an empty fence is a clean review; advisory-only findings are clean with their severity', () => {
    const none = review('none', receipt + 'Nothing to add.\n\n' + fence([]));
    expect(none.status, none.stderr).toBe(0);
    expect(none.stdout).toContain('VERDICT: clean\nFINDINGS: none\n');
    const medium = review('medium', receipt + 'One naming nit.\n\n' + fence([MEDIUM]));
    expect(medium.status, medium.stderr).toBe(0);
    expect(medium.stdout).toContain('VERDICT: clean\nFINDINGS: P2\n');
  });

  test('a reply without the fence or the INPUT receipt is still unavailable (missing_markers)', () => {
    for (const [name, text] of [['no-fence', receipt + 'High: the premise is unmeasured.\n'], ['no-receipt', 'Review follows.\n\n' + fence([HIGH])]] as const) {
      const r = review(name, text);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('VERDICT: unavailable\n');
      expect(r.meta).toMatchObject({ status: 'unavailable', reason: 'missing_markers' });
    }
  });

  test('an empty reply is still unavailable', () => {
    const r = review('empty', '');
    expect(r.status).toBe(1);
    expect(r.meta).toMatchObject({ status: 'unavailable', reason: 'empty_response' });
  });

  test('a malformed findings row is unavailable and names the row', () => {
    const r = review('bad-row', receipt + fence(['{"severity":"Huge","title":"x"}']));
    expect(r.status).toBe(1);
    expect(r.meta).toMatchObject({ status: 'unavailable', reason: 'missing_markers' });
    expect(r.meta.detail).toContain('findings row 1');
  });
});

describe('gate selection', () => {
  test('--gate autoplan applies the same contract to any prompt', () => {
    const plain = path.join(TMP, 'plain-prompt.md');
    fs.writeFileSync(plain, 'Review this plan.\n');
    const r = review('explicit', receipt + fence([HIGH]), ['--gate', 'autoplan'], plain);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('VERDICT: findings\nFINDINGS: P1\n');
  });

  test("a prompt without autoplan's RESULT FORMAT keeps the review gate", () => {
    const plain = path.join(TMP, 'review-prompt.md');
    fs.writeFileSync(plain, 'Review this diff.\n');
    const r = review('review-default', receipt + fence([HIGH]), [], plain);
    expect(r.status).toBe(1);
    expect(r.meta).toMatchObject({ status: 'unavailable', reason: 'missing_markers', detail: 'missing review completion recommendation' });
  });
});

describe('--help', () => {
  test('no help line starts like a real result line', () => {
    for (const r of [run(['--help']), run([]), run(['run'])]) {
      const text = r.stdout + r.stderr;
      expect(text).toContain('consent_missing');
      expect(text.split('\n').filter(line => /^(?:OUTSIDE_STATUS|VERDICT):/.test(line))).toEqual([]);
    }
  });
});
