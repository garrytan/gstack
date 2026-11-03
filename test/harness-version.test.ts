/**
 * EVAL_POLICY v2 series identity and its HARNESS_VERSION guard (CEO-27,
 * ENG-3, DX-6). A case's series is keyed by the bytes it owns plus
 * HARNESS_VERSION; the shared execution harness is pinned blob by blob in
 * scripts/harness-version.json, so a harness edit cannot silently pool runs
 * that behaved differently: it needs a bump (new series) or a recorded
 * non-behavioral decision.
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { decide, formatDrift, harnessDrift, hasDrift, MANIFEST, PINS_DIR, readManifest, workingHarnessFiles, writeManifest,
  type HarnessManifest } from '../scripts/bump-harness-version';
import { caseSeriesIdentitiesV2, globRegex, HARNESS_PATTERNS, HARNESS_VERSION, isCaseOwnedFile, skillDirs, stampTrialSeries, treeEntries,
  type TreeEntry } from '../scripts/eval-trial-series';
import { EVAL_POLICY } from './helpers/periodic-exclude-data';
import { formatTrialOutcomes, parseTrialOutcomes, TRIAL_OUTCOME_SCHEMA } from './helpers/eval-store';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { LIVE_REGISTRY, type Registry } from '../scripts/eval-flake-rank';
import { matchGlob } from './helpers/test-selection';
import { mergePinEdits, type PinMerge } from './helpers/pin-merge-fixture';

const ROOT = path.resolve(import.meta.dir, '..');

describe('HARNESS_VERSION guard', () => {
  test('every pinned shared-harness file matches scripts/harness-version.json', () => {
    expect(MANIFEST).toBe('scripts/harness-version.json');
    expect(PINS_DIR).toBe('scripts/harness-pins');
    const manifest = readManifest(ROOT);
    expect(manifest.version).toBe(HARNESS_VERSION);
    expect(manifest.patterns).toEqual([...HARNESS_PATTERNS]);
    const drift = harnessDrift(manifest, workingHarnessFiles(ROOT, manifest.patterns));
    if (hasDrift(drift)) throw new Error(formatDrift(drift, manifest.version));
    expect(Object.keys(manifest.files)).toContain('test/helpers/eval-store.ts');
  });

  const files = (blobs: Record<string, string>): TreeEntry[] => Object.entries(blobs).map(([file, blob]) => ({ file, blob }));
  const base: HarnessManifest = { version: 3, patterns: [], files: { 'a.ts': { blob: 'a1', since: 3 }, 'b.ts': { blob: 'b1', since: 2 } } };

  test('drift names changed, added and removed files, and the failure prints both fixes and the anchor', () => {
    const drift = harnessDrift(base, files({ 'a.ts': 'a2', 'c.ts': 'c1' }));
    expect(drift).toEqual({ changed: ['a.ts'], added: ['c.ts'], removed: ['b.ts'] });
    const message = formatDrift(drift, 3);
    for (const text of ['changed: a.ts', 'added: c.ts', 'removed: b.ts', 'bump-harness-version.ts --non-behavioral', 'bump-harness-version.ts --bump',
      'take the higher version, then rerun', 'docs/TESTING_INTERNALS.md#harness-version']) expect(message).toContain(text);
    expect(hasDrift(harnessDrift(base, files({ 'a.ts': 'a1', 'b.ts': 'b1' })))).toBe(false);
  });

  test('a bump raises the version and re-pins every file; a non-behavioral decision records only the touched files', () => {
    const now = files({ 'a.ts': 'a2', 'b.ts': 'b1', 'c.ts': 'c1' });
    expect(decide(base, now, 'bump', 'session runner now kills stalled streams')).toEqual({ version: 4, patterns: [],
      files: { 'a.ts': { blob: 'a2', since: 4 }, 'b.ts': { blob: 'b1', since: 4 }, 'c.ts': { blob: 'c1', since: 4 } } });
    expect(decide(base, now, 'non-behavioral', 'rename a local variable')).toEqual({ version: 3, patterns: [],
      files: { 'a.ts': { blob: 'a2', since: 3, nonBehavioral: 'rename a local variable' }, 'b.ts': { blob: 'b1', since: 2 },
        'c.ts': { blob: 'c1', since: 3, nonBehavioral: 'rename a local variable' } } });
    expect(() => decide(base, now, 'bump', 'short')).toThrow('reason');
  });

  const copyManifest = (into: string) => {
    fs.cpSync(path.join(ROOT, MANIFEST), path.join(into, MANIFEST));
    fs.cpSync(path.join(ROOT, PINS_DIR), path.join(into, PINS_DIR), { recursive: true });
  };

  test('the manifest writes one pin file per harness file under scripts/harness-pins and reads back unchanged (GST-1084)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pins-'));
    try {
      copyManifest(dir);
      expect(readManifest(dir)).toEqual(readManifest(ROOT));
      const next: HarnessManifest = { version: 3, patterns: ['test/helpers/x/**'], files: { 'z.ts': { blob: 'z', since: 1 }, 'test/a.ts': { blob: 'a', since: 1, nonBehavioral: 'why' } } };
      writeManifest(dir, next);
      expect(readManifest(dir)).toEqual(next);
      expect(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')).toBe('{\n  "version": 3,\n  "patterns": [\n    "test/helpers/x/**"\n  ]\n}\n');
      expect(fs.readFileSync(path.join(dir, PINS_DIR, 'test/a.ts.json'), 'utf8')).toBe('{"blob":"a","since":1,"nonBehavioral":"why"}\n');
      expect(fs.existsSync(path.join(dir, PINS_DIR, 'test/helpers/eval-store.ts.json'))).toBe(false);
      fs.writeFileSync(path.join(dir, PINS_DIR, 'z.ts.txt'), 'stray\n');
      expect(() => readManifest(dir)).toThrow('every harness pin is <pinned path>.json');
      fs.rmSync(path.join(dir, PINS_DIR, 'z.ts.txt'));
      fs.writeFileSync(path.join(dir, PINS_DIR, 'z.ts.json'), '<<<<<<< ours\n');
      expect(() => readManifest(dir)).toThrow(`${PINS_DIR}/z.ts.json: `);
      fs.writeFileSync(path.join(dir, PINS_DIR, 'z.ts.json'), '{"blob":"z","since":1}\n');
      fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify({ version: 3, patterns: [], files: {} }));
      expect(() => readManifest(dir)).toThrow('holds only version and patterns');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Value: protects=the one-file-per-pin layout still fails on every stale pin; fails_when=a pin with an old blob, a deleted pin
  //   or a pin for a file that is gone passes the guard; seam=readManifest and harnessDrift on the checkout's harness files
  test('a stale, missing or orphaned harness pin fails the guard (GST-1084)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-stale-'));
    try {
      copyManifest(dir);
      const live = readManifest(ROOT);
      const current = workingHarnessFiles(ROOT, live.patterns);
      const pin = (file: string) => path.join(dir, PINS_DIR, `${file}.json`);
      fs.writeFileSync(pin('test/helpers/eval-store.ts'), `${JSON.stringify({ ...live.files['test/helpers/eval-store.ts'], blob: '0'.repeat(40) })}\n`);
      fs.rmSync(pin('test/helpers/e2e-gate.ts'));
      fs.writeFileSync(pin('test/helpers/gone.ts'), `${JSON.stringify({ blob: '1'.repeat(40), since: live.version })}\n`);
      const drift = harnessDrift(readManifest(dir), current);
      expect(drift).toEqual({ changed: ['test/helpers/eval-store.ts'], added: ['test/helpers/e2e-gate.ts'], removed: ['test/helpers/gone.ts'] });
      expect(formatDrift(drift, live.version)).toContain(`Merge conflict in ${MANIFEST} or ${PINS_DIR}/: take the higher version, then rerun the script.`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Value: protects=a --bump that fails partway (pins written, manifest version not) cannot pass the guard with behavior pooled into the
  //   old series; fails_when=a pin ahead of the manifest version reads as no drift; seam=writeManifest failing on a real write, then harnessDrift
  test('a bump that fails partway leaves a pin ahead of the manifest version, and the guard reports it (GST-1084)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-partial-'));
    try {
      copyManifest(dir);
      const live = readManifest(dir);
      const current = workingHarnessFiles(ROOT, live.patterns);
      const [first, second] = current.map(entry => entry.file);
      const blocked = path.join(dir, PINS_DIR, `${second}.json`);
      const original = fs.readFileSync(blocked, 'utf8');
      fs.rmSync(blocked);
      fs.mkdirSync(blocked);
      expect(() => writeManifest(dir, decide(live, current, 'bump', 'behavior changed in the runner'))).toThrow();
      fs.rmdirSync(blocked);
      fs.writeFileSync(blocked, original);
      const after = readManifest(dir);
      expect(after.version).toBe(live.version);
      expect(after.files[first!]!.since).toBe(live.version + 1);
      expect(harnessDrift(after, current).changed).toEqual([first]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Value: protects=PRs that record decisions for different harness files merge without a conflict (the one-line-per-file manifest
  //   conflicted on adjacent lines and on the trailing comma); fails_when=two non-behavioral decisions on adjacent pins conflict in a
  //   real merge, or two decisions on one pin merge silently; seam=writeManifest and git merge-tree --write-tree on two branches
  test('non-behavioral decisions on two different harness files merge cleanly in a real git merge (GST-1084)', () => {
    const live = readManifest(ROOT);
    const record = (file: string, blob: string, reason: string) => (root: string) => {
      const manifest = readManifest(root);
      const files = workingHarnessFiles(ROOT, live.patterns).map(entry => entry.file === file ? { file, blob } : entry);
      writeManifest(root, decide(manifest, files, 'non-behavioral', reason));
    };
    const floor = 'test/helpers/pty/runners/floor.ts', observation = 'test/helpers/pty/runners/observation.ts';
    const merges: PinMerge[] = [];
    try {
      const clean = mergePinEdits(copyManifest, record(floor, 'a'.repeat(40), 'floor runner logging only'), record(observation, 'b'.repeat(40), 'observation runner comment only'));
      merges.push(clean);
      const conflict = mergePinEdits(copyManifest, record(floor, 'a'.repeat(40), 'floor runner logging only'), record(floor, 'c'.repeat(40), 'floor runner rename only'));
      merges.push(conflict);
      expect(clean.output).not.toContain('CONFLICT');
      expect(clean.clean).toBe(true);
      expect(JSON.parse(clean.read(`${PINS_DIR}/${floor}.json`))).toEqual({ blob: 'a'.repeat(40), since: live.version, nonBehavioral: 'floor runner logging only' });
      expect(JSON.parse(clean.read(`${PINS_DIR}/${observation}.json`))).toEqual({ blob: 'b'.repeat(40), since: live.version, nonBehavioral: 'observation runner comment only' });
      expect(clean.read(MANIFEST)).toBe(fs.readFileSync(path.join(ROOT, MANIFEST), 'utf8'));
      expect(conflict.clean).toBe(false);
      expect(conflict.output).toContain(`CONFLICT (content): Merge conflict in ${PINS_DIR}/${floor}.json`);
    } finally {
      for (const merge of merges) fs.rmSync(merge.root, { recursive: true, force: true });
    }
  });
});

describe('v2 series identity', () => {
  const registry: Registry = {
    ...LIVE_REGISTRY,
    touchfiles: {
      'qa-case': ['qa/**', 'test/skill-e2e-qa.test.ts', 'test/fixtures/qa-*.json', 'test/helpers/qa-helper.ts', 'lib/shared.ts'],
      'review-case': ['review/**', 'test/skill-e2e-review.test.ts', 'lib/shared.ts'],
    },
    judgeTouchfiles: {}, globals: ['test/helpers/session-runner.ts'],
  };
  const tree = (overrides: Record<string, string> = {}): TreeEntry[] => Object.entries({
    'qa/SKILL.md.tmpl': 't1', 'qa/SKILL.md': 'g1', 'qa/sections/run.md': 's1', 'qa/bin/helper.ts': 'h1',
    'review/SKILL.md.tmpl': 'r1', 'review/SKILL.md': 'rg1', 'test/skill-e2e-qa.test.ts': 'q1', 'test/skill-e2e-review.test.ts': 'v1',
    'test/fixtures/qa-one.json': 'f1', 'test/helpers/qa-helper.ts': 'qh1', 'lib/shared.ts': 'l1', 'test/helpers/session-runner.ts': 'sr1', ...overrides,
  }).map(([file, blob]) => ({ file, blob }));
  const ids = (entries: TreeEntry[], version = 1) => caseSeriesIdentitiesV2(['qa-case', 'review-case'], entries, registry, version);

  test('a case owns its paid test file, its fixtures and its skills\' prompt files, not helpers or skill code', () => {
    const skills = skillDirs(tree());
    expect([...skills].sort()).toEqual(['qa', 'review']);
    for (const file of ['test/skill-e2e-qa.test.ts', 'test/fixtures/qa-one.json', 'qa/SKILL.md.tmpl', 'qa/SKILL.md', 'qa/sections/run.md', 'SKILL.md.tmpl']) {
      expect(isCaseOwnedFile(file, skills), file).toBe(true);
    }
    for (const file of ['test/helpers/qa-helper.ts', 'test/helpers/x.unit.test.ts', 'lib/shared.ts', 'qa/bin/helper.ts', 'scripts/resolvers/preamble.ts']) {
      expect(isCaseOwnedFile(file, skills), file).toBe(false);
    }
  });

  test('shared helpers and globals change the provenance fingerprint, never the identity', () => {
    const first = ids(tree());
    const changes: Record<string, string>[] = [{ 'lib/shared.ts': 'l2' }, { 'test/helpers/qa-helper.ts': 'qh2' }, { 'test/helpers/session-runner.ts': 'sr2' }, { 'qa/bin/helper.ts': 'h2' }];
    for (const change of changes) {
      const next = ids(tree(change));
      expect(next['qa-case']!.identity, JSON.stringify(change)).toBe(first['qa-case']!.identity);
      expect(next['qa-case']!.fingerprint, JSON.stringify(change)).not.toBe(first['qa-case']!.fingerprint);
    }
  });

  test('owned bytes and a HARNESS_VERSION bump start a new series; other cases keep theirs', () => {
    const first = ids(tree());
    const changes: Record<string, string>[] = [{ 'test/skill-e2e-qa.test.ts': 'q2' }, { 'test/fixtures/qa-one.json': 'f2' }, { 'qa/SKILL.md': 'g2' }, { 'qa/sections/run.md': 's2' }];
    for (const change of changes) {
      const next = ids(tree(change));
      expect(next['qa-case']!.identity, JSON.stringify(change)).not.toBe(first['qa-case']!.identity);
      expect(next['review-case']!.identity).toBe(first['review-case']!.identity);
    }
    const bumped = ids(tree(), 2);
    expect(bumped['qa-case']!.identity).not.toBe(first['qa-case']!.identity);
    expect(bumped['review-case']!.identity).not.toBe(first['review-case']!.identity);
    expect(first['qa-case']!.identity).toMatch(/^[0-9a-f]{16}$/);
  });

  test('the compiled glob matches test-selection matchGlob on the live registry', () => {
    const patterns = [...new Set(Object.values(LIVE_REGISTRY.touchfiles).flat())].slice(0, 400);
    const files = ['qa/SKILL.md', 'qa/sections/a/b.md', 'test/fixtures/qa-eval.json', 'test/helpers/pty/screen.ts', 'browse/src/x.ts', 'ship/sections/review-army.md.tmpl'];
    for (const pattern of patterns) for (const file of files) expect(globRegex(pattern).test(file), `${pattern} ~ ${file}`).toBe(matchGlob(file, pattern));
  });
});

describe('v2 writer', () => {
  test('the report stamp carries the v2 identity, the full fingerprint and HARNESS_VERSION, and stays schema-valid', () => {
    const id = Object.keys(LIVE_REGISTRY.tiers).find(key => LIVE_REGISTRY.tiers[key] === 'gate')!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-stamp-'));
    const file = path.join(dir, 'trial-outcomes.jsonl');
    fs.writeFileSync(file, formatTrialOutcomes([{ schema: TRIAL_OUTCOME_SCHEMA, case: id, file: 'test/x.test.ts', tier: 'gate', kind: 'rule',
      trial: 1, panel: { n: 1, k: 1 }, attempt: 1, outcome: 'passed', duration_ms: 1, cost_usd: 0, policy_version: EVAL_POLICY.version,
      quarantined: false, execution: 'executed', source: 'junit' }]));
    expect(stampTrialSeries(file, ROOT)).toBe(1);
    const { records, errors } = parseTrialOutcomes(fs.readFileSync(file, 'utf8'));
    expect(errors).toEqual([]);
    const expected = caseSeriesIdentitiesV2([id], treeEntries(ROOT))[id]!;
    expect(records[0]).toMatchObject({ series_identity: expected.identity, series_fingerprint: expected.fingerprint, harness_version: HARNESS_VERSION,
      policy_version: EVAL_POLICY.version });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
