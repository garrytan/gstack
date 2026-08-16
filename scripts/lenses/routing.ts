import * as fs from 'fs';
import { parseYamlSubset, type YamlValue } from './yaml-subset';
import { readyLenses, resolveLensName } from './registry';
import type { LensSpec } from './types';

export interface MandatoryLensRule {
  name: string;
  surface_globs: string[];
  lenses: string[];
}

export interface LensPolicy {
  mandatory_lenses: MandatoryLensRule[];
  todo_target?: 'plan_file' | 'todos_md' | 'pr_checklist' | 'issue';
}

export type LensRouteMode = 'mandatory' | 'recommended' | 'all' | 'explicit';

export interface RouteInput {
  mode: LensRouteMode;
  requested?: string[];
  allow_draft?: boolean;
  changed_paths: string[];
  pr_labels?: string[];
  added_lines?: string[];
  declared_surfaces?: string[];
  policy?: LensPolicy;
  no_mandatory?: boolean;
  no_mandatory_reason?: string;
}

export interface RoutedLens {
  lens: string;
  requested_as?: string;
  reasons: string[];
  mandatory: boolean;
  status: LensSpec['status'];
}

export interface MandatoryMatch {
  rule: string;
  lens: string;
  paths: string[];
}

export interface RouteOutput {
  mode: LensRouteMode;
  selected: RoutedLens[];
  skipped: Array<{ lens: string; reason: string }>;
  unmatched_requested: string[];
  mandatory_matches: MandatoryMatch[];
  mandatory_bypassed: boolean;
  mandatory_bypass_reason?: string;
  confirmation_required: boolean;
}

function asObject(value: YamlValue | undefined): Record<string, YamlValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, YamlValue>
    : undefined;
}

function stringArray(value: YamlValue | undefined, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  return (value as string[]).map((item) => item.trim()).filter(Boolean);
}

export function loadLensPolicy(policyPath: string): LensPolicy {
  if (!fs.existsSync(policyPath)) return { mandatory_lenses: [] };
  const raw = parseYamlSubset(fs.readFileSync(policyPath, 'utf8'));
  const mandatoryRaw = asObject(raw.mandatory_lenses);
  const mandatory: MandatoryLensRule[] = [];
  if (mandatoryRaw) {
    for (const [name, value] of Object.entries(mandatoryRaw)) {
      const rule = asObject(value);
      if (!rule) throw new Error(`${policyPath}: mandatory_lenses.${name} must be a mapping`);
      mandatory.push({
        name,
        surface_globs: stringArray(rule.surface_globs, `${policyPath}: mandatory_lenses.${name}.surface_globs`),
        lenses: stringArray(rule.lenses, `${policyPath}: mandatory_lenses.${name}.lenses`),
      });
    }
  }
  const todoTarget = raw.todo_target;
  if (todoTarget !== undefined && !['plan_file', 'todos_md', 'pr_checklist', 'issue'].includes(String(todoTarget))) {
    throw new Error(`${policyPath}: todo_target must be plan_file, todos_md, pr_checklist, or issue`);
  }
  return {
    mandatory_lenses: mandatory,
    todo_target: todoTarget as LensPolicy['todo_target'],
  };
}

export function globToRegExp(glob: string): RegExp {
  let regex = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          regex += '(?:.*/)?';
        } else {
          regex += '.*';
        }
      } else {
        regex += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      regex += '[^/]';
      continue;
    }
    regex += /[\\.^$+{}()|[\]]/.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`${regex}$`);
}

export function matchesAnyGlob(filePath: string, globs: string[]): string[] {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  return globs.filter((glob) => globToRegExp(glob).test(normalized));
}

function matchLens(spec: LensSpec, input: RouteInput): string[] {
  const reasons: string[] = [];
  for (const changedPath of input.changed_paths) {
    for (const glob of matchesAnyGlob(changedPath, spec.invocation_triggers.path_globs)) {
      reasons.push(`path:${changedPath} matched ${glob}`);
    }
  }
  const labels = new Set(input.pr_labels ?? []);
  const surfaces = new Set(input.declared_surfaces ?? []);
  const added = (input.added_lines ?? []).join('\n');
  for (const trigger of spec.invocation_triggers.semantic_triggers) {
    if (trigger.kind === 'pr_label' && labels.has(trigger.value)) reasons.push(`pr_label:${trigger.value}`);
    if (trigger.kind === 'user_declared' && surfaces.has(trigger.value)) reasons.push(`surface:${trigger.value}`);
    if (trigger.kind === 'file_metadata' && added.includes(trigger.value)) reasons.push(`file_metadata:${trigger.value}`);
  }
  return [...new Set(reasons)];
}

function findMandatoryMatches(specs: LensSpec[], input: RouteInput): MandatoryMatch[] {
  const result: MandatoryMatch[] = [];
  for (const rule of input.policy?.mandatory_lenses ?? []) {
    const matchedPaths = input.changed_paths.filter((changedPath) => matchesAnyGlob(changedPath, rule.surface_globs).length > 0);
    if (matchedPaths.length === 0) continue;
    for (const name of rule.lenses) {
      const spec = resolveLensName(specs, name);
      if (!spec) throw new Error(`lens-policy references unknown lens '${name}' in rule '${rule.name}'`);
      if (spec.status !== 'READY') throw new Error(`lens-policy cannot mandate ${spec.status} lens '${spec.lens}'`);
      result.push({ rule: rule.name, lens: spec.lens, paths: matchedPaths });
    }
  }
  return result;
}

export function routeLenses(specs: LensSpec[], input: RouteInput): RouteOutput {
  const selected = new Map<string, RoutedLens>();
  const skipped: RouteOutput['skipped'] = [];
  const unmatched: string[] = [];
  const mandatoryMatches = findMandatoryMatches(specs, input);
  const bypassReason = input.no_mandatory_reason?.trim();

  if (input.no_mandatory && mandatoryMatches.length > 0 && !bypassReason) {
    throw new Error('Bypassing a matching mandatory lens policy requires --no-mandatory-lenses with a non-empty rationale');
  }

  function add(spec: LensSpec, reasons: string[], mandatory = false, requestedAs?: string): void {
    const existing = selected.get(spec.lens);
    if (existing) {
      existing.reasons = [...new Set([...existing.reasons, ...reasons])];
      existing.mandatory = existing.mandatory || mandatory;
      return;
    }
    selected.set(spec.lens, {
      lens: spec.lens,
      requested_as: requestedAs,
      reasons: [...new Set(reasons)],
      mandatory,
      status: spec.status,
    });
  }

  if (input.mode === 'explicit') {
    for (const requested of input.requested ?? []) {
      const spec = resolveLensName(specs, requested);
      if (!spec) {
        unmatched.push(requested);
        continue;
      }
      if (spec.status === 'DEFERRED') {
        skipped.push({ lens: spec.lens, reason: 'DEFERRED lenses are specifications only in V0.5' });
        continue;
      }
      if (spec.status === 'DRAFT' && !input.allow_draft) {
        skipped.push({ lens: spec.lens, reason: 'DRAFT lens requires --lens-draft' });
        continue;
      }
      add(spec, [`explicit:${requested}`], false, requested);
    }
  } else if (input.mode === 'all') {
    for (const spec of readyLenses(specs)) add(spec, ['all-ready-lenses']);
  } else if (input.mode === 'recommended') {
    for (const spec of readyLenses(specs)) {
      const reasons = matchLens(spec, input);
      if (reasons.length > 0) add(spec, reasons);
      else skipped.push({ lens: spec.lens, reason: 'no invocation trigger matched' });
    }
  }

  if (!input.no_mandatory) {
    for (const match of mandatoryMatches) {
      const spec = resolveLensName(specs, match.lens)!;
      add(spec, [`mandatory:${match.rule} matched ${match.paths.join(',')}`], true);
    }
  }

  return {
    mode: input.mode,
    selected: [...selected.values()].sort((a, b) => a.lens.localeCompare(b.lens)),
    skipped: skipped.filter((entry) => !selected.has(entry.lens)),
    unmatched_requested: unmatched,
    mandatory_matches: mandatoryMatches,
    mandatory_bypassed: Boolean(input.no_mandatory && mandatoryMatches.length > 0),
    mandatory_bypass_reason: input.no_mandatory && mandatoryMatches.length > 0 ? bypassReason : undefined,
    confirmation_required: input.mode === 'recommended' && [...selected.values()].some((entry) => !entry.mandatory),
  };
}
