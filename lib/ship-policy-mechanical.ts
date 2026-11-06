/**
 * The `mechanical_retake` key of .gstack/ship-policy.json (GST-1560, docs/ship-policy.md#mechanical-retake): a version or
 * rules constant a branch takes and may have to retake after a base merge, the fixture fields that carry the same value,
 * and the .gstack/generated.json entries that regenerate its goldens. /ship finish proves a retake from these
 * declarations (lib/ship-mechanical.ts); nothing is inferred. Kept beside lib/ship-policy.ts, which stays under the
 * module-size ratchet and must not be imported from here (`glob` is its globError).
 */
export const VALUE_SLOT = '{n}';
export interface MechanicalField { glob: string; field: string }
export interface MechanicalConstant { path: string; template: string; fields: MechanicalField[]; regen: string[] }

const MAX_CONSTANTS = 8, MAX_TEMPLATE = 128, MAX_LIST = 16;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const REGEN_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const DIGITS = /^\d{1,15}$/;

/** What `gstack-ship-policy init --explain` prints for the key. */
export const MECHANICAL_EXPLANATION = 'Array of { path, template, fields, regen }: a version or rules constant a branch may retake after a base merge (GST-1560). path is one literal repository file, template the whole line with one {n} for the value (\'const SAVE_VERSION := {n}\'), fields the { glob, field } fixture fields that carry the same value (a line holding only field: n, field = n or "field": n), regen the .gstack/generated.json entry ids whose command regenerates the goldens. A post-review edit that only retakes the constant (one literal, a higher value), writes the same value into declared fields and leaves goldens those commands regenerate byte-identically routes as mechanical in /ship finish, with no reader; any other edit in those files routes as behavior. Read from the base branch only. Empty (default) declares none (docs/ship-policy.md#mechanical-retake).';

/** Every error in the key at its path; `glob` is lib/ship-policy.ts's globError. */
export function mechanicalErrors(value: unknown, out: Array<{ code: 'POLICY_INVALID' | 'POLICY_CONTAINMENT'; path: string; message: string }> | any[], glob: (g: string) => string | null): void {
  const at = 'mechanical_retake';
  if (!Array.isArray(value)) { out.push({ code: 'POLICY_INVALID', path: at, message: 'must be an array of { path, template, fields, regen }' }); return; }
  if (value.length > MAX_CONSTANTS) out.push({ code: 'POLICY_CONTAINMENT', path: at, message: `more than ${MAX_CONSTANTS} constants` });
  value.forEach((c, i) => {
    const here = `${at}[${i}]`;
    const e = c as Record<string, unknown> | null;
    if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).sort().join() !== 'fields,path,regen,template') { out.push({ code: 'POLICY_INVALID', path: here, message: 'must be exactly { path, template, fields, regen }' }); return; }
    const p = e.path;
    const pathWhy = typeof p !== 'string' ? 'must be a string' : glob(p) ?? (/[*?[\]{}]/.test(p) ? 'must be one literal file, not a glob' : /^\.(gstack|github)\//.test(p) ? 'must not name a path under .gstack/ or .github/' : null);
    if (pathWhy) out.push({ code: 'POLICY_CONTAINMENT', path: `${here}.path`, message: `${JSON.stringify(p)} ${pathWhy}` });
    const t = e.template;
    if (typeof t !== 'string' || t.split(VALUE_SLOT).length !== 2 || !t.replace(VALUE_SLOT, '').trim()) out.push({ code: 'POLICY_INVALID', path: `${here}.template`, message: `must hold exactly one ${VALUE_SLOT} beside literal text` });
    else if (t.length > MAX_TEMPLATE || /[\0\r\n]/.test(t)) out.push({ code: 'POLICY_CONTAINMENT', path: `${here}.template`, message: `must be one line of at most ${MAX_TEMPLATE} characters` });
    const list = (key: 'fields' | 'regen', check: (v: unknown) => string | null) => {
      const v = e[key];
      if (!Array.isArray(v)) { out.push({ code: 'POLICY_INVALID', path: `${here}.${key}`, message: 'must be an array' }); return; }
      if (v.length > MAX_LIST) out.push({ code: 'POLICY_CONTAINMENT', path: `${here}.${key}`, message: `more than ${MAX_LIST} entries` });
      v.forEach((x, j) => { const why = check(x); if (why) out.push({ code: 'POLICY_INVALID', path: `${here}.${key}[${j}]`, message: why }); });
    };
    list('fields', f => {
      const o = f as Record<string, unknown> | null;
      if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).sort().join() !== 'field,glob' || typeof o.glob !== 'string' || typeof o.field !== 'string') return 'must be exactly { glob, field } strings';
      return glob(o.glob) ?? (/^\.(gstack|github)\//.test(o.glob) ? 'glob must not name a path under .gstack/ or .github/' : FIELD_RE.test(o.field) ? null : `field ${JSON.stringify(o.field)} must be a plain key name`);
    });
    list('regen', id => typeof id === 'string' && REGEN_ID_RE.test(id) ? null : `${JSON.stringify(id)} must be a .gstack/generated.json entry id`);
  });
}

/** The value on a line that is exactly the template with digits in its slot (a trailing CR ignored); null otherwise. */
export function constantValue(line: string, template: string): number | null {
  const [pre, post] = template.split(VALUE_SLOT) as [string, string];
  const l = line.replace(/\r$/, '');
  if (l.length <= pre.length + post.length || !l.startsWith(pre) || !l.endsWith(post)) return null;
  const v = l.slice(pre.length, l.length - post.length);
  return DIGITS.test(v) ? Number(v) : null;
}

/** The value on a line holding only the field and a number (`field: n`, `field = n`, `"field": n,`); null otherwise. */
export function fieldValue(line: string, field: string): number | null {
  const m = new RegExp(`^\\s*(["']?)${field.replace(/[.-]/g, '\\$&')}\\1\\s*[:=]\\s*(\\d{1,15})\\s*,?\\s*$`).exec(line.replace(/\r$/, ''));
  return m ? Number(m[2]) : null;
}
