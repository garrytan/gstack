/**
 * Validation of the stamp policy keys (stamp_patterns templates and stamp_placeholders), split out of ship-policy.ts
 * to keep that module under the module-size ratchet.
 */
import type { PolicyError } from './ship-policy';
import { parseVersion } from './version-source';

const MAX_TEMPLATES = 16;
const MAX_TEMPLATE = 128;
const MAX_PLACEHOLDERS = 16;
const MAX_PLACEHOLDER = 32;
export const VERSION_SLOT = '{version}';

export function templateErrors(value: unknown, out: PolicyError[]): void {
  if (!Array.isArray(value)) { out.push({ code: 'POLICY_INVALID', path: 'stamp_patterns', message: 'must be an array of literal templates' }); return; }
  if (value.length > MAX_TEMPLATES) out.push({ code: 'POLICY_CONTAINMENT', path: 'stamp_patterns', message: `more than ${MAX_TEMPLATES} templates` });
  value.forEach((t, i) => {
    const at = `stamp_patterns[${i}]`;
    if (typeof t !== 'string') { out.push({ code: 'POLICY_INVALID', path: at, message: 'must be a string' }); return; }
    if (t.split(VERSION_SLOT).length !== 2) out.push({ code: 'POLICY_INVALID', path: at, message: `${JSON.stringify(t)} must contain exactly one ${VERSION_SLOT}` });
    else if (t.length > MAX_TEMPLATE || /[\0\r\n]/.test(t)) out.push({ code: 'POLICY_CONTAINMENT', path: at, message: `must be one line of at most ${MAX_TEMPLATE} characters` });
  });
}

export function placeholderErrors(value: unknown, out: PolicyError[]): void {
  if (!Array.isArray(value)) { out.push({ code: 'POLICY_INVALID', path: 'stamp_placeholders', message: 'must be an array of literal placeholders' }); return; }
  if (value.length > MAX_PLACEHOLDERS) out.push({ code: 'POLICY_CONTAINMENT', path: 'stamp_placeholders', message: `more than ${MAX_PLACEHOLDERS} placeholders` });
  value.forEach((p, i) => {
    const at = `stamp_placeholders[${i}]`;
    if (typeof p !== 'string') { out.push({ code: 'POLICY_INVALID', path: at, message: 'must be a string' }); return; }
    if (!p.trim() || p.length > MAX_PLACEHOLDER || /[\0\r\n]/.test(p)) out.push({ code: 'POLICY_CONTAINMENT', path: at, message: `must be one non-empty line of at most ${MAX_PLACEHOLDER} characters` });
    else if (p.includes(VERSION_SLOT)) out.push({ code: 'POLICY_INVALID', path: at, message: `${JSON.stringify(p)} must not contain ${VERSION_SLOT}` });
    else if (parseVersion(p)) out.push({ code: 'POLICY_INVALID', path: at, message: `${JSON.stringify(p)} is a version, not a placeholder` });
  });
}
