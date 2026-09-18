import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { ALL_HOST_CONFIGS } from '../hosts';
import { generateAutoplanPublicationHook } from '../scripts/resolvers/composition';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';

const owned: string[] = [];
afterEach(() => { for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true }); });

function context(host: TemplateContext['host']): TemplateContext {
  return { host, paths: HOST_PATHS[host], skillName: 'autoplan', tmplPath: 'autoplan/SKILL.md.tmpl', model: 'claude' };
}

function hookCommand(): string {
  const parsed = Bun.YAML.parse(generateAutoplanPublicationHook(context('claude'))) as any;
  expect(Object.keys(parsed.hooks)).toEqual(['PreToolUse']);
  expect(parsed.hooks.PreToolUse.map((entry: any) => entry.matcher)).toEqual(['Read', 'Agent']);
  for (const entry of parsed.hooks.PreToolUse) {
    expect(entry.hooks).toHaveLength(1);
    expect(entry.hooks[0].type).toBe('command');
    expect(entry.hooks[0].command).toBe(parsed.hooks.PreToolUse[0].hooks[0].command);
  }
  return parsed.hooks.PreToolUse[0].hooks[0].command;
}

describe('Autoplan publication hook generation', () => {
  test('only Claude receives the scoped Read and Agent hook', () => {
    expect(hookCommand()).toContain('/autoplan/bin/phase-publication-hook');
    for (const host of ALL_HOST_CONFIGS) {
      if (host.name !== 'claude') expect(generateAutoplanPublicationHook(context(host.name))).toBe('');
    }
    expect(() => generateAutoplanPublicationHook({ ...context('claude'), skillName: 'review' })).toThrow();
    expect(() => generateAutoplanPublicationHook(context('claude'), ['unexpected'])).toThrow();
  });

  test('a missing installation returns an explicit native denial', () => {
    const fixtureHome = mkdtempSync(join(tmpdir(), 'autoplan-hook-missing-'));
    owned.push(fixtureHome);
    const result = spawnSync('bash', ['-c', hookCommand()], {
      env: { ...process.env, HOME: fixtureHome }, input: '{}', encoding: 'utf8', timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    expect(output.hookEventName).toBe('PreToolUse');
    expect(output.permissionDecision).toBe('deny');
    expect(output.permissionDecisionReason).toContain('guard is unavailable');
  });

  test('the generated command preserves stdin and paths with spaces', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'autoplan-hook-command-'));
    owned.push(fixtureRoot);
    const fixtureHome = join(fixtureRoot, "home with space and 'quote");
    const bin = join(fixtureHome, '.claude/skills/gstack/autoplan/bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'phase-publication-hook'), '#!/usr/bin/env bash\ncat\n');
    const input = JSON.stringify({ session_id: 'fixture-session', tool_name: 'Read', tool_input: { file_path: '/fixture/phase.md' } });
    const result = spawnSync('bash', ['-c', hookCommand()], {
      env: { ...process.env, HOME: fixtureHome }, input, encoding: 'utf8', timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(input);
  });
});
