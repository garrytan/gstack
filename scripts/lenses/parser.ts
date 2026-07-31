import type { LensFindingInput, LensResult, LensSpec } from './types';

export interface ParsedLensOutput {
  result: LensResult | null;
  malformed_lines: Array<{ line: number; raw: string; reason: string }>;
  ignored_blank_lines: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateEnvelope(value: unknown, spec: LensSpec): LensResult {
  if (!isObject(value)) throw new Error('output line must be a JSON object');
  const lens = value.lens;
  if (lens !== spec.lens && !spec.cli_aliases.includes(String(lens))) {
    throw new Error(`output lens '${String(lens)}' does not match '${spec.lens}'`);
  }
  const normalizedLens = spec.lens;
  const status = value.status;
  if (status === 'NO_MATERIAL_FINDINGS') {
    return { lens: normalizedLens, status };
  }
  if (status === 'INSUFFICIENT_EVIDENCE') {
    const missingRequired = value.missing_required;
    if (!Array.isArray(missingRequired) || missingRequired.some((item) => typeof item !== 'string')) {
      throw new Error('INSUFFICIENT_EVIDENCE requires missing_required as an array of strings');
    }
    if (typeof value.why_insufficient !== 'string' || typeof value.what_would_make_actionable !== 'string') {
      throw new Error('INSUFFICIENT_EVIDENCE requires why_insufficient and what_would_make_actionable');
    }
    const missingOptional = value.missing_optional;
    if (missingOptional !== undefined && (!Array.isArray(missingOptional) || missingOptional.some((item) => typeof item !== 'string'))) {
      throw new Error('missing_optional must be an array of strings when present');
    }
    return {
      lens: normalizedLens,
      status,
      missing_required: missingRequired as string[],
      missing_optional: missingOptional as string[] | undefined,
      why_insufficient: value.why_insufficient,
      what_would_make_actionable: value.what_would_make_actionable,
    };
  }
  if (status === 'FINDINGS') {
    if (!Array.isArray(value.findings)) throw new Error('FINDINGS envelope requires a findings array');
    return { lens: normalizedLens, status, findings: value.findings as LensFindingInput[] };
  }
  if ('evidence' in value && 'severity' in value) {
    return { lens: normalizedLens, status: 'FINDINGS', findings: [value as unknown as LensFindingInput] };
  }
  throw new Error("object must be a finding or declare status FINDINGS, NO_MATERIAL_FINDINGS, or INSUFFICIENT_EVIDENCE");
}

export function parseLensOutput(raw: string, spec: LensSpec): ParsedLensOutput {
  const trimmed = raw.trim();
  if (trimmed === 'NO_MATERIAL_FINDINGS' || trimmed === 'NO FINDINGS') {
    return {
      result: { lens: spec.lens, status: 'NO_MATERIAL_FINDINGS' },
      malformed_lines: [],
      ignored_blank_lines: 0,
    };
  }

  const malformed: ParsedLensOutput['malformed_lines'] = [];
  const findings: LensFindingInput[] = [];
  let terminal: LensResult | null = null;
  let ignoredBlankLines = 0;
  const lines = raw.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) {
      ignoredBlankLines += 1;
      continue;
    }
    if (line.startsWith('```')) {
      malformed.push({ line: index + 1, raw: line, reason: 'Markdown fences are not allowed' });
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      const result = validateEnvelope(parsed, spec);
      if (result.status === 'FINDINGS') {
        findings.push(...result.findings);
      } else if (terminal) {
        malformed.push({ line: index + 1, raw: line, reason: 'multiple terminal status objects' });
      } else {
        terminal = result;
      }
    } catch (error) {
      malformed.push({ line: index + 1, raw: line, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  if (terminal && findings.length > 0) {
    malformed.push({ line: 0, raw: '', reason: 'terminal status cannot be combined with findings' });
    return { result: null, malformed_lines: malformed, ignored_blank_lines: ignoredBlankLines };
  }
  if (terminal) return { result: terminal, malformed_lines: malformed, ignored_blank_lines: ignoredBlankLines };
  if (findings.length > 0) {
    return {
      result: { lens: spec.lens, status: 'FINDINGS', findings },
      malformed_lines: malformed,
      ignored_blank_lines: ignoredBlankLines,
    };
  }
  return { result: null, malformed_lines: malformed, ignored_blank_lines: ignoredBlankLines };
}
