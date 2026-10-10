/**
 * B0: the unattended artifact contract. Pins the wire contract (schema
 * versions, ids, hashes, the GSTACK_RESULT grammar, exit codes, reason codes)
 * on the plan branch's own hand-written run (test/fixtures/multi-agent-wave/
 * reference-run) and on mutations of it, never on prose.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ARTIFACT_NAMES, EXIT, SCHEMA_VERSIONS, ackRun, deriveReviewStatus, formatResult, jsonSchema, parseResult,
  renderUrgentBlock, urgentBlockPrecedes, validateRun, validateFile,
} from '../lib/headless-artifacts';
import { RESULT_CODES } from '../lib/result-codes';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-artifact');
const REFERENCE = path.join(ROOT, 'test', 'fixtures', 'multi-agent-wave', 'reference-run');

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(BIN, args, { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-artifact-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** A mutable copy of the reference run; `edit` rewrites run.json after the file edits. */
function copyRun(edit?: (manifest: any, dir: string) => void): string {
  const dir = path.join(tmp, 'run');
  fs.cpSync(REFERENCE, dir, { recursive: true });
  if (edit) {
    const file = path.join(dir, 'run.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    edit(manifest, dir);
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  }
  return path.join(dir, 'run.json');
}
const codes = (file: string) => validateRun(file).errors.map(e => e.code);
const sha = (file: string) => require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('reference run (the plan branch artifacts)', () => {
  test('validates: the hand-written v1 shapes are the contract', () => {
    const result = validateRun(path.join(REFERENCE, 'run.json'));
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.manifest!.run).toBe('maw-20261010');
    const r = run(['validate', path.join(REFERENCE, 'run.json')]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out.trim()).toBe('ARTIFACT_VALID: run=maw-20261010 status=complete');
  });

  test('--json: JSON only on stdout, {valid, errors:[{code,path,message}]}', () => {
    const r = run(['validate', path.join(REFERENCE, 'run.json'), '--json']);
    const parsed = JSON.parse(r.out);
    expect(parsed).toMatchObject({ valid: true, run: 'maw-20261010', status: 'complete', errors: [] });
    expect(r.err).toBe('');
  });

  test('every row id is run-bound and every file carries schema_version', () => {
    for (const name of ['decisions', 'findings', 'tasks'] as const) {
      const rows = fs.readFileSync(path.join(REFERENCE, `${name}.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      for (const row of rows) {
        expect(row.id.startsWith('maw-20261010-')).toBe(true);
        expect(row.schema_version).toBe(SCHEMA_VERSIONS[name]);
      }
    }
  });
});

describe('validate fails on', () => {
  test('an interrupted run (non-terminal status, or a voice still pending)', () => {
    expect(codes(copyRun(m => { m.status = 'running'; }))).toContain('ARTIFACT_RUN_INTERRUPTED');
    expect(codes(copyRun(m => { m.phases.eng.native.status = 'pending'; }))).toContain('ARTIFACT_RUN_INTERRUPTED');
    expect(codes(copyRun(m => { m.status = 'awaiting_result'; }))).toContain('ARTIFACT_RUN_INTERRUPTED');
  });

  test('a missing reviewer (phase absent, voice absent, or completed voice without a bound output)', () => {
    expect(codes(copyRun(m => { delete m.phases.eng; }))).toContain('ARTIFACT_REVIEWER_MISSING');
    expect(codes(copyRun(m => { delete m.phases.eng.outside; }))).toContain('ARTIFACT_REVIEWER_MISSING');
    expect(codes(copyRun(m => { delete m.artifacts['eng-outside.md']; }))).toContain('ARTIFACT_REVIEWER_MISSING');
    // An honest unavailable voice is not a missing reviewer: it has a terminal outcome.
    expect(codes(copyRun(m => { m.phases.eng.outside = { status: 'unavailable' }; delete m.artifacts['eng-outside.md']; }))).toEqual([]);
  });

  test('a stale artifact (hash mismatch) and a count that disagrees with the file', () => {
    const file = copyRun((m, dir) => { fs.appendFileSync(path.join(dir, 'findings.jsonl'), '\n'); });
    expect(codes(file)).toContain('ARTIFACT_STALE');
    expect(codes(copyRun(m => { m.counts.findings = 64; }))).toContain('ARTIFACT_COUNT_MISMATCH');
    expect(codes(copyRun(m => { m.counts.decisions_pending = 1; }))).toContain('ARTIFACT_COUNT_MISMATCH');
    // An omitted row with an unchanged count is still caught: the hash moved.
    const omitted = copyRun((m, dir) => {
      const f = path.join(dir, 'findings.jsonl');
      const rows = fs.readFileSync(f, 'utf8').trim().split('\n');
      fs.writeFileSync(f, rows.slice(0, -1).join('\n') + '\n');
    });
    const found = codes(omitted);
    expect(found).toContain('ARTIFACT_STALE');
    expect(found).toContain('ARTIFACT_COUNT_MISMATCH');
  });

  test('duplicate ids, unbound ids, dangling references and dependency cycles', () => {
    const rebind = (dir: string, m: any, name: string) => { m.artifacts[name].sha256 = sha(path.join(dir, name)); };
    const dup = copyRun((m, dir) => {
      const f = path.join(dir, 'decisions.jsonl');
      const rows = fs.readFileSync(f, 'utf8').trim().split('\n');
      fs.writeFileSync(f, [...rows, rows[0]].join('\n') + '\n');
      m.counts.decisions = rows.length + 1; rebind(dir, m, 'decisions.jsonl');
    });
    expect(codes(dup)).toContain('ARTIFACT_DUPLICATE_ID');

    const unbound = copyRun((m, dir) => {
      const f = path.join(dir, 'tasks.jsonl');
      const rows = fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      rows[0].id = 'other-run-a1';
      fs.writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); rebind(dir, m, 'tasks.jsonl');
    });
    expect(codes(unbound)).toContain('ARTIFACT_UNBOUND_ID');

    const dangling = copyRun((m, dir) => {
      const f = path.join(dir, 'tasks.jsonl');
      const rows = fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      rows[0].findings.push('maw-20261010-ceo-outside-999');
      rows[1].blocked_by.push('maw-20261010-d99');
      rows[2].depends_on.push('maw-20261010-nope');
      fs.writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); rebind(dir, m, 'tasks.jsonl');
    });
    expect(codes(dangling).filter(c => c === 'ARTIFACT_DANGLING_REF')).toHaveLength(3);

    const cycle = copyRun((m, dir) => {
      const f = path.join(dir, 'tasks.jsonl');
      const rows = fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      rows[0].depends_on = [rows[1].id];
      rows[1].depends_on = [rows[2].id];
      rows[2].depends_on = [rows[0].id];
      fs.writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); rebind(dir, m, 'tasks.jsonl');
    });
    const result = validateRun(cycle);
    expect(result.errors.map(e => e.code)).toContain('ARTIFACT_DEPENDENCY_CYCLE');
    expect(result.errors.find(e => e.code === 'ARTIFACT_DEPENDENCY_CYCLE')!.message).toContain('maw-20261010-a1 -> ');
  });

  test('a malformed JSONL tail (interrupted append)', () => {
    const file = copyRun((m, dir) => {
      const f = path.join(dir, 'findings.jsonl');
      fs.appendFileSync(f, '{"schema_version": 1, "run": "maw-20261010", "id": "maw-2026');
      m.artifacts['findings.jsonl'].sha256 = sha(f);
      m.counts.findings = 65;
    });
    const result = validateRun(file);
    const tail = result.errors.find(e => e.code === 'ARTIFACT_MALFORMED_JSONL');
    expect(tail).toBeDefined();
    expect(tail!.path).toMatch(/findings\.jsonl:66$/);
    expect(tail!.message).toContain('malformed tail');
  });

  test('artifact paths that escape the run directory (`..`, absolute, symlink)', () => {
    expect(codes(copyRun(m => { m.artifacts['timing.json'].path = '../timing.json'; }))).toContain('ARTIFACT_PATH_ESCAPE');
    expect(codes(copyRun(m => { m.artifacts['timing.json'].path = path.join(tmp, 'run', 'timing.json'); }))).toContain('ARTIFACT_PATH_ESCAPE');
    const outside = path.join(tmp, 'outside.md');
    fs.writeFileSync(outside, fs.readFileSync(path.join(REFERENCE, 'eng-outside.md')));
    const linked = copyRun((m, dir) => {
      fs.rmSync(path.join(dir, 'eng-outside.md'));
      fs.symlinkSync(outside, path.join(dir, 'eng-outside.md'));
    });
    const result = validateRun(linked);
    const escape = result.errors.find(e => e.code === 'ARTIFACT_PATH_ESCAPE');
    expect(escape).toBeDefined();
    expect(escape!.path).toContain('eng-outside.md');
  });

  test('a missing artifact, an unsupported schema_version, invalid JSON and a schema violation', () => {
    expect(codes(copyRun((m, dir) => { fs.rmSync(path.join(dir, 'dx-native.md')); }))).toContain('ARTIFACT_MISSING');
    expect(codes(copyRun(m => { m.schema_version = 7; }))).toEqual(['ARTIFACT_UNSUPPORTED_VERSION']);
    const broken = copyRun(); fs.writeFileSync(broken, '{"schema_version": 1,');
    expect(codes(broken)).toEqual(['ARTIFACT_INVALID_JSON']);
    expect(codes(copyRun(m => { m.status = 'approved'; }))).toEqual(['ARTIFACT_SCHEMA']);
    const r = run(['validate', copyRun(m => { m.status = 'approved'; })]);
    expect(r.code).toBe(EXIT.fail);
    expect(r.err).toMatch(/\(ARTIFACT_SCHEMA\)\n/);
    expect(r.err).toContain('; fix: ');
    expect(r.out.trim()).toBe('ARTIFACT_INVALID: 1 error(s)');
  });

  test('an unattended run whose review-record.md lacks the GUARD_NOT_INSTALLED line', () => {
    const without = copyRun((m, dir) => {
      m.session_kind = 'unattended';
      fs.writeFileSync(path.join(dir, 'review-record.md'), '# Review record\n');
      m.artifacts['review-record.md'] = { path: 'review-record.md', sha256: sha(path.join(dir, 'review-record.md')) };
    });
    expect(codes(without)).toEqual(['ARTIFACT_GUARD_LINE_MISSING']);
    const withLine = copyRun((m, dir) => {
      m.session_kind = 'unattended';
      fs.writeFileSync(path.join(dir, 'review-record.md'), '# Review record\nautoplan guard: not enforced by this host; publication order is unverified (GUARD_NOT_INSTALLED)\n');
      m.artifacts['review-record.md'] = { path: 'review-record.md', sha256: sha(path.join(dir, 'review-record.md')) };
    });
    expect(codes(withLine)).toEqual([]);
  });

  test('every code the validator emits is in the enumerated result table', () => {
    const emitted = ['ARTIFACT_INVALID_JSON', 'ARTIFACT_UNSUPPORTED_VERSION', 'ARTIFACT_SCHEMA', 'ARTIFACT_MISSING', 'ARTIFACT_STALE',
      'ARTIFACT_PATH_ESCAPE', 'ARTIFACT_MALFORMED_JSONL', 'ARTIFACT_DUPLICATE_ID', 'ARTIFACT_UNBOUND_ID', 'ARTIFACT_DANGLING_REF',
      'ARTIFACT_DEPENDENCY_CYCLE', 'ARTIFACT_COUNT_MISMATCH', 'ARTIFACT_RUN_INTERRUPTED', 'ARTIFACT_REVIEWER_MISSING', 'ARTIFACT_GUARD_LINE_MISSING'];
    for (const code of emitted) expect(RESULT_CODES).toHaveProperty(code);
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'headless-artifacts.ts'), 'utf8');
    for (const code of src.matchAll(/code: '([A-Z_]+)'/g)) expect(RESULT_CODES).toHaveProperty(code[1]!);
  });
});

describe('schema', () => {
  test('prints a JSON Schema per artifact, each with schema_version const and the required list', () => {
    for (const name of ARTIFACT_NAMES) {
      const r = run(['schema', name]);
      expect(r.code).toBe(EXIT.ok);
      const schema = JSON.parse(r.out);
      expect(schema.$schema).toContain('json-schema.org');
      expect(schema.properties.schema_version.const).toBe(SCHEMA_VERSIONS[name]);
      expect(schema.required).toContain('schema_version');
      expect(jsonSchema(name).title).toBe(`gstack ${name} v${SCHEMA_VERSIONS[name]}`);
    }
    expect(run(['schema', '--list']).out.trim().split('\n')).toEqual([...ARTIFACT_NAMES]);
    expect(run(['schema', 'nope']).code).toBe(EXIT.usage);
  });

  test('tasks v2 requires depends_on, acceptance, findings and blocked_by; v1 rows do not validate as v2', () => {
    const v2 = jsonSchema('tasks');
    for (const key of ['depends_on', 'acceptance', 'findings', 'blocked_by']) expect(v2.required).toContain(key);
    const v1 = path.join(tmp, 'tasks-ceo-x.jsonl');
    fs.writeFileSync(v1, JSON.stringify({ phase: 'ceo', run_id: 'r', branch: 'b', commit: 'c', id: 'T1', priority: 'P1', component: 'x', files: [], effort_human: '1d', effort_cc: '1h', title: 't', source_finding: 'f' }) + '\n');
    expect(validateFile(v1, 'tasks').map(e => e.code)).toContain('ARTIFACT_SCHEMA');
  });

  test('standalone pregate and ship-receipt files validate against their schemas', () => {
    const pregate = path.join(tmp, 'pregate.json');
    fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree: 'abc', checks: [{ id: 'secrets', status: 'pass', ms: 12 }, { id: 'lanes', status: 'requires-remote' }] }));
    expect(validateFile(pregate, 'pregate')).toEqual([]);
    expect(run(['validate', pregate, '--as', 'pregate']).code).toBe(EXIT.ok);
    fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree: 'abc', checks: [{ id: 'secrets', status: 'maybe' }] }));
    expect(validateFile(pregate, 'pregate').map(e => e.code)).toEqual(['ARTIFACT_SCHEMA']);
    const receipt = path.join(tmp, 'receipt.json');
    fs.writeFileSync(receipt, JSON.stringify({ schema_version: 1, head: 'h', base: 'main', pr: 3113, session_kind: 'unattended', artifacts_consumed: '6/10' }));
    expect(validateFile(receipt, 'ship-receipt')).toEqual([]);
    fs.writeFileSync(receipt, JSON.stringify({ schema_version: 2, head: 'h', base: 'main' }));
    expect(validateFile(receipt, 'ship-receipt').map(e => e.code)).toEqual(['ARTIFACT_UNSUPPORTED_VERSION']);
  });
});

describe('ack', () => {
  test('is idempotent per consumer, writes consumed_by and appends one analytics row', () => {
    const file = copyRun();
    const analytics = path.join(tmp, 'state', 'analytics', 'autoplan-timing.jsonl');
    const first = ackRun(file, 'SCO-1234', { analyticsPath: analytics, ephemeral: false });
    expect(first).toMatchObject({ added: true, analytics: 'appended' });
    const second = ackRun(file, 'SCO-1234', { analyticsPath: analytics, ephemeral: false });
    expect(second).toMatchObject({ added: false, analytics: 'already_acked' });
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(manifest.consumed_by).toHaveLength(1);
    expect(manifest.consumed_by[0].consumer).toBe('SCO-1234');
    const rows = fs.readFileSync(analytics, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: 'ack', run: 'maw-20261010', consumer: 'SCO-1234' });
    expect(() => ackRun(file, 'bad consumer', { analyticsPath: analytics, ephemeral: false })).toThrow();
  });

  test('bin: records through the state root, says so when the root is ephemeral, refuses an invalid run', () => {
    const file = copyRun();
    const state = path.join(tmp, 'state');
    const r = run(['ack', file, '--consumer', 'thread-a'], { GSTACK_STATE_ROOT: state });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out.trim()).toBe('ARTIFACT_ACK: run=maw-20261010 consumer=thread-a recorded analytics=appended');
    expect(fs.existsSync(path.join(state, 'analytics', 'autoplan-timing.jsonl'))).toBe(true);
    const eph = run(['ack', file, '--consumer', 'thread-b', '--json'], { GSTACK_STATE_ROOT: path.join(tmp, 'state2'), GSTACK_EPHEMERAL: '1' });
    expect(eph.code).toBe(EXIT.ok);
    expect(JSON.parse(eph.out)).toMatchObject({ consumer: 'thread-b', added: true, analytics: 'skipped_ephemeral' });
    expect(eph.err).toContain('ack: analytics skipped (state root is ephemeral; set GSTACK_STATE_ROOT)');
    expect(fs.existsSync(path.join(tmp, 'state2'))).toBe(false);
    const invalid = copyRun(m => { m.status = 'running'; });
    const refused = run(['ack', invalid, '--consumer', 'thread-c'], { GSTACK_STATE_ROOT: state });
    expect(refused.code).toBe(EXIT.refused);
    expect(refused.err).toContain('nothing written');
    expect(JSON.parse(fs.readFileSync(invalid, 'utf8')).consumed_by).toBeUndefined();
  });
});

describe('result grammar, exit table and help', () => {
  test('GSTACK_RESULT line round-trips and rejects unknown statuses', () => {
    const line = formatResult('autoplan', 'gate_pending', '/tmp/run');
    expect(line).toBe('GSTACK_RESULT: skill=autoplan status=gate_pending run=/tmp/run');
    expect(parseResult(`noise\n${line}\n`)).toEqual({ skill: 'autoplan', status: 'gate_pending', run: '/tmp/run' });
    expect(parseResult('GSTACK_RESULT: skill=x status=approved run=/r')).toBeUndefined();
  });

  test('--help prints the shared exit table; no args is usage (2)', () => {
    const help = run(['--help']);
    expect(help.code).toBe(EXIT.ok);
    expect(help.out).toContain('Exit codes: 0 ok · 1 fail · 2 usage · 3 refused or needs a flag');
    expect(run([]).code).toBe(EXIT.usage);
    expect(run(['bogus']).code).toBe(EXIT.usage);
  });

  test('validate is a query command: no GSTACK_RESULT line on either path', () => {
    expect(run(['validate', path.join(REFERENCE, 'run.json')]).out).not.toContain('GSTACK_RESULT');
    expect(run(['validate', copyRun(m => { m.status = 'running'; })]).out).not.toContain('GSTACK_RESULT');
  });
});

describe('derivations shared with the review log and the final report', () => {
  test('deriveReviewStatus: clean only when nothing is open; counts over the whole file', () => {
    const rows = [
      { severity: 'Critical', disposition: 'accepted' },
      { severity: 'Critical', disposition: 'open' },
      { severity: 'High' },
      { severity: 'Low', disposition: 'deferred' },
      { severity: 'CRITICAL', action: 'fixed' },
      { severity: 'INFORMATIONAL', action: 'skipped' },
    ];
    expect(deriveReviewStatus(rows)).toEqual({ status: 'issues_open', unresolved: 3, issues_found: 6, critical_gaps: 1, findings_total: 6, findings_open: 3, findings_resolved: 3 });
    expect(deriveReviewStatus([{ severity: 'Critical', disposition: 'accepted' }])).toMatchObject({ status: 'clean', findings_open: 0, critical_gaps: 0, issues_found: 1 });
    expect(deriveReviewStatus([])).toMatchObject({ status: 'clean', findings_total: 0 });
  });

  test('URGENT block: fixed heading, `None.` when nothing was raised, one line per urgent finding with owner and id', () => {
    expect(renderUrgentBlock([{ id: 'r-1', severity: 'Critical', title: 'x' }])).toBe('## URGENT, outside this plan\n\nNone.\n');
    const block = renderUrgentBlock([
      { id: 'r-ceo-outside-2', severity: 'Critical', title: 'Token logged in plaintext', urgent: true, suggested_owner: 'platform team' },
      { id: 'r-eng-native-F3', severity: 'High', title: 'Backup job drops rows', outside_plan: true },
    ]);
    expect(block.split('\n')[0]).toBe('## URGENT, outside this plan');
    expect(block).toContain('- r-ceo-outside-2 [Critical] Token logged in plaintext — platform team');
    expect(block).toContain('- r-eng-native-F3 [High] Backup job drops rows — owner: unassigned');
    expect(urgentBlockPrecedes(`# Report\n${block}\n### Plan Summary\n...`)).toBe(true);
    expect(urgentBlockPrecedes(`### Plan Summary\n...\n${block}`)).toBe(false);
    const r = run(['urgent', path.join(REFERENCE, 'findings.jsonl')]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toBe('## URGENT, outside this plan\n\nNone.\n');
  });

  test('autoplan Phase 4 places the URGENT block before the summary in the final report and in the plan file (B12)', () => {
    const tmpl = fs.readFileSync(path.join(import.meta.dir, '..', 'autoplan', 'SKILL.md.tmpl'), 'utf8');
    const phase4 = tmpl.split('## Phase 4: Final Approval Gate')[1]?.split('**Option handling:**')[0] ?? '';
    expect(urgentBlockPrecedes(phase4)).toBe(true);
    expect(phase4.indexOf('## URGENT, outside this plan')).toBeGreaterThan(phase4.indexOf('## /autoplan Review Complete'));
    expect(phase4).toContain('gstack-artifact urgent $_AP/findings.jsonl');
    expect(phase4).toContain('also written above `## Implementation plan` in ACTIVE_PLAN');
    const rendered = fs.readFileSync(path.join(import.meta.dir, '..', 'autoplan', 'SKILL.md'), 'utf8');
    expect(urgentBlockPrecedes(rendered.split('## Phase 4: Final Approval Gate')[1] ?? '')).toBe(true);
  });
});
