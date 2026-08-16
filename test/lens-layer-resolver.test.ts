import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import {
  generateLensEarlyCommands,
  generateLensPrepare,
  generateLensLayer,
  generateLensDisposition,
} from '../scripts/resolvers/lens-layer';

const ROOT = path.resolve(import.meta.dir, '..');
const ctx: TemplateContext = {
  skillName: 'review',
  tmplPath: path.join(ROOT, 'review', 'SKILL.md.tmpl'),
  host: 'claude',
  paths: HOST_PATHS.claude,
};

describe('stakeholder lens resolver', () => {
  test('list and describe short-circuit before preamble', () => {
    const content = generateLensEarlyCommands(ctx);
    expect(content).toContain('Do not run the preamble');
    expect(content).toContain('--lens list');
    expect(content).toContain('--lens describe');
  });

  test('plain review checks mandatory policy and otherwise stays unchanged', () => {
    const content = generateLensPrepare(ctx);
    expect(content).toContain('--mode <mode>');
    expect(content).toContain('No lens flag: `mandatory`');
    expect(content).toContain('LENS_MODE=off');
    expect(content).toContain('--no-mandatory-lenses');
  });

  test('independent Stage A excludes technical and peer findings', () => {
    const content = generateLensLayer(ctx);
    expect(content).toContain('Stage A independent lens dispatch');
    expect(content).toContain('Do not pass technical findings');
    expect(content).toContain('gstack-lens-reviewer');
    expect(content).toContain('empty tool allowlist');
  });

  test('structured reconciliation does not overclaim free-text novelty', () => {
    const content = generateLensLayer(ctx);
    expect(content).toContain('Stage B structured reconciliation');
    expect(content).toContain('claim_key');
    expect(content).toContain('AMBIGUOUS');
    expect(content).toContain('NOT_MEASURED');
  });

  test('CTO synthesis is a separate constrained stage', () => {
    const content = generateLensLayer(ctx);
    expect(content).toContain('Stage C CTO synthesis');
    expect(content).toContain('A CTO is not another lens');
    expect(content).toContain('gstack-cto-synthesizer');
    expect(content).toContain('cannot read repository content');
    expect(content).toContain('gstack-lens-synthesis-validate --input <synthesis-input.json> --output <synthesis-output.json>');
    expect(content).not.toContain('--synthesis <synthesis-output.json>');
  });

  test('lens-only skips Review Army without changing core Step 4', () => {
    const content = generateLensPrepare(ctx);
    expect(content).toContain('skip the complete Review Army section');
    expect(content).toContain('Core Step 4 still runs');
  });

  test('disposition separates validity, relevance, decision, and routing feedback', () => {
    const content = generateLensDisposition(ctx);
    expect(content).toContain('validity');
    expect(content).toContain('relevance');
    expect(content).toContain('routing_feedback');
    expect(content).not.toContain('Accept everything');
  });

  test('managed Claude agents declare an empty tool allowlist', () => {
    for (const name of ['gstack-lens-reviewer', 'gstack-lens-output-validator', 'gstack-cto-synthesizer']) {
      const content = fs.readFileSync(path.join(ROOT, 'hosts', 'claude', 'agents', `${name}.md`), 'utf8');
      expect(content).toContain('tools: []');
      expect(content).toContain('permissionMode: dontAsk');
      expect(content).toContain('gstack-managed-agent');
    }
  });

  test('setup installs the managed Claude agents', () => {
    const setup = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');
    expect(setup).toContain('install_claude_managed_agents');
    expect(setup).toContain('hosts/claude/agents');
  });

  test('generated review skill contains lens sections and no placeholders', () => {
    const content = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf8');
    expect(content).toContain('## Step 4.7: Stakeholder Lens Layer');
    expect(content).toContain('## Step 5e: Stakeholder lens disposition');
    expect(content).not.toMatch(/\{\{LENS_[A-Z_]+\}\}/);
  });
});
