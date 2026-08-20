/**
 * Integer flag normalization for the design CLI (#2032).
 *
 * The CLI's flag parser yields a string ("3"), boolean true (bare flag with
 * no value), or undefined (flag absent). parseInt on those produced NaN that
 * flowed silently into loop bounds and setTimeout:
 *   --count abc   → for (i < NaN) never runs → ZERO variants, exit 0
 *   --retry abc   → attempt <= NaN is false  → generate() silent no-op
 *   --timeout abc → setTimeout(NaN) fires ~immediately → serve dies at boot
 *
 * Contract (matches the --viewports precedent, variants.ts: error LOUDLY on
 * nonsense; these commands spend real image-API money, so a silent fixup
 * hides typos from calling agents):
 *   - undefined                  → default (flag absent)
 *   - true / "" (bare flag)      → error: requires a value
 *   - non-numeric / non-integer  → error ("3.7" is rejected, not truncated)
 *   - below min                  → error
 *   - above max (when given)     → clamp to max, stderr warning
 *   - repeated flag              → parser is last-wins before we ever see it
 */

export interface IntFlagSpec {
  name: string;
  def: number;
  min: number;
  max?: number;
}

export type IntFlagResult =
  | { ok: true; value: number; warning?: string }
  | { ok: false; error: string };

/** Pure decision function — unit-testable without process.exit. */
export function parseIntFlag(raw: unknown, spec: IntFlagSpec): IntFlagResult {
  const { name, def, min, max } = spec;
  const bounds = `an integer >= ${min}${max !== undefined ? ` (max ${max})` : ""}`;

  if (raw === undefined || raw === false) return { ok: true, value: def };
  if (raw === true) {
    return { ok: false, error: `--${name} requires a value. Expected ${bounds}.` };
  }

  const s = String(raw).trim();
  if (s === "") {
    return { ok: false, error: `--${name} requires a value. Expected ${bounds}.` };
  }
  if (!/^-?\d+$/.test(s)) {
    return { ok: false, error: `Invalid --${name}: "${s}" is not an integer. Expected ${bounds}.` };
  }

  const n = parseInt(s, 10);
  if (n < min) {
    return { ok: false, error: `Invalid --${name}: ${n} is below the minimum of ${min}.` };
  }
  if (max !== undefined && n > max) {
    return {
      ok: true,
      value: max,
      warning: `--${name} ${n} exceeds the maximum of ${max}; using ${max}.`,
    };
  }
  return { ok: true, value: n };
}

/** CLI wrapper: loud exit(1) on invalid input, stderr warning on clamp. */
export function normalizeIntFlag(raw: unknown, spec: IntFlagSpec): number {
  const r = parseIntFlag(raw, spec);
  if (!r.ok) {
    console.error(r.error);
    process.exit(1);
  }
  if (r.warning) console.error(r.warning);
  return r.value;
}
