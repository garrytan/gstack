/**
 * ship-policy-readers — the `readers` key of .gstack/ship-policy.json (docs/ship-policy.md#readers, GST-1322): what
 * /ship's readers may not fetch or open, beyond the fetch rule every brief carries (lib/review-fetch.ts).
 * `forbid_fetch` names hosts (`huggingface.co`) or repositories (`github.com/owner/repo`) no reader may reach, web
 * page reads included; `forbid_paths` are git glob pathspecs no reader may open, cut out of every reader's diff;
 * `brief_note` is one line every reader's brief carries (a custody note). The base branch's policy governs: the
 * head may add forbid_fetch entries, never remove one; its forbid_paths and brief_note are ignored, because a path
 * the head adds would cut the branch's own code out of its review and its text would reach every brief. Kept beside lib/ship-policy.ts,
 * which stays under the module-size ratchet and must not be imported from here.
 */
import { createHash } from 'node:crypto';

export interface ReadersPolicy { forbid_fetch: string[]; forbid_paths: string[]; brief_note: string | null }
export const READERS_POLICY_DEFAULT: ReadersPolicy = { forbid_fetch: [], forbid_paths: [], brief_note: null };
export const MAX_BRIEF_NOTE = 400;
const FETCH_ENTRY = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+(\/[A-Za-z0-9._-]{1,100}(\/[A-Za-z0-9._-]{1,100})?)?$/;

/** The key with every omitted field at its default (a policy file may set any subset). */
export function readersPolicy(p: { readers?: Partial<ReadersPolicy> | null } | null | undefined): ReadersPolicy {
  return { ...READERS_POLICY_DEFAULT, ...(p?.readers ?? {}) };
}

const CREDENTIAL = /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|AKIA[0-9A-Z]{16}|xox[abprs]-|-----BEGIN|eyJ[A-Za-z0-9_-]{20,}\.)/;

/** What `gstack-ship-policy init --explain` prints for the key. */
export const READERS_EXPLANATION = '{ forbid_fetch?, forbid_paths?, brief_note? }: what /ship\'s readers may not reach beyond the fetch rule every brief carries (no clone, fetch or download of another repository, dataset or archive). forbid_fetch: hosts (`huggingface.co`) or `host/owner/repo` (`github.com/owner/repo`) no reader may reach, web page reads included; forbid_paths: git glob pathspecs no reader may open, cut out of every reader\'s diff; brief_note: one line (at most 400 characters) every brief carries, for example a custody note. Read from the base branch; the head may add forbid_fetch entries, never remove one, and its forbid_paths and brief_note are ignored (docs/ship-policy.md#readers).';

/** forbid_paths: git glob pathspecs checked as review_exclude_paths are (`contained` is lib/ship-policy.ts's containedRelative). */
function pathErrors(value: unknown, out: Array<{ code: 'POLICY_INVALID'; path: string; message: string }>, contained: (p: string) => string | null): void {
  if (!Array.isArray(value)) { out.push({ code: 'POLICY_INVALID', path: 'readers.forbid_paths', message: 'must be an array of git glob pathspecs' }); return; }
  if (value.length > 64) out.push({ code: 'POLICY_INVALID', path: 'readers.forbid_paths', message: 'more than 64 patterns' });
  value.forEach((p, i) => {
    const why = typeof p !== 'string' ? 'must be a string' : p.length > 256 ? 'is longer than 256 characters' : contained(p) ?? (/^[:!]/.test(p) ? 'must not start with : or ! (no pathspec magic or negation)' : /[\x00-\x1f\x7f]/.test(p) ? 'contains a control character' : p.replace(/\/+$/, '') === '' || p === '.' ? 'must not name the whole repository' : null);
    if (why) out.push({ code: 'POLICY_INVALID', path: `readers.forbid_paths[${i}]`, message: `${JSON.stringify(p)} ${why}` });
  });
}

/** `readers`: each field's error at its path. */
export function readersErrors(value: unknown, out: Array<{ code: 'POLICY_INVALID'; path: string; message: string }> | any[], contained: (p: string) => string | null): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { out.push({ code: 'POLICY_INVALID', path: 'readers', message: 'must be { forbid_fetch?, forbid_paths?, brief_note? }' }); return; }
  const v = value as Record<string, unknown>;
  for (const k of Object.keys(v)) if (!(k in READERS_POLICY_DEFAULT)) out.push({ code: 'POLICY_INVALID', path: `readers.${k}`, message: 'unknown key' });
  if ('forbid_fetch' in v) {
    if (!Array.isArray(v.forbid_fetch)) out.push({ code: 'POLICY_INVALID', path: 'readers.forbid_fetch', message: 'must be an array of hosts (huggingface.co) or host/owner/repo (github.com/owner/repo)' });
    else {
      if (v.forbid_fetch.length > 64) out.push({ code: 'POLICY_INVALID', path: 'readers.forbid_fetch', message: 'more than 64 entries' });
      v.forbid_fetch.forEach((e, i) => { if (typeof e !== 'string' || !FETCH_ENTRY.test(e)) out.push({ code: 'POLICY_INVALID', path: `readers.forbid_fetch[${i}]`, message: `${JSON.stringify(e)} must be a lowercase host or host/owner[/repo], no scheme` }); });
    }
  }
  if ('forbid_paths' in v) pathErrors(v.forbid_paths, out, contained);
  if ('brief_note' in v && v.brief_note !== null) {
    const n = v.brief_note;
    if (typeof n !== 'string' || !n.trim()) out.push({ code: 'POLICY_INVALID', path: 'readers.brief_note', message: 'must be a non-empty string or null' });
    else if (n.length > MAX_BRIEF_NOTE) out.push({ code: 'POLICY_INVALID', path: 'readers.brief_note', message: `longer than ${MAX_BRIEF_NOTE} characters` });
    else if (/[\x00-\x1f\x7f]/.test(n)) out.push({ code: 'POLICY_INVALID', path: 'readers.brief_note', message: 'must be one line with no control characters' });
    else if (CREDENTIAL.test(n)) out.push({ code: 'POLICY_INVALID', path: 'readers.brief_note', message: 'looks like it carries a credential' });
  }
}

/** What a pass applies: the base's lists plus any forbid_fetch entry the head adds (a branch can tighten, never loosen); forbid_paths and the note come from the base only. */
export interface EffectiveReaders extends ReadersPolicy { digest: string; base_entries: number; head_added: string[] }
export function effectiveReaders(base: ReadersPolicy, head: ReadersPolicy | null): EffectiveReaders {
  const union = (a: string[], b: string[] | undefined) => [...a, ...(b ?? []).filter(x => !a.includes(x))];
  const forbid_fetch = union(base.forbid_fetch, head?.forbid_fetch);
  const forbid_paths = [...base.forbid_paths];
  const head_added = forbid_fetch.slice(base.forbid_fetch.length);
  const policy = { forbid_fetch, forbid_paths, brief_note: base.brief_note };
  return { ...policy, digest: createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 12), base_entries: base.forbid_fetch.length + base.forbid_paths.length, head_added };
}

/** Whether a pass applies anything beyond the default fetch rule. */
export const declaresReaders = (r: ReadersPolicy) => r.forbid_fetch.length > 0 || r.forbid_paths.length > 0 || !!r.brief_note;
