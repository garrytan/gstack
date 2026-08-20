import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const setup = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');

describe('setup Codex model activation', () => {
  test('exposes --model and limits it to Codex installs', () => {
    expect(setup).toContain('--model <id>');
    expect(setup).toContain('MODEL_OVERRIDE_SET=1');
    expect(setup).toContain('--model is supported only when Codex is selected');
    // The override reaches the resolver as QUOTED argv — an unquoted
    // regression would word-split/glob user input.
    expect(setup).toContain('--explicit "$MODEL_OVERRIDE"');
  });

  test('resolver runs on every setup, before any INSTALL_CODEX gate', () => {
    // A plain `./setup` (claude host) still regenerates .agents/, and live
    // ~/.codex/skills symlinks point into it — resolution must not be gated
    // on the codex host being selected, or a Sol user's profile gets
    // clobbered back to the hardcoded fallback.
    const blockStart = setup.indexOf('# Resolve the model overlay');
    const blockEnd = setup.indexOf('# 1. Build browse binary', blockStart);
    expect(blockStart).toBeGreaterThan(-1);
    const block = setup.slice(blockStart, blockEnd);
    const resolverAt = block.indexOf('_CODEX_MODEL_OUTPUT=');
    const firstGateAt = block.indexOf('INSTALL_CODEX');
    expect(resolverAt).toBeGreaterThan(-1);
    expect(firstGateAt === -1 || resolverAt < firstGateAt).toBe(true);
  });

  test('resolves the profile once, fails closed, and passes it as quoted argv', () => {
    expect(setup).toContain('scripts/resolve-codex-generation-model.ts');
    expect(setup).toContain('Codex skill profile: $CODEX_GENERATION_MODEL');
    expect(setup).toContain('Source: $CODEX_GENERATION_MODEL_SOURCE');
    expect(setup).toContain('gen:skill-docs --host codex --model "$CODEX_GENERATION_MODEL"');
    // Positive pin of the parse mechanism (an eval-shaped regression would
    // remove this line rather than merely rephrase an eval call).
    expect(setup).toContain(`IFS=$'\\t' read -r CODEX_GENERATION_MODEL CODEX_GENERATION_MODEL_SOURCE`);
    // Fail-closed: empty resolver output aborts setup, including the exit.
    const guardAt = setup.indexOf('gstack setup failed: Codex model resolver returned no model');
    expect(guardAt).toBeGreaterThan(-1);
    expect(setup.slice(guardAt, guardAt + 200)).toContain('exit 1');
  });

  test('regenerates Codex after both fresh and stale build paths', () => {
    const generationStart = setup.indexOf('# 1b. Generate .agents/ Codex skill docs');
    const generationEnd = setup.indexOf('# 1c. Generate .factory/', generationStart);
    const block = setup.slice(generationStart, generationEnd);
    expect(block).toContain('if [ "$NEEDS_AGENTS_GEN" -eq 1 ]; then');
    expect(block).not.toContain('NEEDS_BUILD" -eq 0');
  });

  test('fallback generation and handoff preserve the selected profile', () => {
    const linkStart = setup.indexOf('link_codex_skill_dirs()');
    const linkEnd = setup.indexOf('create_agents_sidecar()', linkStart);
    const block = setup.slice(linkStart, linkEnd);
    expect(block).toContain('gen:skill-docs --host codex --model "$CODEX_GENERATION_MODEL"');
    expect(block).toContain('gen:skill-docs --host codex --model $CODEX_GENERATION_MODEL');
    expect(setup).toContain('model changes: rerun ./setup --host codex');
    expect(setup).toContain('model profile: $CODEX_GENERATION_MODEL');
  });

  test('Kiro copies a claude-profile render, then restores the Codex profile', () => {
    // Kiro fronts Claude-family models (hosts/kiro.ts defaultModel: 'claude')
    // but builds from the codex-shaped .agents render — the copy must happen
    // against a claude-overlay render, and the resolved Codex profile must be
    // restored afterward so ~/.codex/skills symlinks stay correct.
    const kiroStart = setup.indexOf('# 6. Install for Kiro CLI');
    const kiroEnd = setup.indexOf('# 6b.', kiroStart);
    expect(kiroStart).toBeGreaterThan(-1);
    const block = setup.slice(kiroStart, kiroEnd);
    const claudeRenderAt = block.indexOf('gen:skill-docs --host codex --model claude');
    const restoreAt = block.indexOf('gen:skill-docs --host codex --model "$CODEX_GENERATION_MODEL"');
    expect(claudeRenderAt).toBeGreaterThan(-1);
    expect(restoreAt).toBeGreaterThan(claudeRenderAt);
  });

  test('Kiro rewrites the codex-rendered SETUP_COMMAND and never symlinks gstack-upgrade', () => {
    // The artifact Kiro copies was rendered for the codex host, so its
    // gstack-upgrade skill bakes in './setup --host codex'. Every copy path
    // must rewrite it to '--host kiro', and the KIRO_GSTACK gstack-upgrade
    // file must be a sed COPY (a symlink would track .agents after the
    // Codex-profile restore — wrong overlay AND wrong reinstall host).
    const kiroStart = setup.indexOf('# 6. Install for Kiro CLI');
    const kiroEnd = setup.indexOf('# 6b.', kiroStart);
    const block = setup.slice(kiroStart, kiroEnd);
    const rewrites = block.split('\\./setup --host codex|./setup --host kiro').length - 1;
    expect(rewrites).toBeGreaterThanOrEqual(3);
    expect(block).not.toContain('_link_or_copy "$AGENTS_DIR/gstack-upgrade/SKILL.md"');
  });

  test('Codex skills path honors CODEX_HOME', () => {
    expect(setup).toContain('CODEX_SKILLS="${CODEX_HOME:-$HOME/.codex}/skills"');
  });

  test('--model prints the one-shot persistence note', () => {
    expect(setup).toContain('--model applies to this run only');
  });
});

describe('Codex E2E hermetic model pin', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'test', 'helpers', 'codex-session-runner.ts'), 'utf8');

  test('copies authentication only and can ignore operator config', () => {
    expect(runner).toContain("for (const entry of ['auth.json'])");
    expect(runner).toContain("if (ignoreUserConfig) args.push('--ignore-user-config')");
    expect(runner).toContain('CODEX_HOME: tempCodexDir');
    expect(runner).not.toContain("if (entry === 'skills') continue");
  });
});

describe('Sol E2E tree hygiene', () => {
  const solTest = fs.readFileSync(path.join(ROOT, 'test', 'codex-e2e-sol-scope.test.ts'), 'utf8');

  test('snapshots and restores the exact prior .agents tree around the Sol render', () => {
    // The Sol render must not persist in the shared .agents tree (host-config
    // golden, parallel shard worktree copies, live symlinked installs) — and
    // the restore must be the operator's EXACT prior render, not a forced
    // default profile.
    const backupAt = solTest.indexOf('gstack-agents-backup-');
    const solRenderAt = solTest.indexOf("'--model', 'gpt-5.6-sol'");
    const restoreAt = solTest.indexOf('fs.cpSync(priorAgentsBackup, agentsDir');
    expect(backupAt).toBeGreaterThan(-1);
    expect(solRenderAt).toBeGreaterThan(backupAt);
    expect(restoreAt).toBeGreaterThan(solRenderAt);
    // Scope-widening detection must see untracked + staged files, not just
    // unstaged tracked modifications.
    expect(solTest).toContain("['status', '--porcelain']");
    expect(solTest).not.toContain("['diff', '--name-only']");
    // The fixture seed commit must survive global commit.gpgsign=true.
    expect(solTest).toContain("['config', 'commit.gpgsign', 'false']");
  });
});
