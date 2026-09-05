#!/usr/bin/env bun
/**
 * gstack-render — render a local HTML file through the Aside browser.
 *
 *   bun run ~/.claude/skills/gstack/bin/gstack-render.ts <file.html> [options] [steps...]
 *
 * Options
 *   --serve-root <dir>        directory served over loopback (default: the file's dir)
 *   --wait-selector <sel>     wait until this selector is attached before any step
 *   --wait-expr <js>          wait until this expression is truthy before any step
 *   --timeout <ms>            whole-render budget (default 120000; Aside caps a script at 120s)
 *   --quiet                   print only the OK/EVAL lines
 *
 * Steps (run in the order given; repeatable)
 *   --pdf <out.pdf> [--paper letter|a4|... | --paper-in WxH] [--margin <len>] [--margin-top <len>] ...
 *                   [--header <html>] [--footer <html>] [--page-numbers] [--tagged] [--outline]
 *                   [--print-background] [--prefer-css-page-size] [--landscape] [--wait-pagedjs]
 *   --screenshot <out> [--width <px>] [--height <px>] [--selector <css>] [--viewport-only] [--jpeg [--quality <n>]]
 *   --eval <js> [--out <file>]    evaluate in the page (promises awaited); with --out the result is
 *                                 written to the file (strings verbatim, data: URLs decoded to bytes,
 *                                 anything else as JSON); without --out it is printed as EVAL <i>: ...
 *
 * Output: one `OK <path>` line per artifact, `EVAL <i>: <text>` for inline evals,
 * `PAGE_ERRORS=[...]` when the page logged errors, exit 0. On failure: `ERROR: ...`,
 * exit 1. `NEEDS_ASIDE` / `ASIDE_NOT_RUNNING` follow the BROWSER SETUP contract.
 *
 * Aside refuses file:// URLs, so the file's directory is served on 127.0.0.1
 * for the duration of the render — relative <img>/<script>/<link> paths inside
 * that directory resolve; anything outside it does not.
 */
import * as path from 'node:path';
import {
  probeAside, renderWithAside, lengthToInches, paperInches,
  type RenderSpec, type RenderStep, type PdfStepOptions,
} from '../lib/aside-render';

function usage(msg?: string): never {
  if (msg) console.error(`ERROR: ${msg}`);
  console.error('usage: gstack-render <file.html> [--serve-root DIR] [--wait-selector SEL] [--wait-expr JS] [--timeout MS] (--pdf OUT [pdf opts] | --screenshot OUT [--width N] [--height N] [--selector CSS] [--jpeg] | --eval JS [--out FILE])...');
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') usage();
const file = path.resolve(argv[0]);
const spec: RenderSpec = { file, steps: [] };
let quiet = false;
let i = 1;
const take = (flag: string): string => {
  const v = argv[++i];
  if (v === undefined) usage(`${flag} needs a value`);
  return v;
};
let current: RenderStep | null = null;
const commit = () => { if (current) spec.steps.push(current); current = null; };
const pdfOf = (): PdfStepOptions => {
  if (!current || current.kind !== 'pdf') usage('pdf option given before --pdf');
  current.options ??= {};
  return current.options;
};
const shotOf = () => {
  if (!current || current.kind !== 'screenshot') usage('screenshot option given before --screenshot');
  return current;
};

for (; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case '--serve-root': spec.serveRoot = path.resolve(take(a)); break;
    case '--wait-selector': (spec.waitFor ??= {}).selector = take(a); break;
    case '--wait-expr': (spec.waitFor ??= {}).expression = take(a); break;
    case '--wait-timeout': (spec.waitFor ??= {}).timeoutMs = Number(take(a)); break;
    case '--timeout': spec.timeoutMs = Number(take(a)); break;
    case '--quiet': quiet = true; break;
    case '--pdf': commit(); current = { kind: 'pdf', out: path.resolve(take(a)), options: {} }; break;
    case '--screenshot': commit(); current = { kind: 'screenshot', out: path.resolve(take(a)) }; break;
    case '--eval': commit(); current = { kind: 'eval', expression: take(a) }; break;
    case '--out': {
      if (!current || current.kind !== 'eval') usage('--out belongs to --eval');
      current.out = path.resolve(take(a)); break;
    }
    // pdf options
    case '--paper': {
      const p = paperInches(take(a));
      if (!p) usage(`unknown paper format ${argv[i]}`);
      const o = pdfOf(); [o.paperWidth, o.paperHeight] = p; break;
    }
    case '--paper-in': {
      const m = take(a).match(/^([0-9.]+)x([0-9.]+)$/i);
      if (!m) usage('--paper-in wants WxH in inches, e.g. 8.5x11');
      const o = pdfOf(); o.paperWidth = Number(m[1]); o.paperHeight = Number(m[2]); break;
    }
    case '--margin': { const v = lengthToInches(take(a)); const o = pdfOf(); o.marginTop = o.marginRight = o.marginBottom = o.marginLeft = v; break; }
    case '--margin-top': pdfOf().marginTop = lengthToInches(take(a)); break;
    case '--margin-right': pdfOf().marginRight = lengthToInches(take(a)); break;
    case '--margin-bottom': pdfOf().marginBottom = lengthToInches(take(a)); break;
    case '--margin-left': pdfOf().marginLeft = lengthToInches(take(a)); break;
    case '--header': { const o = pdfOf(); o.displayHeaderFooter = true; o.headerTemplate = take(a); o.footerTemplate ??= '<div></div>'; break; }
    case '--footer': { const o = pdfOf(); o.displayHeaderFooter = true; o.footerTemplate = take(a); o.headerTemplate ??= '<div></div>'; break; }
    case '--page-numbers': {
      const o = pdfOf(); o.displayHeaderFooter = true; o.headerTemplate ??= '<div></div>';
      o.footerTemplate = '<div style="font-size:9pt; font-family:Helvetica,Arial,sans-serif; color:#666; width:100%; text-align:center;"><span class="pageNumber"></span> of <span class="totalPages"></span></div>';
      break;
    }
    case '--tagged': pdfOf().generateTaggedPDF = true; break;
    case '--outline': pdfOf().generateDocumentOutline = true; break;
    case '--print-background': pdfOf().printBackground = true; break;
    case '--prefer-css-page-size': pdfOf().preferCSSPageSize = true; break;
    case '--landscape': pdfOf().landscape = true; break;
    case '--wait-pagedjs': pdfOf().waitForPagedJs = true; break;
    // screenshot options
    case '--width': shotOf().width = Number(take(a)); break;
    case '--height': shotOf().height = Number(take(a)); break;
    case '--selector': shotOf().selector = take(a); break;
    case '--viewport-only': shotOf().fullPage = false; break;
    case '--jpeg': shotOf().type = 'jpeg'; break;
    case '--quality': shotOf().quality = Number(take(a)); break;
    default: usage(`unknown argument ${a}`);
  }
}
commit();
if (spec.steps.length === 0) usage('no steps given (--pdf, --screenshot, or --eval)');

const probe = probeAside();
if (!probe.ok) {
  console.log(probe.reason);
  console.error(`ERROR: ${probe.reason}: ${probe.detail}`);
  process.exit(1);
}

const result = await renderWithAside(spec);
if (!result.ok) {
  console.error(`ERROR: ${result.error}`);
  if (!quiet) console.error(result.stdout.trim().split('\n').slice(-12).join('\n'));
  process.exit(1);
}
for (const out of result.outputs) console.log(`OK ${out}`);
for (const [idx, text] of Object.entries(result.evals)) console.log(`EVAL ${idx}: ${text}`);
const errs = result.stdout.match(/^PAGE_ERRORS=(.+)$/m)?.[1];
if (errs && errs !== '[]') console.log(`PAGE_ERRORS=${errs}`);
