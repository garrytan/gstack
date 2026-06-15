/**
 * gstack-distill-apply — Layer 8 proposal application (plan-tune cathedral T11).
 *
 * Verifies the three apply paths:
 *   - memory-nugget → appended to ~/.gstack/free-text-memory.json (local
 *     source-of-truth; gbrain is mirror when configured).
 *   - preference   → routed through gstack-question-preference with
 *                    source=plan-tune (user-origin gate cleared).
 *   - declared-nudge → atomic update to developer-profile.json declared dim,
 *                     small=0.05, medium=0.10, large=0.15, clamped to [0,1].
 * Plus:
 *   - --list shows proposals with kind, confidence, rationale, quotes.
 *   - Applied proposals get applied_at + gbrain_published flag.
 *   - Bad --proposal index errors with non-zero exit.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-distill-apply');

let stateRoot: string;
let fixtureCwd: string;
let cwdSlug: string;
let proposalFile: string;

beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-apply-'));
  cwdSlug = 'apply-fixture';
  fixtureCwd = path.join(stateRoot, cwdSlug);
  fs.mkdirSync(fixtureCwd, { recursive: true });
  fs.mkdirSync(path.join(stateRoot, 'projects', cwdSlug), { recursive: true });
  proposalFile = path.join(stateRoot, 'projects', cwdSlug, 'distillation-proposals.json');
});

afterEach(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

function writeProposals(proposals: Array<Record<string, unknown>>): void {
  fs.writeFileSync(
    proposalFile,
    JSON.stringify(
      { generated_at: new Date().toISOString(), source_event_count: 1, proposals },
      null,
      2,
    ),
  );
}

function run(args: string[]): { stdout: string; stderr: string; status: number } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.GSTACK_STATE_ROOT = stateRoot;
  env.GSTACK_QUESTION_LOG_NO_DERIVE = '1';
  delete env.GSTACK_HOME;
  const res = spawnSync(BIN, args, { env, encoding: 'utf-8', cwd: fixtureCwd });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status ?? -1,
  };
}

// ----------------------------------------------------------------------
// --list
// ----------------------------------------------------------------------

describe('--list', () => {
  test('handles missing proposals file', () => {
    const r = run(['--list']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/NO_PROPOSALS/);
  });

  test('renders all 3 kinds + source quotes', () => {
    writeProposals([
      {
        kind: 'preference',
        confidence: 0.9,
        question_id: 'ship-changelog-voice-polish',
        preference: 'never-ask',
        rationale: 'user repeatedly skipped this',
        source_quotes: ['skip the polish for typo PRs'],
      },
      {
        kind: 'declared-nudge',
        confidence: 0.85,
        dimension: 'scope_appetite',
        direction: 'up',
        magnitude: 'medium',
      },
      {
        kind: 'memory-nugget',
        confidence: 0.95,
        nugget: 'User prefers complete edge cases',
        applies_to_signal_keys: ['scope-appetite'],
      },
    ]);
    const r = run(['--list']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('preference');
    expect(r.stdout).toContain('declared-nudge');
    expect(r.stdout).toContain('memory-nugget');
    expect(r.stdout).toContain('skip the polish for typo PRs');
    expect(r.stdout).toContain('scope-appetite');
  });
});

// ----------------------------------------------------------------------
// memory-nugget application
// ----------------------------------------------------------------------

describe('memory-nugget apply', () => {
  test('appends to ~/.gstack/free-text-memory.json with full metadata', () => {
    writeProposals([
      {
        kind: 'memory-nugget',
        confidence: 0.9,
        nugget: 'User prefers verbose explanations with tradeoffs',
        applies_to_signal_keys: ['detail-preference'],
        source_quotes: ['always explain the tradeoffs'],
      },
    ]);
    const r = run(['--proposal', '0', '--gbrain-published', 'true']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('APPLIED: memory-nugget');

    const memPath = path.join(stateRoot, 'free-text-memory.json');
    const mem = JSON.parse(fs.readFileSync(memPath, 'utf-8'));
    expect(mem.nuggets.length).toBe(1);
    expect(mem.nuggets[0].nugget).toContain('verbose explanations');
    expect(mem.nuggets[0].applies_to_signal_keys).toEqual(['detail-preference']);
    expect(mem.nuggets[0].gbrain_published).toBe(true);
    expect(mem.nuggets[0].source_quotes).toEqual(['always explain the tradeoffs']);
  });

  test('appends without clobbering existing nuggets', () => {
    fs.writeFileSync(
      path.join(stateRoot, 'free-text-memory.json'),
      JSON.stringify({ nuggets: [{ nugget: 'pre-existing', applies_to_signal_keys: [] }] }),
    );
    writeProposals([
      {
        kind: 'memory-nugget',
        confidence: 0.9,
        nugget: 'new nugget',
        applies_to_signal_keys: [],
      },
    ]);
    run(['--proposal', '0']);
    const mem = JSON.parse(
      fs.readFileSync(path.join(stateRoot, 'free-text-memory.json'), 'utf-8'),
    );
    expect(mem.nuggets.length).toBe(2);
    expect(mem.nuggets[0].nugget).toBe('pre-existing');
    expect(mem.nuggets[1].nugget).toBe('new nugget');
  });
});

// ----------------------------------------------------------------------
// preference application
// ----------------------------------------------------------------------

describe('preference apply', () => {
  test('routes through gstack-question-preference with source=plan-tune', () => {
    writeProposals([
      {
        kind: 'preference',
        confidence: 0.9,
        question_id: 'ship-changelog-voice-polish',
        preference: 'never-ask',
        source_quotes: ['skip the polish for typo PRs'],
      },
    ]);
    const r = run(['--proposal', '0']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('APPLIED: preference');

    const prefPath = path.join(stateRoot, 'projects', cwdSlug, 'question-preferences.json');
    const prefs = JSON.parse(fs.readFileSync(prefPath, 'utf-8'));
    expect(prefs['ship-changelog-voice-polish']).toBe('never-ask');
  });
});

// ----------------------------------------------------------------------
// declared-nudge application
// ----------------------------------------------------------------------

describe('declared-nudge apply', () => {
  test('medium up nudge on unset dim → 0.5 + 0.10 = 0.6', () => {
    writeProposals([
      {
        kind: 'declared-nudge',
        confidence: 0.9,
        dimension: 'scope_appetite',
        direction: 'up',
        magnitude: 'medium',
      },
    ]);
    run(['--proposal', '0']);
    const profile = JSON.parse(
      fs.readFileSync(path.join(stateRoot, 'developer-profile.json'), 'utf-8'),
    );
    expect(profile.declared.scope_appetite).toBe(0.6);
  });

  test('small down nudge on existing value', () => {
    fs.writeFileSync(
      path.join(stateRoot, 'developer-profile.json'),
      JSON.stringify({ declared: { scope_appetite: 0.8 } }),
    );
    writeProposals([
      {
        kind: 'declared-nudge',
        confidence: 0.9,
        dimension: 'scope_appetite',
        direction: 'down',
        magnitude: 'small',
      },
    ]);
    run(['--proposal', '0']);
    const profile = JSON.parse(
      fs.readFileSync(path.join(stateRoot, 'developer-profile.json'), 'utf-8'),
    );
    expect(profile.declared.scope_appetite).toBe(0.75);
  });

  test('clamps to [0, 1]', () => {
    fs.writeFileSync(
      path.join(stateRoot, 'developer-profile.json'),
      JSON.stringify({ declared: { scope_appetite: 0.95 } }),
    );
    writeProposals([
      {
        kind: 'declared-nudge',
        confidence: 0.9,
        dimension: 'scope_appetite',
        direction: 'up',
        magnitude: 'large',
      },
    ]);
    run(['--proposal', '0']);
    const profile = JSON.parse(
      fs.readFileSync(path.join(stateRoot, 'developer-profile.json'), 'utf-8'),
    );
    expect(profile.declared.scope_appetite).toBe(1);
  });
});

// ----------------------------------------------------------------------
// Proposal marked applied
// ----------------------------------------------------------------------

describe('proposal marked applied', () => {
  test('applied_at + gbrain_published written back to proposals.json', () => {
    writeProposals([
      {
        kind: 'memory-nugget',
        confidence: 0.9,
        nugget: 'something',
        applies_to_signal_keys: [],
      },
    ]);
    run(['--proposal', '0', '--gbrain-published', 'true']);
    const p = JSON.parse(fs.readFileSync(proposalFile, 'utf-8'));
    expect(p.proposals[0].applied_at).toBeTruthy();
    expect(p.proposals[0].gbrain_published).toBe(true);
  });
});

// ----------------------------------------------------------------------
// Error paths
// ----------------------------------------------------------------------

describe('error paths', () => {
  test('bad --proposal index exits non-zero', () => {
    writeProposals([
      { kind: 'memory-nugget', confidence: 0.9, nugget: 'x', applies_to_signal_keys: [] },
    ]);
    const r = run(['--proposal', '99']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('invalid --proposal');
  });

  test('missing --proposal exits non-zero', () => {
    writeProposals([
      { kind: 'memory-nugget', confidence: 0.9, nugget: 'x', applies_to_signal_keys: [] },
    ]);
    const r = run([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('--proposal');
  });
});
