/** Replays every stored auto-decide-preserved census capture through the observer's real screen and native detectors. */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findNativeAutoDecision } from './helpers/native-auto-decide';
import { classifyVisible } from './helpers/pty/classify';

const DIR = path.join(import.meta.dir, 'fixtures/detector-corpora/auto-decide-preserved');
const inventory: Array<{ run: string; outcome: string; available: boolean; entry: string | null }> =
  JSON.parse(fs.readFileSync(path.join(DIR, 'inventory.json'), 'utf8'));
const files = fs.readdirSync(DIR).filter(name => name !== 'inventory.json' && name.endsWith('.json')).sort();
const load = (name: string) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
const native = (entry: any) => findNativeAutoDecision(entry.input.native.transcript, entry.input.native.tools, entry.input.native.options);
const screen = (entry: any) => ['auto_decided', 'plan_ready'].includes(classifyVisible(entry.input.screen.text, { strictPlanWrites: true })?.outcome ?? '');
const verdict = (credited: boolean) => credited ? 'pass' : 'refuse';

describe('auto-decide-preserved detector corpus', () => {
  test('inventory names every entry, and each entry is bounded and pinned to its census', () => {
    expect(inventory.flatMap(row => row.entry ? [row.entry] : []).sort()).toEqual(files);
    const verdicts = files.map(name => load(name).expected);
    expect(verdicts).toContain('pass');
    expect(verdicts).toContain('refuse');
    for (const name of files) {
      expect(fs.statSync(path.join(DIR, name)).size, name).toBeLessThanOrEqual(64 * 1024);
      const entry = load(name);
      const row = inventory.find(r => r.entry === name)!;
      expect(entry.schema).toBe('gstack-detector-corpus/v1');
      expect(entry.case).toBe('auto-decide-preserved');
      expect(entry.source.run).toBe(row.run);
      expect(entry.source.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.census_outcome).toBe(row.outcome);
      expect(name).toBe(`${row.run}-t1-${row.outcome === 'passed' ? 'pass' : 'fail'}.json`);
      expect(entry.justification.trim()).not.toBe('');
      expect(JSON.stringify(entry)).not.toMatch(/\/home\/runner|\/Users\//);
    }
  });

  for (const name of files) {
    const entry = load(name);
    test(`${name}: the case's detectors ${entry.expected === 'pass' ? 'credit' : 'refuse'} it (census ${entry.census_outcome})`, () => {
      expect(verdict(screen(entry) || native(entry) !== null)).toBe(entry.expected);
      expect(verdict(screen(entry))).toBe(entry.screen_expected);
      const decision = native(entry);
      expect(verdict(decision !== null)).toBe(entry.native_expected);
      if (decision) expect(decision.option).toBe('HOLD SCOPE');
    });
  }

  test('37186854666: a "Mode application and rationale." heading is not a mode field, but a real unfinished field still withdraws', () => {
    const entry = load('37186854666-t1-pass.json');
    const last = () => entry.input.native.transcript.assistantMessages.at(-1);
    const original = last().text;
    expect(original).toContain('**Mode application and rationale.** The draft is a fix to an existing path with its own ceiling already pinned: membership');
    expect(native(entry)).toMatchObject({ option: 'HOLD SCOPE' });
    for (const [label, edit] of Object.entries({
      'colon inside the heading sentence': (t: string) => t.replace('**Mode application and rationale.**', '**Mode application and rationale:** still open.'),
      'later pending field': (t: string) => `${t}\n\nMode pending: SCOPE EXPANSION.`,
      'later different mode': (t: string) => `${t}\n\nMode: SCOPE EXPANSION.`,
    })) {
      last().text = edit(original);
      expect(native(entry), label).toBeNull();
    }
  });
});

describe('auto-decide handoff needs a user-visible witness', () => {
  test('37182865432: the helper result alone is refused; the same session is credited once its chat begins with the line', () => {
    const entry = load('37182865432-t1-fail.json');
    const line = 'Auto-decided review mode → HOLD SCOPE (your preference). Change with /plan-tune. Approved decisions: none.';
    expect(entry.input.native.tools.some((t: { kind: string; content?: unknown }) => t.kind === 'result' && t.content === line)).toBe(true);
    expect(native(entry)).toBeNull();
    const last = entry.input.native.transcript.assistantMessages.at(-1);
    const original = last.text;
    last.text = `${line}\n\n${original}`;
    expect(native(entry)).toMatchObject({ option: 'HOLD SCOPE', annotation: line });
    last.text = `Note: ${line}\n\n${original}`;
    expect(native(entry)).toBeNull();
  });
});

describe('a start that ran while the skill loaded (GST-3157)', () => {
  const START_LINE = '!`~/.claude/skills/gstack/bin/gstack-skill-load start --skill "plan-ceo-review" --model "claude"`';
  const rendered = fs.readFileSync(path.join(import.meta.dir, '../plan-ceo-review/SKILL.md'), 'utf8');
  const moved = () => {
    const entry = load('37195203538-t1-pass.json');
    const tools: any[] = entry.input.native.tools;
    const use = tools.find(t => t.kind === 'use' && String(t.input?.command ?? '').includes('gstack-skill-start --skill'));
    const result = tools.find(t => t.kind === 'result' && t.toolUseId === use.toolUseId);
    entry.input.native.tools = tools.filter(t => t !== use && t !== result);
    const text = (output: string, skill = 'plan-ceo-review') =>
      `Base directory for this skill: /fixture/.claude/skills/${skill}\n\n${rendered.replace(START_LINE, () => output)}`;
    const skillLoad = (output = result.content as string, extra: object = {}) =>
      ({ sessionId: entry.input.native.options.sessionId, skill: 'plan-ceo-review', text: text(output), timestamp: use.timestamp, ...extra });
    return { entry, use, result, text, skillLoad, loads: (...loads: object[]) => { entry.input.native.transcript.skillLoads = loads; } };
  };

  test('the rendered skill still carries the injected start line this replay replaces', () => {
    expect(rendered.split(START_LINE)).toHaveLength(2);
  });

  test('37195203538 with its start moved to load is credited from the loaded skill text alone', () => {
    const m = moved();
    expect(native(m.entry)).toBeNull();
    m.loads(m.skillLoad());
    const decision = native(m.entry);
    expect(decision).toMatchObject({ option: 'HOLD SCOPE', sessionId: m.entry.input.native.options.sessionId });
    expect(decision!.preambleToolUseId).toBeUndefined();
  });

  for (const [name, mutate] of Object.entries({
    'a second start through Bash': (m: ReturnType<typeof moved>) => { m.loads(m.skillLoad()); m.entry.input.native.tools.push(m.use, m.result); },
    'two loads': (m: ReturnType<typeof moved>) => m.loads(m.skillLoad(), m.skillLoad()),
    'another skill': (m: ReturnType<typeof moved>) => m.loads(m.skillLoad(undefined, { skill: 'plan-eng-review' })),
    'another session': (m: ReturnType<typeof moved>) => m.loads(m.skillLoad(undefined, { sessionId: 'foreign' })),
    'a load before the command': (m: ReturnType<typeof moved>) => m.loads(m.skillLoad(undefined, { timestamp: '2026-10-04T10:27:00.000Z' })),
    'question tuning off': (m: ReturnType<typeof moved>) => m.loads(m.skillLoad((m.result.content as string).replace('QUESTION_TUNING: true', 'QUESTION_TUNING: false'))),
    'a start that failed at load': (m: ReturnType<typeof moved>) => m.loads(m.skillLoad('SKILL_START: failed at load (exit 1); run the start command below yourself with Bash, then continue.')),
    'shell execution disabled by policy': (m: ReturnType<typeof moved>) => m.loads(m.skillLoad('[shell command execution disabled by policy]')),
    'an un-run injection line': (m: ReturnType<typeof moved>) => m.loads(m.skillLoad(START_LINE)),
  })) test(`a load-time start is refused with ${name}`, () => {
    const m = moved();
    mutate(m);
    expect(native(m.entry)).toBeNull();
  });

  test('a start that failed at load and then ran through Bash is the one start', () => {
    const m = moved();
    m.loads(m.skillLoad('SKILL_START: failed at load (exit 1); run the start command below yourself with Bash, then continue.'));
    m.entry.input.native.tools.push(m.use, m.result);
    expect(native(m.entry)).toMatchObject({ option: 'HOLD SCOPE', preambleToolUseId: m.use.toolUseId });
  });
});
