/**
 * outsideVoiceFailurePolicy + ratchet (d).
 *
 * The auth / timeout / empty-response bullets that follow every outside-voice
 * invocation used to be hand-typed at four call sites in review.ts and
 * design.ts, and they drifted ("auth failed" vs "authentication failed", a
 * missing "API key" trigger, differing fallback wording). One owner now
 * renders them; the ratchet below keeps new copies from appearing.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALL_HOST_CONFIGS } from '../hosts/index';
import { outsideVoiceFailurePolicy, outsideVoiceFor, type OutsideVoiceFailurePolicyOptions } from '../scripts/resolvers/outside-voice';
import { generateAdversarialStep } from '../scripts/resolvers/outside-voice-steps';
import { gateOutcomeLine } from '../lib/gate-outcomes';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');
const ALLOWLIST = 'test/fixtures/outside-voice-failure-prose-allowlist.json';
const OWNER_FILE = 'scripts/resolvers/outside-voice.ts';

const ctxFor = (host: string, skillName = 'review'): TemplateContext =>
  ({ host, skillName, tmplPath: `${skillName}/SKILL.md.tmpl`, paths: HOST_PATHS[host] }) as TemplateContext;

const base: OutsideVoiceFailurePolicyOptions = {
  timeoutMinutes: 5, onTimeout: 'fallback', stderrOnEmpty: false, fallback: 'native', escape: 0,
};

describe('outsideVoiceFailurePolicy', () => {
  test('native fallback: every failure names the provider message and falls back to the native subagent', () => {
    expect(outsideVoiceFailurePolicy(ctxFor('claude'), base)).toBe([
      '- **Auth failure:** If stderr contains "auth", "login", "unauthorized", or "API key": "Codex authentication failed. Run `codex login` to authenticate." Fall back to the Claude subagent below.',
      '- **Timeout:** "Codex timed out after 5 minutes." Fall back to the Claude subagent below.',
      '- **Empty response:** "Codex returned no response." Fall back to the Claude subagent below.',
    ].join('\n'));
  });

  test('missing-coverage timeout, stderr on empty, no fallback, escaped backticks', () => {
    const out = outsideVoiceFailurePolicy(ctxFor('claude'), {
      timeoutMinutes: 9, onTimeout: 'missing-coverage', stderrOnEmpty: true, fallback: 'none', escape: 1,
    });
    expect(out).toContain('Run \\`codex login\\` to authenticate."\n');
    expect(out).toContain('- **Timeout:** "Codex timed out after 9 minutes and was terminated; this pass produced NO findings." A timed-out pass is MISSING COVERAGE, not a clean bill');
    expect(out).toContain('- **Empty response:** "Codex returned no response. Stderr: <paste relevant error>."');
    expect(out).not.toContain('Fall back');
  });

  test('the Codex harness names Claude Code and its login command', () => {
    const out = outsideVoiceFailurePolicy(ctxFor('codex'), base);
    expect(out).toContain('"Claude Code authentication failed. Run `claude auth login` to authenticate."');
    expect(out).toContain(`Fall back to the ${outsideVoiceFor(ctxFor('codex')).nativeLabel} subagent below.`);
  });
});

// ─── MISSING COVERAGE retention ────────────────────────────────────
// At 96764e80, exactly the adversarial step (review + ship, every host) told
// the agent that a timed-out outside pass is MISSING COVERAGE. The prose
// unification must not turn any of those into a silent timeout.
describe('timeout MISSING COVERAGE wording is retained', () => {
  const timeoutLine = (text: string) => text.split('\n').find((l) => l.startsWith('- **Timeout:**')) ?? '';

  test.each(ALL_HOST_CONFIGS.flatMap((h) => ['review', 'ship'].map((s) => [h.name, s])))(
    'adversarial step on %s /%s', (host, skill) => {
      expect(timeoutLine(generateAdversarialStep(ctxFor(host, skill)))).toContain('MISSING COVERAGE');
    });

  test.each(['review/sections/adversarial.md', 'ship/sections/adversarial.md'])('generated %s', (rel) => {
    expect(timeoutLine(fs.readFileSync(path.join(ROOT, rel), 'utf8'))).toContain('MISSING COVERAGE');
  });
});

// ─── Ratchet (d) ────────────────────────────────────────────────────
// Signature: every auth-failure, timeout and empty-response phrasing used by
// the hand-written copies at 96764e80 (review.ts:746-748, :904-906,
// :1171-1173; design.ts:855-857).
const SIGNATURE = [
  /authentication failed\. Run/,
  /\bauth failed\. Run/,
  /timed out after \d+ minutes/,
  /exceeded \d+ minutes and was terminated/,
  /returned no response/,
];

interface SourceFile { file: string; text: string }
interface AllowEntry { file: string; text: string; reason?: string }

function walk(dir: string, keep: (rel: string) => boolean, out: SourceFile[] = []): SourceFile[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    if (entry.isDirectory()) walk(full, keep, out);
    else if (keep(rel)) out.push({ file: rel, text: fs.readFileSync(full, 'utf8') });
  }
  return out;
}

function scannedFiles(): SourceFile[] {
  return walk(ROOT, (rel) => rel.endsWith('.tmpl') || (rel.startsWith('scripts/resolvers/') && rel.endsWith('.ts')));
}

/** Lines of the owner function itself are the one legitimate source. */
function ownerLines(text: string): Set<number> {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('export function outsideVoiceFailurePolicy('));
  const owned = new Set<number>();
  if (start < 0) return owned;
  for (let i = start; i < lines.length; i += 1) {
    owned.add(i);
    if (lines[i] === '}') break;
  }
  return owned;
}

export function scanFailureProse(files: SourceFile[], allowlist: AllowEntry[]): string[] {
  const problems: string[] = [];
  for (const entry of allowlist) {
    if (!entry.reason?.trim()) problems.push(`${ALLOWLIST}  entry for ${entry.file} has no reason: ${entry.text}`);
  }
  const used = new Set<AllowEntry>();
  for (const { file, text } of files) {
    const owned = file === OWNER_FILE ? ownerLines(text) : new Set<number>();
    text.split('\n').forEach((line, i) => {
      if (owned.has(i) || !SIGNATURE.some((re) => re.test(line))) return;
      const trimmed = line.trim();
      const allowed = allowlist.find((e) => e.file === file && e.text === trimmed);
      if (allowed) { used.add(allowed); return; }
      problems.push(`${file}:${i + 1}  ${trimmed.slice(0, 160)}`);
    });
  }
  for (const entry of allowlist) {
    if (!used.has(entry)) problems.push(`${ALLOWLIST}  stale entry matches nothing in ${entry.file}: ${entry.text}`);
  }
  return problems;
}

export function formatFailureProse(problems: string[]): string {
  return [
    'Outside-voice failure prose found outside outsideVoiceFailurePolicy (ratchet d):',
    ...problems.map((p) => `  ${p}`),
    'Rule: outside-voice auth/timeout/empty-response fallback bullets come only from outsideVoiceFailurePolicy(), so every skill falls back the same way instead of drifting.',
    `Fix: call outsideVoiceFailurePolicy(ctx, { timeoutMinutes, onTimeout, stderrOnEmpty, fallback, escape }) from ${OWNER_FILE} instead of writing the bullets by hand.`,
    `Allowlist: ${ALLOWLIST}. Add an entry (file, exact trimmed line, reason) only for prose that is not an outside-voice fallback, such as a skill's own direct CLI error handling.`,
  ].join('\n');
}

const readAllowlist = (): AllowEntry[] => JSON.parse(fs.readFileSync(path.join(ROOT, ALLOWLIST), 'utf8'));

describe('ratchet (d): outside-voice failure prose has one owner', () => {
  test('no resolver or template hand-writes the failure bullets', () => {
    const problems = scanFailureProse(scannedFiles(), readAllowlist());
    if (problems.length) throw new Error(formatFailureProse(problems));
  });

  test('the scan is not vacuous: it reaches the owner, the call sites and the allowlisted template', () => {
    const files = scannedFiles().map((f) => f.file);
    for (const rel of [OWNER_FILE, 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/design.ts', 'codex/SKILL.md.tmpl']) {
      expect(files).toContain(rel);
    }
  });

  test('a planted copy is reported with file:line, the fix and the allowlist path', () => {
    const planted = [
      { file: 'scripts/resolvers/planted.ts', text: 'const a = 1;\n- **Timeout:** "${label} exceeded 9 minutes and was terminated."\n' },
      { file: 'planted/SKILL.md.tmpl', text: '- Auth failure: "Codex auth failed. Run `codex login`."\n' },
    ];
    const problems = scanFailureProse(planted, []);
    expect(problems).toEqual([
      'scripts/resolvers/planted.ts:2  - **Timeout:** "${label} exceeded 9 minutes and was terminated."',
      'planted/SKILL.md.tmpl:1  - Auth failure: "Codex auth failed. Run `codex login`."',
    ]);
    const message = formatFailureProse(problems);
    expect(message).toContain('scripts/resolvers/planted.ts:2');
    expect(message).toContain('Fix: call outsideVoiceFailurePolicy(');
    expect(message).toContain(ALLOWLIST);
  });

  test('a copy pasted into the owner file outside the owner function is still reported', () => {
    const owner = scannedFiles().find((f) => f.file === OWNER_FILE)!;
    const text = `${owner.text}\nconst copy = '"Codex returned no response."';\n`;
    const problems = scanFailureProse([{ file: OWNER_FILE, text }], []);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith(`${OWNER_FILE}:`);
  });

  test('allowlist entries are keyed on file and text, so inserting a line above still passes', () => {
    const allowlist = readAllowlist();
    const files = scannedFiles().map((f) => (f.file === 'codex/SKILL.md.tmpl' ? { ...f, text: `inserted line\n${f.text}` } : f));
    expect(scanFailureProse(files, allowlist)).toEqual([]);
  });

  test('an allowlist entry without a reason fails', () => {
    const allowlist = readAllowlist().map((e, i) => (i === 0 ? { file: e.file, text: e.text } : e));
    const problems = scanFailureProse(scannedFiles(), allowlist);
    expect(problems).toEqual([`${ALLOWLIST}  entry for codex/SKILL.md.tmpl has no reason: ${allowlist[0].text}`]);
  });
});

describe('a 402 or quota stop is never reported as an auth failure', () => {
  test('the validator\'s budget line does not itself trip the auth rule\'s keywords', () => {
    const line = gateOutcomeLine('Codex outside review', 'budget_exhausted');
    expect(line).not.toMatch(/auth|login|unauthorized|API key/i);
    expect(line).toContain('HTTP 402');
  });

  test('the /codex skill\'s own error handling names the budget stop before its auth error', () => {
    const text = fs.readFileSync(path.join(ROOT, 'codex/SKILL.md'), 'utf8');
    const budget = text.indexOf('- **Budget or quota stop (HTTP 402, payment required, quota):**');
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(text.indexOf('- **Auth error:**'));
  });
});
