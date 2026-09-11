import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  commitSectionBatch,
  parseSectionDeliveryArgs,
  prepareSectionBatch,
  selectSectionBatch,
} from '../lib/section-delivery';

function sha256(bytes: string | Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

function fixture(runId = 'run-section'): {
  root: string;
  runtimeRoot: string;
  stateRoot: string;
  repositoryRoot: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-section-delivery-'));
  const runtimeRoot = path.join(root, 'runtime');
  const stateRoot = path.join(root, 'state');
  const repositoryRoot = path.join(root, 'repo');
  const content = '<!-- AUTO-GENERATED from review-army.md.tmpl -->\n# Review Army\n';
  const relative = '.agents/skills/gstack-review/sections/review-army.md';
  fs.mkdirSync(path.join(runtimeRoot, 'sections/review'), { recursive: true });
  fs.mkdirSync(path.join(stateRoot, 'ecpe/inflight'), { recursive: true });
  fs.mkdirSync(path.join(stateRoot, 'projects/repo-1'), { recursive: true });
  fs.mkdirSync(repositoryRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, 'sections/review/review-army.md'), content);
  fs.writeFileSync(path.join(runtimeRoot, '.ecpe-installed-runtime.json'), JSON.stringify({
    schema: 'ecpe.gstack-runtime.v1',
    artifacts: { [relative]: { sha256: sha256(content), size: Buffer.byteLength(content), mode: 0o644 } },
  }));
  fs.writeFileSync(path.join(stateRoot, 'ecpe/inflight', `${runId}.json`), JSON.stringify({
    schema: 'ecpe.lifecycle-inflight.v1',
    run_id: runId,
    slug: 'repo-1',
    skill: 'review',
    branch: 'main',
    repository_root: fs.realpathSync(repositoryRoot),
    contract: { work_kind: 'review', finish_line: 'review_receipt' },
  }));
  return { root, runtimeRoot, stateRoot, repositoryRoot };
}

describe('compiled section delivery boundary', () => {
  test('accepts only compiled skill/stage IDs and exact CLI flags', () => {
    expect(selectSectionBatch('review', 'review-army')).toEqual(['review-army']);
    expect(() => selectSectionBatch('review', '../../review-army')).toThrow('section_stage_unknown');
    expect(parseSectionDeliveryArgs(['resolve', '--skill', 'review', '--stage', 'review-army', '--json']))
      .toEqual({ skill: 'review', stage: 'review-army', json: true });
    for (const forbidden of ['--section', '--path', '--hash', '--content', '--run-id']) {
      expect(() => parseSectionDeliveryArgs(['resolve', '--skill', 'review', '--stage', 'review-army', forbidden, 'x']))
        .toThrow('section_argument_invalid');
    }
  });

  test('verifies installed bytes, sorts/deduplicates, and permits one batch per stage', () => {
    const f = fixture();
    const prepared = prepareSectionBatch({
      runtimeRoot: f.runtimeRoot,
      stateRoot: f.stateRoot,
      repositoryRoot: f.repositoryRoot,
      skill: 'review',
      stage: 'review-army',
    });
    expect(prepared.output.sections.map(section => section.id)).toEqual(['review-army']);
    expect(prepared.output.sections[0].content).toContain('# Review Army');
    expect(() => prepareSectionBatch({
      runtimeRoot: f.runtimeRoot,
      stateRoot: f.stateRoot,
      repositoryRoot: f.repositoryRoot,
      skill: 'review',
      stage: 'review-army',
    })).toThrow('section_batch_already_delivered');
  });

  test('serves a Claude source-layout section attested by the installed manifest', () => {
    const f = fixture('run-source-layout');
    const content = fs.readFileSync(path.join(f.runtimeRoot, 'sections/review/review-army.md'), 'utf8');
    fs.rmSync(path.join(f.runtimeRoot, 'sections'), { recursive: true });
    const sourceFile = path.join(f.runtimeRoot, 'review/sections/review-army.md');
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, content);
    fs.writeFileSync(path.join(f.runtimeRoot, '.ecpe-installed-runtime.json'), JSON.stringify({
      schema: 'ecpe.gstack-runtime.v1',
      artifacts: { 'review/sections/review-army.md': { sha256: sha256(content), size: Buffer.byteLength(content), mode: 0o644 } },
    }));
    const prepared = prepareSectionBatch({
      runtimeRoot: f.runtimeRoot,
      stateRoot: f.stateRoot,
      repositoryRoot: f.repositoryRoot,
      skill: 'review',
      stage: 'review-army',
    });
    expect(prepared.output.sections[0].content).toBe(content);
  });

  test('rejects a direct/manual section mutation even when the caller never supplies a hash', () => {
    const f = fixture();
    fs.appendFileSync(path.join(f.runtimeRoot, 'sections/review/review-army.md'), 'tampered\n');
    expect(() => prepareSectionBatch({
      runtimeRoot: f.runtimeRoot,
      stateRoot: f.stateRoot,
      repositoryRoot: f.repositoryRoot,
      skill: 'review',
      stage: 'review-army',
    })).toThrow('installed_section_mismatch');
  });

  test('rejects manifest-attested section bytes that are not valid UTF-8', () => {
    const f = fixture('run-invalid-utf8');
    const file = path.join(f.runtimeRoot, 'sections/review/review-army.md');
    const bytes = Buffer.from([0x23, 0x20, 0xc3, 0x28, 0x0a]);
    fs.writeFileSync(file, bytes);
    fs.writeFileSync(path.join(f.runtimeRoot, '.ecpe-installed-runtime.json'), JSON.stringify({
      schema: 'ecpe.gstack-runtime.v1',
      artifacts: {
        '.agents/skills/gstack-review/sections/review-army.md': {
          sha256: sha256(bytes),
          size: bytes.length,
          mode: 0o644,
        },
      },
    }));
    expect(() => prepareSectionBatch({
      runtimeRoot: f.runtimeRoot,
      stateRoot: f.stateRoot,
      repositoryRoot: f.repositoryRoot,
      skill: 'review',
      stage: 'review-army',
    })).toThrow('installed_section_encoding_invalid');
  });

  test('commits one atomic terminal batch only after delivery output is emitted', () => {
    const f = fixture('run-complete');
    const prepared = prepareSectionBatch({
      runtimeRoot: f.runtimeRoot,
      stateRoot: f.stateRoot,
      repositoryRoot: f.repositoryRoot,
      skill: 'review',
      stage: 'review-army',
    });
    const timeline = path.join(f.stateRoot, 'projects/repo-1/timeline.jsonl');
    expect(fs.existsSync(timeline)).toBe(false);
    const emitted = JSON.stringify(prepared.output);
    expect(emitted).toContain('# Review Army');
    commitSectionBatch(prepared);
    const entries = fs.readFileSync(timeline, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const observations = entries.map(entry => entry.ecpe);
    expect(observations.filter(item => item.kind === 'section_load')).toHaveLength(1);
    expect(observations.filter(item => item.kind === 'authority_call')).toHaveLength(1);
    expect(observations[0].authority_call.authority_processes).toBe(1);
    expect(observations.at(-1).section_load.delivery_batch_id).toBe(prepared.batchId);
  });
});
