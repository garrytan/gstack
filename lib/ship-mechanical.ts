/**
 * Mechanical retakes after review (GST-1560, docs/ship-policy.md#mechanical-retake). After a base merge a branch may
 * have to retake a version or rules number the base just took (founderstar#563: RULE_NUMBERS 80 to 81 in one line, the
 * same value in 8 save fixtures, one regenerated golden). /ship finish routes such paths as mechanical, with no reader,
 * only when the base policy's `mechanical_retake` declares them and the diff proves each one:
 *   - the constant: exactly one line matching its template on each side, a value the reviewed branch took (not the
 *     reviewed base's), a current value above both the reviewed one and the current base's, and the file's patch with
 *     that line masked is the reviewed patch (lib/ship-patch.ts comparePath);
 *   - a fixture field: the masked patch is the reviewed one, and each field line either kept its value or moved from the
 *     constant's reviewed value to its current value;
 *   - a golden: a base .gstack/generated.json entry the constant names regenerates it byte-identically (lib/regen.ts).
 * A declared path that fails its proof is refused with the reason and stays behavior; nothing is inferred.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isGatePath } from './review-depth';
import { isRegistryUnavailable, loadRegistryFromBase, runRegen } from './regen';
import { comparePath, type PatchSides } from './ship-patch';
import { matchesAny } from './ship-policy';
import { constantValue, fieldValue, VALUE_SLOT, type MechanicalConstant } from './ship-policy-mechanical';
import { sidecarLine } from './ship-sidecar';

export interface MechanicalRefusal { path: string; reason: string }
export interface MechanicalInput { sides?: PatchSides; base: string; candidates: readonly string[]; declared: readonly MechanicalConstant[] }
const SIDES = ['reviewedBase', 'reviewed', 'currentBase', 'current'] as const;
type Side = typeof SIDES[number];

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env, input?: string): string | null {
  const r = spawnSync('git', ['--literal-pathspecs', ...args], { cwd, encoding: 'latin1', input: input === undefined ? undefined : Buffer.from(input, 'latin1'), timeout: 120_000, maxBuffer: 256 * 1024 * 1024, env });
  return r.status === 0 ? r.stdout : null;
}

/** The four sides with `rel` rewritten by `mask` (an absent file stays absent), and each side's masked blob; a string says why not. */
function maskedSides(cwd: string, s: PatchSides, rel: string, mask: (text: string) => string): { sides: PatchSides; blobs: Record<Side, string | null> } | string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-mechanical-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, 'index') };
  try {
    const sides = { ...s };
    const blobs = {} as Record<Side, string | null>;
    for (const side of SIDES) {
      const ls = git(cwd, ['ls-tree', s[side], '--', rel], env);
      if (ls === null) return `git could not read it at ${side} ${s[side].slice(0, 12)}`;
      if (!ls.trim()) { blobs[side] = null; continue; }
      const entry = /^(100644|100755) blob ([0-9a-f]{40,64})\t/.exec(ls);
      const text = entry && git(cwd, ['cat-file', 'blob', entry[2]!], env);
      if (!entry || text === null) return `is not a regular file at ${side} ${s[side].slice(0, 12)}`;
      const blob = git(cwd, ['hash-object', '-w', '--stdin'], env, mask(text))?.trim();
      const tree = blob && git(cwd, ['read-tree', s[side]], env) !== null && git(cwd, ['update-index', '--cacheinfo', `${entry[1]},${blob},${rel}`], env) !== null ? git(cwd, ['write-tree'], env)?.trim() : undefined;
      if (!tree) return `git could not build its masked tree at ${side}`;
      sides[side] = tree;
      blobs[side] = `${entry[1]} ${blob}`;
    }
    return { sides, blobs };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Why the branch's patch to `rel`, with `mask` applied on every side, is not the reviewed patch; null when it is. */
function maskedChange(cwd: string, s: PatchSides, rel: string, mask: (text: string) => string): string | null {
  const m = maskedSides(cwd, s, rel, mask);
  if (typeof m === 'string') return m;
  if (m.blobs.reviewedBase === m.blobs.reviewed && m.blobs.currentBase === m.blobs.current) return null;
  return comparePath(cwd, m.sides, rel) === 'same' ? null : 'changes more than the declared values since review (the masked patch is not the reviewed one)';
}

/**
 * The declared paths among `candidates` whose post-review change is a proven mechanical retake (path -> what moved),
 * and each declared candidate that failed its proof with the reason. Paths no declaration names are neither.
 */
export function mechanicalPaths(cwd: string, i: MechanicalInput): { proven: Record<string, string>; refused: MechanicalRefusal[] } {
  const proven: Record<string, string> = Object.create(null);
  const refused: MechanicalRefusal[] = [];
  const retaken = new Map<MechanicalConstant, { from: number; to: number }>();
  const s = i.sides;
  const refuse = (p: string, reason: string) => refused.push({ path: p, reason });
  const gate = (p: string) => isGatePath(p) || /^\.(gstack|github)\//.test(p);
  const text = (side: Side, rel: string) => s && git(cwd, ['show', `${s[side]}:${rel}`]);
  for (const c of i.declared.filter(d => i.candidates.includes(d.path))) {
    if (!s) { refuse(c.path, 'needs --reviewed-base'); continue; }
    if (gate(c.path)) { refuse(c.path, 'is a gate path or under .gstack/ or .github/'); continue; }
    const values = SIDES.map(side => (text(side, c.path) ?? '').split('\n').map(l => constantValue(l, c.template)).filter((v): v is number => v !== null));
    const odd = SIDES.find((_, k) => values[k]!.length !== 1);
    if (odd) { refuse(c.path, `does not hold exactly one line matching ${JSON.stringify(c.template)} at ${odd}`); continue; }
    const [rb, rv, cb, cv] = values.map(v => v[0]!) as [number, number, number, number];
    if (rv === rb) { refuse(c.path, `the reviewed branch did not take the constant (${rv} at the reviewed base too), so a new take is behavior`); continue; }
    if (!(cv > rv && cv > cb)) { refuse(c.path, `retakes ${rv} as ${cv}, not above the reviewed ${rv} and the base's ${cb}`); continue; }
    const why = maskedChange(cwd, s, c.path, t => t.split('\n').map(l => (constantValue(l, c.template) === null ? l : c.template)).join('\n'));
    if (why) { refuse(c.path, why); continue; }
    proven[c.path] = `constant ${rv} → ${cv}`;
    retaken.set(c, { from: rv, to: cv });
  }
  const rest = i.candidates.filter(p => !i.declared.some(d => d.path === p));
  const goldens: string[] = [];
  for (const p of rest) {
    const c = i.declared.find(d => d.fields.some(f => matchesAny([f.glob], p)));
    if (!c) { if (i.declared.some(d => d.regen.length)) goldens.push(p); continue; }
    const take = retaken.get(c);
    if (!take || !s) { refuse(p, `its constant ${c.path} is not a proven retake`); continue; }
    if (gate(p)) { refuse(p, 'is a gate path or under .gstack/ or .github/'); continue; }
    const fields = c.fields.filter(f => matchesAny([f.glob], p)).map(f => f.field);
    const valueOf = (l: string) => fields.map(f => fieldValue(l, f)).find(v => v !== null) ?? null;
    const [was, now] = (['reviewed', 'current'] as const).map(side => text(side, p)?.split('\n').map(valueOf).filter((v): v is number => v !== null) ?? null);
    if (!was || !now || !now.length || was.length !== now.length) { refuse(p, `does not hold the same number of ${fields.join(', ')} lines at the reviewed and the current tree`); continue; }
    const bad = now.findIndex((v, k) => v !== was[k] && !(was[k] === take.from && v === take.to));
    if (bad >= 0) { refuse(p, `writes ${now[bad]} into ${fields.join(', ')} where it held ${was[bad]}, not the constant's ${take.from} → ${take.to}`); continue; }
    if (now.every((v, k) => v === was[k])) { refuse(p, `changes no ${fields.join(', ')} value`); continue; }
    const why = maskedChange(cwd, s, p, t => t.split('\n').map(l => (valueOf(l) === null ? l : l.replace(/\d+(\s*,?\s*\r?)$/, `${VALUE_SLOT}$1`))).join('\n'));
    if (why) { refuse(p, why); continue; }
    proven[p] = `${fields.join(', ')} ${take.from} → ${take.to}`;
  }
  if (!goldens.length) return { proven, refused };
  const load = loadRegistryFromBase(cwd, i.base);
  const registry = isRegistryUnavailable(load) || load.errors.length ? { entries: [] } : load.registry;
  const entries = registry.entries.filter(e => e.command);
  const named = (p: string, cs: readonly MechanicalConstant[]) => entries.filter(e => cs.some(c => c.regen.includes(e.id)) && matchesAny(e.outputs, p));
  const claimed = goldens.filter(p => named(p, i.declared).length);
  const ids = [...new Set(claimed.flatMap(p => named(p, [...retaken.keys()]).map(e => e.id)))];
  const results = ids.length && claimed.some(p => !gate(p)) ? runRegen({ repoRoot: cwd, registry, mode: 'check', only: ids, prove: claimed }).results : [];
  for (const p of claimed) {
    const by = named(p, [...retaken.keys()]);
    if (!by.length) { refuse(p, 'its constant is not a proven retake'); continue; }
    if (gate(p)) { refuse(p, 'is a gate path or under .gstack/ or .github/'); continue; }
    const ok = results.find(r => by.some(e => e.id === r.id) && r.status === 'fresh' && r.proven?.includes(p));
    if (!ok) { refuse(p, `does not regenerate byte-identically from ${by.map(e => e.id).join(', ')} (${results.filter(r => by.some(e => e.id === r.id)).map(r => r.status).join(', ') || 'not run'})`); continue; }
    proven[p] = `golden, regenerated by ${ok.id}`;
  }
  return { proven, refused };
}

/** The PR body and receipt line for one mechanical path. */
export const mechanicalLine = (p: string, what: string) => `Mechanical retake: ${p} (${what})`;

function recordFile(cwd: string, tree: string): string {
  const rel = spawnSync('git', ['rev-parse', '--git-path', `gstack/mechanical-${tree.slice(0, 12)}.json`], { cwd, encoding: 'utf8', timeout: 30_000 }).stdout?.trim();
  return path.resolve(cwd, rel || `.git/gstack/mechanical-${tree.slice(0, 12)}.json`);
}

/** Saves finish's mechanical paths and Godot UID sidecars (path -> sibling) for the tree it routed, for gstack-ship-receipt write; the error message when it cannot. */
export function writeMechanicalRecord(cwd: string, tree: string, proven: Readonly<Record<string, string>>, sidecars: Readonly<Record<string, string>> = {}): string | null {
  const file = recordFile(cwd, tree);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ tree, paths: proven, sidecars }) + '\n');
    return null;
  } catch (e) {
    return `${file}: ${(e as Error).message.split('\n')[0]}`;
  }
}

/** The mechanical and sidecar lines finish recorded for exactly this tree, which the receipt's `mechanical` lists; none when it recorded none. */
export function readMechanicalLines(cwd: string, tree: string): string[] {
  try {
    const v = JSON.parse(fs.readFileSync(recordFile(cwd, tree), 'utf8'));
    if (v?.tree !== tree || !v.paths || typeof v.paths !== 'object') return [];
    const lines = (o: unknown, line: (p: string, w: string) => string) => Object.entries(o && typeof o === 'object' ? o : {}).filter(([, w]) => typeof w === 'string').map(([p, w]) => line(p, w as string));
    return [...lines(v.paths, mechanicalLine), ...lines(v.sidecars, sidecarLine)].sort();
  } catch {
    return [];
  }
}
