import * as fs from 'fs';
import * as path from 'path';
import { parseFrontmatterDocument, type YamlObject, type YamlValue } from './yaml-subset';
import {
  EVIDENCE_KINDS,
  LENS_STATUSES,
  type EvidenceKind,
  type InvocationTriggers,
  type LensSpec,
  type LensStatus,
  type SemanticTrigger,
} from './types';

const LENS_FILE_EXCLUSIONS = new Set(['shared-behavior.md', 'registry.md']);
const NAME_RE = /^[a-z][a-z0-9-]*$/;
const SEVERITY_RE = /^[A-Z][A-Z0-9_]*$/;
const SKILL_RE = /^\/[a-z][a-z0-9-]*$/;

// These patterns reject direct stakeholder roleplay instructions while allowing
// ordinary domain nouns such as "user impersonation" or "insider threat".
const PERSONA_FRAMING_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /\bpretend\s+(?:that\s+)?you\s+are\b/i, description: 'pretend-you-are framing' },
  { pattern: /\bassume\s+you\s+are\s+(?:an?\s+)?(?:[a-z-]+\s+){0,3}(?:investor|regulator|buyer|insider|user|competitor)\b/i, description: 'assume-you-are-stakeholder framing' },
  { pattern: /\bact\s+as\s+(?:an?\s+)?(?:[a-z-]+\s+){0,3}(?:investor|regulator|buyer|insider|user|competitor)\b/i, description: 'act-as-stakeholder framing' },
  { pattern: /\byou\s+are\s+(?:an?\s+)?(?:[a-z-]+\s+){0,3}(?:investor|regulator|buyer|insider|user|competitor)\s+(?:reviewing|evaluating|trying)\b/i, description: 'stakeholder-role assignment' },
];

const REQUIRED_READY_HEADINGS = [
  '## When I use this lens',
  '## Objective',
  '## Search strategy',
];

function isObject(value: YamlValue | undefined): value is Record<string, YamlValue> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function expectString(source: YamlObject, key: string, file: string, allowEmpty = false): string {
  const value = source[key];
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new Error(`${file}: '${key}' must be a non-empty string`);
  }
  return value.trim();
}

function expectNullableString(source: YamlObject, key: string, file: string): string | null {
  const value = source[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${file}: '${key}' must be a string or null`);
  return value.trim() || null;
}

function expectStringArray(source: YamlObject, key: string, file: string, allowEmpty = true): string[] {
  const value = source[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${file}: '${key}' must be an array of strings`);
  }
  const result = (value as string[]).map((item) => item.trim()).filter(Boolean);
  if (!allowEmpty && result.length === 0) throw new Error(`${file}: '${key}' must not be empty`);
  return result;
}

function expectEnum<T extends readonly string[]>(source: YamlObject, key: string, allowed: T, file: string): T[number] {
  const value = expectString(source, key, file);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${file}: '${key}' must be one of ${allowed.join(', ')}, got '${value}'`);
  }
  return value as T[number];
}

function parseSemanticTrigger(value: string, file: string): SemanticTrigger {
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`${file}: semantic trigger '${value}' must use kind=value`);
  }
  const kind = value.slice(0, separator);
  const triggerValue = value.slice(separator + 1);
  if (!['pr_label', 'file_metadata', 'user_declared'].includes(kind)) {
    throw new Error(`${file}: semantic trigger kind '${kind}' is not supported in V0.5`);
  }
  return { kind: kind as SemanticTrigger['kind'], value: triggerValue };
}

function parseInvocationTriggers(frontmatter: YamlObject, file: string): InvocationTriggers {
  const raw = frontmatter.invocation_triggers;
  if (!isObject(raw)) throw new Error(`${file}: 'invocation_triggers' must be a mapping`);
  const pathGlobs = expectStringArray(raw, 'path_globs', file);
  const rawSemantic = expectStringArray(raw, 'semantic_triggers', file);
  return {
    path_globs: pathGlobs,
    semantic_triggers: rawSemantic.map((value) => parseSemanticTrigger(value, file)),
  };
}

function validateNameList(values: string[], label: string, file: string, regex: RegExp): void {
  for (const value of values) {
    if (!regex.test(value)) throw new Error(`${file}: invalid ${label} '${value}'`);
  }
  if (new Set(values).size !== values.length) throw new Error(`${file}: duplicate values in '${label}'`);
}

function markerName(lens: string): string {
  return lens.replace(/-/g, ' ').toUpperCase();
}

function validateObjectiveConditionedPrompt(body: string, file: string): void {
  for (const { pattern, description } of PERSONA_FRAMING_PATTERNS) {
    if (pattern.test(body)) {
      throw new Error(`${file}: persona framing prohibited (${description}); encode an objective function, evidence standard, materiality threshold, and escalation policy instead`);
    }
  }
}

function validateReadyPromptShape(body: string, file: string): void {
  for (const heading of REQUIRED_READY_HEADINGS) {
    if (!body.includes(heading)) throw new Error(`${file}: READY lens prompt must include '${heading}'`);
  }
  if (!body.includes('## Lens-specific output fields')) {
    throw new Error(`${file}: READY lens prompt must include '## Lens-specific output fields'`);
  }
}

export function parseLensFile(filePath: string): LensSpec {
  const content = fs.readFileSync(filePath, 'utf8');
  const { frontmatter, body } = parseFrontmatterDocument(content);
  const file = path.basename(filePath);
  const lens = expectString(frontmatter, 'lens', file);
  if (!NAME_RE.test(lens)) throw new Error(`${file}: invalid lens name '${lens}'`);
  if (path.basename(filePath, '.md') !== lens) {
    throw new Error(`${file}: file name must match lens '${lens}'`);
  }

  const aliases = expectStringArray(frontmatter, 'cli_aliases', file);
  validateNameList(aliases, 'cli_aliases', file, NAME_RE);
  if (aliases.includes(lens)) throw new Error(`${file}: cli_aliases must not repeat the canonical name`);

  const status = expectEnum(frontmatter, 'status', LENS_STATUSES, file) as LensStatus;
  const summary = expectString(frontmatter, 'summary', file);
  const primarySkill = expectStringArray(frontmatter, 'primary_skill', file, false);
  const supportedSkills = expectStringArray(frontmatter, 'supported_skills', file);
  validateNameList(primarySkill, 'primary_skill', file, SKILL_RE);
  validateNameList(supportedSkills, 'supported_skills', file, SKILL_RE);
  if (primarySkill.some((skill) => supportedSkills.includes(skill))) {
    throw new Error(`${file}: primary_skill and supported_skills must not overlap`);
  }

  const severity = expectStringArray(frontmatter, 'severity', file, false);
  validateNameList(severity, 'severity', file, SEVERITY_RE);
  if (status === 'READY' && severity.length !== 5) {
    throw new Error(`${file}: READY lenses must define exactly 5 severity categories`);
  }

  const evidenceKinds = expectStringArray(frontmatter, 'allowed_evidence_kinds', file, false);
  for (const kind of evidenceKinds) {
    if (!(EVIDENCE_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`${file}: unsupported evidence kind '${kind}'`);
    }
  }

  const expectedMarkerName = markerName(lens);
  const startMarker = `==== LENS PROMPT START | ${expectedMarkerName} ====`;
  const endMarker = `==== LENS PROMPT END | ${expectedMarkerName} ====`;
  if (!body.includes(startMarker) || !body.includes(endMarker)) {
    throw new Error(`${file}: prompt body must include exact START and END markers for ${expectedMarkerName}`);
  }
  if (body.indexOf(startMarker) > body.indexOf(endMarker)) {
    throw new Error(`${file}: prompt END marker appears before START marker`);
  }
  validateObjectiveConditionedPrompt(body, file);
  if (status === 'READY') validateReadyPromptShape(body, file);

  const spec: LensSpec = {
    lens,
    cli_aliases: aliases,
    status,
    summary,
    primary_skill: primarySkill,
    supported_skills: supportedSkills,
    severity,
    ranking: expectString(frontmatter, 'ranking', file),
    scope_disclaimer: expectString(frontmatter, 'scope_disclaimer', file),
    required_artifacts: expectStringArray(frontmatter, 'required_artifacts', file),
    optional_artifacts: expectStringArray(frontmatter, 'optional_artifacts', file),
    required_context: expectStringArray(frontmatter, 'required_context', file),
    optional_context: expectStringArray(frontmatter, 'optional_context', file),
    allowed_evidence_kinds: evidenceKinds as EvidenceKind[],
    on_missing_required_evidence: expectEnum(frontmatter, 'on_missing_required_evidence', ['INSUFFICIENT_EVIDENCE'] as const, file),
    invocation_triggers: parseInvocationTriggers(frontmatter, file),
    evidence_threshold: expectEnum(frontmatter, 'evidence_threshold', ['STRONG_ONLY', 'STRONG_OR_MODERATE', 'ANY'] as const, file),
    materiality_threshold: expectEnum(frontmatter, 'materiality_threshold', ['BLOCKING_ONLY', 'MATERIAL_OR_BLOCKING', 'ANY'] as const, file),
    escalation_policy: expectEnum(frontmatter, 'escalation_policy', ['ADVISORY', 'MATERIAL', 'BLOCKING', 'REQUIRES_DOMAIN_VALIDATION', 'ADVISORY_PLUS_MATERIAL'] as const, file),
    autofix_policy: expectEnum(frontmatter, 'autofix_policy', ['ask_always', 'mechanical_only'] as const, file),
    safety_directive: expectNullableString(frontmatter, 'safety_directive', file),
    prompt_marker_name: expectedMarkerName,
    body,
    path: filePath,
  };

  if (spec.status === 'READY' && ![...spec.primary_skill, ...spec.supported_skills].includes('/review')) {
    throw new Error(`${file}: V0.5 READY lenses must support /review`);
  }
  if (spec.status === 'READY' && spec.autofix_policy !== 'ask_always') {
    throw new Error(`${file}: V0.5 READY lenses must use autofix_policy: ask_always`);
  }
  return spec;
}

export function defaultLensRoot(repoRoot: string): string {
  return path.join(repoRoot, 'review', 'lenses');
}

export function loadLensRegistry(repoRoot: string): LensSpec[] {
  const lensRoot = defaultLensRoot(repoRoot);
  if (!fs.existsSync(lensRoot)) throw new Error(`Lens directory not found: ${lensRoot}`);
  const specs = fs.readdirSync(lensRoot)
    .filter((name: string) => name.endsWith('.md') && !LENS_FILE_EXCLUSIONS.has(name))
    .sort()
    .map((name: string) => parseLensFile(path.join(lensRoot, name)));
  if (specs.length === 0) throw new Error(`No lens specifications found in ${lensRoot}`);

  const names = new Map<string, string>();
  for (const spec of specs) {
    for (const name of [spec.lens, ...spec.cli_aliases]) {
      const existing = names.get(name);
      if (existing) throw new Error(`Lens name or alias '${name}' is shared by '${existing}' and '${spec.lens}'`);
      names.set(name, spec.lens);
    }
  }
  return specs;
}

export function resolveLensName(specs: LensSpec[], name: string): LensSpec | undefined {
  return specs.find((spec) => spec.lens === name || spec.cli_aliases.includes(name));
}

export function readyLenses(specs: LensSpec[]): LensSpec[] {
  return specs.filter((spec) => spec.status === 'READY');
}

export function renderRegistryMarkdown(specs: LensSpec[]): string {
  const rows = [...specs]
    .sort((a, b) => a.lens.localeCompare(b.lens))
    .map((spec) => `| \`${spec.lens}\` | ${spec.cli_aliases.map((a) => `\`${a}\``).join(', ') || 'none'} | ${spec.status} | ${spec.primary_skill.join(', ')} | ${spec.summary} |`)
    .join('\n');
  return `<!-- AUTO-GENERATED from review/lenses/*.md frontmatter. Do not edit directly. -->\n<!-- Regenerate: bun run gen:skill-docs -->\n\n# Stakeholder Lens Registry\n\nThe validated lens frontmatter is the source of truth. READY lenses may run normally. DRAFT lenses require explicit naming plus \`--lens-draft\`. DEFERRED lenses are specifications only.\n\n| Lens | CLI aliases | Status | Primary skill | Objective |\n|------|-------------|--------|---------------|-----------|\n${rows}\n`;
}

export function writeGeneratedRegistry(repoRoot: string, specs = loadLensRegistry(repoRoot)): string {
  const output = path.join(defaultLensRoot(repoRoot), 'registry.md');
  fs.writeFileSync(output, renderRegistryMarkdown(specs));
  return output;
}

export interface RegistrySyncResult {
  changed: boolean;
  outputPath: string;
  specs: LensSpec[];
}

export function syncGeneratedRegistry(repoRoot: string, dryRun = false): RegistrySyncResult {
  const specs = loadLensRegistry(repoRoot);
  const outputPath = path.join(defaultLensRoot(repoRoot), 'registry.md');
  const generated = renderRegistryMarkdown(specs);
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : null;
  const changed = current !== generated;
  if (changed && !dryRun) fs.writeFileSync(outputPath, generated);
  return { changed, outputPath, specs };
}
