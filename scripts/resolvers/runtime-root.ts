/**
 * Runtime root for env-var hosts (C1, #1159): the one owner of how generated
 * bash finds gstack on Codex and every other `usesEnvVars` host.
 *
 * Those hosts run each fenced block in a fresh shell, so `GSTACK_ROOT`, `B`
 * and `D` set by an earlier block are gone. The preamble's root resolution and
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
 * Lines that assign `B` (browse) or `D` (design). BROWSE SETUP, DESIGN SETUP and
 * the prelude all use this, so a later fence runs the binary setup checked.
 * Env-var hosts derive from `GSTACK_ROOT`, which the prelude already points at
 * the repo-local install when one exists; other hosts keep their
 * repo-local-first probe.
 */
export function binaryAssignment(ctx: TemplateContext, tool: 'browse' | 'design'): string {
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
  if (assigns('GSTACK_ROOT').test(body)) return '';
  const needRoot = needB || needD || ROOT_VARS.test(body);
  const derived = Object.entries(DERIVED)
    .filter(([name]) => uses(`GSTACK_${name}`).test(body) && !assigns(`GSTACK_${name}`).test(body))
    .map(([name, dir]) => `GSTACK_${name}=$GSTACK_ROOT/${dir}`);
  return [
    needRoot ? resolveRoot(ctx) : '',
    derived.join(' '),
    needB ? binaryAssignment(ctx, 'browse') : '',
    needD ? binaryAssignment(ctx, 'design') : '',
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
