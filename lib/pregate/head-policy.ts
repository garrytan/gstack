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
    load: { ...trusted, config: { ...trusted.config, dependencies }, kind: 'head', label: `head (unreviewed) ${PREGATE_CONFIG_PATH}: adds ${n} lane${n === 1 ? '' : 's'} over ${trusted.label}` },
    explain: Object.entries(adds).map(([glob, tests]) => `head policy adds: dependencies[${JSON.stringify(glob)}] → ${tests.join(', ')}`),
  };
}
