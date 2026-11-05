/**
 * The one selection every reader's diff is built from (GST-1476, docs/ship-policy.md#review-exclude-paths): the base policy's
 * review_exclude_paths specs, the readers policy's forbid_paths specs, the kept files and the secret-line excerpts (GST-1447).
 * gstack-review-plan applies it to every dispatch, buildManifest applies it again to every pass reader, and a standalone
 * gstack-review-dispatch render applies it to its one reader, so a first render, a re-render after a failed dispatch and a
 * late stage all read the same diff (harness-evals #269: the Red Team's own render read 30.3 MB, the pass's readers 2 MB).
 */
import { spawnSync } from 'node:child_process';
import { forbidSpecs, forbiddenPath } from './review-fetch';
import { isUnavailable } from './ship-policy';
import { loadPolicyAt } from './ship-policy-at';
import type { EffectiveReaders } from './ship-policy-readers';

export interface PolicySelection { specs: string[]; keep: string[]; excerpt: string[]; forbidden: InstanceType<typeof Bun.Glob>[] }
/** The plan's review_exclude object (an active one carries specs, keep and excerpt) or the manifest's copy of it. */
export type ExcludeSource = { state?: unknown; specs?: unknown; keep?: unknown; excerpt?: unknown } | null | undefined;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

export function policySelection(x: ExcludeSource, readers: Pick<EffectiveReaders, 'forbid_paths'> | null | undefined): PolicySelection {
  const active = x?.state === 'active';
  const forbid = readers?.forbid_paths ?? [];
  return {
    specs: [...(active ? strings(x.specs) : []), ...forbidSpecs({ forbid_paths: forbid })],
    keep: active ? strings(x.keep) : [],
    excerpt: active ? strings(x.excerpt) : [],
    forbidden: forbid.map(g => new Bun.Glob(g.replace(/\/+$/, ''))),
  };
}

/** Whether <base>'s policy may exclude anything: false only when it reads cleanly and declares no review_exclude_paths (an unreadable one goes to the plan, which refuses). */
export function mayExclude(root: string, base: string): boolean {
  const rev = (r: string) => spawnSync('git', ['rev-parse', '--verify', '-q', `${r}^{commit}`], { cwd: root, encoding: 'utf8', timeout: 30_000 }).stdout?.trim() || null;
  const b = base.replace(/^origin\//, '');
  const ref = rev(`origin/${b}`) ? `origin/${b}` : b;
  const sha = rev(ref);
  if (!sha) return false;
  const load = loadPolicyAt(root, sha, ref);
  return isUnavailable(load) || load.policy.review_exclude_paths.length > 0;
}

/**
 * A reader's pathspecs with the selection applied: every spec it lacks appended, the kept files (its own first) less any
 * forbidden path, and the excerpt files among them. keep still lists the excerpt files, as the plan's dispatches do.
 */
export function selectFor<D extends { exclude: string[]; keep?: string[]; excerpt?: string[] }>(d: D, s: PolicySelection): D {
  const exclude = [...d.exclude, ...s.specs.filter(x => !d.exclude.includes(x))];
  const keep = [...new Set([...(d.keep ?? []), ...s.keep])].filter(k => !s.forbidden.length || !forbiddenPath(s.forbidden, k.replace(/^:\(top,literal\)/, '')));
  const excerpt = [...new Set([...(d.excerpt ?? []), ...s.excerpt])].filter(k => keep.includes(k));
  const { keep: _k, excerpt: _e, ...rest } = d;
  return { ...rest, exclude, ...(keep.length ? { keep } : {}), ...(excerpt.length ? { excerpt } : {}) } as D;
}
