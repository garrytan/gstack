import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';

describe('generated anchor projection', () => {
  test('governed generated skills name one host-specific anchor without cwd fallback', () => {
    for (const skill of ['review', 'ship', 'land-and-deploy', 'setup-deploy']) {
      const body = fs.readFileSync(`${skill}/SKILL.md`, 'utf8');
      const line = body.split('\n').find((item) => item.includes('GSTACK_ANCHOR_INVOCATION='));
      expect(line).toContain('/gstack-anchor');
      expect(line).not.toContain('GSTACK_HOME');
      expect(line).not.toContain('$PWD');
    }
  });

  test('Codex carved pointers use only compiled skill/stage IDs', () => {
    const body = fs.readFileSync('.agents/skills/gstack-review/SKILL.md', 'utf8');
    expect(body).toContain('gstack-section-delivery resolve --skill review --stage review-army --json');
    expect(body).not.toContain('gstack-section-delivery resolve --path');
    expect(body).not.toContain('gstack-section-delivery resolve --section');
  });

  test('project identity is exposed only through the installed authority anchor', () => {
    const registry = fs.readFileSync('lib/authority-command-registry.ts', 'utf8');
    const wrapper = fs.readFileSync('bin/gstack-project-identity', 'utf8');
    expect(registry).toContain("'gstack-project-identity': 'scripts/authority/project-identity.ts'");
    expect(wrapper).toContain('gstack-anchor" gstack-project-identity');
    expect(wrapper).not.toContain('bun -e');
  });

  test('profile, manifest, plan, and validator runtime use only installed authority bundles', () => {
    const registry = fs.readFileSync('lib/authority-command-registry.ts', 'utf8');
    for (const command of ['gstack-work-profile', 'gstack-semantic-manifest', 'gstack-execution-plan', 'gstack-validator-runtime']) {
      expect(registry).toContain(`'${command}': 'scripts/authority/`);
      const wrapper = fs.readFileSync(`bin/${command}`, 'utf8');
      expect(wrapper).toContain(`gstack-anchor\" ${command}`);
      expect(wrapper).not.toContain('bun -e');
    }
  });

  test('review reads and dependency/candidate adapters use installed authority bundles', () => {
    const registry = fs.readFileSync('lib/authority-command-registry.ts', 'utf8');
    for (const command of ['gstack-review-read', 'gstack-counterpart-proof', 'gstack-candidate-preview']) {
      expect(registry).toContain(`'${command}': 'scripts/authority/`);
      const wrapper = fs.readFileSync(`bin/${command}`, 'utf8');
      expect(wrapper).toContain(`gstack-anchor" ${command}`);
    }
  });

  test('release tools are registered and the title compatibility wrapper delegates to the anchor', () => {
    const registry = fs.readFileSync('lib/authority-command-registry.ts', 'utf8');
    for (const command of ['gstack-next-version', 'gstack-version-bump', 'gstack-pr-title-rewrite']) {
      expect(registry).toContain(`'${command}':`);
    }
    const wrapper = fs.readFileSync('bin/gstack-pr-title-rewrite.sh', 'utf8');
    expect(wrapper).toContain('gstack-anchor" gstack-pr-title-rewrite');
    expect(wrapper).not.toContain('sed -E');
    expect(wrapper).not.toContain('bun ');
  });

  test('ShipReceipt inspection is exposed through a narrow installed authority bundle',()=>{
    const registry=fs.readFileSync('lib/authority-command-registry.ts','utf8');
    const readiness=fs.readFileSync('land-and-deploy/sections/readiness-gate.md.tmpl','utf8');
    expect(registry).toContain("'gstack-ship-handoff': 'scripts/authority/ship-handoff.ts'");
    expect(readiness).toContain('$GSTACK_ANCHOR_INVOCATION gstack-ship-handoff inspect');
    expect(readiness).not.toContain('bin/gstack-evidence handoff-inspect');
  });

  test('ship canary readiness uses a narrow installed authority bundle',()=>{
    const registry=fs.readFileSync('lib/authority-command-registry.ts','utf8');
    const readiness=fs.readFileSync('land-and-deploy/sections/readiness-gate.md.tmpl','utf8');
    expect(registry).toContain("'gstack-lane-canary': 'scripts/authority/lane-canary.ts'");
    expect(readiness).toContain('$GSTACK_ANCHOR_INVOCATION gstack-lane-canary inspect');
    expect(readiness).not.toContain('gstack-evidence lane-canary inspect');
  });
});
