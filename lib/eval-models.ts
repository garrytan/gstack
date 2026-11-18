/**
 * eval-models — a repo's eval model rules, .gstack/eval-models.json, and the
 * lint gstack-eval-plan runs over every arm it prices or reserves (field
 * list 2, W9). The file states the rules as data, never prose:
 *
 *   allow     ids or globs an arm may use; required, and an id it does not
 *             match fails closed (an uncatalogued or misspelled model is
 *             never admitted by default)
 *   deny      ids or globs no arm may use, checked first
 *   scopes    per eval scope (smoke, full: the call-plan row scope; an arm
 *             with no stated scope is full) an extra allow and/or deny list,
 *             so "Fable in smoke only" is scopes.full.deny ["claude-fable-*"]
 *   families  optional ordered map, newest first: an arm must be the newest
 *             id of its family, and with the map present an arm in no family
 *             fails as unresolved instead of passing unchecked
 *
 * Literal allow/deny apply whatever lib/model-catalog.ts holds. MODEL_CATALOG
 * (one current model per provider and review tier) only checks the families
 * map's currency: a catalog model listed after another id in its family is a
 * stale map. The reviewed copy is read from origin/<base>; the working tree's
 * copy only with --models-from head. Doc: docs/eval-models.md.
 */
import { spawnSync } from './spawn-sync';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MODEL_CATALOG } from './model-catalog';
import type { ResultCodeName } from './result-codes';

export const EVAL_MODELS_PATH = '.gstack/eval-models.json';
export const EVAL_SCOPES = ['smoke', 'full'] as const;
export type EvalScope = typeof EVAL_SCOPES[number];
export interface ScopeRules { allow?: string[]; deny: string[] }
export interface EvalModelRules { schema_version: 1; allow: string[]; deny: string[]; scopes: Partial<Record<EvalScope, ScopeRules>>; families: Record<string, string[]> }
export interface ArmUse { model: string; scope: EvalScope; where: string }
export type ModelVerdict = 'ok' | 'denied' | 'old-generation' | 'generation-unresolved';
export interface ModelFinding extends ArmUse { verdict: ModelVerdict; reason: string }
export interface ModelRulesCheck { ok: boolean; source: string; lines: string[]; findings: ModelFinding[]; errors: Array<{ code: ResultCodeName; message: string }> }

const PATTERN = /^[A-Za-z0-9._:/*?-]+$/;
const TOP_KEYS = ['schema_version', 'allow', 'deny', 'scopes', 'families'];

function patterns(v: unknown, at: string, errors: string[], o: { required?: boolean; literal?: boolean } = {}): string[] {
  if (v === undefined && !o.required) return [];
  if (!Array.isArray(v) || (o.required && v.length === 0)) { errors.push(`${at} must be ${o.required ? 'a non-empty' : 'an'} array of model ids${o.literal ? '' : ' or globs'}`); return []; }
  const out: string[] = [];
  v.forEach((p, i) => {
    if (typeof p !== 'string' || !PATTERN.test(p) || (o.literal && /[*?]/.test(p))) errors.push(`${at}[${i}] ${JSON.stringify(p)} is not a model id${o.literal ? ' (family entries are literal ids, newest first)' : ' or glob (letters, digits, . _ : / - and the wildcards * ?)'}`);
    else out.push(p);
  });
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Parse and validate the rules; any unknown key, scope or malformed entry fails the whole file. */
export function parseEvalModels(text: string): { rules: EvalModelRules } | { errors: string[] } {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch (e: any) { return { errors: [`not valid JSON: ${e.message}`] }; }
  if (!isObject(doc)) return { errors: ['must be a JSON object'] };
  const errors: string[] = [];
  for (const k of Object.keys(doc)) if (!TOP_KEYS.includes(k)) errors.push(`unknown key ${JSON.stringify(k)} (known: ${TOP_KEYS.join(', ')})`);
  if (doc.schema_version !== 1) errors.push('schema_version must be 1');
  const rules: EvalModelRules = { schema_version: 1, allow: patterns(doc.allow, 'allow', errors, { required: true }), deny: patterns(doc.deny, 'deny', errors), scopes: {}, families: {} };
  if (doc.scopes !== undefined && !isObject(doc.scopes)) errors.push('scopes must be an object keyed by eval scope');
  for (const [scope, v] of Object.entries(isObject(doc.scopes) ? doc.scopes : {})) {
    if (!(EVAL_SCOPES as readonly string[]).includes(scope)) { errors.push(`scopes.${scope}: unknown eval scope (known: ${EVAL_SCOPES.join(', ')})`); continue; }
    if (!isObject(v)) { errors.push(`scopes.${scope} must be an object with allow and/or deny`); continue; }
    const extra = Object.keys(v).filter(k => k !== 'allow' && k !== 'deny');
    if (extra.length) errors.push(`scopes.${scope}: unknown key(s) ${extra.join(', ')} (known: allow, deny)`);
    rules.scopes[scope as EvalScope] = { ...(v.allow !== undefined ? { allow: patterns(v.allow, `scopes.${scope}.allow`, errors, { required: true }) } : {}), deny: patterns(v.deny, `scopes.${scope}.deny`, errors) };
  }
  if (doc.families !== undefined && !isObject(doc.families)) errors.push('families must be an object of family name to model ids, newest first');
  const owner = new Map<string, string>();
  for (const [family, ids] of Object.entries(isObject(doc.families) ? doc.families : {})) {
    rules.families[family] = patterns(ids, `families.${family}`, errors, { required: true, literal: true });
    for (const id of rules.families[family]!) {
      if (owner.has(id)) errors.push(`families: ${id} is listed in both ${owner.get(id)} and ${family}`);
      else owner.set(id, family);
    }
  }
  for (const entry of MODEL_CATALOG) {
    const family = owner.get(entry.model);
    const head = family ? rules.families[family]![0] : entry.model;
    if (head !== entry.model) errors.push(`families.${family} lists ${head} before ${entry.model}, gstack's current ${entry.provider} ${entry.tier} model (lib/model-catalog.ts, verified ${entry.verifiedAt}); list newest first`);
  }
  return errors.length ? { errors } : { rules };
}

/** The id as given, without a provider prefix, and a Claude id without its date suffix: the forms a rule may name. */
function forms(model: string): string[] {
  const bare = model.replace(/^[a-z-]+[/:]/, '');
  return [...new Set([model, bare, /^claude-/.test(bare) ? bare.replace(/-\d{8}$/, '') : bare])];
}
const glob = (p: string) => new RegExp(`^${p.split('').map(c => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')}$`);
const firstMatch = (list: string[] | undefined, model: string) => (list ?? []).find(p => forms(model).some(f => glob(p).test(f)));

/** Deny, the scope's deny, allow, the scope's allow, then the newest-generation rule; the first that refuses decides. */
export function lintArmModels(rules: EvalModelRules, uses: ArmUse[]): ModelFinding[] {
  const families = Object.entries(rules.families);
  return uses.map((use): ModelFinding => {
    const scope = rules.scopes[use.scope];
    const denied = firstMatch(rules.deny, use.model);
    if (denied) return { ...use, verdict: 'denied', reason: `deny ${denied}` };
    const scopeDenied = firstMatch(scope?.deny, use.model);
    if (scopeDenied) return { ...use, verdict: 'denied', reason: `scopes.${use.scope}.deny ${scopeDenied}` };
    const allowed = firstMatch(rules.allow, use.model);
    if (!allowed) return { ...use, verdict: 'denied', reason: 'matches no allow entry (unknown ids fail closed)' };
    if (scope?.allow && !firstMatch(scope.allow, use.model)) return { ...use, verdict: 'denied', reason: `matches no scopes.${use.scope}.allow entry` };
    if (!families.length) return { ...use, verdict: 'ok', reason: `allow ${allowed}` };
    const family = families.find(([, ids]) => ids.some(id => forms(use.model).includes(id)));
    if (!family) return { ...use, verdict: 'generation-unresolved', reason: 'in no families entry, so the newest-generation rule cannot be checked' };
    if (!forms(use.model).includes(family[1][0]!)) return { ...use, verdict: 'old-generation', reason: `families.${family[0]} newest is ${family[1][0]}` };
    return { ...use, verdict: 'ok', reason: `allow ${allowed}; newest in families.${family[0]}` };
  });
}

const VERDICT_CODE: Record<Exclude<ModelVerdict, 'ok'>, ResultCodeName> = { denied: 'EVAL_MODEL_DENIED', 'old-generation': 'EVAL_MODEL_OLD_GENERATION', 'generation-unresolved': 'EVAL_MODEL_GENERATION_UNRESOLVED' };

function gitText(repoRoot: string, args: string[]): string | null {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 ? r.stdout : null;
}

export interface EvalModelsLoad { text: string | null; label: string; notes: string[]; error: string | null }

/** The reviewed rules from origin/<base> (default) or the working tree's copy; text null when none are declared. */
export function loadEvalModels(repoRoot: string | null, o: { from: 'base' | 'head'; base: string }): EvalModelsLoad {
  if (!repoRoot) return { text: null, label: 'none (not a git repository)', notes: [], error: null };
  const headFile = path.join(repoRoot, EVAL_MODELS_PATH);
  const head = fs.existsSync(headFile) ? fs.readFileSync(headFile, 'utf8') : null;
  if (o.from === 'head') return { text: head, label: head === null ? `none (no ${EVAL_MODELS_PATH} in the working tree)` : `head (unreviewed) ${EVAL_MODELS_PATH}`, notes: [], error: null };
  const ref = `origin/${o.base.replace(/^origin\//, '')}`;
  const sha = gitText(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])?.trim();
  if (!sha) {
    if (head === null) return { text: null, label: `none (${ref} is not a resolvable commit)`, notes: [], error: null };
    return { text: null, label: ref, notes: [], error: `${ref} is not a resolvable commit, so the reviewed ${EVAL_MODELS_PATH} cannot be read; fetch it, or pass --models-from head to lint with the working-tree copy` };
  }
  const at = `${ref}@${sha.slice(0, 12)}`;
  const base = gitText(repoRoot, ['show', `${sha}:${EVAL_MODELS_PATH}`]);
  if (base === null) return { text: null, label: `none at ${at}`, notes: head === null ? [] : [`the working tree has an unreviewed ${EVAL_MODELS_PATH}; --models-from head lints with it`], error: null };
  return { text: base, label: `${at}:${EVAL_MODELS_PATH}`, notes: head !== null && head !== base ? [`the working-tree ${EVAL_MODELS_PATH} differs from the reviewed copy; linting with ${ref}`] : [], error: null };
}

/** Load, validate and lint: one EVAL_MODEL line per arm, then the EVAL_MODELS summary; a refusal or an invalid file is an error. */
export function checkModelRules(repoRoot: string | null, uses: ArmUse[], o: { from: 'base' | 'head'; base: string }): ModelRulesCheck {
  const load = loadEvalModels(repoRoot, o);
  const notes = load.notes.map(n => `EVAL_MODELS_NOTE: ${n}`);
  const invalid = (message: string): ModelRulesCheck => ({ ok: false, source: load.label, lines: [...notes, `EVAL_MODELS: invalid source=${load.label}`], findings: [], errors: [{ code: 'EVAL_MODELS_INVALID', message }] });
  if (load.error) return invalid(load.error);
  if (load.text === null) return { ok: true, source: load.label, lines: [...notes, `EVAL_MODELS: ${load.label}`], findings: [], errors: [] };
  const parsed = parseEvalModels(load.text);
  if ('errors' in parsed) return invalid(`${load.label}: ${parsed.errors.join('; ')}`);
  const findings = lintArmModels(parsed.rules, uses);
  const bad = findings.filter(f => f.verdict !== 'ok');
  return {
    ok: bad.length === 0, source: load.label, findings,
    lines: [...notes, ...findings.map(f => `EVAL_MODEL: ${f.model} scope=${f.scope} ${f.verdict} (${f.reason}) where=${f.where}`), `EVAL_MODELS: ${bad.length ? `fail refused=${bad.length}/${findings.length}` : `ok n=${findings.length}`} source=${load.label}`],
    errors: bad.map(f => ({ code: VERDICT_CODE[f.verdict as Exclude<ModelVerdict, 'ok'>], message: `${f.model} (scope ${f.scope}, ${f.where}): ${f.reason}` })),
  };
}
