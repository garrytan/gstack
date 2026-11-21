/**
 * autoplan-public — the machine-path-free public copy of a run (field list 2,
 * W6). `gstack-autoplan export --out <run> --public <dir>` copies the run's
 * listed artifacts and run.json into <dir> with only the run's recorded
 * machine roots rewritten (the run directory, the home directory, the plan
 * input's directory, the checkpoint directory, the worktree root): a path in
 * the worktree becomes repo-relative, any other becomes
 * `<local notes (not committed)>`. Inline code and fences in plan.md are
 * never rewritten. The private run is only read, so resume and its bindings
 * are unchanged. Every copied file gets its own sha256, and run.json's
 * `provenance` names the private digest it was derived from.
 * `validatePublic` is the check behind `gstack-artifact validate --public
 * <dir> [--private <run.json>]`: with the private manifest (on the exporting
 * machine) any recorded root is an ARTIFACT_MACHINE_PATH error with
 * file:line; without it the provenance digests are checked; both WARN with
 * file:line on generic home-path patterns. Export runs the private check on a
 * staging copy before anything reaches <dir>.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { repoRoot } from './autoplan-plan-text';
import { checkpointRoot } from './autoplan-checkpoint';
import { FILES, RunError, type RunState } from './autoplan-state';
import { sha256File, validateRun, type ValidationError } from './headless-artifacts';

export const LOCAL_NOTES = '<local notes (not committed)>';
const GENERIC_HOME = /(?:\/home\/[A-Za-z0-9._-]+\/|\/Users\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[^\\\s]+\\)/;

export interface RecordedRoot { label: string; root: string }
interface Provenance { private_run: string; private_manifest_sha256: string; exported_at: string; roots: string[]; files: Record<string, { private_sha256: string; public_sha256: string }> }

/** The machine roots a run recorded on this machine, longest first; the worktree root is labelled for the repo-relative rewrite. */
export function recordedRoots(state: Pick<RunState, 'out' | 'plan_input' | 'plan_source'>, env: NodeJS.ProcessEnv = process.env): RecordedRoot[] {
  const input = state.plan_input ?? state.plan_source;
  const worktree = input ? repoRoot(path.dirname(input)) : undefined;
  const candidates: RecordedRoot[] = [
    { label: 'run', root: state.out }, { label: 'home', root: os.homedir() },
    ...(input ? [{ label: 'plan_input', root: path.dirname(input) }] : []),
    ...(checkpointRoot(env) ? [{ label: 'checkpoint', root: checkpointRoot(env)! }] : []),
    ...(worktree ? [{ label: 'worktree', root: worktree }] : []),
  ];
  const seen = new Set<string>();
  return candidates.map(c => ({ ...c, root: path.resolve(c.root) })).filter(c => c.root !== path.parse(c.root).root && !seen.has(c.root) && seen.add(c.root))
    .sort((a, b) => b.root.length - a.root.length);
}

/** Rewrite every recorded root in `text`: worktree paths become repo-relative, the rest `<local notes (not committed)>`. */
export function rewriteRoots(text: string, roots: RecordedRoot[]): string {
  const worktree = roots.find(r => r.label === 'worktree')?.root;
  const inWorktree = (p: string) => !!worktree && (p === worktree || p.startsWith(worktree + path.sep));
  let out = text;
  for (const r of roots) {
    if (r.label !== 'worktree' && inWorktree(r.root)) continue;
    const local = r.label !== 'worktree';
    out = out.split(r.root + path.sep).join(local ? `${LOCAL_NOTES}/` : '').split(r.root).join(local ? LOCAL_NOTES : '.');
  }
  return out;
}

/** Per line of a Markdown text: inside a fenced block (or a fence marker itself), or not. */
function fencedLines(text: string): boolean[] {
  let fence: string | null = null;
  return text.split('\n').map(line => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (fence === null || marker.startsWith(fence))) { fence = fence === null ? marker[0]!.repeat(marker.length) : null; return true; }
    return fence !== null;
  });
}

/** plan.md: rewrite prose only; fenced blocks and inline code spans keep their bytes. */
function rewriteProse(text: string, roots: RecordedRoot[]): string {
  const fenced = fencedLines(text);
  return text.split('\n').map((line, i) => (fenced[i] ? line
    : line.split(/(`[^`]*`)/).map(part => (part.startsWith('`') && part.endsWith('`') && part.length > 1 ? part : rewriteRoots(part, roots))).join(''))).join('\n');
}

function rewriteJson(value: unknown, roots: RecordedRoot[]): unknown {
  if (typeof value === 'string') return rewriteRoots(value, roots);
  if (Array.isArray(value)) return value.map(v => rewriteJson(v, roots));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [rewriteRoots(k, roots), rewriteJson(v, roots)]));
  return value;
}

/** Every recorded-root hit (error) and generic home-path hit (warning) in the files under `dir`, with file:line. */
function scan(dir: string, roots: RecordedRoot[]): { errors: ValidationError[]; warnings: string[] } {
  const errors: ValidationError[] = [], warnings: string[] = [];
  const walk = (rel: string): string[] => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(rel, e.name)) : e.isFile() ? [path.join(rel, e.name)] : []));
  for (const rel of walk('')) {
    const text = fs.readFileSync(path.join(dir, rel), 'utf8');
    const fenced = rel === 'plan.md' ? fencedLines(text) : [];
    text.split('\n').forEach((line, i) => {
      const hit = roots.find(r => line.includes(r.root));
      const code = rel === 'plan.md' && (fenced[i] || /`/.test(line));
      if (hit) errors.push({ code: 'ARTIFACT_MACHINE_PATH', path: `${rel}:${i + 1}`, message: `the recorded ${hit.label} root ${hit.root} appears in the public copy${code ? ' (inside code, which export never rewrites: edit the plan)' : ''}` });
      else if (GENERIC_HOME.test(line)) warnings.push(`WARN: ${rel}:${i + 1} has a home-directory path (${GENERIC_HOME.exec(line)![0]}); check it is not a machine path`);
    });
  }
  return { errors, warnings };
}

export interface PublicValidation { valid: boolean; errors: ValidationError[]; warnings: string[]; run?: string }

/** `gstack-artifact validate --public <dir> [--private <run.json>]`. */
export function validatePublic(dir: string, privateRunJson?: string, env: NodeJS.ProcessEnv = process.env): PublicValidation {
  const runJson = path.join(dir, FILES.run);
  const structural = validateRun(runJson);
  const errors = [...structural.errors];
  const manifest = structural.manifest as (RunState & { provenance?: Provenance }) | undefined;
  const prov = manifest?.provenance;
  if (manifest && !prov) errors.push({ code: 'ARTIFACT_SCHEMA', path: 'run.json.provenance', message: 'a public copy names the private digests it came from; this run.json has no provenance (write it with gstack-autoplan export --public)' });
  for (const [name, d] of Object.entries(prov?.files ?? {})) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) errors.push({ code: 'ARTIFACT_MISSING', path: name, message: 'listed in provenance, absent from the public copy' });
    else if (sha256File(file) !== d.public_sha256) errors.push({ code: 'ARTIFACT_STALE', path: name, message: `sha256 differs from provenance public_sha256 ${d.public_sha256.slice(0, 12)}` });
  }
  let roots: RecordedRoot[] = [];
  if (privateRunJson) {
    const priv = JSON.parse(fs.readFileSync(privateRunJson, 'utf8')) as RunState;
    priv.out = path.dirname(path.resolve(privateRunJson));
    roots = recordedRoots(priv, env);
    if (prov && prov.private_run !== priv.run) errors.push({ code: 'ARTIFACT_UNBOUND_ID', path: 'run.json.provenance.private_run', message: `${prov.private_run} is not the private run ${priv.run}` });
    for (const [name, d] of Object.entries(prov?.files ?? {})) {
      const listed = name === FILES.run ? sha256File(privateRunJson) : priv.artifacts?.[name]?.sha256;
      if (listed !== d.private_sha256) errors.push({ code: 'ARTIFACT_STALE', path: name, message: `provenance private_sha256 ${d.private_sha256.slice(0, 12)} is not the private run's ${(listed ?? 'missing').slice(0, 12)}` });
    }
  }
  const s = scan(dir, roots);
  errors.push(...s.errors);
  return { valid: errors.length === 0, errors, warnings: s.warnings, run: manifest?.run };
}

/** Write the public copy of `state` to `dir` without touching the private run; refuses on any recorded root left behind. */
export function exportPublic(state: RunState, dir: string, env: NodeJS.ProcessEnv = process.env): { files: string[]; warnings: string[] } {
  const target = path.resolve(dir);
  const out = path.resolve(state.out);
  if (target === out || target.startsWith(out + path.sep) || out.startsWith(target + path.sep)) throw new RunError('ARTIFACT_PATH_ESCAPE', `--public ${target} overlaps the run directory ${out}`, 3);
  if (fs.existsSync(target) && fs.readdirSync(target).length) {
    let previous: string | undefined;
    try { previous = JSON.parse(fs.readFileSync(path.join(target, FILES.run), 'utf8')).provenance?.private_run; } catch { /* not a public copy */ }
    if (previous !== state.run) throw new RunError('ARTIFACT_PUBLIC_TARGET_EXISTS', `${target} is not empty and holds no earlier public copy of ${state.run}`, 3);
  }
  const roots = recordedRoots(state, env);
  const privateRun = path.join(out, FILES.run);
  const staging = `${target}.public-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    const files: Provenance['files'] = {};
    for (const [name, entry] of Object.entries(state.artifacts)) {
      const src = path.resolve(out, entry.path);
      const dest = path.resolve(staging, entry.path);
      if (!src.startsWith(out + path.sep) || !dest.startsWith(staging + path.sep)) throw new RunError('ARTIFACT_PATH_ESCAPE', `artifact ${name} path ${JSON.stringify(entry.path)} leaves the run directory; nothing was written`, 3);
      if (!fs.existsSync(src) || sha256File(src) !== entry.sha256) throw new RunError('ARTIFACT_STALE', `${entry.path} does not match run.json; run gstack-autoplan export --out ${out} first`, 3);
      const text = fs.readFileSync(src, 'utf8');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, name === 'plan.md' ? rewriteProse(text, roots) : entry.path.endsWith('.json') ? JSON.stringify(rewriteJson(JSON.parse(text), roots), null, 2) + '\n' : rewriteRoots(text, roots));
      files[name] = { private_sha256: entry.sha256, public_sha256: sha256File(dest) };
    }
    const manifest = rewriteJson(JSON.parse(fs.readFileSync(privateRun, 'utf8')), roots) as RunState & { provenance?: Provenance };
    for (const [name, d] of Object.entries(files)) manifest.artifacts[name] = { path: state.artifacts[name]!.path, sha256: d.public_sha256 };
    manifest.provenance = { private_run: state.run, private_manifest_sha256: sha256File(privateRun), exported_at: new Date().toISOString(), roots: roots.map(r => r.label), files };
    fs.writeFileSync(path.join(staging, FILES.run), JSON.stringify(manifest, null, 2) + '\n');
    const check = validatePublic(staging, privateRun, env);
    const escapes = check.errors.filter(e => e.code === 'ARTIFACT_PATH_ESCAPE');
    if (escapes.length) throw new RunError('ARTIFACT_PATH_ESCAPE', escapes.map(e => `${e.path}: ${e.message}`).join('; '), 3);
    const leaks = check.errors.filter(e => e.code === 'ARTIFACT_MACHINE_PATH');
    if (leaks.length) throw new RunError('ARTIFACT_MACHINE_PATH', leaks.slice(0, 5).map(e => `${e.path}: ${e.message}`).join('; ') + (leaks.length > 5 ? ` (+${leaks.length - 5} more)` : ''), 3);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(staging, target);
    return { files: [...Object.values(state.artifacts).map(e => path.join(target, e.path)), path.join(target, FILES.run)], warnings: check.warnings };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
