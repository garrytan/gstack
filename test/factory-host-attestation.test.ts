import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  buildHostGuardAttestation,
  createGuardedAgentSession,
  createTestOnlyGuardedHostShim,
  digestHostGuardAttestation,
  sanitizeHostGuardAttestationForArtifact,
  verifyHostGuardAttestation,
  type FactoryGuardedAgentSessionSpec,
  type HostGuardAttestationFields,
} from '../lib/factory-host-attestation';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const WORKSPACE = '/repo';

function fields(overrides: Partial<HostGuardAttestationFields> = {}): HostGuardAttestationFields {
  return {
    factoryRunId: 'run-1',
    phaseId: 'qa-execution',
    workspaceRoot: WORKSPACE,
    bashGuarded: true,
    editGuarded: true,
    writeGuarded: true,
    readGuarded: true,
    globGuarded: true,
    grepGuarded: true,
    webGuarded: 'denied',
    unsupportedToolDefault: 'deny',
    browserGuarded: true,
    browseOutputDir: path.join(WORKSPACE, '.gstack', 'factory', 'run-1', 'browse-output'),
    osConfinement: 'absent',
    attestedAt: NOW.toISOString(),
    hostId: 'pi-test-host',
    ...overrides,
  };
}

function spec(overrides: Partial<FactoryGuardedAgentSessionSpec> = {}): FactoryGuardedAgentSessionSpec {
  return {
    factoryRunId: 'run-1',
    phaseId: 'qa-execution',
    workspaceRoot: WORKSPACE,
    profile: 'non-destructive-write',
    browserRequested: true,
    browserPolicy: {
      outputDirRelativeToRun: 'browse-output',
      allowlistedSubcommands: ['goto', 'snapshot', 'screenshot'],
    },
    hooks: {
      executeCommand: () => undefined,
      applyEdit: () => undefined,
      applyWrite: () => undefined,
      read: () => undefined,
      glob: () => undefined,
      grep: () => undefined,
      onUnsupportedTool: () => undefined,
    },
    ...overrides,
  };
}

describe('factory host guard attestation', () => {
  test('builds and verifies a fresh attestation bound to run, phase, workspace, and browser output dir', () => {
    const attestation = buildHostGuardAttestation(fields());
    expect(attestation.attestationDigest).toMatch(/^[0-9a-f]{64}$/);

    const verification = verifyHostGuardAttestation(attestation, {
      now: () => NOW,
      expectedFactoryRunId: 'run-1',
      expectedPhaseId: 'qa-execution',
      expectedWorkspaceRoot: WORKSPACE,
      requireBrowser: true,
    });

    expect(verification).toMatchObject({ ok: true });
  });

  test('digest is stable regardless of object key insertion order', () => {
    const a = fields();
    const b = {
      hostId: 'pi-test-host',
      attestedAt: NOW.toISOString(),
      osConfinement: 'absent',
      browseOutputDir: path.join(WORKSPACE, '.gstack', 'factory', 'run-1', 'browse-output'),
      browserGuarded: true,
      unsupportedToolDefault: 'deny',
      webGuarded: 'denied',
      grepGuarded: true,
      globGuarded: true,
      readGuarded: true,
      writeGuarded: true,
      editGuarded: true,
      bashGuarded: true,
      workspaceRoot: WORKSPACE,
      phaseId: 'qa-execution',
      factoryRunId: 'run-1',
    } satisfies HostGuardAttestationFields;

    expect(digestHostGuardAttestation(a)).toBe(digestHostGuardAttestation(b));
  });

  test('detects digest mismatch, missing fields, run mismatch, and phase mismatch', () => {
    const valid = buildHostGuardAttestation(fields());
    expect(verifyHostGuardAttestation({ ...valid, attestationDigest: 'bad' }, { now: () => NOW })).toEqual({ ok: false, reason: 'digest-mismatch' });

    const { hostId: _hostId, ...missingHost } = valid;
    expect(verifyHostGuardAttestation(missingHost, { now: () => NOW })).toEqual({ ok: false, reason: 'missing-field' });
    expect(verifyHostGuardAttestation(valid, { now: () => NOW, expectedFactoryRunId: 'other-run' })).toEqual({ ok: false, reason: 'run-id-mismatch' });
    expect(verifyHostGuardAttestation(valid, { now: () => NOW, expectedPhaseId: 'other-phase' })).toEqual({ ok: false, reason: 'phase-id-mismatch' });
  });

  test('enforces freshness window and rejects any future attestation', () => {
    const valid = buildHostGuardAttestation(fields());
    expect(verifyHostGuardAttestation(valid, {
      now: () => new Date(NOW.getTime() + 11_000),
      freshnessWindowMs: 10_000,
    })).toEqual({ ok: false, reason: 'attestation-expired' });

    expect(verifyHostGuardAttestation(valid, {
      now: () => new Date(NOW.getTime() - 1),
      freshnessWindowMs: 10_000,
    })).toEqual({ ok: false, reason: 'attestation-from-future' });
  });

  test('requires every guarded hook and fail-closed unsupported/web posture', () => {
    expect(verifyHostGuardAttestation(buildHostGuardAttestation(fields({ bashGuarded: false })), { now: () => NOW })).toEqual({ ok: false, reason: 'bashGuarded-false' });
    expect(verifyHostGuardAttestation(buildHostGuardAttestation(fields({ unsupportedToolDefault: 'deny' })), { now: () => NOW })).toMatchObject({ ok: true });
    expect(verifyHostGuardAttestation({ ...buildHostGuardAttestation(fields()), webGuarded: 'allowed' }, { now: () => NOW })).toEqual({ ok: false, reason: 'web-not-denied' });
  });

  test('requires browser output under the current .gstack/factory/<runId> tree when browser is guarded', () => {
    const valid = buildHostGuardAttestation(fields());
    expect(verifyHostGuardAttestation({ ...valid, workspaceRoot: 'relative-workspace' }, { now: () => NOW })).toEqual({ ok: false, reason: 'workspace-root-not-absolute' });
    expect(verifyHostGuardAttestation({ ...valid, browseOutputDir: '.gstack/factory/run-1/browse-output' }, { now: () => NOW })).toEqual({ ok: false, reason: 'browse-output-not-absolute' });
    expect(verifyHostGuardAttestation(buildHostGuardAttestation(fields({ browseOutputDir: undefined })), { now: () => NOW })).toEqual({ ok: false, reason: 'missing-browse-output-dir' });
    expect(verifyHostGuardAttestation(buildHostGuardAttestation(fields({ browseOutputDir: path.join(WORKSPACE, '.gstack', 'factory', 'other-run', 'browse-output') })), { now: () => NOW })).toEqual({ ok: false, reason: 'browse-output-not-run-scoped' });
    expect(verifyHostGuardAttestation(buildHostGuardAttestation(fields({ browseOutputDir: '/tmp/browse-output' })), { now: () => NOW })).toEqual({ ok: false, reason: 'browse-output-outside-workspace' });
    expect(verifyHostGuardAttestation(buildHostGuardAttestation(fields({ browserGuarded: false, browseOutputDir: undefined })), { now: () => NOW, requireBrowser: true })).toEqual({ ok: false, reason: 'browser-not-guarded' });
    expect(verifyHostGuardAttestation(buildHostGuardAttestation(fields({ browserGuarded: false })), { now: () => NOW })).toEqual({ ok: false, reason: 'browser-output-without-browser-guard' });
  });

  test('sanitizes an attestation artifact without exposing absolute workspace paths', () => {
    const attestation = buildHostGuardAttestation(fields());
    const artifact = sanitizeHostGuardAttestationForArtifact(attestation);

    expect(artifact).toMatchObject({
      factoryRunId: 'run-1',
      phaseId: 'qa-execution',
      hostId: 'pi-test-host',
      attestationDigest: attestation.attestationDigest,
      browser: { browserGuarded: true, browseOutputDirRelative: '.gstack/factory/run-1/browse-output' },
    });
    expect(JSON.stringify(artifact)).not.toContain(WORKSPACE);
  });

  test('default guarded session shim keeps existing hosts unsupported', () => {
    expect(createGuardedAgentSession(spec())).toEqual({ supported: false, reason: 'no-host' });
  });

  test('test-only guarded host shim returns a verifiable attested session without public exposure wiring', async () => {
    const host = createTestOnlyGuardedHostShim({ now: () => NOW, hostId: 'test-host' });
    const handle = host.createGuardedAgentSession(spec());

    expect(handle.supported).toBe(true);
    if (!handle.supported) throw new Error('expected test host to be supported');
    expect(handle.sessionId).toBe('test-guarded-run-1-qa-execution');
    expect(verifyHostGuardAttestation(handle.attestation, {
      now: () => NOW,
      expectedFactoryRunId: 'run-1',
      expectedPhaseId: 'qa-execution',
      expectedWorkspaceRoot: WORKSPACE,
      requireBrowser: true,
    })).toMatchObject({ ok: true });
    await handle.dispatch('test message');
    await handle.close();
  });
});
