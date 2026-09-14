#!/usr/bin/env bun
/**
 * gstack-design-md — inspect, convert, and read DESIGN.md in the open format.
 *
 *   bun --no-env-file run ~/.claude/skills/gstack/bin/gstack-design-md.ts check [DESIGN.md]
 *   bun --no-env-file run ~/.claude/skills/gstack/bin/gstack-design-md.ts convert [DESIGN.md] [--write]
 *   bun --no-env-file run ~/.claude/skills/gstack/bin/gstack-design-md.ts tokens [DESIGN.md]
 *   bun --no-env-file run ~/.claude/skills/gstack/bin/gstack-design-md.ts mark <spec|legacy-keep> [DESIGN.md]
 *
 * check    DESIGN_MD_FORMAT: spec | legacy | unknown | missing (+ DESIGN_MD_REASON for unknown),
 *          DESIGN_MD_MARKER: spec | legacy-keep | none. Exit 0.
 * convert  Legacy → spec (lib/design-md.ts convertLegacy). Prints the result; with --write,
 *          backs the original up to DESIGN.md.legacy.bak and writes temp+rename. Refuses an
 *          ambiguous file (DESIGN_MD_CONVERT_REFUSED, exit 2) and a non-legacy one (exit 1).
 * tokens   Flat token map as JSON ({"colors.primary": "#F59E0B", ...}); {path} refs resolved;
 *          invalid refs listed under "errors" (DESIGN_MD_TOKEN_REF_INVALID). Exit 0.
 * mark     Persist the user's one-time format choice inside the file: a file that opens with
 *          front matter gets a YAML comment on line 2, any other file an HTML comment on
 *          line 1. A text-level splice: every other byte is untouched. Refuses a choice that
 *          contradicts the file (spec on a non-spec file, legacy-keep on a spec file), exit 2.
 *
 * Exit 3 + DESIGN_MD_INTERNAL_ERROR is a gstack bug. YAML errors never propagate: a file whose
 * front matter does not parse is `unknown` with a reason.
 */
import * as fs from 'fs';
import * as path from 'path';
import { SENTINEL } from '../lib/design-detect-contract';
import { atomicWriteSync } from '../lib/fs-atomic';
import {
  parseDesignMd, detectFormat, convertLegacy, renderDesignMd, tokensFlat, insertMarker,
  type DesignMdDoc, type FormatChoice, FORMAT_CHOICES, DesignMdEditRefused } from '../lib/design-md';

/** The file itself, through any symlink (a `DESIGN.md -> docs/DESIGN.md` layout must edit the target, never replace the link). */
function resolveFile(arg?: string): string {
  const p = path.resolve(arg ?? 'DESIGN.md');
  try { return fs.realpathSync(p); } catch { return p; }
}

function load(file: string): { text: string; doc: DesignMdDoc } | null {
  try { const text = fs.readFileSync(file, 'utf-8'); return { text, doc: parseDesignMd(text) }; } catch { return null; }
}

export function main(argv = process.argv.slice(2)): number {
  const verb = argv[0] ?? '';
  const flags = new Set(argv.filter(a => a.startsWith('--')));
  const positional = argv.slice(1).filter(a => !a.startsWith('--'));

  switch (verb) {
    case 'check': {
      const file = resolveFile(positional[0]);
      const loaded = load(file);
      const { format, reason } = detectFormat(loaded?.doc ?? null);
      process.stdout.write(`${SENTINEL.DESIGN_MD_FORMAT}: ${format}\n`);
      if (reason) process.stdout.write(`${SENTINEL.DESIGN_MD_REASON}: ${reason}\n`);
      process.stdout.write(`${SENTINEL.DESIGN_MD_MARKER}: ${loaded?.doc.marker ?? 'none'}\n`);
      return 0;
    }
    case 'convert': {
      const file = resolveFile(positional[0]);
      const loaded = load(file);
      const { format, code, reason } = detectFormat(loaded?.doc ?? null);
      if (code === 'ambiguous') {
        process.stderr.write(`${SENTINEL.DESIGN_MD_CONVERT_REFUSED}: ${reason}\n`);
        return 2;
      }
      if (format !== 'legacy' || !loaded) {
        process.stderr.write(`${SENTINEL.DESIGN_MD_FORMAT}: ${format}${reason ? ` (${reason})` : ''}; convert only accepts a legacy gstack DESIGN.md\n`);
        return 1;
      }
      let out: string;
      try {
        out = renderDesignMd(convertLegacy(loaded.doc), { emitFrontmatter: true });
      } catch (err) {
        if (err instanceof DesignMdEditRefused) { process.stderr.write(`${SENTINEL.DESIGN_MD_CONVERT_REFUSED}: ${err.message.replace(/^[A-Z_]+: /, '')}\n`); return 2; }
        throw err;
      }
      if (flags.has('--write')) {
        fs.writeFileSync(`${file}.legacy.bak`, loaded.text);
        atomicWriteSync(file, out);
        process.stdout.write(`${SENTINEL.DESIGN_MD_FORMAT}: spec\n${SENTINEL.DESIGN_MD_WRITTEN}: ${file}\n${SENTINEL.DESIGN_MD_BACKUP}: ${file}.legacy.bak\n`);
      } else {
        process.stdout.write(out);
      }
      return 0;
    }
    case 'tokens': {
      const file = resolveFile(positional[0]);
      const loaded = load(file);
      const flat = tokensFlat(loaded?.doc.frontmatter ?? null);
      process.stdout.write(JSON.stringify({ file, format: detectFormat(loaded?.doc ?? null).format, ...flat }, null, 2) + '\n');
      for (const e of flat.errors) process.stderr.write(e + '\n');
      return 0;
    }
    case 'mark': {
      const choice = positional[0] as FormatChoice | undefined;
      if (!(FORMAT_CHOICES as readonly string[]).includes(choice)) {
        process.stderr.write(`usage: gstack-design-md.ts mark <${FORMAT_CHOICES.join('|')}> [DESIGN.md]\n`);
        return 2;
      }
      const file = resolveFile(positional[1]);
      const loaded = load(file);
      if (!loaded) { process.stdout.write(`${SENTINEL.DESIGN_MD_FORMAT}: missing\n`); return 1; }
      const { format } = detectFormat(loaded.doc);
      if ((choice === 'spec' && format !== 'spec') || (choice === 'legacy-keep' && format === 'spec')) {
        process.stderr.write(`${SENTINEL.DESIGN_MD_CONVERT_REFUSED}: mark ${choice} contradicts the file's format (${format}); file unchanged\n`);
        return 2;
      }
      atomicWriteSync(file, insertMarker(loaded.text, choice));
      process.stdout.write(`${SENTINEL.DESIGN_MD_MARKER}: ${choice}\n`);
      return 0;
    }
    default:
      process.stderr.write(`usage: gstack-design-md.ts check [file] | convert [file] [--write] | tokens [file] | mark <${FORMAT_CHOICES.join('|')}> [file]\n`);
      return 2;
  }
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (err) {
    const e = err as Error;
    process.stderr.write(`${SENTINEL.DESIGN_MD_INTERNAL_ERROR}: ${e?.name ?? 'Error'}: ${String(e?.message ?? e).slice(0, 300)}\n`);
    process.exitCode = 3;
  }
}
