/**
 * pregate/head-policy — `--policy-from head` (GST-419): a branch's own
 * `.gstack/pregate.json` may only add test lanes over the trusted policy (the
 * base branch's copy, or the user-owned file when the base has none). A lane
 * is a `dependencies` glob with a non-empty test list, or extra tests on a glob
 * the trusted policy already maps. Everything else (a removed or shrunk glob, a
 * new `[]` declaration, the runner, guards, warn, allowlist, timeouts, the
 * remote gate, ...) must equal the trusted copy, or the run is refused with
 * PREGATE_HEAD_POLICY_LOOSENS. A branch behind its base is compared with the
 * copy at its merge base and runs the base tip's policy plus its additions, so
 * a lane the base gained later never reads as a removal. With no trusted policy
 * at all, the head file is a bootstrap and runs as written. `sealed` is not
 * compared: its guard reads the base branch's copy itself.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GENERATED_PATH } from '../regen';
import { PREGATE_CONFIG_PATH, loadConfigFromHead, parseConfig, type ConfigLoad, type PregateConfig } from './config';

type Loaded = Exclude<ConfigLoad, { unavailable: true }>;

const FROZEN = ['runner', 'empty_lanes', 'selection', 'warn', 'strays', 'local', 'guards', 'serial_patterns', 'price_file', 'stall_timeout_s', 'timeout_s', 'remote_gate', 'allowlist'] as const;

const canonical = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
};
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Each way `head` loosens `ref`, and the tests it adds per glob. */
export function headPolicyDiff(ref: PregateConfig, head: PregateConfig, base: string): { loosens: string[]; adds: Record<string, string[]> } {
  const loosens: string[] = FROZEN.filter(k => !same(ref[k], head[k])).map(k => `${k} differs from the trusted policy`);
  const adds: Record<string, string[]> = {};
  for (const [glob, tests] of Object.entries(ref.dependencies)) {
    const now = head.dependencies[glob];
    if (!now) { loosens.push(`dependencies[${JSON.stringify(glob)}] is removed`); continue; }
    const dropped = tests.filter(t => !now.includes(t));
    if (dropped.length) loosens.push(`dependencies[${JSON.stringify(glob)}] drops ${dropped.join(', ')}`);
    const extra = now.filter(t => !tests.includes(t));
    if (extra.length) adds[glob] = extra;
  }
  for (const [glob, tests] of Object.entries(head.dependencies)) {
    if (glob in ref.dependencies) continue;
    if (!tests.length) loosens.push(`dependencies[${JSON.stringify(glob)}] declares no lane needed; a [] declaration must land on ${base} first`);
    else adds[glob] = tests;
  }
  return { loosens, adds };
}

/** The policy at the merge base when it carries a valid copy; the branch's additions are measured from there. */
function forkCopy(repoRoot: string, mergeBase: string, knownChecks: readonly string[]): PregateConfig | null {
  const r = spawnSync('git', ['show', `${mergeBase}:${PREGATE_CONFIG_PATH}`], { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0 || r.error) return null;
  const parsed = parseConfig(r.stdout, knownChecks);
  return parsed.errors.length ? null : parsed.config;
}

/** The policy a `--policy-from head` run uses over `trusted`, or what the head file loosens. */
export function headPolicy(repoRoot: string, trusted: Loaded, mergeBase: string, base: string, knownChecks: readonly string[]): { load: Loaded; explain: string[] } | { loosens: string[] } {
  const head = loadConfigFromHead(repoRoot, knownChecks) as Loaded;
  if (trusted.kind === 'none' || head.errors.length) return { load: head, explain: [] };
  if (head.kind === 'none') return { loosens: [`${PREGATE_CONFIG_PATH} is absent at head while ${trusted.label} declares a policy`] };
  const ref = (trusted.kind === 'base' && forkCopy(repoRoot, mergeBase, knownChecks)) || trusted.config;
  const { loosens, adds } = headPolicyDiff(ref, head.config, base);
  if (loosens.length) return { loosens };
  const dependencies = { ...trusted.config.dependencies };
  for (const [glob, tests] of Object.entries(adds)) dependencies[glob] = [...new Set([...(dependencies[glob] ?? []), ...tests])];
  const n = Object.keys(adds).length;
  return {
    load: { ...trusted, config: { ...trusted.config, dependencies }, declaresLanes: trusted.declaresLanes === true || head.declaresLanes === true, kind: 'head', label: `head (unreviewed) ${PREGATE_CONFIG_PATH}: adds ${n} lane${n === 1 ? '' : 's'} over ${trusted.label}` },
    explain: Object.entries(adds).map(([glob, tests]) => `head policy adds: dependencies[${JSON.stringify(glob)}] → ${tests.join(', ')}`),
  };
}

/**
 * Whether a /ship run on the final tree (gstack-ship-release accept, and finish's full pregate rerun) gates under the
 * branch's own policy (GST-1595): only when the base branch carries a policy and the branch's file differs from the copy
 * it forked from (else the base tip's) in nothing but added test lanes, with GENERATED_PATH equal to the base tip's (a
 * head-policy run loads the regen registry from the branch, context.ts), so the gate only gets stricter. Any other difference keeps the base policy, as before. `line` names the policy and why; it is absent
 * when the branch leaves the policy alone.
 */
export function lanesOnlyHeadPolicy(repoRoot: string, base: string): { head: boolean; line?: string } {
  const ref = `origin/${base.replace(/^origin\//, '')}`;
  const show = (rev: string, file: string) => { const r = spawnSync('git', ['show', `${rev}:${file}`], { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 }); return r.status === 0 && !r.error ? r.stdout : null; };
  const read = (file: string) => { try { return fs.readFileSync(path.join(repoRoot, file), 'utf8'); } catch { return null; } };
  const json = (text: string | null): Record<string, unknown> | null => { try { const v = text === null ? null : JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };
  const tip = show(ref, PREGATE_CONFIG_PATH), headText = read(PREGATE_CONFIG_PATH);
  const fork = spawnSync('git', ['merge-base', ref, 'HEAD'], { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 }).stdout?.trim();
  const trusted = json((fork && show(fork, PREGATE_CONFIG_PATH)) || tip), head = json(headText);
  if (headText === tip || (trusted && head && same(trusted, head))) return { head: false };
  const keep = (why: string) => ({ head: false, line: `POLICY: base ${ref}:${PREGATE_CONFIG_PATH} (the branch's copy ${why}, so it does not count here; land it on ${ref.slice(7)} first)` });
  if (!tip || !trusted) return keep(`has no reviewed copy on ${ref} to add lanes to`);
  if (!head) return keep(headText === null ? 'is deleted' : 'does not parse as a JSON object');
  const { dependencies: refDeps = {}, ...refRest } = trusted, { dependencies: headDeps = {}, ...headRest } = head;
  const other = [...new Set([...Object.keys(refRest), ...Object.keys(headRest)])].filter(k => !same(refRest[k], headRest[k])).sort();
  if (other.length) return keep(`also changes ${other.join(', ')}`);
  const lists = (v: unknown): v is Record<string, string[]> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(t => Array.isArray(t) && t.every(x => typeof x === 'string'));
  if (!lists(refDeps) || !lists(headDeps)) return keep('has a dependencies entry that is not a list of test files');
  const { loosens, adds } = headPolicyDiff({ dependencies: refDeps } as PregateConfig, { dependencies: headDeps } as PregateConfig, ref.slice(7));
  if (loosens.length) return keep(loosens.join('; '));
  if (show(ref, GENERATED_PATH) !== read(GENERATED_PATH)) return keep(`comes with a changed ${GENERATED_PATH}`);
  const n = Object.keys(adds).length;
  return { head: true, line: `POLICY: head (unreviewed) ${PREGATE_CONFIG_PATH}: adds ${n} test lane${n === 1 ? '' : 's'} over ${ref} and changes nothing else, so the gate is only stricter` };
}
