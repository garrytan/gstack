#!/usr/bin/env bun
/**
 * gstack-companies-export — tarball a company's full artifact tree.
 *
 * Single-job utility. Bundles ~/.gstack/builders/$BUILDER/companies/$COMPANY/
 * into a portable .tar.gz so a builder can hand off, archive, or move a
 * company between machines. Cheap to add now, hard to retrofit later.
 *
 *   gstack-companies-export <company-slug> [--builder <slug>] [--out <path>]
 *
 * Default --out: ./<company-slug>-export-YYYY-MM-DD.tar.gz
 *
 * The symmetric `gstack-companies-import` is Phase B2 (per design doc).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function gstackHome(): string {
  return process.env.GSTACK_HOME ?? path.join(os.homedir(), '.gstack');
}
function buildersRoot(): string { return path.join(gstackHome(), 'builders'); }
function builderDir(b: string): string { return path.join(buildersRoot(), b); }
function companyDir(b: string, c: string): string { return path.join(builderDir(b), 'companies', c); }

function listDirs(p: string): string[] {
  if (!fs.existsSync(p)) return [];
  return fs.readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function validateSlug(name: string, value: string): void {
  if (!SLUG_RE.test(value)) {
    die(`invalid ${name}: ${JSON.stringify(value)} (must be kebab-case [a-z0-9-])`);
  }
}

function die(msg: string): never {
  process.stderr.write(`gstack-companies-export: ${msg}\n`);
  process.exit(1);
}

function usage(): never {
  process.stderr.write([
    'usage:',
    '  gstack-companies-export <company-slug> [--builder <slug>] [--out <path>]',
    '',
    '  --out defaults to ./<company-slug>-export-YYYY-MM-DD.tar.gz',
    '',
  ].join('\n'));
  process.exit(2);
}

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) die(`flag --${key} needs a value`);
      flags[key] = val;
      i++;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function resolveBuilderForCompany(company: string, hint?: string): string {
  if (hint) {
    validateSlug('builder', hint);
    if (!fs.existsSync(companyDir(hint, company))) {
      die(`company ${JSON.stringify(company)} not found under builder ${JSON.stringify(hint)}`);
    }
    return hint;
  }
  const matches = listDirs(buildersRoot()).filter((b) => fs.existsSync(companyDir(b, company)));
  if (matches.length === 0) {
    die(`company ${JSON.stringify(company)} not found under any builder`);
  }
  if (matches.length > 1) {
    die(`company ${JSON.stringify(company)} exists under multiple builders (${matches.join(', ')}); pass --builder`);
  }
  return matches[0];
}

function isoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultOutPath(companySlug: string): string {
  return path.join(process.cwd(), `${companySlug}-export-${isoDate()}.tar.gz`);
}

function ensureParentDirExists(p: string): void {
  const parent = path.dirname(path.resolve(p));
  fs.mkdirSync(parent, { recursive: true });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage();
  if (argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') usage();

  const { positional, flags } = parseFlags(argv);
  if (positional.length !== 1) {
    die(`expected exactly one positional argument: <company-slug> (got ${positional.length})`);
  }

  const companySlug = positional[0];
  validateSlug('company-slug', companySlug);

  const builder = resolveBuilderForCompany(companySlug, flags['builder']);
  const sourceDir = companyDir(builder, companySlug);

  // Sanity: source dir must exist (resolveBuilderForCompany already verified).
  if (!fs.existsSync(sourceDir)) {
    die(`source directory missing: ${sourceDir}`);
  }

  const outPath = path.resolve(flags['out'] ?? defaultOutPath(companySlug));
  ensureParentDirExists(outPath);

  // tar -czf <out> -C <parent> <leaf>  → archive contains a single top-level
  // directory named after the company slug (not a tree of /Users/.../...).
  // -C changes directory before adding entries.
  const parent = path.dirname(sourceDir);
  const leaf = path.basename(sourceDir);
  const result = spawnSync('tar', ['-czf', outPath, '-C', parent, leaf], {
    encoding: 'utf-8',
    timeout: 120000,
  });

  if (result.status !== 0) {
    die(`tar failed (exit ${result.status}): ${result.stderr?.toString() ?? ''}`);
  }

  // Verify the archive exists and is non-empty.
  if (!fs.existsSync(outPath)) {
    die(`tar reported success but ${outPath} does not exist`);
  }
  const size = fs.statSync(outPath).size;
  if (size === 0) {
    die(`tar produced an empty archive at ${outPath}`);
  }

  process.stdout.write(`${outPath}\n`);
}

main().catch((err) => die((err as Error).stack ?? String(err)));
