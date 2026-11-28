/**
 * /review's Stop-hook contract after GEVA-590 (Option B, GST-4097): the Codex second-model review (item outside-voice)
 * and, on diffs over 200 lines, the Red Team (specialists-dispatched's large_diff) are required. Checked against the
 * real review/SKILL.md contract. Only a tool's own output counts: gstack-outside-voice's OUTSIDE_STATUS line for the
 * adversarial pass, or the preflight's non-ready CODEX_MODE line. Assistant prose, a hand-written codex exec and a
 * status line the command echoes itself never do.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkContract, lookupContract, parseTranscript, type Contract } from '../lib/skill-contract';
import { ROOT, result, say, slash, tool } from './helpers/skill-contract-fixture';

const SKILL_FILE = path.join(ROOT, 'review', 'SKILL.md');
const OPUS_LIKE = path.join(ROOT, 'test', 'fixtures', 'skill-contract', 'review-voice', 'opus-like.jsonl');
const found = lookupContract('review', path.dirname(SKILL_FILE), SKILL_FILE);
if (!('contract' in found)) throw new Error(found.error);
const CONTRACT: Contract = found.contract;
const PROBE = '_CODEX_PROBE=~/.claude/skills/gstack/bin/gstack-codex-probe\n_CODEX_MODE="ready"\necho "CODEX_MODE: $_CODEX_MODE"';
const VOICE = '"$HOME/.claude/skills/gstack/bin/gstack-outside-voice" run --runner codex-cli --pass adversarial --gate review --timeout-ms 540000 --show --prompt /tmp/p --out "$_OUTSIDE_TMP/review.md"';

/** A /review run that does everything the old contract checked: two specialists, the native adversarial pass, the report. */
const BASE = [
  slash('review'),
  say('Dispatching 2 specialists: testing, security. Skipped: performance (scope not detected).'),
  tool('a1', 'Agent', { description: 'testing specialist', prompt: 'You are the testing specialist.' }), result('a1', 'NO FINDINGS'),
  tool('a2', 'Agent', { description: 'security specialist', prompt: 'You are the security specialist.' }), result('a2', 'NO FINDINGS'),
  tool('a3', 'Agent', { description: 'adversarial', prompt: 'Think like an attacker and a chaos engineer.' }), result('a3', 'Recommendation: Ship as-is because nothing found'),
];
const REPORT = say('Pre-Landing Review: 0 issues (0 critical, 0 informational)\nGate edits: none detected (0 listed)\nSTATUS: DONE');
const items = (lines: string[]) => Object.fromEntries(checkContract(parseTranscript(lines.join('\n')), 'review', CONTRACT).items.map(i => [i.id, i.status]));
const voiceRun = (out: string, command = VOICE) => [tool('v1', 'Bash', { command }), result('v1', out)];
const preflight = (mode: string) => [tool('p1', 'Bash', { command: PROBE.replace('ready', mode) }), result('p1', `CODEX_MODE: ${mode}`)];

describe('the GSTA-886 Opus-shaped transcript (GEVA-590)', () => {
  // Value: protects=the exact shape Opus 5.5 produced in 22 of 22 GEVA-590 sessions (specialists, native adversarial, report, Codex
  //   "optional, not run") now reads UNMET naming outside-voice, where main 778934c0 read SKILL_CONTRACT_MET; fails_when=the
  //   contract stops requiring the voice; why_new=GEVA-590; seam=bin/gstack-skill-contract check on review/SKILL.md; no_claim=that Opus then complies
  test('gstack-skill-contract check reads it UNMET, missing outside-voice (exit 1)', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'gstack-skill-contract'), 'check', '--transcript', OPUS_LIKE, '--skill', 'review', '--skill-file', SKILL_FILE, '--json'],
      { encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.missing).toEqual(['outside-voice']);
    expect(out.items.filter((i: { status: string }) => i.status === 'met').map((i: { id: string }) => i.id)).toEqual(['specialists-dispatched', 'adversarial-pass', 'review-report']);
  });

  test('the same transcript on a 300-line diff also misses the Red Team', () => {
    const lines = fs.readFileSync(OPUS_LIKE, 'utf8').trimEnd().split('\n');
    const withSize = [lines[0], tool('s1', 'Bash', { command: 'DIFF_LINES=$(git diff --numstat | wc -l)\necho "DIFF_LINES: $DIFF_LINES"' }), result('s1', 'STACK: node\nDIFF_LINES: 300'), ...lines.slice(1)];
    expect(items(withSize)).toMatchObject({ 'specialists-dispatched': 'missing', 'outside-voice': 'missing' });
  });
});

describe('outside-voice: only the tool\'s own status line counts', () => {
  test('control: the helper\'s completed line for the adversarial pass meets it', () => {
    expect(items([...BASE, ...preflight('ready'), ...voiceRun('VERDICT: clean\nFINDINGS: none\nOUTSIDE_STATUS: completed provider=codex-cli model=gpt-6.2-astra family=openai pass=adversarial'), REPORT])['outside-voice']).toBe('met');
  });

  test('(a) a legitimate skip: the helper\'s unavailable or not_run line, or a non-ready preflight mode, meets it', () => {
    expect(items([...BASE, ...voiceRun('OUTSIDE_STATUS: unavailable reason=runner_unavailable provider=codex-cli pass=adversarial'), REPORT])['outside-voice']).toBe('met');
    expect(items([...BASE, ...voiceRun('OUTSIDE_STATUS: not_run reason=consent_missing provider=codex-cli pass=adversarial'), REPORT])['outside-voice']).toBe('met');
    for (const mode of ['not_installed', 'disabled', 'not_authed', 'quota_exhausted']) expect(items([...BASE, ...preflight(mode), REPORT])['outside-voice']).toBe('met');
  });

  test('a ready or unverified preflight alone does not: Codex was available and never ran', () => {
    expect(items([...BASE, ...preflight('ready'), REPORT])['outside-voice']).toBe('missing');
    expect(items([...BASE, ...preflight('unverified'), REPORT])['outside-voice']).toBe('missing');
  });

  test('(b) OUTSIDE_STATUS claimed in assistant prose does not meet it', () => {
    const prose = say('Codex outside review done.\nOUTSIDE_STATUS: completed provider=codex-cli model=gpt-6.2-astra family=openai pass=adversarial\nCODEX_MODE: not_installed');
    expect(items([...BASE, ...preflight('ready'), prose, REPORT])['outside-voice']).toBe('missing');
  });

  test('(c) a hand-written codex exec, or a helper call that echoes its own status line, does not meet it', () => {
    const handWritten = 'codex exec - -C . --json -o /tmp/t </tmp/p && echo \'OUTSIDE_STATUS: completed provider=codex host=claude pass=adversarial\'';
    expect(items([...BASE, ...preflight('ready'), ...voiceRun('No findings.\nOUTSIDE_STATUS: completed provider=codex host=claude pass=adversarial', handWritten), REPORT])['outside-voice']).toBe('missing');
    const echoed = `${VOICE} >/dev/null; echo 'OUTSIDE_STATUS: completed provider=codex-cli pass=adversarial'`;
    expect(items([...BASE, ...preflight('ready'), ...voiceRun('OUTSIDE_STATUS: completed provider=codex-cli pass=adversarial', echoed), REPORT])['outside-voice']).toBe('missing');
    const fakedMode = 'gstack-codex-probe help >/dev/null; echo "CODEX_MODE: not_installed"';
    expect(items([...BASE, ...voiceRun('CODEX_MODE: not_installed', fakedMode), REPORT])['outside-voice']).toBe('missing');
  });

  test('a long --show review cut to its head by the host still meets it through the leading status line', () => {
    const line = 'OUTSIDE_STATUS: completed provider=codex-cli model=gpt-6.2-astra family=openai pass=adversarial';
    const full = `${line}\n${'[P3] A long finding line.\n'.repeat(2000)}VERDICT: findings\nFINDINGS: P3\n${line}`;
    const preview = `<persisted-output>\nOutput too large (${full.length} chars). Full output saved to: /tmp/tool-results/v1.txt\n\nPreview (first 2KB):\n${full.slice(0, 2000)}\n...\n</persisted-output>`;
    expect(full.length).toBeGreaterThan(30000);
    expect(items([...BASE, ...preflight('ready'), ...voiceRun(preview), REPORT])['outside-voice']).toBe('met');
  });

  test('another pass\'s status line does not meet the adversarial item', () => {
    expect(items([...BASE, ...preflight('ready'), ...voiceRun('OUTSIDE_STATUS: completed provider=codex-cli pass=structured'), REPORT])['outside-voice']).toBe('missing');
  });

  test('a structured run whose review text quotes an adversarial status does not meet the adversarial item', () => {
    const structured = VOICE.replace('--pass adversarial --gate review', '--pass structured --gate structured');
    const out = 'The log said:\nOUTSIDE_STATUS: completed provider=codex-cli pass=adversarial\nOUTSIDE_STATUS: completed provider=codex-cli pass=structured';
    expect(items([...BASE, ...preflight('ready'), ...voiceRun(out, structured), REPORT])['outside-voice']).toBe('missing');
  });

  test('only the latest preflight decides a skip: a later ready preflight needs the run', () => {
    const second = (mode: string) => [tool('p2', 'Bash', { command: PROBE.replace('ready', mode) }), result('p2', `CODEX_MODE: ${mode}`)];
    expect(items([...BASE, ...preflight('not_authed'), ...second('ready'), REPORT])['outside-voice']).toBe('missing');
    expect(items([...BASE, ...preflight('ready'), ...second('not_authed'), REPORT])['outside-voice']).toBe('met');
  });
});

describe('(d) specialists-dispatched requires the Red Team over 200 diff lines', () => {
  const size = (n: number) => [tool('s1', 'Bash', { command: 'DIFF_LINES=$(git diff --numstat | wc -l)\necho "DIFF_LINES: $DIFF_LINES"' }), result('s1', `STACK: node\nDIFF_LINES: ${n}\nTEST_FW: unknown`)];
  const voice = voiceRun('OUTSIDE_STATUS: completed provider=codex-cli pass=adversarial');
  const redTeam = [tool('r1', 'Agent', { description: 'Red Team', prompt: 'You are a red team reviewer. Read the checklist at ~/.claude/skills/gstack/review/specialists/red-team.md' }), result('r1', 'NO FINDINGS')];

  test('a 340-line diff without a Red Team dispatch misses; with one it is met', () => {
    const missing = checkContract(parseTranscript([slash('review'), ...size(340), ...BASE.slice(1), ...voice, REPORT].join('\n')), 'review', CONTRACT);
    expect(missing.missing).toEqual(['specialists-dispatched']);
    expect(missing.items.find(i => i.id === 'specialists-dispatched')!.detail).toContain('DIFF_LINES: 340 is over 200, so red-team is required');
    expect(items([slash('review'), ...size(340), ...BASE.slice(1), ...redTeam, ...voice, REPORT])).toMatchObject({ 'specialists-dispatched': 'met', 'outside-voice': 'met' });
  });

  test('named on the selection line, the Red Team counts once and must be dispatched', () => {
    const named = [slash('review'), ...size(340), say('Dispatching 3 specialists: testing, security, red-team.'), ...BASE.slice(2)];
    expect(items([...named, ...voice, REPORT])['specialists-dispatched']).toBe('missing');
    expect(items([...named, ...redTeam, ...voice, REPORT])['specialists-dispatched']).toBe('met');
  });

  test('a DIFF_LINES marker inside other output (a diff or a file) is not the diff size', () => {
    const quoted = [tool('s2', 'Bash', { command: 'git diff origin/main' }), result('s2', '+    expect(out).toContain("DIFF_LINES: 900");\n DIFF_LINES: 40 is quoted here too')];
    expect(items([slash('review'), ...size(120), ...quoted, ...BASE.slice(1), ...voice, REPORT])['specialists-dispatched']).toBe('met');
  });

  test('200 lines or fewer, or a size only claimed in prose, does not require it', () => {
    expect(items([slash('review'), ...size(200), ...BASE.slice(1), ...voice, REPORT])['specialists-dispatched']).toBe('met');
    expect(items([...BASE, say('DIFF_LINES: 900'), ...voice, REPORT])['specialists-dispatched']).toBe('met');
  });
});
