/**
 * carry_mechanical (GST-1210): a base-policy allowlist for the receipt carry. A declared version constant is one whole
 * line matching a literal template with one {n} slot; the carry masks only that line's digits, compares the masked sides
 * with the same rule as any other path (lib/ship-patch.ts comparePath) and needs the pregate's regen check to have proved
 * every changed path under goldens at HEAD (docs/ship-policy.md#receipt-carry). Split out of ship-policy.ts to keep that
 * module under the module-size ratchet.
 */
import type { PolicyError } from './ship-policy';

export const CONSTANT_SLOT = '{n}';
const MAX_CONSTANTS = 8;
const MAX_TEMPLATE = 128;
const MAX_PATH = 256;
const MAX_GOLDENS = 16;

export interface CarryMechanical { version_constants: Array<{ path: string; template: string }>; goldens: string[] }

const unsafePath = (p: string) => !p || p.length > MAX_PATH || /[\0\r\n\\]/.test(p) || p.startsWith('/') || p.startsWith(':') || p.startsWith('!') || p.split('/').some(s => s === '..' || s === '.' || s === '');

export function carryMechanicalErrors(value: unknown, out: PolicyError[]): void {
  const at = 'carry_mechanical';
  if (!value || typeof value !== 'object' || Array.isArray(value)) { out.push({ code: 'POLICY_INVALID', path: at, message: 'must be { version_constants, goldens }' }); return; }
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (key !== 'version_constants' && key !== 'goldens') out.push({ code: 'POLICY_INVALID', path: `${at}.${key}`, message: 'unknown key' });
  if (!Array.isArray(v.version_constants)) out.push({ code: 'POLICY_INVALID', path: `${at}.version_constants`, message: 'must be an array of { path, template }' });
  else {
    if (v.version_constants.length > MAX_CONSTANTS) out.push({ code: 'POLICY_CONTAINMENT', path: `${at}.version_constants`, message: `more than ${MAX_CONSTANTS} constants` });
    v.version_constants.forEach((c, i) => {
      const here = `${at}.version_constants[${i}]`;
      const entry = c as Record<string, unknown> | null;
      if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || typeof entry.template !== 'string' || Object.keys(entry).some(k => k !== 'path' && k !== 'template')) { out.push({ code: 'POLICY_INVALID', path: here, message: 'must be { path, template } strings' }); return; }
      if (unsafePath(entry.path) || /[*?[\]{}]/.test(entry.path)) out.push({ code: 'POLICY_CONTAINMENT', path: `${here}.path`, message: 'must be a literal repository-relative file path (no glob, no ..)' });
      const parts = entry.template.split(CONSTANT_SLOT);
      if (parts.length !== 2 || !(parts[0]! + parts[1]!).trim()) out.push({ code: 'POLICY_INVALID', path: `${here}.template`, message: `${JSON.stringify(entry.template)} must hold exactly one ${CONSTANT_SLOT} beside literal text` });
      else if (entry.template.length > MAX_TEMPLATE || /[\0\r\n]/.test(entry.template)) out.push({ code: 'POLICY_CONTAINMENT', path: `${here}.template`, message: `must be one line of at most ${MAX_TEMPLATE} characters` });
    });
  }
  if (!Array.isArray(v.goldens)) out.push({ code: 'POLICY_INVALID', path: `${at}.goldens`, message: 'must be an array of globs' });
  else {
    if (v.goldens.length > MAX_GOLDENS) out.push({ code: 'POLICY_CONTAINMENT', path: `${at}.goldens`, message: `more than ${MAX_GOLDENS} globs` });
    v.goldens.forEach((g, i) => { if (typeof g !== 'string' || unsafePath(g)) out.push({ code: 'POLICY_CONTAINMENT', path: `${at}.goldens[${i}]`, message: 'must be a repository-relative glob (no ..)' }); });
  }
}

/** The text with its one line matching `template` (digits in the slot, nothing else on the line) set to the template; null unless exactly one line matches. */
export function maskConstant(text: string, template: string): { masked: string; value: number } | null {
  const [pre, post] = template.split(CONSTANT_SLOT) as [string, string];
  const lines = text.split('\n');
  let hit = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length <= pre.length + post.length || !line.startsWith(pre) || !line.endsWith(post) || !/^\d{1,15}$/.test(line.slice(pre.length, line.length - post.length))) continue;
    if (hit >= 0) return null;
    hit = i;
  }
  if (hit < 0) return null;
  const value = Number(lines[hit]!.slice(pre.length, lines[hit]!.length - post.length));
  lines[hit] = template;
  return { masked: lines.join('\n'), value };
}
