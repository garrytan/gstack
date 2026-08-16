import type { CtoSynthesisOutput, SynthesisInput } from './types';

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function requireFindingIds(value: unknown, field: string, allowed: Set<string>, minimum = 1): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} must be an array of finding IDs`);
  }
  const ids = [...new Set((value as string[]).map((item) => item.trim()).filter(Boolean))];
  if (ids.length < minimum) throw new Error(`${field} must contain at least ${minimum} finding ID(s)`);
  const unknown = ids.filter((id) => !allowed.has(id));
  if (unknown.length > 0) throw new Error(`${field} references unknown finding IDs: ${unknown.join(', ')}`);
  return ids;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

export function validateCtoSynthesis(raw: unknown, input: SynthesisInput): CtoSynthesisOutput {
  if (!isObject(raw)) throw new Error('CTO synthesis output must be a JSON object');
  const allowed = new Set(input.findings.map((finding) => finding.finding_id));

  const shared_primitives = requireArray(raw.shared_primitives, 'shared_primitives').map((value, index) => {
    if (!isObject(value)) throw new Error(`shared_primitives[${index}] must be an object`);
    return {
      primitive: requireString(value.primitive, `shared_primitives[${index}].primitive`),
      rationale: requireString(value.rationale, `shared_primitives[${index}].rationale`),
      finding_ids: requireFindingIds(value.finding_ids, `shared_primitives[${index}].finding_ids`, allowed, 2),
    };
  });

  const reinforcing_constraints = requireArray(raw.reinforcing_constraints, 'reinforcing_constraints').map((value, index) => {
    if (!isObject(value)) throw new Error(`reinforcing_constraints[${index}] must be an object`);
    return {
      summary: requireString(value.summary, `reinforcing_constraints[${index}].summary`),
      finding_ids: requireFindingIds(value.finding_ids, `reinforcing_constraints[${index}].finding_ids`, allowed, 2),
    };
  });

  const tensions = requireArray(raw.tensions, 'tensions').map((value, index) => {
    if (!isObject(value)) throw new Error(`tensions[${index}] must be an object`);
    return {
      summary: requireString(value.summary, `tensions[${index}].summary`),
      decision_required: requireString(value.decision_required, `tensions[${index}].decision_required`),
      finding_ids: requireFindingIds(value.finding_ids, `tensions[${index}].finding_ids`, allowed, 2),
    };
  });

  const sequencing = requireArray(raw.sequencing, 'sequencing').map((value, index) => {
    if (!isObject(value)) throw new Error(`sequencing[${index}] must be an object`);
    if (typeof value.order !== 'number' || !Number.isInteger(value.order) || value.order < 1) {
      throw new Error(`sequencing[${index}].order must be a positive integer`);
    }
    return {
      order: value.order,
      action: requireString(value.action, `sequencing[${index}].action`),
      finding_ids: requireFindingIds(value.finding_ids, `sequencing[${index}].finding_ids`, allowed),
    };
  }).sort((a, b) => a.order - b.order);

  const decisions_required = requireArray(raw.decisions_required, 'decisions_required').map((value, index) => {
    if (!isObject(value)) throw new Error(`decisions_required[${index}] must be an object`);
    const options = value.options === undefined
      ? undefined
      : requireArray(value.options, `decisions_required[${index}].options`).map((option, optionIndex) => requireString(option, `decisions_required[${index}].options[${optionIndex}]`));
    return {
      decision: requireString(value.decision, `decisions_required[${index}].decision`),
      finding_ids: requireFindingIds(value.finding_ids, `decisions_required[${index}].finding_ids`, allowed),
      ...(options ? { options } : {}),
    };
  });

  return { shared_primitives, reinforcing_constraints, tensions, sequencing, decisions_required };
}
