import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_ROLE_CONFIGS,
  applyEnvRoleConfig,
  cloneRoleConfigs,
  migrateLegacyModels,
} from '../role-config';
import {
  BUILD_DEFAULTS,
  DEFAULT_BUILD_CONFIG_FILE,
  loadBuildDefaults,
} from '../build-config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('role config defaults', () => {
  it('loads defaults from the tracked build config file', () => {
    const loaded = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
    expect(path.basename(DEFAULT_BUILD_CONFIG_FILE)).toBe('configure.cm');
    expect(loaded.roles.primaryImpl.model).toBeTruthy();
    expect(loaded.limits.codexMaxIterations).toBe(5);
    expect(loaded.timeoutsMs.gemini).toBe(600000);
    expect(BUILD_DEFAULTS.roles.primaryImpl.model).toBe(loaded.roles.primaryImpl.model);
  });

  it('matches the default build routing', () => {
    expect(DEFAULT_ROLE_CONFIGS.testWriter).toEqual(BUILD_DEFAULTS.roles.testWriter);
    expect(DEFAULT_ROLE_CONFIGS.primaryImpl).toEqual(BUILD_DEFAULTS.roles.primaryImpl);
    expect(DEFAULT_ROLE_CONFIGS.testFixer).toEqual(BUILD_DEFAULTS.roles.testFixer);
    expect(DEFAULT_ROLE_CONFIGS.reviewSecondary).toEqual(BUILD_DEFAULTS.roles.reviewSecondary);
    expect(DEFAULT_ROLE_CONFIGS.ship.command).toBe('/gstack-ship');
    expect(DEFAULT_ROLE_CONFIGS.land.command).toBe('/gstack-land-and-deploy');
    expect(DEFAULT_ROLE_CONFIGS.contextSave.command).toBe('/context-save');
  });
});

describe('role config precedence helpers', () => {
  it('can load an alternate config file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-build-config-'));
    try {
      const file = path.join(dir, 'configure.cm');
      const defaults = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
      defaults.roles.primaryImpl.model = 'gemini-custom-preview';
      defaults.limits.codexMaxIterations = 7;
      fs.writeFileSync(file, JSON.stringify(defaults, null, 2));

      const loaded = loadBuildDefaults(file);
      expect(loaded.roles.primaryImpl.model).toBe('gemini-custom-preview');
      expect(loaded.limits.codexMaxIterations).toBe(7);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fills new roles when loading an older alternate config file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-build-config-'));
    try {
      const file = path.join(dir, 'configure.cm');
      const defaults = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
      delete (defaults.roles as any).contextSave;
      fs.writeFileSync(file, JSON.stringify(defaults, null, 2));
      const loaded = loadBuildDefaults(file);
      expect(loaded.roles.contextSave).toEqual(DEFAULT_ROLE_CONFIGS.contextSave);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid config files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-build-config-'));
    try {
      const file = path.join(dir, 'bad.configure.cm');
      const defaults = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
      (defaults.roles.primaryImpl as any).provider = 'bad-provider';
      fs.writeFileSync(file, JSON.stringify(defaults, null, 2));

      expect(() => loadBuildDefaults(file)).toThrow('roles.primaryImpl.provider');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies env overrides over defaults', () => {
    const roles = applyEnvRoleConfig(cloneRoleConfigs(), {
      GSTACK_BUILD_SHIP_MODEL: 'gpt-5.4',
      GSTACK_BUILD_SHIP_REASONING: 'medium',
      GSTACK_BUILD_SHIP_COMMAND: '/custom-ship',
    });
    expect(roles.ship.model).toBe('gpt-5.4');
    expect(roles.ship.reasoning).toBe('medium');
    expect(roles.ship.command).toBe('/custom-ship');
  });

  it('fills new roles when migrating an older persisted role config', () => {
    const roles = cloneRoleConfigs({
      primaryImpl: {
        ...DEFAULT_ROLE_CONFIGS.primaryImpl,
        model: 'gemini-old-state',
      },
    });
    expect(roles.primaryImpl.model).toBe('gemini-old-state');
    expect(roles.contextSave).toEqual(DEFAULT_ROLE_CONFIGS.contextSave);
  });

  it('migrates old model fields into roleConfigs', () => {
    const roles = migrateLegacyModels({
      geminiModel: 'gemini-legacy',
      codexModel: 'codex-legacy',
      codexReviewModel: 'review-legacy',
    });
    expect(roles.primaryImpl.model).toBe('gemini-legacy');
    expect(roles.secondaryImpl.model).toBe('codex-legacy');
    expect(roles.reviewSecondary.model).toBe('review-legacy');
  });
});
