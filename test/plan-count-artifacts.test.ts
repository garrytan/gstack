import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPlanCountSnapshotWriter, persistPlanCountSnapshot } from './helpers/plan-count-artifacts';

const input = {
  skillName: 'plan-design-review', observation: { outcome: 'timeout', reviewCount: 3 },
  raw: '\x1b[2JSTART\r' + 'raw-frame\r'.repeat(2000) + '\x1b[31mEND',
  visible: 'START\r' + 'visible-frame\r'.repeat(2000) + 'END',
  cwd: '/temporary/count-fixture', claudeConfigDir: '/temporary/claude-config',
};

describe('plan-count diagnostic artifacts', () => {
  test('refreshes one in-progress attempt through final outcome without keeping old copies', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-count-artifacts-'));
    try {
      const save = createPlanCountSnapshotWriter({ EVALS_RUN_ID: 'checkpoint', GSTACK_EVAL_DIR: root });
      const progress = save({ ...input, observation: { state: 'in_progress', reviewCount: 1 } });
      const recordPath = path.join(progress.artifactDir!, 'observation.json');
      expect(JSON.parse(fs.readFileSync(recordPath, 'utf8'))).toMatchObject({ state: 'in_progress', reviewCount: 1 });
      const final = save({ ...input, raw: input.raw + '\nlast question', observation: { outcome: 'completion_summary', reviewCount: 5 } });
      expect(final.artifactDir).toBe(progress.artifactDir);
      const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      expect(record).toMatchObject({ outcome: 'completion_summary', reviewCount: 5 });
      expect(record.state).toBeUndefined();
      expect(fs.readdirSync(final.artifactDir!).sort()).toEqual(['observation.json', 'terminal.raw.log', 'terminal.visible.log']);
      expect(fs.readFileSync(path.join(final.artifactDir!, 'terminal.raw.log'), 'utf8')).toBe(input.raw + '\nlast question');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  test('keeps complete output and distinct retry records in the configured eval directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-count-artifacts-'));
    try {
      const env = { EVALS_RUN_ID: 'same-run', GSTACK_EVAL_DIR: root };
      const first = persistPlanCountSnapshot(input, env);
      const second = persistPlanCountSnapshot({ ...input, raw: 'retry' }, env);
      expect(first.artifactError).toBeUndefined();
      expect(second.artifactError).toBeUndefined();
      expect(first.artifactDir).not.toBe(second.artifactDir);
      expect(path.relative(root, first.artifactDir!)).toStartWith(path.join('pty-count', 'same-run'));
      expect(fs.readFileSync(path.join(first.artifactDir!, 'terminal.raw.log'), 'utf8')).toBe(input.raw);
      expect(fs.readFileSync(path.join(first.artifactDir!, 'terminal.visible.log'), 'utf8')).toBe(input.visible);
      const record = JSON.parse(fs.readFileSync(path.join(first.artifactDir!, 'observation.json'), 'utf8'));
      expect(record).toMatchObject({ ...input.observation, artifactDir: first.artifactDir,
        capture: { skill: input.skillName, cwd: input.cwd, claudeConfigDir: input.claudeConfigDir } });
      expect(fs.readFileSync(path.join(second.artifactDir!, 'terminal.raw.log'), 'utf8')).toBe('retry');
      if (process.platform !== 'win32') {
        expect(fs.statSync(path.join(first.artifactDir!, 'terminal.raw.log')).mode & 0o777).toBe(0o600);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('does not persist ordinary free runs without EVALS_RUN_ID', () => {
    const missing = path.join(os.tmpdir(), `unused-count-artifacts-${crypto.randomUUID()}`);
    expect(persistPlanCountSnapshot(input, { GSTACK_EVAL_DIR: missing })).toEqual({});
    expect(fs.existsSync(missing)).toBe(false);
  });

  test('keeps run and skill identifiers within the owned artifact directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-count-artifacts-'));
    try {
      const saved = persistPlanCountSnapshot({ ...input, skillName: '../../other' }, {
        EVALS_RUN_ID: '../outside', GSTACK_EVAL_DIR: root,
      });
      expect(saved.artifactError).toBeUndefined();
      expect(path.relative(root, saved.artifactDir!)).not.toStartWith('..');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('reports a diagnostic write failure without replacing the original observation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-count-artifacts-'));
    const file = path.join(root, 'file');
    fs.writeFileSync(file, 'unchanged');
    try {
      const result = persistPlanCountSnapshot(input, { EVALS_RUN_ID: 'run', GSTACK_EVAL_DIR: file });
      expect(result.artifactError).toBeDefined();
      expect(input.observation).toEqual({ outcome: 'timeout', reviewCount: 3 });
      expect(fs.readFileSync(file, 'utf8')).toBe('unchanged');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
