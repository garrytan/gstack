import { createHash } from 'node:crypto';
import path from 'node:path';
import type { FactoryCommandGuardRequest } from './factory-command-guard';
import type { FactoryFileWriteRequest } from './factory-file-write-guard';

export type HostGuardWebPosture = 'denied';
export type HostGuardUnsupportedToolDefault = 'deny';
export type HostGuardOsConfinement = 'present' | 'absent';

export interface HostGuardAttestationFields {
  readonly factoryRunId: string;
  readonly phaseId: string;
  readonly workspaceRoot: string;
  readonly bashGuarded: boolean;
  readonly editGuarded: boolean;
  readonly writeGuarded: boolean;
  readonly readGuarded: boolean;
  readonly globGuarded: boolean;
  readonly grepGuarded: boolean;
  readonly webGuarded: HostGuardWebPosture;
  readonly unsupportedToolDefault: HostGuardUnsupportedToolDefault;
  readonly browserGuarded: boolean;
  readonly browseOutputDir?: string;
  readonly osConfinement: HostGuardOsConfinement;
  readonly attestedAt: string;
  readonly hostId: string;
}

export interface HostGuardAttestation extends HostGuardAttestationFields {
  readonly attestationDigest: string;
}

export type HostGuardAttestationVerification =
  | { readonly ok: true; readonly attestation: HostGuardAttestation }
  | { readonly ok: false; readonly reason: string };

export interface VerifyHostGuardAttestationOptions {
  readonly now?: () => Date;
  readonly freshnessWindowMs?: number;
  readonly expectedFactoryRunId?: string;
  readonly expectedPhaseId?: string;
  readonly expectedWorkspaceRoot?: string;
  readonly requireBrowser?: boolean;
}

export interface SanitizedHostGuardAttestationArtifact {
  readonly factoryRunId: string;
  readonly phaseId: string;
  readonly hostId: string;
  readonly attestedAt: string;
  readonly attestationDigest: string;
  readonly hooks: {
    readonly bashGuarded: boolean;
    readonly editGuarded: boolean;
    readonly writeGuarded: boolean;
    readonly readGuarded: boolean;
    readonly globGuarded: boolean;
    readonly grepGuarded: boolean;
    readonly webGuarded: HostGuardWebPosture;
    readonly unsupportedToolDefault: HostGuardUnsupportedToolDefault;
  };
  readonly browser: {
    readonly browserGuarded: boolean;
    readonly browseOutputDirRelative?: string;
  };
  readonly osConfinement: HostGuardOsConfinement;
}

export interface FactoryGuardedBrowserPolicy {
  readonly outputDirRelativeToRun: string;
  readonly allowlistedSubcommands: readonly string[];
}

export interface FactoryGuardedAgentSessionSpec {
  readonly factoryRunId: string;
  readonly phaseId: string;
  readonly workspaceRoot: string;
  readonly profile: 'non-destructive-write';
  readonly browserRequested?: boolean;
  readonly browserPolicy?: FactoryGuardedBrowserPolicy;
  readonly hooks: {
    readonly executeCommand: (request: FactoryCommandGuardRequest) => unknown | Promise<unknown>;
    readonly applyEdit: (request: FactoryFileWriteRequest) => unknown | Promise<unknown>;
    readonly applyWrite: (request: FactoryFileWriteRequest) => unknown | Promise<unknown>;
    readonly read: (request: { readonly absolutePath: string }) => unknown | Promise<unknown>;
    readonly glob: (request: { readonly pattern: string }) => unknown | Promise<unknown>;
    readonly grep: (request: { readonly pattern: string; readonly paths?: readonly string[] }) => unknown | Promise<unknown>;
    readonly onUnsupportedTool: (request: { readonly toolName: string }) => unknown | Promise<unknown>;
  };
}

export type FactoryGuardedAgentSessionResult =
  | { readonly supported: false; readonly reason: 'no-host' | 'attestation-invalid' | 'unsupported-profile' }
  | FactoryGuardedAgentSessionHandle;

export interface FactoryGuardedAgentSessionHandle {
  readonly supported: true;
  readonly sessionId: string;
  readonly attestation: HostGuardAttestation;
  readonly dispatch: (message: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

const DEFAULT_FRESHNESS_WINDOW_MS = 10_000;
const REQUIRED_BOOLEAN_FIELDS: Array<keyof HostGuardAttestationFields> = [
  'bashGuarded',
  'editGuarded',
  'writeGuarded',
  'readGuarded',
  'globGuarded',
  'grepGuarded',
  'browserGuarded',
];

export function buildHostGuardAttestation(fields: HostGuardAttestationFields): HostGuardAttestation {
  return {
    ...fields,
    workspaceRoot: normalizeAbsolutePath(fields.workspaceRoot),
    browseOutputDir: fields.browseOutputDir ? normalizeAbsolutePath(fields.browseOutputDir) : undefined,
    attestationDigest: digestHostGuardAttestation(fields),
  };
}

export function digestHostGuardAttestation(fields: HostGuardAttestationFields): string {
  const normalized: HostGuardAttestationFields = {
    ...fields,
    workspaceRoot: normalizeAbsolutePath(fields.workspaceRoot),
    browseOutputDir: fields.browseOutputDir ? normalizeAbsolutePath(fields.browseOutputDir) : undefined,
  };
  return createHash('sha256').update(stableJson(normalized)).digest('hex');
}

export function verifyHostGuardAttestation(
  input: unknown,
  options: VerifyHostGuardAttestationOptions = {},
): HostGuardAttestationVerification {
  const attestation = asHostGuardAttestation(input);
  if (!attestation) return { ok: false, reason: 'missing-field' };

  for (const field of REQUIRED_BOOLEAN_FIELDS) {
    if (attestation[field] !== true && field !== 'browserGuarded') {
      return { ok: false, reason: `${field}-false` };
    }
  }
  if (attestation.webGuarded !== 'denied') return { ok: false, reason: 'web-not-denied' };
  if (attestation.unsupportedToolDefault !== 'deny') return { ok: false, reason: 'unsupported-tool-not-deny' };
  if (attestation.osConfinement !== 'present' && attestation.osConfinement !== 'absent') {
    return { ok: false, reason: 'invalid-os-confinement' };
  }
  if (!path.isAbsolute(attestation.workspaceRoot)) {
    return { ok: false, reason: 'workspace-root-not-absolute' };
  }
  if (attestation.browseOutputDir && !path.isAbsolute(attestation.browseOutputDir)) {
    return { ok: false, reason: 'browse-output-not-absolute' };
  }
  if (options.expectedFactoryRunId && attestation.factoryRunId !== options.expectedFactoryRunId) {
    return { ok: false, reason: 'run-id-mismatch' };
  }
  if (options.expectedPhaseId && attestation.phaseId !== options.expectedPhaseId) {
    return { ok: false, reason: 'phase-id-mismatch' };
  }
  const expectedWorkspaceRoot = options.expectedWorkspaceRoot ? normalizeAbsolutePath(options.expectedWorkspaceRoot) : undefined;
  if (expectedWorkspaceRoot && normalizeAbsolutePath(attestation.workspaceRoot) !== expectedWorkspaceRoot) {
    return { ok: false, reason: 'workspace-root-mismatch' };
  }
  if (options.requireBrowser && attestation.browserGuarded !== true) {
    return { ok: false, reason: 'browser-not-guarded' };
  }
  if (attestation.browserGuarded) {
    const browseDirDecision = verifyBrowseOutputDir(attestation);
    if (!browseDirDecision.ok) return browseDirDecision;
  } else if (attestation.browseOutputDir) {
    return { ok: false, reason: 'browser-output-without-browser-guard' };
  }

  const expectedDigest = digestHostGuardAttestation(stripDigest(attestation));
  if (attestation.attestationDigest !== expectedDigest) {
    return { ok: false, reason: 'digest-mismatch' };
  }

  const attestedAtMs = Date.parse(attestation.attestedAt);
  if (!Number.isFinite(attestedAtMs)) return { ok: false, reason: 'invalid-attested-at' };
  const now = options.now?.() ?? new Date();
  if (attestedAtMs > now.getTime()) {
    return { ok: false, reason: 'attestation-from-future' };
  }
  const ageMs = now.getTime() - attestedAtMs;
  if (ageMs > (options.freshnessWindowMs ?? DEFAULT_FRESHNESS_WINDOW_MS)) {
    return { ok: false, reason: 'attestation-expired' };
  }

  return { ok: true, attestation };
}

export function sanitizeHostGuardAttestationForArtifact(attestation: HostGuardAttestation): SanitizedHostGuardAttestationArtifact {
  const browseOutputDirRelative = attestation.browseOutputDir
    ? path.relative(normalizeAbsolutePath(attestation.workspaceRoot), normalizeAbsolutePath(attestation.browseOutputDir)).replace(/\\/g, '/')
    : undefined;
  return {
    factoryRunId: attestation.factoryRunId,
    phaseId: attestation.phaseId,
    hostId: attestation.hostId,
    attestedAt: attestation.attestedAt,
    attestationDigest: attestation.attestationDigest,
    hooks: {
      bashGuarded: attestation.bashGuarded,
      editGuarded: attestation.editGuarded,
      writeGuarded: attestation.writeGuarded,
      readGuarded: attestation.readGuarded,
      globGuarded: attestation.globGuarded,
      grepGuarded: attestation.grepGuarded,
      webGuarded: attestation.webGuarded,
      unsupportedToolDefault: attestation.unsupportedToolDefault,
    },
    browser: {
      browserGuarded: attestation.browserGuarded,
      browseOutputDirRelative,
    },
    osConfinement: attestation.osConfinement,
  };
}

export function createGuardedAgentSession(_spec: FactoryGuardedAgentSessionSpec): FactoryGuardedAgentSessionResult {
  return { supported: false, reason: 'no-host' };
}

export function createTestOnlyGuardedHostShim(options: {
  readonly now?: () => Date;
  readonly hostId?: string;
  readonly tamperDigest?: boolean;
} = {}) {
  return {
    createGuardedAgentSession(spec: FactoryGuardedAgentSessionSpec): FactoryGuardedAgentSessionResult {
      if (spec.profile !== 'non-destructive-write') {
        return { supported: false, reason: 'unsupported-profile' };
      }
      const attestedAt = (options.now?.() ?? new Date()).toISOString();
      const browseOutputDir = spec.browserRequested
        ? path.join(spec.workspaceRoot, '.gstack', 'factory', spec.factoryRunId, spec.browserPolicy?.outputDirRelativeToRun ?? 'browse-output')
        : undefined;
      const attestation = buildHostGuardAttestation({
        factoryRunId: spec.factoryRunId,
        phaseId: spec.phaseId,
        workspaceRoot: spec.workspaceRoot,
        bashGuarded: true,
        editGuarded: true,
        writeGuarded: true,
        readGuarded: true,
        globGuarded: true,
        grepGuarded: true,
        webGuarded: 'denied',
        unsupportedToolDefault: 'deny',
        browserGuarded: spec.browserRequested === true,
        browseOutputDir,
        osConfinement: 'absent',
        attestedAt,
        hostId: options.hostId ?? 'test-only-guarded-host',
      });
      const finalAttestation = options.tamperDigest
        ? { ...attestation, attestationDigest: `${attestation.attestationDigest.slice(0, -1)}${attestation.attestationDigest.endsWith('0') ? '1' : '0'}` }
        : attestation;
      const messages: string[] = [];
      return {
        supported: true,
        sessionId: `test-guarded-${spec.factoryRunId}-${spec.phaseId}`,
        attestation: finalAttestation,
        async dispatch(message: string) {
          messages.push(message);
        },
        async close() {
          messages.length = 0;
        },
      };
    },
  };
}

function asHostGuardAttestation(input: unknown): HostGuardAttestation | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  for (const field of [
    'factoryRunId',
    'phaseId',
    'workspaceRoot',
    'webGuarded',
    'unsupportedToolDefault',
    'osConfinement',
    'attestedAt',
    'hostId',
    'attestationDigest',
  ]) {
    if (typeof value[field] !== 'string' || String(value[field]).length === 0) return null;
  }
  for (const field of REQUIRED_BOOLEAN_FIELDS) {
    if (typeof value[field] !== 'boolean') return null;
  }
  if (value.browseOutputDir !== undefined && typeof value.browseOutputDir !== 'string') return null;
  return value as unknown as HostGuardAttestation;
}

function verifyBrowseOutputDir(attestation: HostGuardAttestation): HostGuardAttestationVerification {
  if (!attestation.browseOutputDir) return { ok: false, reason: 'missing-browse-output-dir' };
  const workspaceRoot = normalizeAbsolutePath(attestation.workspaceRoot);
  const outputDir = normalizeAbsolutePath(attestation.browseOutputDir);
  const relative = path.relative(workspaceRoot, outputDir).replace(/\\/g, '/');
  const requiredPrefix = `.gstack/factory/${attestation.factoryRunId}/`;
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    return { ok: false, reason: 'browse-output-outside-workspace' };
  }
  if (!relative.startsWith(requiredPrefix)) {
    return { ok: false, reason: 'browse-output-not-run-scoped' };
  }
  return { ok: true, attestation };
}

function stripDigest(attestation: HostGuardAttestation): HostGuardAttestationFields {
  const { attestationDigest: _digest, ...fields } = attestation;
  return fields;
}

function normalizeAbsolutePath(input: string): string {
  return path.resolve(input);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
