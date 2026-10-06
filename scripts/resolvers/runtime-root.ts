/**
 * Runtime root for env-var hosts (C1, #1159): the one owner of how generated
 * bash finds gstack on Codex and every other `usesEnvVars` host.
 *
 * Those hosts run each fenced block in a fresh shell, so `GSTACK_ROOT`, `B`,
 * `D` and `P` set by an earlier block are gone. The preamble's root resolution and
 * the per-fence prelude come from `runtimeRootPrelude()`; `insertRuntimePreludes()`
 * is the single post-render pass (gen-skill-docs, before rewriteInstallRoot)
 * that puts it into every fence that uses these variables without assigning
 * them. Claude output is returned unchanged.
 *
 * Precedence: an exported `GSTACK_ROOT` that contains `bin/` and `lib/`; then,
 * on a per-install render, the literal install root (no git call); otherwise the
 * repo-local install, then the host's global root (`CODEX_HOME` on Codex). No
 * root prints one line naming what was tried and the setup command, and exits.
 */
import { getHostConfig } from '../../hosts/index';
import { toShellPath, type TemplateContext } from './types';

/** Per-fence byte budget for the prelude (T-ENG1), asserted by the INV-3 test. */
export const PRELUDE_BYTE_BUDGET = 400;
/**
 * make-pdf's dev-build override (E2), appended to `P`'s assignment. It is the
 * one fixed segment outside PRELUDE_BYTE_BUDGET: root plus `P=...` fits the
 * budget like `B`/`D` do, and the override is needed in every block that runs
 * `$P` so readiness and use name the same binary.
 */
export const MAKE_PDF_OVERRIDE = ';[ -x "${MAKE_PDF_BIN:-}" ]&&P=$MAKE_PDF_BIN||:';

const ROOT_VARS = /\$\{?GSTACK_(?:ROOT|BIN|BROWSE|DESIGN|MAKE_PDF)\b/;
const assigns = (name: string) => new RegExp(`(?:^|[\\s;&|(])${name}=`, 'm');
const uses = (name: string) => new RegExp(`\\$\\{?${name}\\b`);

/**
 * Root resolution only (sets `GSTACK_ROOT`). Kept compact: it repeats in every
 * fence that needs it, under PRELUDE_BYTE_BUDGET together with its derived vars.
 */
function resolveRoot(ctx: TemplateContext): string {
  const host = getHostConfig(ctx.host);
  const fix = `Fix: ./setup --host ${host.name} from your gstack checkout; ./setup --status shows it.`;
  const exported = '[ -d "${GSTACK_ROOT:-/-}/bin" ]&&[ -d "$GSTACK_ROOT/lib" ]||';
  if (ctx.installRoot) {
    return `${exported}{ GSTACK_ROOT="${ctx.installRoot.replace(/\/+$/, '')}";[ -d "$GSTACK_ROOT/bin" ]||{ echo "gstack: no install found (tried $GSTACK_ROOT). ${fix}">&2;exit 1;};}`;
  }
  const global = host.name === 'codex' ? '${CODEX_HOME:-~/.codex}/skills/gstack' : `~/${host.globalRoot}`;
  return `${exported}{ _r=$(git rev-parse --show-toplevel 2>/dev/null)/${host.localSkillRoot};[ -d "$_r/bin" ]||_r=${global};[ -d "$_r/bin" ]||{ echo "gstack: no install found (tried $_r). ${fix}">&2;exit 1;};GSTACK_ROOT=$_r;}`;
}

const DERIVED: Record<string, string> = { BIN: 'bin', BROWSE: 'browse/dist', DESIGN: 'design/dist', MAKE_PDF: 'make-pdf/dist' };

/** The preamble's root resolution: GSTACK_ROOT plus GSTACK_BIN. */
export function runtimeRootPrelude(ctx: TemplateContext): string {
  if (!getHostConfig(ctx.host).usesEnvVars) return '';
  return `${resolveRoot(ctx)}\nGSTACK_BIN=$GSTACK_ROOT/bin`;
}

/**
 * Lines that assign `B` (browse), `D` (design) or `P` (make-pdf). BROWSE SETUP,
 * DESIGN SETUP, MAKE-PDF SETUP and the prelude all use this, so a later fence
 * runs the binary setup checked. Env-var hosts derive from `GSTACK_ROOT`, which
 * the prelude already points at the repo-local install when one exists; other
 * hosts keep their repo-local-first probe. make-pdf's binary is
 * `make-pdf/dist/pdf`, and `MAKE_PDF_BIN` (a contributor dev build) wins on
 * every host.
 */
export function binaryAssignment(ctx: TemplateContext, tool: 'browse' | 'design' | 'make-pdf'): string {
  if (tool === 'make-pdf') {
    if (getHostConfig(ctx.host).usesEnvVars) return `P=$GSTACK_ROOT/make-pdf/dist/pdf${MAKE_PDF_OVERRIDE}`;
    return `_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
P=""
[ -n "$MAKE_PDF_BIN" ] && [ -x "$MAKE_PDF_BIN" ] && P="$MAKE_PDF_BIN"
[ -z "$P" ] && [ -n "$_ROOT" ] && [ -x "$_ROOT/${ctx.paths.localSkillRoot}/make-pdf/dist/pdf" ] && P="$_ROOT/${ctx.paths.localSkillRoot}/make-pdf/dist/pdf"
[ -z "$P" ] && P="${toShellPath(ctx.paths.skillRoot)}/make-pdf/dist/pdf"`;
  }
  const v = tool === 'browse' ? 'B' : 'D';
  const dir = tool === 'browse' ? ctx.paths.browseDir : ctx.paths.designDir;
  if (getHostConfig(ctx.host).usesEnvVars) return `${v}=$GSTACK_ROOT/${tool}/dist/${tool}`;
  return `_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
${v}=""
[ -n "$_ROOT" ] && [ -x "$_ROOT/${ctx.paths.localSkillRoot}/${tool}/dist/${tool}" ] && ${v}="$_ROOT/${ctx.paths.localSkillRoot}/${tool}/dist/${tool}"
[ -z "$${v}" ] && ${v}="${toShellPath(dir)}/${tool}"`;
}

/** The prelude one fence needs, or '' when it needs none. */
export function fencePrelude(ctx: TemplateContext, body: string): string {
  if (!getHostConfig(ctx.host).usesEnvVars) return '';
  const needB = uses('B').test(body) && !assigns('B').test(body);
  const needD = uses('D').test(body) && !assigns('D').test(body);
  const needP = uses('P').test(body) && !assigns('P').test(body);
  if (assigns('GSTACK_ROOT').test(body)) return '';
  const needRoot = needB || needD || needP || ROOT_VARS.test(body);
  const derived = Object.entries(DERIVED)
    .filter(([name]) => uses(`GSTACK_${name}`).test(body) && !assigns(`GSTACK_${name}`).test(body))
    .map(([name, dir]) => `GSTACK_${name}=$GSTACK_ROOT/${dir}`);
  return [
    needRoot ? resolveRoot(ctx) : '',
    derived.join(' '),
    needB ? binaryAssignment(ctx, 'browse') : '',
    needD ? binaryAssignment(ctx, 'design') : '',
    needP ? binaryAssignment(ctx, 'make-pdf') : '',
  ].filter(Boolean).join('\n');
}

/**
 * Post-render pass: insert the prelude at the top of every top-level ```bash
 * fence that needs it. Fences nested inside a longer fence are examples, not
 * commands, and are left alone; an indented fence gets indented prelude lines.
 */
export function insertRuntimePreludes(content: string, ctx: TemplateContext): string {
  if (!getHostConfig(ctx.host).usesEnvVars) return content;
  const lines = content.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)(`{3,})(.*)$/);
    out.push(lines[i]);
    if (!open) continue;
    let end = i + 1;
    while (end < lines.length && !new RegExp(`^\\s*\`{${open[2].length},}\\s*$`).test(lines[end])) end++;
    const body = lines.slice(i + 1, end);
    if (open[2].length === 3 && open[3].trim() === 'bash') {
      const prelude = fencePrelude(ctx, body.join('\n'));
      if (prelude) out.push(...prelude.split('\n').map(line => open[1] + line));
    }
    out.push(...body);
    if (end < lines.length) out.push(lines[end]);
    i = end;
  }
  return out.join('\n');
}
