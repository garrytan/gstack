#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BUG_FIX_OVERLAYS, evaluateBugFixRegression, overlaysForSource } from './bug-fix-overlays';
import { contractFor, DISPATCHERS, SOURCE_ASSIGNMENTS } from './assignments';
import { ROOT, blobShaForPath, legacySections, renderLegacyBody, renderPortedAssetBytes, renderPortedLegacyBody, renderPortedLegacySection, sourceBlobSha } from './render-legacy';
import { routeStructured } from './route';
import { SCENARIOS } from './scenarios';
import { GSTACK2_BASE_SHA, TREE_NAMES } from './types';

const CONTRACT_KEYS = ['question_order', 'pressure', 'smart_skips', 'stop_approval_gates', 'evidence', 'artifacts', 'mutation', 'exit', 'voice'];
const PROVENANCE_KEYS = ['original_source_file', 'original_line_range', 'purpose', 'invocation_conditions', 'modes', 'question_sequence', 'follow_up_behavior', 'smart_skip_rules', 'pushback_rules', 'stop_gates', 'approval_gates', 'rubrics_and_scoring', 'cognitive_frameworks', 'evidence_requirements', 'artifacts_produced', 'mutation_authority', 'exit_states', 'voice', 'response_posture', 'new_location', 'parity_test'];
const ALLOWED_DISPOSITIONS = new Set(['VERBATIM_PORT', 'MECHANICAL_PORT', 'SHARED_MODULE', 'BUG_FIX', 'DUPLICATE_INFRASTRUCTURE', 'REMOVE_WITH_USER_APPROVAL']);
export const EXPECTED_PARITY_CHECKS = 4681;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function json(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function files(directory: string, suffix = ''): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((file) => file.endsWith(suffix)).sort();
}

export function normalizeGolden(value: string): string {
  return `${value.replace(/\r\n/g, '\n').trim()}\n`;
}

export function extractLegacyBody(module: string, source: string): string {
  const startMarker = `<!-- GSTACK2_LEGACY_BODY_START source=${source} -->`;
  const endMarker = `<!-- GSTACK2_LEGACY_BODY_END source=${source} -->`;
  const start = module.indexOf(startMarker);
  const end = module.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) throw new Error(`Missing legacy body markers for ${source}`);
  return normalizeGolden(module.slice(start + startMarker.length, end));
}

export interface ParityResult {
  checks: number;
  sources: number;
  sections: number;
  scenarios: number;
  regressions: number;
  assets: number;
}

export function runParity(): ParityResult {
  const failures: string[] = [];
  let checks = 0;
  const check = (condition: unknown, message: string): void => {
    checks += 1;
    if (!condition) failures.push(message);
  };

  const publicSkills = fs.readdirSync(path.join(ROOT, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(ROOT, 'skills', entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
  check(JSON.stringify(publicSkills) === JSON.stringify([...TREE_NAMES].sort()), `Public skills differ: ${publicSkills.join(', ')}`);
  check(SOURCE_ASSIGNMENTS.length === 55, `Expected 55 source assignments; got ${SOURCE_ASSIGNMENTS.length}`);
  check(SOURCE_ASSIGNMENTS.filter((entry) => entry.mandatory).length === 31, 'Mandatory specialist count is not 31');
  const exactModes: Record<string, string[]> = {
    plan: ['Discovery', 'Product', 'Engineering', 'DX', 'Specification', 'Full chain'],
    design: ['Explore', 'Generate', 'Critique', 'Implement'],
    qa: ['Report', 'Fix'],
    debug: ['Diagnose-only', 'Fix'],
    review: ['Normal', 'Security', 'Performance', 'Deep'],
    ship: ['Prepare', 'Land', 'Deploy', 'Monitor', 'Resume'],
  };
  for (const [tree, modes] of Object.entries(exactModes)) {
    const actual = DISPATCHERS.find((entry) => entry.name === tree)?.modes.map((entry) => entry.mode);
    check(JSON.stringify(actual) === JSON.stringify(modes), `${tree} top-level modes differ: ${actual?.join(', ')}`);
  }

  for (const tree of TREE_NAMES) {
    const skillPath = path.join(ROOT, 'skills', tree, 'SKILL.md');
    const skill = fs.readFileSync(skillPath, 'utf8');
    const fmEnd = skill.indexOf('\n---', 4);
    const fm = skill.slice(4, fmEnd);
    const keys = fm.split('\n').map((line) => line.match(/^([a-z][a-z0-9_-]*):/)?.[1]).filter(Boolean).sort();
    check(JSON.stringify(keys) === JSON.stringify(['description', 'name']), `${tree} frontmatter must contain only name and description`);
    check(new RegExp(`^name: ${tree}$`, 'm').test(fm), `${tree} frontmatter name mismatch`);
    check(skill.split('\n').length < 500, `${tree}/SKILL.md exceeds 500 lines`);
    let prior = -1;
    for (const label of ['Target:', 'Mode:', 'Depth:', 'Mutation:', 'Active modules:', 'Skipped modules:', 'Web context:']) {
      const position = skill.indexOf(label);
      check(position > prior, `${tree} required execution header is missing or out of order at ${label}`);
      prior = position;
    }
    const metadata = fs.readFileSync(path.join(ROOT, 'skills', tree, 'agents', 'openai.yaml'), 'utf8');
    check(/^interface:\n  display_name: .+\n  short_description: .+\n  default_prompt: .+\n$/.test(metadata), `${tree} openai.yaml schema mismatch`);
    check(metadata.includes(`$${tree}`), `${tree} default prompt does not mention $${tree}`);
    const dispatcher = DISPATCHERS.find((entry) => entry.name === tree)!;
    for (const mode of dispatcher.modes) {
      for (const source of mode.modules) {
        const localModule = path.join(ROOT, 'skills', tree, 'references', 'legacy', `${source}.md`);
        const owner = SOURCE_ASSIGNMENTS.find((entry) => entry.source === source)!;
        const canonicalModule = path.join(ROOT, 'skills', owner.tree, 'references', 'legacy', `${source}.md`);
        check(fs.existsSync(localModule), `${tree}:${mode.mode} is not package-closed; missing ${source}`);
        check(skill.includes(`references/legacy/${source}.md`), `${tree}:${mode.mode} does not use its package-local ${source} module`);
        if (fs.existsSync(localModule) && fs.existsSync(canonicalModule)) {
          check(sha256(fs.readFileSync(localModule)) === sha256(fs.readFileSync(canonicalModule)), `${tree}:${mode.mode} dependency copy drifted for ${source}`);
        }
      }
    }
    const packagedModules = files(path.join(ROOT, 'skills', tree, 'references', 'legacy'), '.md');
    for (const moduleName of packagedModules) {
      const modulePath = path.join(ROOT, 'skills', tree, 'references', 'legacy', moduleName);
      const module = fs.readFileSync(modulePath, 'utf8');
      check(
        !/(?:~\/\.claude\/skills\/gstack|\$GSTACK_ROOT)\/[a-z0-9-]+\/SKILL\.md|\$\{?CLAUDE_SKILL_DIR\}?\/\.\.\/[a-z0-9-]+\/SKILL\.md/.test(module),
        `${tree}/${moduleName} still reaches another host or source checkout for a skill`,
      );
      check(!/GSTACK_ROOT="\$HOME\/\.(?:claude|codex)\/skills\/gstack"/.test(module), `${tree}/${moduleName} still binds runtime state to a host skill directory`);
      check(!/(?:\$HOME\/|\$_ROOT\/|^)\.agents\/skills\/gstack\/(?:bin|browse|design|make-pdf|lib|extension)/m.test(module), `${tree}/${moduleName} still resolves a runtime capability through host placement`);
      check(
        !/(?:\$\{GSTACK_HOME:-\$HOME\/\.gstack\}|\$GSTACK_STATE_ROOT|\$\{GSTACK_STATE_ROOT\}|\$GSTACK_HOME)[^\n]{0,16}\/projects\/(?:\$\{SLUG|\$SLUG\b|\$_PLAN_SLUG\b|<slug>|\{slug\})/.test(module),
        `${tree}/${moduleName} still keys worktree-local state by repository slug`,
      );
      check(!/~\/\.gstack(?:\/|(?=[\s`'"),.;:\]}]))/.test(module), `${tree}/${moduleName} bypasses GSTACK_HOME with a literal state path`);
      check(!/"\$HOME\/\.gstack(?:\/|")/.test(module), `${tree}/${moduleName} bypasses GSTACK_HOME with a quoted HOME state path`);
      check(!/\$\{HOME\}\/\.gstack(?:\/|(?=[\s`'"),.;:\]}]))/.test(module), `${tree}/${moduleName} bypasses GSTACK_HOME with a braced HOME state path`);
      check(!/(?<![-"{])\$HOME\/\.gstack(?:\/|(?=[\s`'"),.;:\]}]))/.test(module), `${tree}/${moduleName} bypasses GSTACK_HOME with an unquoted HOME state path`);
      if (module.includes('GSTACK_BIN=')) check(module.includes('GSTACK_HOME="${GSTACK_HOME:-$HOME/.gstack}"'), `${tree}/${moduleName} lacks the host-neutral runtime root`);
      for (const match of module.matchAll(/(?:^|[\s`(])((?:references\/(?:legacy|sections|support|artifacts)|assets)\/[A-Za-z0-9_.\/-]+)/g)) {
        const relative = match[1].replace(/[.,;:]+$/, '');
        check(fs.existsSync(path.join(ROOT, 'skills', tree, relative)), `${tree}/${moduleName} has an unpackaged local reference: ${relative}`);
      }
    }
  }
  const systemFunctionalPath = path.join(ROOT, 'skills', 'qa', 'references', 'SYSTEM-FUNCTIONAL.md');
  check(fs.existsSync(systemFunctionalPath), 'QA lacks the system-functional execution adapter');
  if (fs.existsSync(systemFunctionalPath)) {
    const adapter = fs.readFileSync(systemFunctionalPath, 'utf8');
    check(
      adapter.includes('Report mode reads `qa-only` and never changes product code')
        && adapter.includes('`investigate` proves root cause')
        && adapter.includes('rerun the exact failing probe'),
      'System-functional adapter lost preserved report/fix, root-cause, or exact re-verification behavior',
    );
    for (const source of ['devex-review', 'qa-only', 'qa', 'investigate']) {
      check(fs.existsSync(path.join(ROOT, 'skills', 'qa', 'references', 'legacy', `${source}.md`)), `System-functional QA package lacks preserved ${source}`);
    }
    check(adapter.includes('API, CLI command, backend job, worker, queue consumer, webhook'), 'System-functional adapter does not cover the required non-browser surfaces');
  }
  check(fs.readFileSync(path.join(ROOT, 'skills', 'qa', 'SKILL.md'), 'utf8').includes('references/SYSTEM-FUNCTIONAL.md'), 'QA dispatcher does not load system-functional when activated');
  for (const tree of TREE_NAMES) {
    const dispatcher = fs.readFileSync(path.join(ROOT, 'skills', tree, 'SKILL.md'), 'utf8');
    const authority = path.join(ROOT, 'skills', tree, 'references', 'AUTHORITY-POLICY.md');
    check(fs.existsSync(authority), `${tree} lacks the executable authority/evidence policy`);
    check(dispatcher.includes('references/AUTHORITY-POLICY.md'), `${tree} dispatcher does not load the authority/evidence policy`);
  }
  const effectsPath = path.join(ROOT, 'skills', 'ship', 'references', 'EXTERNAL-EFFECTS.md');
  check(fs.existsSync(effectsPath), 'Ship lacks the durable external-effect protocol');
  if (fs.existsSync(effectsPath)) {
    const effects = fs.readFileSync(effectsPath, 'utf8');
    check(effects.includes('gstack state effect') && effects.includes('Never retry automatically'), 'Ship external-effect protocol lost durable claim or no-repeat behavior');
  }
  check(fs.readFileSync(path.join(ROOT, 'skills', 'ship', 'SKILL.md'), 'utf8').includes('references/EXTERNAL-EFFECTS.md'), 'Ship dispatcher does not bind external actions to durable state');

  check(files(path.join(ROOT, 'evals', 'parity', 'contracts'), '.json').length === 55, 'Contract fixture count is not 55');
  const baselineRenders = json(path.join(ROOT, 'evals', 'parity', 'baseline-render-hashes.json'));
  check(baselineRenders.base_sha === GSTACK2_BASE_SHA, 'Immutable rendered-baseline SHA mismatch');
  for (const assignment of SOURCE_ASSIGNMENTS) {
    const baseBlob = sourceBlobSha(assignment.source);
    const baselineBody = normalizeGolden(renderLegacyBody(assignment.source));
    const expectedBody = normalizeGolden(renderPortedLegacyBody(assignment.source));
    const immutableRenderHash = baselineRenders.sources[assignment.source];
    if (immutableRenderHash == null) {
      check(assignment.source === 'codex', `${assignment.source} unexpectedly lacks an immutable Codex render`);
    } else {
      check(sha256(baselineBody) === immutableRenderHash, `${assignment.source} current resolver output drifted from the immutable base render`);
    }
    const modulePath = path.join(ROOT, 'skills', assignment.tree, 'references', 'legacy', `${assignment.source}.md`);
    const module = fs.readFileSync(modulePath, 'utf8');
    const generatedBody = extractLegacyBody(module, assignment.source);
    const legacyMarker = `<!-- GSTACK2_LEGACY_BODY_START source=${assignment.source} -->`;
    const prelude = module.slice(0, module.indexOf(legacyMarker));
    check(!/^\s*#{1,6}\s|^\s*[-*]\s|^\s*\d+\.\s/m.test(prelude), `${assignment.source} has visible generated prose before preserved judgment`);
    check(prelude.split('\n').length <= 5, `${assignment.source} generated prelude is not thin`);
    check(generatedBody === expectedBody, `${assignment.source} normalized legacy body differs`);
    check(module.includes(`blob=${baseBlob}`), `${assignment.source} module lacks source blob provenance`);
    check(module.includes(`baseline_render_sha256=${sha256(baselineBody)}`), `${assignment.source} module lacks immutable baseline render hash`);
    check(module.includes(`ported_render_sha256=${sha256(expectedBody)}`), `${assignment.source} module lacks installable port render hash`);
    const contract = json(path.join(ROOT, 'evals', 'parity', 'contracts', `${assignment.source}.json`));
    check(contract.base_sha === GSTACK2_BASE_SHA && contract.blob_sha === baseBlob, `${assignment.source} contract provenance mismatch`);
    check(JSON.stringify(Object.keys(contract.contract).sort()) === JSON.stringify([...CONTRACT_KEYS].sort()), `${assignment.source} contract dimensions mismatch`);
    check(JSON.stringify(contract.contract) === JSON.stringify(contractFor(assignment)), `${assignment.source} contract content mismatch`);
    for (const overlay of overlaysForSource(assignment.source)) {
      check(module.includes(`anchor=${overlay.anchor}`), `${assignment.source} is missing PR #${overlay.pr} anchor`);
      check(module.includes(overlay.body), `${assignment.source} is missing PR #${overlay.pr} judgment body`);
    }
  }

  const sections = legacySections();
  check(sections.length === 16, `Expected 16 section templates; got ${sections.length}`);
  for (const section of sections) {
    check(blobShaForPath(section.relativePath) === json(path.join(ROOT, 'docs', 'gstack-2', 'JUDGMENT-PROVENANCE.json')).sections.find((item: any) => item.source_path === section.relativePath)?.blob_sha, `${section.relativePath} blob provenance mismatch`);
    const assignment = SOURCE_ASSIGNMENTS.find((entry) => entry.source === section.source)!;
    const module = fs.readFileSync(path.join(ROOT, 'skills', assignment.tree, 'references', 'legacy', `${assignment.source}.md`), 'utf8');
    const portedSection = renderPortedLegacySection(section);
    check(module.includes(portedSection.trim()), `${section.relativePath} was not mechanically inlined`);
    const sectionName = path.basename(section.relativePath).replace(/\.tmpl$/, '');
    const packaged = path.join(ROOT, 'skills', assignment.tree, 'references', 'sections', section.source, sectionName);
    check(fs.existsSync(packaged), `${section.relativePath} is referenced but not packaged`);
    if (fs.existsSync(packaged)) check(normalizeGolden(fs.readFileSync(packaged, 'utf8')) === normalizeGolden(portedSection), `${section.relativePath} packaged content drifted`);
  }

  check(SCENARIOS.length === 25, `Expected 25 scenarios; got ${SCENARIOS.length}`);
  check(files(path.join(ROOT, 'evals', 'parity', 'scenarios'), '.json').length === 25, 'Generated scenario fixture count is not 25');
  for (const scenario of SCENARIOS) {
    const routed = routeStructured(scenario.signals);
    const expectedRoute = {
      tree: scenario.expected.tree,
      mode: scenario.expected.mode,
      depth: scenario.expected.depth,
      mutation: scenario.expected.mutation,
      active_modules: scenario.expected.active_modules,
      skipped_modules: scenario.expected.skipped_modules,
      web_context: scenario.expected.web_context,
    };
    check(JSON.stringify(routed) === JSON.stringify(expectedRoute), `${scenario.id} structured route mismatch`);
    check(scenario.expected.decision_basis.length > 0, `${scenario.id} lacks routing evidence`);
    check(JSON.stringify(json(path.join(ROOT, 'evals', 'parity', 'scenarios', `${scenario.id}.json`))) === JSON.stringify(scenario), `${scenario.id} generated fixture drift`);
  }

  check(BUG_FIX_OVERLAYS.length === 16, `Expected 16 regression definitions; got ${BUG_FIX_OVERLAYS.length}`);
  check(files(path.join(ROOT, 'evals', 'parity', 'regressions'), '.json').length === 16, 'Generated regression fixture count is not 16');
  for (const overlay of BUG_FIX_OVERLAYS) {
    const fixture = json(path.join(ROOT, 'evals', 'parity', 'regressions', `pr-${overlay.pr}.json`));
    check(JSON.stringify(fixture) === JSON.stringify(overlay), `PR #${overlay.pr} regression fixture drift`);
    check(Object.keys(overlay.regression.input).length > 0 && Object.keys(overlay.regression.expected).length > 0, `PR #${overlay.pr} regression is empty`);
    check(
      JSON.stringify(evaluateBugFixRegression(overlay.pr, fixture.regression.input)) === JSON.stringify(fixture.regression.expected),
      `PR #${overlay.pr} executable replacement regression failed`,
    );
  }

  const manifest = json(path.join(ROOT, 'evals', 'parity', 'manifest.json'));
  const provenance = json(path.join(ROOT, 'docs', 'gstack-2', 'JUDGMENT-PROVENANCE.json'));
  check(JSON.stringify(manifest) === JSON.stringify(provenance), 'Eval manifest and judgment provenance differ');
  check(manifest.base_sha === GSTACK2_BASE_SHA, 'Provenance base SHA mismatch');
  const helperClosure = json(path.join(ROOT, 'evals', 'parity', 'runtime-helper-closure.json'));
  check(JSON.stringify(helperClosure.helpers) === JSON.stringify(manifest.runtime_helpers), 'Runtime helper closure and provenance differ');
  for (const helper of helperClosure.helpers) {
    const sourcePath = helper.platform_source_paths?.[process.platform === 'win32' ? 'win32' : 'posix']
      ?? helper.source_path;
    check(fs.existsSync(path.join(ROOT, sourcePath)), `Preserved helper ${helper.name} has no source payload at ${sourcePath}`);
    check(Array.isArray(helper.consumer_modules) && helper.consumer_modules.length > 0, `Preserved helper ${helper.name} has no consumer provenance`);
  }
  for (const record of [...manifest.sources, ...manifest.sections]) {
    check(ALLOWED_DISPOSITIONS.has(record.disposition), `${record.source_path} uses invalid disposition ${record.disposition}`);
    for (const key of PROVENANCE_KEYS) check(record[key] !== undefined, `${record.source_path} lacks provenance field ${key}`);
  }
  for (const asset of manifest.assets) {
    const target = path.join(ROOT, asset.target_path);
    check(fs.existsSync(target), `Missing relocated asset ${asset.target_path}`);
    const baseline = Bun.spawnSync({
      cmd: ['git', 'show', `${GSTACK2_BASE_SHA}:${asset.source_path}`],
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    check(baseline.exitCode === 0, `Unable to read pinned asset ${asset.source_path}`);
    if (baseline.exitCode === 0) {
      const expected = renderPortedAssetBytes(asset.source_path, baseline.stdout);
      const expectedDisposition = sha256(expected) === sha256(baseline.stdout) ? 'VERBATIM_PORT' : 'MECHANICAL_PORT';
      check(asset.blob_sha === blobShaForPath(asset.source_path), `Relocated asset blob provenance mismatch: ${asset.target_path}`);
      check(asset.baseline_sha256 === sha256(baseline.stdout), `Relocated asset baseline hash mismatch: ${asset.target_path}`);
      check(asset.sha256 === sha256(expected), `Relocated asset port hash mismatch: ${asset.target_path}`);
      check(asset.disposition === expectedDisposition, `Relocated asset disposition mismatch: ${asset.target_path}`);
      if (fs.existsSync(target)) {
        const installed = fs.readFileSync(target);
        check(sha256(installed) === sha256(expected), `Relocated asset hash mismatch: ${asset.target_path}`);
        if (asset.target_path.endsWith('.md')) {
          check(!/~\/.claude\/skills\/gstack|browse\/bin\/remote-slug/.test(installed.toString()), `Relocated asset retains a host-specific runtime path: ${asset.target_path}`);
        }
      }
    }
  }
  for (const sectionCopy of manifest.section_copies ?? []) {
    const target = path.join(ROOT, sectionCopy.target_path);
    check(fs.existsSync(target), `Missing packaged section ${sectionCopy.target_path}`);
    if (fs.existsSync(target)) check(sha256(fs.readFileSync(target)) === sectionCopy.sha256, `Packaged section hash mismatch: ${sectionCopy.target_path}`);
  }
  for (const dependency of manifest.dependency_copies ?? []) {
    const target = path.join(ROOT, dependency.target);
    check(fs.existsSync(target), `Missing transitive module copy ${dependency.target}`);
    if (fs.existsSync(target)) check(sha256(fs.readFileSync(target)) === dependency.sha256, `Transitive module copy drift: ${dependency.target}`);
  }

  check(files(path.join(ROOT, 'compat'), '.md').length === 56, 'Compatibility alias file count is not 55 + README');
  const migrationMap = json(path.join(ROOT, 'compat', 'migration-map.json'));
  check(migrationMap.schema_version === 1, 'Compatibility migration map schema mismatch');
  check(migrationMap.aliases.length === 55, 'Compatibility migration map must contain 55 aliases');
  check(migrationMap.policy.default_discoverable === false, 'Compatibility aliases must be opt-in');
  check(
    migrationMap.policy.context_choice_migrated_implicitly === false &&
      migrationMap.policy.context_consent_migrated_implicitly === false,
    'Compatibility migration must not infer Context choice or consent',
  );
  for (const assignment of SOURCE_ASSIGNMENTS) {
    const aliasPath = path.join(ROOT, 'skills', '.compat', assignment.source, 'SKILL.md');
    const needsAlias = !(TREE_NAMES as readonly string[]).includes(assignment.source);
    check(fs.existsSync(aliasPath) === needsAlias, needsAlias
      ? `Missing opt-in compatibility alias for ${assignment.source}`
      : `Redundant compatibility alias collides with canonical ${assignment.source}`);
    if (fs.existsSync(aliasPath)) {
      const alias = fs.readFileSync(aliasPath, 'utf8');
      check(alias.includes(assignment.replacement), `${assignment.source} alias lacks exact replacement invocation`);
      check(alias.includes('internal: true'), `${assignment.source} alias must stay out of default discovery`);
      check(!alias.includes('GSTACK2_LEGACY_BODY_START'), `${assignment.source} alias copied specialist judgment`);
      check(alias.split('\n').length < 30, `${assignment.source} alias is not thin`);
    }
  }
  for (const tree of TREE_NAMES) {
    const compatibility = fs.readFileSync(path.join(ROOT, 'skills', tree, 'references', 'COMPATIBILITY.md'), 'utf8');
    check(!compatibility.includes('../../../') && !compatibility.includes('compat/README.md'), `${tree} compatibility map escapes the selected package`);
    for (const reference of ['SHARED-JUDGMENT.md', 'WEB-CONTEXT.md']) {
      const referencePath = path.join(ROOT, 'skills', tree, 'references', reference);
      check(fs.existsSync(referencePath), `${tree} lacks ${reference}`);
      if (fs.existsSync(referencePath)) {
        check(
          /^<!-- GENERATED[^\n]* -->\n# /.test(fs.readFileSync(referencePath, 'utf8')),
          `${tree}/${reference} must separate the generated marker from its Markdown heading`,
        );
      }
    }
  }
  for (const required of ['SKILL-MIGRATION.md', 'JUDGMENT-PROVENANCE.json', 'JUDGMENT-PARITY.md', 'SCENARIOS.md']) {
    check(fs.existsSync(path.join(ROOT, 'docs', 'gstack-2', required)), `Missing docs/gstack-2/${required}`);
  }

  if (checks !== EXPECTED_PARITY_CHECKS) {
    failures.push(`Parity check inventory changed: expected ${EXPECTED_PARITY_CHECKS}, observed ${checks}`);
  }
  if (failures.length) {
    throw new Error(`GStack 2 parity failed (${failures.length}/${checks} checks):\n- ${failures.join('\n- ')}`);
  }
  return {
    checks,
    sources: SOURCE_ASSIGNMENTS.length,
    sections: sections.length,
    scenarios: SCENARIOS.length,
    regressions: BUG_FIX_OVERLAYS.length,
    assets: manifest.assets.length,
  };
}

if (import.meta.main) {
  const result = runParity();
  process.stdout.write(`GStack 2 parity passed: ${result.checks} checks; ${result.sources} sources, ${result.sections} sections, ${result.scenarios} scenarios, ${result.regressions} regressions, ${result.assets} assets.\n`);
}
