/**
 * ship-policy-review — the base-read `review` key of .gstack/ship-policy.json (docs/review-policy.md#review-depth),
 * kept beside lib/ship-policy.ts so that module stays under the size ratchet. `panel` keeps today's reviewer panel
 * for a class (risk by default: the printed full-depth plan and its full pass 2 on risk class, one reader elsewhere; R65 as amended by FOUN-64), `reader_model` is the model of that one reader,
 * `platform` lets a non-risk diff rely on the platform review at its exact head, and `risk_paths` adds code
 * paths to R51's risk classes.
 */
export interface ReviewPolicy { panel: 'off' | 'risk' | 'all'; reader_model: string; platform: 'off' | 'on'; risk_paths: string[] }
export const REVIEW_POLICY_DEFAULT: ReviewPolicy = { panel: 'all', reader_model: 'lane', platform: 'off', risk_paths: [] };
const MODEL = /^[A-Za-z0-9][\w./:-]{0,127}$/;

/** The key with every omitted field at its default (a policy file may set any subset). */
export function reviewPolicy(p: { review?: Partial<ReviewPolicy> | null } | null | undefined): ReviewPolicy {
  return { ...REVIEW_POLICY_DEFAULT, ...(p?.review ?? {}) };
}

/** `review`: each field's error at its path; `globs` checks risk_paths as ship-policy checks every glob list. */
export function reviewErrors(value: unknown, out: { code: 'POLICY_INVALID'; path: string; message: string }[] | any[], globs: (key: string, v: unknown) => void): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { out.push({ code: 'POLICY_INVALID', path: 'review', message: 'must be { panel?, reader_model?, platform?, risk_paths? }' }); return; }
  const v = value as Record<string, unknown>;
  for (const k of Object.keys(v)) if (!(k in REVIEW_POLICY_DEFAULT)) out.push({ code: 'POLICY_INVALID', path: `review.${k}`, message: 'unknown key' });
  if ('panel' in v && !['off', 'risk', 'all'].includes(v.panel as string)) out.push({ code: 'POLICY_INVALID', path: 'review.panel', message: `must be off | risk | all, got ${JSON.stringify(v.panel)}` });
  if ('platform' in v && !['off', 'on'].includes(v.platform as string)) out.push({ code: 'POLICY_INVALID', path: 'review.platform', message: `must be off | on, got ${JSON.stringify(v.platform)}` });
  if ('reader_model' in v && (typeof v.reader_model !== 'string' || !MODEL.test(v.reader_model))) out.push({ code: 'POLICY_INVALID', path: 'review.reader_model', message: 'must be lane, cross-family or a model id (letters, digits and . _ / : -)' });
  if ('risk_paths' in v) globs('review.risk_paths', v.risk_paths);
}
