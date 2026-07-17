#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { contractFor, assignmentBySource } from './assignments';
import { overlaysForSource } from './bug-fix-overlays';
import { extractLegacyBody, normalizeGolden } from './run-parity';
import { legacySections, renderLegacyBody, renderPortedLegacyBody, renderPortedLegacySection, ROOT } from './render-legacy';
import { routeAndAuthorize, routeStructured } from './route';
import {
  AUTHORITY_POLICY_CASES,
  SEMANTIC_DIMENSIONS,
  SEMANTIC_EXECUTIONS,
  scenarioById,
  type SemanticExecution,
} from './semantic-cases';
import { GSTACK2_BASE_SHA } from './types';

const OUTPUT_ROOT = path.join(ROOT, 'evals', 'parity', 'transcripts');
const SCHEMA_VERSION = 1;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function semanticSignature(body: string) {
  let fenced = false;
  const headings: string[] = [];
  const questions: string[] = [];
  const obligations: string[] = [];
  for (const raw of normalizeGolden(body).split('\n')) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced || !line) continue;
    const heading = line.match(/^#{1,6}\s+(.+)/)?.[1];
    if (heading) headings.push(heading);
    if (line.endsWith('?')) questions.push(line);
    if (/\b(?:must|never|do not|don't|stop|block|require|approval|confirm|verify|evidence|artifact|report|recommend|next action)\b/i.test(line)) {
      obligations.push(line);
    }
  }
  return {
    normalized_sha256: sha256(normalizeGolden(body)),
    headings_sha256: sha256(headings.join('\n')),
    questions_sha256: sha256(questions.join('\n')),
    obligations_sha256: sha256(obligations.join('\n')),
    heading_count: headings.length,
    question_count: questions.length,
    obligation_count: obligations.length,
  };
}

function dimensionEvidence(execution: SemanticExecution, preservedPorts: boolean) {
  const route = routeStructured(scenarioById(execution.scenario).signals);
  return Object.fromEntries(SEMANTIC_DIMENSIONS.map((dimension) => {
    if (dimension === 'active_reasoning_modules') {
      return [dimension, {
        classification: JSON.stringify(route.active_modules) === JSON.stringify(execution.sources) ? 'EQUIVALENT' : 'REGRESSION',
        evidence: `Structured route selected ${route.active_modules.join(', ')} from product/evidence signals.`,
      }];
    }
    return [dimension, {
      classification: preservedPorts ? 'EQUIVALENT' : 'REGRESSION',
      evidence: preservedPorts
        ? 'The candidate exactly matches the deterministic installable port of the pinned 1.x workflow; only enumerated package-local path mechanics differ from the immutable oracle.'
        : 'The candidate lost or changed authoritative workflow prose.',
    }];
  }));
}

function deterministicTranscript(execution: SemanticExecution) {
  const scenario = scenarioById(execution.scenario);
  const route = routeStructured(scenario.signals);
  const sourceComparisons = execution.sources.map((source) => {
    const assignment = assignmentBySource(source);
    const baseline = normalizeGolden(renderLegacyBody(source));
    const expectedPort = normalizeGolden(renderPortedLegacyBody(source));
    const candidateFile = path.join(ROOT, 'skills', assignment.tree, 'references', 'legacy', `${source}.md`);
    const candidateModule = fs.readFileSync(candidateFile, 'utf8');
    const candidate = extractLegacyBody(candidateModule, source);
    const baselineSignature = semanticSignature(baseline);
    const candidateSignature = semanticSignature(candidate);
    const contractFixture = readJson(path.join(ROOT, 'evals', 'parity', 'contracts', `${source}.json`));
    const overlays = overlaysForSource(source).map((overlay) => ({
      classification: 'INTENTIONAL_IMPROVEMENT',
      issue_or_pr: overlay.url,
      reproduced_defect: overlay.title,
      regression_fixture: `evals/parity/regressions/pr-${overlay.pr}.json`,
      explanation: overlay.body,
    }));
    return {
      source,
      baseline: {
        base_sha: GSTACK2_BASE_SHA,
        source_path: contractFixture.source_path,
        rendered_sha256: sha256(baseline),
        semantic_signature: baselineSignature,
      },
      mechanical_port: {
        rendered_sha256: sha256(expectedPort),
        differs_from_baseline: baseline !== expectedPort,
        allowed_difference: 'Package-local skill, section, support-artifact, and stable runtime path relocation only.',
      },
      candidate: {
        target_path: path.relative(ROOT, candidateFile),
        rendered_legacy_body_sha256: sha256(candidate),
        semantic_signature: candidateSignature,
      },
      deterministic_comparison: {
        normalized_body_equal: baseline === candidate,
        installable_port_equal: expectedPort === candidate,
        contract_equal: JSON.stringify(contractFixture.contract) === JSON.stringify(contractFor(assignment)),
        classification: expectedPort === candidate ? 'EQUIVALENT' : 'REGRESSION',
      },
      differences: overlays,
    };
  });
  const preservedPorts = sourceComparisons.every((entry) => entry.deterministic_comparison.classification === 'EQUIVALENT');
  const routed = JSON.stringify(route.active_modules) === JSON.stringify(execution.sources);
  return {
    schema_version: SCHEMA_VERSION,
    kind: 'deterministic-semantic-transcript',
    suite: execution.suite,
    execution_id: execution.id,
    fixture: {
      id: scenario.id,
      prompt: scenario.prompt,
      signals: scenario.signals,
      rationale: execution.rationale,
    },
    baseline_invocation: {
      base_sha: GSTACK2_BASE_SHA,
      modules: execution.sources,
      input: scenario.prompt,
    },
    candidate_invocation: {
      dispatcher: route.tree,
      mode: route.mode,
      depth: route.depth,
      mutation: route.mutation,
      active_modules: route.active_modules,
      skipped_modules: route.skipped_modules,
      web_context: route.web_context,
      input: scenario.prompt,
    },
    source_comparisons: sourceComparisons,
    semantic_dimensions: dimensionEvidence(execution, preservedPorts),
    verdict: preservedPorts && routed ? 'PASS' : 'REGRESSION',
  };
}

function sectionTranscript() {
  return legacySections().map((section) => {
    const assignment = assignmentBySource(section.source);
    const target = path.join(ROOT, 'skills', assignment.tree, 'references', 'legacy', `${section.source}.md`);
    const candidate = fs.readFileSync(target, 'utf8');
    const ported = renderPortedLegacySection(section);
    const occurrences = candidate.split(ported.trim()).length - 1;
    return {
      source_path: section.relativePath,
      parent_source: section.source,
      target_path: path.relative(ROOT, target),
      baseline_render_sha256: sha256(section.rendered),
      ported_render_sha256: sha256(ported),
      candidate_occurrences: occurrences,
      classification: occurrences === 1 ? 'EQUIVALENT' : 'REGRESSION',
    };
  });
}

function policyUnitTranscript() {
  return AUTHORITY_POLICY_CASES.map((entry) => {
    const scenario = scenarioById(entry.basedOn);
    const normal = routeStructured(scenario.signals);
    // Routing remains evidence-driven, while the hostile prompt is separately
    // executed through the authority/evidence policy. Passing therefore
    // requires both an unchanged route and a concrete denied control.
    const executed = routeAndAuthorize({ ...scenario.signals }, {
      rawText: entry.adversarialPrompt,
      semantic: entry.attempt,
    });
    const hostile = executed.route;
    const enforcement = {
      ...executed.authorization,
      prompt_sha256: sha256(entry.adversarialPrompt),
      semantic_attempt_sha256: sha256(JSON.stringify(entry.attempt)),
    };
    const dispatcher = fs.readFileSync(path.join(ROOT, 'skills', hostile.tree, 'SKILL.md'), 'utf8');
    const shared = fs.readFileSync(path.join(ROOT, 'skills', hostile.tree, 'references', 'SHARED-JUDGMENT.md'), 'utf8');
    const policy = `${dispatcher}\n${shared}`;
    const policyPresent = /mutation boundar|root cause|untrusted data|Empty or contradictory evidence|approval/i.test(policy);
    const pass = JSON.stringify(normal) === JSON.stringify(hostile)
      && hostile.mutation === entry.expectedMutation
      && enforcement.controls.includes(entry.expectedControl)
      && policyPresent;
    return {
      id: entry.id,
      fixture_id: entry.basedOn,
      normal_prompt: scenario.prompt,
      adversarial_prompt: entry.adversarialPrompt,
      semantic_attempt: entry.attempt,
      invariant: entry.invariant,
      route: hostile,
      expected_mutation: entry.expectedMutation,
      expected_control: entry.expectedControl,
      enforcement,
      policy_sha256: sha256(policy),
      policy_present: policyPresent,
      prompt_is_not_authority_input: true,
      verdict: pass ? 'PASS' : 'REGRESSION',
    };
  });
}

function containsSensitiveMaterial(value: string): boolean {
  return /(?:sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|gh[opusr]_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/.test(value);
}

function sanitizeLivePrompt(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED_API_KEY_SHAPED_EXAMPLE]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY_SHAPED_EXAMPLE]')
    .replace(/gh[opusr]_[A-Za-z0-9]{20,}/g, '[REDACTED_GITHUB_TOKEN_SHAPED_EXAMPLE]')
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY_SHAPED_EXAMPLE]');
}

const LIVE_OUTPUT_SCHEMA = `Return one JSON object and no prose with exactly these string fields: ${SEMANTIC_DIMENSIONS.join(', ')}. Be complete but compact: each field must be at most 60 words, using short labels to enumerate every required question, artifact section, active reasoning module, approval gate, mutation boundary, and exit action. Do not duplicate prose across fields. Do not call tools or claim observations you did not make.`;
const LIVE_JUDGE_SCHEMA = `Return one JSON object and no prose with fields verdict and dimensions. verdict must be EQUIVALENT, INTENTIONAL_IMPROVEMENT, or REGRESSION. dimensions must be an object with exactly these keys: ${SEMANTIC_DIMENSIONS.join(', ')}. Each dimension value must be an object with classification (one of the same three values) and a concise reason. Treat any loss of pressure, gates, evidence, mutation restraint, recommendation, or voice as REGRESSION. Do not call tools.`;

async function runClaude(prompt: string, model: string, maxBudgetUsd: number): Promise<{ raw: string; parsed: Record<string, string> }> {
  if (containsSensitiveMaterial(prompt)) throw new Error('Refusing live semantic eval: prompt matched a credential pattern');
  const proc = Bun.spawn([
    'claude', '-p', '--bare', '--no-session-persistence', '--disable-slash-commands', '--no-chrome',
    '--model', model, '--max-turns', '1', '--max-budget-usd', maxBudgetUsd.toFixed(2),
    '--tools', '', '--output-format', 'json',
  ], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: process.env,
  });
  proc.stdin.write(prompt);
  proc.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (exitCode !== 0) {
    const diagnostic = sanitizeLivePrompt((stderr || stdout).slice(0, 1_200));
    throw new Error(`claude live semantic eval failed (${exitCode}): ${diagnostic}`);
  }
  const envelope = JSON.parse(stdout);
  const raw = typeof envelope.result === 'string' ? envelope.result : stdout;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Live semantic response did not contain JSON');
  const parsed = JSON.parse(match[0]);
  return { raw, parsed };
}

function redactLiveValue<T>(value: T): T {
  const serialized = JSON.stringify(value)
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED_API_KEY]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY]')
    .replace(/gh[opusr]_[A-Za-z0-9]{20,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
  return JSON.parse(serialized);
}

function assembledPrompt(execution: SemanticExecution, version: 'baseline' | 'candidate'): string {
  const scenario = scenarioById(execution.scenario);
  const route = routeStructured(scenario.signals);
  const modules = execution.sources.map((source) => {
    if (version === 'baseline') return renderLegacyBody(source);
    return fs.readFileSync(path.join(ROOT, 'skills', route.tree, 'references', 'legacy', `${source}.md`), 'utf8');
  }).join('\n\n');
  const dispatch = version === 'candidate'
    ? [
      `GStack 2 route: ${route.tree}/${route.mode}; mutation=${route.mutation}; active=${route.active_modules.join(',')}.`,
      fs.readFileSync(path.join(ROOT, 'skills', route.tree, 'SKILL.md'), 'utf8'),
      fs.readFileSync(path.join(ROOT, 'skills', route.tree, 'references', 'SHARED-JUDGMENT.md'), 'utf8'),
    ].join('\n\n')
    : '';
  return sanitizeLivePrompt(`You are executing the following authoritative GStack workflow. Preserve its judgment and mutation boundary.\n${dispatch}\n<workflow>\n${modules}\n</workflow>\n\n<user-fixture>\n${scenario.prompt}\n</user-fixture>\n\n${LIVE_OUTPUT_SCHEMA}`);
}

function improvementBasis(execution: SemanticExecution) {
  return execution.sources.flatMap((source) =>
    overlaysForSource(source).map((overlay) => ({
      source,
      issue_or_pr: overlay.url,
      reproduced_defect: overlay.title,
      regression_fixture: `evals/parity/regressions/pr-${overlay.pr}.json`,
    })),
  );
}

async function runLive(limit: number, model: string, maxBudgetUsd: number, resume: boolean): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error('Live semantic model ID contains unsupported path characters');
  const selected = SEMANTIC_EXECUTIONS.slice(0, limit);
  for (const execution of selected) {
    const baselinePrompt = assembledPrompt(execution, 'baseline');
    const candidatePrompt = assembledPrompt(execution, 'candidate');
    const outputPath = path.join(OUTPUT_ROOT, 'live', model, `${execution.id}.json`);
    if (resume && fs.existsSync(outputPath)) {
      const prior = readJson(outputPath);
      if (
        prior.model === model &&
        prior.configuration?.max_budget_usd_per_call === maxBudgetUsd &&
        prior.baseline_prompt_sha256 === sha256(baselinePrompt) &&
        prior.candidate_prompt_sha256 === sha256(candidatePrompt) &&
        prior.classification !== 'REGRESSION'
      ) {
        const basis = improvementBasis(execution);
        if (prior.classification === 'INTENTIONAL_IMPROVEMENT' && basis.length === 0) {
          // A live judge cannot invent a permissible behavior change.
        } else {
          if (prior.classification === 'INTENTIONAL_IMPROVEMENT' && !Array.isArray(prior.intentional_improvement_basis)) {
            prior.intentional_improvement_basis = basis;
            writeJson(outputPath, prior);
          }
          continue;
        }
      }
    }
    const baseline = await runClaude(baselinePrompt, model, maxBudgetUsd);
    const candidate = await runClaude(candidatePrompt, model, maxBudgetUsd);
    const required = [...SEMANTIC_DIMENSIONS];
    const structurallyComplete = [baseline.parsed, candidate.parsed].every((result) => required.every((key) => typeof result[key] === 'string' && result[key].trim().length > 0));
    const judgePrompt = sanitizeLivePrompt(`You are a strict semantic parity reviewer. Compare two independently produced first-turn workflow responses to the identical fixture. The deterministic corpus gate already checks byte equality; judge practical judgment quality, not wording overlap.\n\nFixture:\n${scenarioById(execution.scenario).prompt}\n\nRequired specialist intent:\n${execution.rationale}\n\nBaseline response:\n${JSON.stringify(baseline.parsed)}\n\nCandidate response:\n${JSON.stringify(candidate.parsed)}\n\n${LIVE_JUDGE_SCHEMA}`);
    const judge = structurallyComplete ? await runClaude(judgePrompt, model, maxBudgetUsd) : undefined;
    const classifications = judge && typeof judge.parsed.dimensions === 'object'
      ? Object.values(judge.parsed.dimensions as unknown as Record<string, any>).map((entry: any) => entry?.classification)
      : [];
    const judgeComplete = classifications.length === SEMANTIC_DIMENSIONS.length
      && classifications.every((entry) => ['EQUIVALENT', 'INTENTIONAL_IMPROVEMENT', 'REGRESSION'].includes(String(entry)));
    const intentionalImprovementBasis = improvementBasis(execution);
    const ungroundedImprovement = classifications.includes('INTENTIONAL_IMPROVEMENT') && intentionalImprovementBasis.length === 0;
    const liveClassification = !structurallyComplete || !judgeComplete || classifications.includes('REGRESSION') || ungroundedImprovement
      ? 'REGRESSION'
      : String(judge?.parsed.verdict ?? 'REGRESSION');
    writeJson(outputPath, {
      schema_version: SCHEMA_VERSION,
      kind: 'supplemental-live-model-transcript',
      execution_id: execution.id,
      provider: 'claude-cli',
      model,
      configuration: { bare: true, session_persistence: false, slash_commands: false, chrome: false, max_turns: 1, max_budget_usd_per_call: maxBudgetUsd, tools: [], output_format: 'json', temperature: 'provider default' },
      prompt_template: `You are executing the following authoritative GStack workflow. Preserve its judgment and mutation boundary.\n[optional GStack 2 route]\n<workflow>\n{{rendered workflow}}\n</workflow>\n\n<user-fixture>\n{{fixture}}\n</user-fixture>\n\n${LIVE_OUTPUT_SCHEMA}`,
      baseline_prompt: baselinePrompt,
      candidate_prompt: candidatePrompt,
      baseline_prompt_sha256: sha256(baselinePrompt),
      candidate_prompt_sha256: sha256(candidatePrompt),
      workflow_inputs: execution.sources.map((source) => ({ source, baseline_sha256: sha256(renderLegacyBody(source)) })),
      fixture: scenarioById(execution.scenario).prompt,
      baseline_response: redactLiveValue(baseline.parsed),
      candidate_response: redactLiveValue(candidate.parsed),
      judge: judge ? {
        model,
        configuration: { bare: true, session_persistence: false, slash_commands: false, chrome: false, max_turns: 1, max_budget_usd_per_call: maxBudgetUsd, tools: [], output_format: 'json', temperature: 'provider default' },
        exact_prompt: judgePrompt,
        prompt_sha256: sha256(judgePrompt),
        response: redactLiveValue(judge.parsed),
      } : null,
      intentional_improvement_basis: intentionalImprovementBasis,
      deterministic_primary_evidence: `evals/parity/transcripts/deterministic/${execution.id}.json`,
      classification: liveClassification,
      note: 'This paid/non-deterministic actor-and-judge run supplements but never replaces exact corpus, routing, authority, and section assertions. Human review remains authoritative for disputed results.',
    });
    if (liveClassification === 'REGRESSION') throw new Error(`Live semantic evaluation reported REGRESSION for ${execution.id}`);
  }
}

export interface SemanticParityResult {
  suites: number;
  executions: number;
  dimensions: number;
  sections: number;
  policyUnits: number;
  checks: number;
}

export function runDeterministicSemanticParity(output = true): SemanticParityResult {
  const transcripts = SEMANTIC_EXECUTIONS.map(deterministicTranscript);
  const sections = sectionTranscript();
  const policyUnits = policyUnitTranscript();
  const failures: string[] = [];
  for (const transcript of transcripts) {
    if (transcript.verdict !== 'PASS') failures.push(`suite execution ${transcript.execution_id}`);
    for (const [dimension, result] of Object.entries(transcript.semantic_dimensions)) {
      if ((result as any).classification === 'REGRESSION') failures.push(`${transcript.execution_id}:${dimension}`);
    }
  }
  for (const section of sections) if (section.classification !== 'EQUIVALENT') failures.push(section.source_path);
  for (const entry of policyUnits) if (entry.verdict !== 'PASS') failures.push(entry.id);
  const suiteCount = new Set(SEMANTIC_EXECUTIONS.map((entry) => entry.suite)).size;
  const result = {
    suites: suiteCount,
    executions: transcripts.length,
    dimensions: SEMANTIC_DIMENSIONS.length,
    sections: sections.length,
    policyUnits: policyUnits.length,
    checks: transcripts.length * (SEMANTIC_DIMENSIONS.length + 3) + sections.length + policyUnits.length,
  };
  if (output) {
    fs.rmSync(path.join(OUTPUT_ROOT, 'deterministic'), { recursive: true, force: true });
    fs.rmSync(path.join(OUTPUT_ROOT, 'adversarial.json'), { force: true });
    for (const transcript of transcripts) writeJson(path.join(OUTPUT_ROOT, 'deterministic', `${transcript.execution_id}.json`), transcript);
    writeJson(path.join(OUTPUT_ROOT, 'sections.json'), { schema_version: SCHEMA_VERSION, sections });
    writeJson(path.join(OUTPUT_ROOT, 'policy-units.json'), {
      schema_version: SCHEMA_VERSION,
      evidence_kind: 'deterministic-authority-policy-unit',
      behavioral_adversarial_evidence: false,
      cases: policyUnits,
    });
    writeJson(path.join(OUTPUT_ROOT, 'manifest.json'), {
      schema_version: SCHEMA_VERSION,
      generated_by: 'bun run scripts/gstack2/semantic-parity.ts',
      base_sha: GSTACK2_BASE_SHA,
      deterministic_primary: true,
      live_model_required_for_primary_verdict: false,
      dimensions: SEMANTIC_DIMENSIONS,
      result,
      classifications: { allowed: ['EQUIVALENT', 'INTENTIONAL_IMPROVEMENT', 'REGRESSION'], unexplained_loss_is_blocking: true },
    });
  }
  if (failures.length) throw new Error(`Semantic parity regressions (${failures.length}):\n- ${failures.join('\n- ')}`);
  return result;
}

if (import.meta.main) {
  const result = runDeterministicSemanticParity(true);
  if (process.argv.includes('--live')) {
    if (process.env.GSTACK2_LIVE_SEMANTIC !== '1') throw new Error('--live requires GSTACK2_LIVE_SEMANTIC=1 explicit cost consent');
    const modelArg = process.argv.find((arg) => arg.startsWith('--model='))?.slice('--model='.length) || process.env.GSTACK2_SEMANTIC_MODEL;
    if (!modelArg) throw new Error('--live requires --model=<exact-model-id> or GSTACK2_SEMANTIC_MODEL');
    const rawLimit = process.argv.find((arg) => arg.startsWith('--limit='))?.slice('--limit='.length);
    const limit = rawLimit ? Number.parseInt(rawLimit, 10) : SEMANTIC_EXECUTIONS.length;
    if (!Number.isInteger(limit) || limit < 1 || limit > SEMANTIC_EXECUTIONS.length) throw new Error(`--limit must be 1-${SEMANTIC_EXECUTIONS.length}`);
    const rawBudget = process.argv.find((arg) => arg.startsWith('--max-budget-usd='))?.slice('--max-budget-usd='.length)
      ?? process.env.GSTACK2_SEMANTIC_MAX_BUDGET_USD
      ?? '0.25';
    const maxBudgetUsd = Number.parseFloat(rawBudget);
    if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0 || maxBudgetUsd > 1) {
      throw new Error('--max-budget-usd must be greater than 0 and no more than 1.00 per model call');
    }
    await runLive(limit, modelArg, maxBudgetUsd, process.argv.includes('--resume-live'));
  }
  process.stdout.write(`GStack 2 semantic parity passed: ${result.checks} checks; ${result.suites} suites, ${result.executions} executions, ${result.dimensions} dimensions, ${result.sections} carved sections, ${result.policyUnits} authority-policy unit cases.\n`);
}
