/**
 * Field list 2, W8: `gstack-eval-plan prereg --check` runs a preregistration's
 * declared summarizer on its declared synthetic fixture (only with
 * --allow-repo-commands) and fails PREREG_DIAGNOSTIC_UNTESTED when a count
 * differs from its preregistered definition, before the freeze commit. The D7
 * shape (gbrain-evals #162): two diagnostic counts that did not match.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkPrereg, parsePreregDiagnostics, preregTemplate } from '../lib/eval-plan';
import { capyHost, type CapyHost } from './helpers/capy-host';

const BIN = path.resolve(import.meta.dir, '..', 'bin', 'gstack-eval-plan');
const FILLED = ['Bars', 'Arms', 'Decoys', 'Stop rules', 'Held-out exposure'].map(s => `## ${s}\n- filled in\n`).join('\n') + '\n## Comparison\nstack: none\nwhy: one arm, no skill stack\n';
const SUMMARIZER = [
  'touch ran.marker',
  'r=$(grep -c \'"kind":"refusal"\' "$1")',
  't=$(grep -c \'"kind":"truncated"\' "$1")',
  'echo "summarizing $1"',
  'printf \'{"refusals":%s,"truncated":%s}\\n\' "$r" "$t"',
].join('\n') + '\n';
const RECORDS = ['refusal', 'refusal', 'truncated', 'answer'].map(kind => JSON.stringify({ kind })).join('\n') + '\n';

function diagnostics(rows: Array<[string, string]>, o: { summarizer?: string; fixture?: string } = {}): string {
  return `\n## Diagnostics\nsummarizer: ${o.summarizer ?? '`sh summarize.sh {fixture}`'}\nfixture: ${o.fixture ?? 'fixtures/synthetic records.jsonl'}\n\n| diagnostic | expected |\n|---|---|\n${rows.map(([n, c]) => `| ${n} | ${c} |`).join('\n')}\n`;
}

let host: CapyHost;
let repo: string;
beforeEach(() => {
  host = capyHost();
  repo = path.join(host.base, 'repo');
  fs.mkdirSync(path.join(repo, 'fixtures'), { recursive: true });
  const init = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: host.env, encoding: 'utf8', timeout: 30_000 });
  if (init.status !== 0) throw new Error(init.stderr);
  fs.writeFileSync(path.join(repo, 'summarize.sh'), SUMMARIZER);
  fs.writeFileSync(path.join(repo, 'fixtures', 'synthetic records.jsonl'), RECORDS);
  fs.mkdirSync(path.join(repo, 'evals'));
});
afterEach(() => host.cleanup());

function check(text: string, ...flags: string[]) {
  const file = path.join(repo, 'evals', 'prereg.md');
  fs.writeFileSync(file, text);
  const r = spawnSync(BIN, ['prereg', '--check', file, ...flags], { cwd: host.base, env: host.env, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', ran: fs.existsSync(path.join(repo, 'ran.marker')) };
}

describe('prereg --check: the Diagnostics section', () => {
  test('the declared summarizer is listed, not run, without --allow-repo-commands (exit 3)', () => {
    const r = check(FILLED + diagnostics([['refusals', '2'], ['truncated', '1']]));
    expect(r.code).toBe(3);
    expect(r.ran).toBe(false);
    expect(r.out).toContain('PREREG: ok present=6/6 stack=none diagnostics=2 file=');
    expect(r.out).toContain(`PREREG_COMMAND: summarizer="sh summarize.sh {fixture}" fixture=fixtures/synthetic records.jsonl cwd=${fs.realpathSync(repo)}`);
    expect(r.err).toContain('(REPO_COMMANDS_NOT_ALLOWED)');
    expect(r.out).not.toContain('PREREG_DIAGNOSTICS:');
  });

  test('with --allow-repo-commands, matching counts pass and bind the fixture by sha256; the path reaches the command quoted', () => {
    const r = check(FILLED + diagnostics([['refusals', '2'], ['truncated', '1']]), '--allow-repo-commands');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.ran).toBe(true);
    const sha = createHash('sha256').update(RECORDS).digest('hex').slice(0, 12);
    expect(r.out).toContain('PREREG_DIAGNOSTIC: refusals expected=2 got=2 ok\nPREREG_DIAGNOSTIC: truncated expected=1 got=1 ok\n');
    expect(r.out).toContain(`PREREG_DIAGNOSTICS: ok n=2 fixture=fixtures/synthetic records.jsonl sha256=${sha}\n`);
  });

  test('the D7 shape: two counts off their definitions, a declared count the summarizer never reports and an undeclared one all fail PREREG_DIAGNOSTIC_UNTESTED', () => {
    const r = check(FILLED + diagnostics([['refusals', '3'], ['truncated', '0'], ['empty_answers', '0']]), '--allow-repo-commands');
    expect(r.code).toBe(1);
    expect(r.out).toContain('PREREG_DIAGNOSTIC: refusals expected=3 got=2 mismatch');
    expect(r.out).toContain('PREREG_DIAGNOSTIC: truncated expected=0 got=1 mismatch');
    expect(r.out).toContain('PREREG_DIAGNOSTIC: empty_answers expected=0 got=none missing');
    expect(r.out).toContain('PREREG_DIAGNOSTICS: untested n=3');
    expect(r.err).toContain('refusals mismatch (expected 3, got 2); truncated mismatch (expected 0, got 1); empty_answers missing (expected 0, got none)');
    expect(r.err.trim()).toEndWith('(PREREG_DIAGNOSTIC_UNTESTED)');
    const undeclared = check(FILLED + diagnostics([['refusals', '2']]), '--allow-repo-commands');
    expect(undeclared.code).toBe(1);
    expect(undeclared.out).toContain('PREREG_DIAGNOSTIC: truncated expected=undeclared got=1 undeclared');
    expect(undeclared.err).toContain('(PREREG_DIAGNOSTIC_UNTESTED)');
  });

  test('a failing summarizer, non-JSON output and a missing fixture are untested, never passed', () => {
    fs.writeFileSync(path.join(repo, 'fail.sh'), 'echo "boom: no such column" >&2\nexit 2\n');
    const failed = check(FILLED + diagnostics([['refusals', '2']], { summarizer: 'sh fail.sh {fixture}' }), '--allow-repo-commands');
    expect(failed.code).toBe(1);
    expect(failed.out).toContain('PREREG_DIAGNOSTICS: untested n=0');
    expect(failed.err).toContain('summarizer exited 2: boom: no such column');
    const prose = check(FILLED + diagnostics([['refusals', '2']], { summarizer: 'echo refusals=2 {fixture}' }), '--allow-repo-commands');
    expect(prose.code).toBe(1);
    expect(prose.err).toContain('not a JSON object of diagnostic counts');
    const missing = check(FILLED + diagnostics([['refusals', '2']], { fixture: 'fixtures/nope.jsonl' }), '--allow-repo-commands');
    expect(missing.code).toBe(1);
    expect(missing.ran).toBe(false);
    expect(missing.err).toContain('declared fixture fixtures/nope.jsonl is not a file');
  });

  test('an incomplete declaration is PREREG_INCOMPLETE and never runs, even with --allow-repo-commands', () => {
    const r = check(FILLED + diagnostics([['refusals', 'two']], { summarizer: 'sh summarize.sh fixtures/x.jsonl' }), '--allow-repo-commands');
    expect(r.code).toBe(1);
    expect(r.ran).toBe(false);
    expect(r.out).toContain('PREREG: incomplete present=6/6 stack=none diagnostics=invalid');
    expect(r.err).toContain('diagnostics: row "| refusals | two |"');
    expect(r.err).toContain('diagnostics: the summarizer command never names the fixture ({fixture})');
    expect(r.err).toContain('diagnostics: no | diagnostic | expected | rows');
    expect(r.err.trim()).toEndWith('(PREREG_INCOMPLETE)');
  });

  test('without a Diagnostics section the check is unchanged; the template mentions the section without adding a heading', () => {
    const r = check(FILLED);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`PREREG: ok present=6/6 stack=none file=${path.join(repo, 'evals', 'prereg.md')}\n`);
    expect(parsePreregDiagnostics(FILLED)).toBeNull();
    expect(parsePreregDiagnostics(FILLED + '\n## Diagnostics\n<!-- none -->\n')).toBeNull();
    expect(preregTemplate()).toContain('## Diagnostics');
    expect(checkPrereg(preregTemplate()).diagnostics).toBeNull();
  });
});
