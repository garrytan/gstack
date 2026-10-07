/** CEO-12, DX-14, ENG-15: one content-free, schema-tagged line per guarded decision, bounded by trim-on-write. */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { GUARD_LOG_KEEP_LINES, GUARD_LOG_TRIM_BYTES, logGuardDecision } from '../autoplan/bin/guard-log';
import { guardFixture, section, type GuardFixture } from './helpers/autoplan-guard-fixture';

const fixtures: GuardFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });

describe('autoplan guard decision log', () => {
  test('one line each for an allow, a hard denial and a transient denial', async () => {
    const f = guardFixture(); fixtures.push(f);
    f.journal();
    await f.hook(f.input('allow', 'Read', { file_path: section('ceo-phase.md') }));
    await f.hook(f.input('hard', 'Agent', { prompt: f.snapshot.nativeDispatchPrompt, model: 'haiku' }));
    f.publish(); f.use('pending', 'Read', { file_path: section('design-phase.md') });
    f.use('transient', 'Read', { file_path: section('design-phase.md'), offset: 2 }); f.journal();
    await f.hook(f.input('transient', 'Read', { file_path: section('design-phase.md'), offset: 2 }));
    const lines = f.log();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ schema: 1, decision: 'allow', disposition: 'allow', code: null, path: 'payload', claude_code_version: '2.1.292' });
    expect(lines[1]).toMatchObject({ schema: 1, decision: 'deny', disposition: 'fallback', code: 'agent_key', path: 'payload', unknown_keys: ['model'] });
    expect(lines[2]).toMatchObject({ schema: 1, decision: 'deny', disposition: 'transient', code: 'entry_pending', path: 'journal' });
    for (const line of lines) expect(Object.keys(line).sort()).toEqual(expect.arrayContaining(['ts', 'schema', 'decision', 'disposition', 'code', 'path', 'claude_code_version']));
    expect(JSON.stringify(lines)).not.toContain(f.cwd);
    expect(JSON.stringify(lines)).not.toContain('reviewer for this phase');
  });

  test('past the byte bound the log keeps the newest lines through a rename; below it, nothing is rewritten', () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'autoplan-guard-trim-'));
    const prior = process.env.GSTACK_STATE_ROOT; process.env.GSTACK_STATE_ROOT = root;
    try {
      const file = path.join(root, 'analytics', 'autoplan-guard.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const old = Array.from({ length: 2_000 }, (_, i) => JSON.stringify({ schema: 1, n: i, pad: 'x'.repeat(150) }));
      fs.writeFileSync(file, old.join('\n') + '\n');
      expect(fs.statSync(file).size).toBeGreaterThan(GUARD_LOG_TRIM_BYTES);
      logGuardDecision({ decision: 'allow', disposition: 'allow', path: 'journal' });
      const kept = fs.readFileSync(file, 'utf8').trim().split('\n');
      expect(kept).toHaveLength(GUARD_LOG_KEEP_LINES);
      expect(JSON.parse(kept[0]!).n).toBe(1_001);
      expect(JSON.parse(kept.at(-1)!)).toMatchObject({ decision: 'allow' });
      expect(fs.readdirSync(path.dirname(file))).toEqual(['autoplan-guard.jsonl']);
      fs.writeFileSync(file, 'small\n');
      logGuardDecision({ decision: 'deny', disposition: 'transient', code: 'entry_pending', path: 'journal' });
      expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
    } finally {
      if (prior === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = prior;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a logging failure never throws', () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'autoplan-guard-fail-'));
    const prior = process.env.GSTACK_STATE_ROOT; process.env.GSTACK_STATE_ROOT = path.join(root, 'file');
    fs.writeFileSync(path.join(root, 'file'), 'not a directory');
    try { expect(() => logGuardDecision({ decision: 'allow', disposition: 'allow', path: 'none' })).not.toThrow(); }
    finally {
      if (prior === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = prior;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
