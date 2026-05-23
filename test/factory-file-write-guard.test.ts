import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { evaluateFactoryFileWriteSafety, type FactoryFileWriteIntent } from '../lib/factory-file-write-guard';
import type { CommandSafetyProfile } from '../lib/factory-core';

const ROOT = '/repo';

function guard(
  target: string,
  options: {
    readonly profile?: CommandSafetyProfile;
    readonly intent?: FactoryFileWriteIntent;
    readonly targetExists?: boolean;
    readonly oldContentMatched?: boolean;
    readonly explicitReason?: string;
    readonly runId?: string;
    readonly workspaceRoot?: string;
  } = {},
) {
  const intent = options.intent ?? 'create';
  const targetExists = Object.prototype.hasOwnProperty.call(options, 'targetExists')
    ? options.targetExists
    : intent === 'create' ? false : undefined;
  return evaluateFactoryFileWriteSafety({
    absolutePath: target.startsWith('/') ? target : path.join(ROOT, target),
    workspaceRoot: options.workspaceRoot ?? ROOT,
    profile: options.profile ?? 'non-destructive-write',
    intent,
    targetExists,
    oldContentMatched: options.oldContentMatched,
    explicitReason: options.explicitReason,
    context: { workflowId: 'qa-fix', phaseId: 'qa-execution', runId: options.runId ?? 'run-1' },
  });
}

describe('factory file write guard', () => {
  test('allows source, test, and docs writes under non-destructive-write', () => {
    expect(guard('lib/new-helper.ts')).toMatchObject({ allowed: true, matchedRuleId: 'source-test-docs-allowlist' });
    expect(guard('test/new-helper.test.ts')).toMatchObject({ allowed: true, matchedRuleId: 'source-test-docs-allowlist' });
    expect(guard('docs/designs/new-plan.md')).toMatchObject({ allowed: true, matchedRuleId: 'source-test-docs-allowlist' });
    expect(guard('browse/src/commands.ts', { intent: 'overwrite', targetExists: true })).toMatchObject({ allowed: true, matchedRuleId: 'source-test-docs-allowlist' });
  });

  test('denies writes outside the workspace root, including canonical symlink escapes', () => {
    expect(guard('/tmp/outside.ts')).toMatchObject({ allowed: false, matchedRuleId: 'outside-workspace-path' });
    // The host must feed the canonical realpath. If a symlink in /repo points
    // to /tmp/outside.ts, the classifier sees /tmp/outside.ts and denies it.
    expect(guard('/tmp/outside-from-symlink.ts')).toMatchObject({ allowed: false, matchedRuleId: 'outside-workspace-path' });
  });

  test('denies traversal, backslash, and non-absolute paths before policy allowlists', () => {
    expect(evaluateFactoryFileWriteSafety({
      absolutePath: '/repo/../other/file.ts',
      workspaceRoot: ROOT,
      profile: 'non-destructive-write',
      intent: 'create',
    })).toMatchObject({ allowed: false, matchedRuleId: 'path-traversal' });
    expect(evaluateFactoryFileWriteSafety({
      absolutePath: 'C:\\repo\\file.ts',
      workspaceRoot: ROOT,
      profile: 'non-destructive-write',
      intent: 'create',
    })).toMatchObject({ allowed: false, matchedRuleId: 'non-absolute-path' });
    expect(evaluateFactoryFileWriteSafety({
      absolutePath: 'relative/file.ts',
      workspaceRoot: ROOT,
      profile: 'non-destructive-write',
      intent: 'create',
    })).toMatchObject({ allowed: false, matchedRuleId: 'non-absolute-path' });
  });

  test('denies protected files and protected directories', () => {
    for (const target of [
      'CLAUDE.md',
      'package-lock.json',
      'package.json',
      'bun.lock',
      'pnpm-lock.yaml',
      'yarn.lock',
      'Cargo.lock',
    ]) {
      expect(guard(target), target).toMatchObject({ allowed: false, matchedRuleId: 'protected-file' });
    }

    for (const target of [
      '.git/config',
      '.pi/extensions/pi-gstack/index.ts',
      '.agents/skills/foo/SKILL.md',
      '.claude/settings.json',
    ]) {
      expect(guard(target), target).toMatchObject({ allowed: false, matchedRuleId: 'protected-directory' });
    }
  });

  test('denies secret-looking paths for every intent', () => {
    for (const target of [
      '.env',
      '.env.local',
      'src/.env.production',
      'secrets/api.json',
      'config/credentials-prod.json',
      '.ssh/id_ed25519',
      'env-master/prod.env',
      '.npmrc.local',
    ]) {
      expect(guard(target), target).toMatchObject({ allowed: false, matchedRuleId: 'secret-path' });
    }
  });

  test('denies hidden bootstrap dotfiles at the workspace root', () => {
    expect(guard('.gitignore')).toMatchObject({ allowed: false, matchedRuleId: 'hidden-bootstrap-file' });
    expect(guard('.editorconfig')).toMatchObject({ allowed: false, matchedRuleId: 'hidden-bootstrap-file' });
  });

  test('denies generated output directories', () => {
    for (const target of [
      'lib/dist/generated.js',
      'build/output.txt',
      'node_modules/pkg/index.js',
      'app/.next/server.js',
      '.turbo/cache/file',
    ]) {
      expect(guard(target), target).toMatchObject({ allowed: false, matchedRuleId: 'generated-output-directory' });
    }
  });

  test('scopes .gstack writes to the current factory run output tree', () => {
    expect(guard('.gstack/factory/run-1/browse-output/screenshot.png')).toMatchObject({ allowed: true, matchedRuleId: 'factory-run-output' });
    expect(guard('.gstack/projects/log.jsonl')).toMatchObject({ allowed: false, matchedRuleId: 'protected-gstack-path' });
    expect(guard('.gstack/factory/other-run/browse-output/screenshot.png')).toMatchObject({ allowed: false, matchedRuleId: 'wrong-factory-run-output-path' });
    expect(guard('.gstack/factory/run-1')).toMatchObject({ allowed: false, matchedRuleId: 'factory-run-output-root' });
  });

  test('requires exact host-observed edit and overwrite intent preconditions', () => {
    expect(guard('lib/existing.ts', { intent: 'overwrite', targetExists: false })).toMatchObject({ allowed: false, matchedRuleId: 'overwrite-target-missing' });
    expect(guard('lib/new.ts', { intent: 'create', targetExists: true })).toMatchObject({ allowed: false, matchedRuleId: 'create-target-exists' });
    expect(guard('lib/new.ts', { intent: 'create', targetExists: undefined })).toMatchObject({ allowed: false, matchedRuleId: 'create-target-existence-unknown' });
    expect(guard('lib/existing.ts', { intent: 'edit-existing', targetExists: false, oldContentMatched: true })).toMatchObject({ allowed: false, matchedRuleId: 'edit-target-missing' });
    expect(guard('lib/existing.ts', { intent: 'edit-existing', targetExists: true, oldContentMatched: false })).toMatchObject({ allowed: false, matchedRuleId: 'edit-old-content-mismatch' });
    expect(guard('lib/existing.ts', { intent: 'edit-existing', targetExists: true, oldContentMatched: true })).toMatchObject({ allowed: true, matchedRuleId: 'source-test-docs-allowlist' });
  });

  test('defaults outside-allowlist writes to deny unless an explicit reason is supplied', () => {
    for (const target of [
      'README.md',
      'bin/gstack-new-helper',
      'scripts/new-helper.ts',
      'hosts/pi.ts',
      'extension/sidepanel.js',
      'supabase/functions/factory.ts',
      'contrib/add-host/new.ts',
      'openclaw/skills/example/SKILL.md',
    ]) {
      expect(guard(target), target).toMatchObject({ allowed: false, matchedRuleId: 'write-default-deny' });
      expect(guard(target, { explicitReason: 'Explicitly approved outside the default source/test/docs allowlist.' }), target).toMatchObject({ allowed: true, matchedRuleId: 'explicit-reason-allowlist' });
    }
  });

  test('denies read-only and release-action profiles', () => {
    expect(guard('lib/file.ts', { profile: 'read-only' })).toMatchObject({ allowed: false, matchedRuleId: 'write-profile-unsupported' });
    expect(guard('lib/file.ts', { profile: 'release-action' })).toMatchObject({ allowed: false, matchedRuleId: 'write-profile-unsupported' });
  });
});
