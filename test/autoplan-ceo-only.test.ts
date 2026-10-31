import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseResult } from '../lib/headless-artifacts';
import { CEO_REVIEW_HEADINGS, ceoOnlyEvidence, listFiles } from './helpers/autoplan-ceo-only-evidence';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const handoff = (...args: string[]) => spawnSync('bash', [path.join(ROOT, 'bin/gstack-ceo-mode-handoff'), ...args], { encoding: 'utf8', timeout: 10_000 });

describe('/autoplan --ceo-only skill text', () => {
  const skill = read('autoplan/SKILL.md');
  const section = read('autoplan/sections/ceo-only.md');

  test('the section index routes --ceo-only to its section before any preamble block', () => {
    expect(skill).toContain('| the invocation names `--ceo-only` (read before any preamble instruction block) | `sections/ceo-only.md` |');
  });

  test('the section forbids every question channel and names the skipped offers', () => {
    for (const s of ['Never call AskUserQuestion (native or `mcp__*`) or\nExitPlanMode', 'never ask the user in prose', 'never wait for a reply',
      'office-hours and BENEFITS_FROM', "0E's question", 'Next Steps chaining and CEO plan\npromotion', '**Never applied:** a user challenge'])
      expect(section).toContain(s);
  });

  test('the section runs CEO only, honors --no-outside and the state root, and ends status=reviewed', () => {
    expect(section).toContain('Run Phases 0, 0.5 and 1 only');
    expect(section).toContain("`outside_status: disabled (--no-outside)`");
    expect(section).toContain('`GSTACK_STATE_ROOT`\n(the override');
    expect(section).toContain('gstack-ceo-mode-handoff "<mode>" --ceo-only');
    expect(section).toContain('`GSTACK_RESULT: skill=autoplan status=reviewed run=<absolute $_AP>`');
    for (const h of CEO_REVIEW_HEADINGS) expect(section.replace(/\`\n\`/g, '` `').replace(/\n/g, ' ')).toContain(h.replace(/\n/g, ' '));
  });
});

test('a normal /autoplan run never reads sections/ceo-only.md (the parity raise in carve-guards.ts rests on it)', () => {
  const skill = read('autoplan/SKILL.md');
  expect(skill.split('ceo-only.md').length - 1).toBe(1);
  expect(skill).toContain('| the invocation names `--ceo-only` (read before any preamble instruction block) | `sections/ceo-only.md` |');
  const others = fs.readdirSync(path.join(ROOT, 'autoplan/sections')).filter(f => f.endsWith('.md') && f !== 'ceo-only.md')
    .map(f => `autoplan/sections/${f}`);
  const runner = ['bin/gstack-autoplan', 'autoplan/DRIVER.md', ...fs.readdirSync(path.join(ROOT, 'lib')).filter(f => f.startsWith('autoplan-')).map(f => `lib/${f}`)];
  for (const rel of [...others, ...runner]) expect(read(rel), rel).not.toContain('ceo-only.md');
});

describe('gstack-ceo-mode-handoff --ceo-only', () => {
  test('names the CEO-only rule, not a saved preference', () => {
    const r = handoff('SELECTIVE_EXPANSION', '--ceo-only');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("Auto-selected review mode → SELECTIVE EXPANSION (CEO-only run: Step 0E's rule). Approved decisions: none.");
  });
  test('refuses --auto with --ceo-only', () => {
    const r = handoff('HOLD SCOPE', '--auto', '--ceo-only');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--auto and --ceo-only conflict');
  });
});

test('GSTACK_RESULT parses status=reviewed', () => {
  expect(parseResult('x\nGSTACK_RESULT: skill=autoplan status=reviewed run=/r')).toEqual({ skill: 'autoplan', status: 'reviewed', run: '/r' });
});

describe('ceo-only evidence: a passing run and each negative control', () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-only-evidence-'));
  const review = ['# CEO-only review: Pricing tier', '', 'Mode: HOLD SCOPE (ceo-only). Not approved.', '',
    '## User challenges (direction kept)', 'None.', '## Scope added', 'None.', '## Conservative choices', 'None.',
    '## Findings', '- High: the premise was never checked with developers; interview them first.',
    '## Decision Audit Trail', '| # | Phase | Decision |', '|---|---|---|', '| 1 | CEO | Mode HOLD SCOPE |', ''].join('\n');
  fs.writeFileSync(path.join(runDir, 'ceo-review.md'), review);
  const assistant = (...content: any[]) => ({ type: 'assistant', message: { content } });
  const user = (...content: any[]) => ({ type: 'user', message: { content } });
  const good = [
    assistant({ type: 'tool_use', id: 't1', name: 'Bash', input: { command: '~/.claude/skills/gstack/bin/gstack-ceo-mode-handoff "HOLD SCOPE" --ceo-only --decisions "none"' } }),
    user({ type: 'tool_result', tool_use_id: 't1', content: "Auto-selected review mode → HOLD SCOPE (CEO-only run: Step 0E's rule). Approved decisions: none." }),
    assistant({ type: 'tool_use', id: 't2', name: 'Agent', input: { prompt: 'native CEO review' } }),
    assistant({ type: 'text', text: 'Phases 2, 2.5, 3 and 4 skipped (CEO-only run).' }),
  ];
  const output = `Review done.\nGSTACK_RESULT: skill=autoplan status=reviewed run=${runDir}`;
  const base = { transcript: good, output, strayWrites: [] as string[], mustMention: [/developer/i, /interview|talk|validat/i] };

  test('a complete run passes', () => {
    const e = ceoOnlyEvidence(base);
    expect(e.reasons).toEqual([]);
    expect(e.runDir).toBe(runDir);
  });
  const fails = (name: string, patch: Partial<typeof base>, reason: RegExp) => test(name, () => {
    const e = ceoOnlyEvidence({ ...base, ...patch });
    expect(e.passed).toBe(false);
    expect(e.reasons.join('\n')).toMatch(reason);
  });
  fails('an AskUserQuestion call fails', { transcript: [...good, assistant({ type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: {} })] }, /asked 1 question/);
  fails('an MCP AskUserQuestion variant fails', { transcript: [...good, assistant({ type: 'tool_use', id: 'q', name: 'mcp__conductor__AskUserQuestion', input: {} })] }, /asked 1 question/);
  fails('ExitPlanMode fails', { transcript: [...good, assistant({ type: 'tool_use', id: 'q', name: 'ExitPlanMode', input: {} })] }, /tool ExitPlanMode/);
  fails('a prose question fails', { output: `Which mode would you like me to use?\n${output}` }, /prose: Which mode would you like/);
  fails('a wrong terminal status fails', { output: output.replace('status=reviewed', 'status=gate_pending') }, /status=gate_pending, expected reviewed/);
  fails('a missing terminal line fails', { output: 'Review done.' }, /no GSTACK_RESULT line/);
  fails('headings without a review fail', { transcript: [assistant({ type: 'text', text: 'Done.' })] }, /no gstack-ceo-mode-handoff[\s\S]*no CEO reviewer subagent/);
  fails('loading a skipped phase fails', { transcript: [...good, assistant({ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: '/h/.claude/skills/gstack/autoplan/sections/eng-phase.md' } })] }, /loaded a skipped phase/);
  fails('a write outside its roots fails', { strayWrites: ['.config/x.json'] }, /wrote 1 file\(s\) outside its roots, under \.config\/x\.json/);
  fails('a review that misses the seeded flaw fails', { mustMention: [/churn/i] }, /never names the seeded flaw/);
  test('a missing ceo-review.md fails', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-only-empty-'));
    const e = ceoOnlyEvidence({ ...base, output: `GSTACK_RESULT: skill=autoplan status=reviewed run=${empty}` });
    expect(e.reasons.join('\n')).toContain('ceo-review.md is missing');
  });
  test('listFiles skips the declared roots', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-only-home-'));
    fs.mkdirSync(path.join(home, 'state'));
    fs.writeFileSync(path.join(home, 'state', 'a'), '');
    fs.writeFileSync(path.join(home, 'b'), '');
    fs.mkdirSync(path.join(home, '.bun', 'install', 'cache'), { recursive: true });
    fs.writeFileSync(path.join(home, '.bun', 'install', 'cache', 'c'), '');
    fs.mkdirSync(path.join(home, '.bun', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.bun', 'bin', 'd'), '');
    expect(listFiles(home, ['state', '.bun/install/cache'])).toEqual(['.bun/bin/d', 'b']);
  });
});
