import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ALL_HOST_CONFIGS } from '../hosts';
import { runGeneration, type GenerationResult } from '../scripts/gen-skill-docs';
import { discoverSectionTemplates } from '../scripts/discover-skills';
import { SECTION, SECTION_INDEX, sectionPath, usesLazySections } from '../scripts/resolvers/sections';
import { generateQAMethodReads, generateQAResource } from '../scripts/resolvers/qa';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { runBashScript } from './helpers/bash-script';
import { PARITY_INVARIANTS, runParityChecks } from './helpers/parity-harness';
import { expectMentions, expectTokens } from './helpers/prompt-structure';

const ROOT = path.resolve(import.meta.dir, '..');
const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-qa-sections-'));
const rendered = path.join(owned, 'rendered');
const setup = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');
const QA_SKILLS = ['qa', 'qa-only'];
const REPORT_TEMPLATE = fs.readFileSync(path.join(ROOT, 'qa/templates/functional-report-template.md'), 'utf8');
const GENERATED_REPORT = '<!-- AUTO-GENERATED from qa/templates/functional-report-template.md — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\n' + REPORT_TEMPLATE;
let generated: GenerationResult;
let fixture: typeof import('../scripts/resolvers/sections');

function put(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function context(host: string, skillName: string): TemplateContext {
  return { host, skillName, tmplPath: '', paths: HOST_PATHS[host] };
}

function setupFunction(name: string): string {
  const start = setup.indexOf(`${name}() {`);
  const end = setup.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Missing setup function ${name}`);
  return setup.slice(start, end + 2);
}

beforeAll(async () => {
  generated = await runGeneration({ host: 'all', outputRoot: rendered });
  expect(generated.exitCode, JSON.stringify(generated.diagnostics)).toBe(0);
  const fixtureRoot = path.join(owned, 'fixture');
  put(path.join(fixtureRoot, 'scripts/resolvers/sections.ts'), fs.readFileSync(path.join(ROOT, 'scripts/resolvers/sections.ts'), 'utf8'));
  for (const skill of [...QA_SKILLS, 'ship']) {
    put(path.join(fixtureRoot, skill, 'sections/manifest.json'), JSON.stringify({
      skill, sections: [{ id: 'native', file: 'contract-probes.md', title: 'Native probes', trigger: 'probing a native contract' }],
    }));
    put(path.join(fixtureRoot, skill, 'sections/contract-probes.md.tmpl'), 'PRIVATE_SECTION_BODY\n{{INVOKE_SKILL:investigate}}\n');
  }
  fixture = await import(path.join(fixtureRoot, 'scripts/resolvers/sections.ts'));
}, 120_000);

afterAll(() => fs.rmSync(owned, { recursive: true, force: true }));

describe('QA-only cross-host lazy rendering', () => {
  test('Codex review defines omitted-Army records without waiving native or QA completion', () => {
    const codex = ALL_HOST_CONFIGS.find(host => host.name === 'codex')!;
    const text = fs.readFileSync(path.join(rendered, codex.hostSubdir, 'skills/gstack-review/SKILL.md'), 'utf8');
    const record = text.slice(text.indexOf('## Step 5.8: Persist Eng Review result')).replace(/\s+/g, ' ');
    expect(text).not.toContain('### Dispatch specialists');
    expect(text).not.toContain('### Step 4.6: Collect and merge findings');
    expect(text).not.toContain('SPECIALIST REVIEW: N findings');
    expectTokens(record, ['`specialists: {}`'], 'record');
    expectMentions(record, [['without', 'specialist', 'claiming']], 'record');
    expect(record).toContain('`10.0` when small-diff specialists were skipped or this host omits Review Army');
    expectMentions(record, [['not', 'completion', 'evidence']], 'record');
    expectMentions(record, [['not', 'inconclusive', 'required']], 'record');
    expect(record).toContain('`/ship` named-risk acceptance cannot complete `/review`');
    expectTokens(record, ['`issues_found`'], 'record');
    expect(record).toContain('State INCOMPLETE if `COMPLETED` is false, even when N=0');
  });

  for (const host of ALL_HOST_CONFIGS) {
    test(`${host.name} review loads QA methods before static review and reuses them before probes`, () => {
      const directory = host.name === 'claude' ? 'review' : `${host.hostSubdir}/skills/gstack-review`;
      const text = fs.readFileSync(path.join(rendered, directory, 'SKILL.md'), 'utf8');
      const start = text.indexOf('## Step 4: Critical pass (core review)');
      const core = text.indexOf('Apply both checklist passes in order', start);
      const exploration = text.indexOf('### Step 4.7: Exploratory QA', core);
      expect(start).toBeGreaterThan(-1);
      expect(core).toBeGreaterThan(start);
      expect(exploration).toBeGreaterThan(core);
      const preparation = text.slice(start, core);
      const loop = preparation.indexOf('sections/exploratory.md');
      expect(loop).toBeGreaterThan(-1);
      expect(preparation).toContain('Step 4 is read-only: defer charters, setup and probes to Step 4.7');
      expect(preparation).not.toContain('sections/system-functional.md');
      const qaDirectory = host.name === 'claude' ? 'qa' : `${host.hostSubdir}/skills/gstack-qa`;
      const shared = fs.readFileSync(path.join(rendered, qaDirectory, 'sections/exploratory.md'), 'utf8');
      const scope = shared.indexOf('Read `sections/scope.md`');
      const selection = shared.indexOf('in full and select the surfaces');
      const methods = shared.indexOf('Read `sections/system-functional.md`');
      expect(scope).toBeGreaterThan(-1);
      expect(selection).toBeGreaterThan(scope);
      expect(methods).toBeGreaterThan(selection);
      expect(shared).toContain('**Browser surfaces only:**');
      expect(preparation).not.toContain('sections/browser-setup.md');
      expect(shared).toContain('sections/qa-patterns.md');
      expect(preparation.replace(/\s+/g, ' ')).toContain('Step 4 is read-only: defer charters, setup and probes to Step 4.7');
      expect(shared.indexOf('Write a **charter**')).toBeGreaterThan(methods);
      expectMentions(shared, [['do not', 'invocation', 'completed']], 'shared');
      const qa = text.slice(exploration, text.indexOf('## Step 5: Fix-First Review', exploration));
      const charter = qa.indexOf('**1. Set the charter and isolation.**');
      const readiness = qa.indexOf('**2. Check readiness and list required checks.**');
      const setup = qa.indexOf("Read QA's `sections/browser-setup.md`");
      const probes = qa.indexOf('**3. Run smoke and plan checks.**');
      expect(charter).toBeGreaterThan(-1);
      expect(readiness).toBeGreaterThan(charter);
      expect(setup).toBeGreaterThan(readiness);
      expect(probes).toBeGreaterThan(setup);
      expectMentions(qa.slice(charter, readiness).replace(/\s+/g, ' '), [['before', 'isolation/permission', 'preflight']], 'section');
      const flat = qa.replace(/\s+/g, ' ');
      expectMentions(flat, [['only', 'tools/session/target/ownership', 'otherwise']], 'flat');
      expectMentions(flat, [['never', 'bootstrap', 'install']], 'flat');
      expect(flat).toContain('Functional-only skips browser setup');
      if (usesLazySections(host.name, 'review')) {
        const index = text.slice(text.indexOf('## Section index'), text.indexOf('## Step 1:'));
        expect(index.indexOf('Select surfaces and read QA methods')).toBeLessThan(index.indexOf('sections/review-army.md'));
      } else {
        expect(text).not.toContain('## Section index');
      }
    });

    for (const skill of QA_SKILLS) {
      test(`${host.name} ${skill} resolves a passive manifest without inlining its body`, () => {
        const ctx = context(host.name, skill);
        expect(usesLazySections(host.name, skill)).toBe(true);
        const reference = fixture.sectionPath(ctx, skill, 'native');
        expect(reference).toContain('`sections/contract-probes.md`');
        expect(reference).toContain('installed');
        expect(reference).toContain('SKILL.md directory');
        expect(reference).toContain(host.name === 'claude' ? `\`${skill}\`` : `\`gstack-${skill}\``);
        const pointer = fixture.SECTION(ctx, ['native']);
        expect(pointer).toContain(reference);
        expect(pointer).toContain('probing a native contract');
        expect(pointer).toContain('never the product working directory');
        expect(pointer).toContain('missing or unreadable');
        expect(pointer).toContain('QA setup blocker');
        expect(pointer).not.toContain('PRIVATE_SECTION_BODY');
        expect(pointer).not.toContain('$GSTACK_ROOT');
        expect(fixture.SECTION_INDEX(ctx)).toContain(reference);
        expect(fixture.SECTION_INDEX(context(host.name, 'ship'), [skill])).toContain(reference);
        expect(fixture.sectionPath(context(host.name, 'review'), skill, 'native')).toBe(reference);
        expect(fixture.sectionPath(context(host.name, 'ship'), skill, 'native')).toBe(reference);
      });
    }

    test(`${host.name} generates all QA section templates and preserves other skills' section policy`, () => {
      const sections = discoverSectionTemplates(ROOT);
      const targets = sections.filter(section => QA_SKILLS.includes(section.skillDir));
      expect(targets.length).toBeGreaterThan(0);
      for (const section of targets) {
        const dir = host.name === 'claude' ? section.skillDir : `${host.hostSubdir}/skills/gstack-${section.skillDir}`;
        const file = `${dir}/sections/${path.basename(section.output)}`;
        expect(generated.artifacts).toContainEqual({ relativePath: file, kind: 'section', host: host.name });
        const body = fs.readFileSync(path.join(rendered, file), 'utf8');
        expect(body).toContain('AUTO-GENERATED');
        expect(body).not.toMatch(/\{\{[A-Z_]+(?::[^}]*)?\}\}/);
        expect(fs.readFileSync(path.join(rendered, dir, 'SKILL.md'), 'utf8')).not.toContain(body.split('\n').slice(2).join('\n').trim());
      }
      const outside = generated.artifacts.filter(artifact => artifact.host === host.name && artifact.kind === 'section'
        && !/^(?:qa|qa-only|ship|plan-ceo-review|office-hours)\//.test(artifact.relativePath)
        && !/\/gstack-(?:qa(?:-only)?|ship|plan-ceo-review|office-hours)\//.test(artifact.relativePath));
      expect(outside.length > 0).toBe(host.name === 'claude');
      // C4: ship is carved on every host; external pointers are relative to the installed skill.
      const ctx = context(host.name, 'ship');
      const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'ship/sections/manifest.json'), 'utf8'));
      const entry = manifest.sections[0];
      expect(usesLazySections(host.name, 'ship')).toBe(true);
      const pointer = host.name === 'claude'
        ? `\`~/.claude/skills/gstack/ship/sections/${entry.file}\``
        : `\`sections/${entry.file}\` relative to the installed \`gstack-ship\` SKILL.md directory`;
      expect(SECTION(ctx, [entry.id])).toBe(`> **STOP.** Before ${entry.trigger}, Read ${pointer} and execute it\n> in full. Do not work from memory — that section is the source of truth for this step.`);
      // Skills carved only on Claude still inline their sections elsewhere.
      const reviewCtx = context(host.name, 'review');
      const reviewEntry = JSON.parse(fs.readFileSync(path.join(ROOT, 'review/sections/manifest.json'), 'utf8')).sections[0];
      expect(usesLazySections(host.name, 'review')).toBe(host.name === 'claude');
      if (host.name !== 'claude') {
        expect(SECTION(reviewCtx, [reviewEntry.id])).toBe(fs.readFileSync(path.join(ROOT, 'review/sections', `${reviewEntry.file}.tmpl`), 'utf8').trimEnd());
        expect(SECTION_INDEX(reviewCtx)).toBe('');
      }
    });

    test(`${host.name} packages the authored functional report beside the QA entrypoint`, () => {
      const dir = host.name === 'claude' ? 'qa' : `${host.hostSubdir}/skills/gstack-qa`;
      const relativePath = `${dir}/templates/functional-report-template.md`;
      expect(generated.artifacts.find(artifact => artifact.relativePath === relativePath))
        .toEqual({ relativePath, kind: 'asset', host: host.name });
      expect(fs.readFileSync(path.join(rendered, relativePath), 'utf8'))
        .toBe(host.name === 'claude' ? REPORT_TEMPLATE : GENERATED_REPORT);
    });

    test(`${host.name} qa-only reads shared browser setup directly without a redirect section`, () => {
      const dir = host.name === 'claude' ? 'qa-only' : `${host.hostSubdir}/skills/gstack-qa-only`;
      const entry = fs.readFileSync(path.join(rendered, dir, 'SKILL.md'), 'utf8');
      const browserRead = generateQAResource(context(host.name, 'qa-only'), ['browser-setup']);
      expect(entry).toContain(browserRead);
      expect(entry.indexOf('**Browser surface only:**')).toBeLessThan(entry.indexOf(browserRead));
      expect(browserRead).toContain(sectionPath(context(host.name, 'qa-only'), 'qa', 'browser-setup'));
      expect(browserRead).toContain("this host's installed caller skill");
      expect(browserRead).toContain('No product-directory or cross-host substitutes');
      expect(browserRead).toContain('Missing/unreadable assets block required QA');
      expect(browserRead).toContain('continue other safe probes');
      expect(generated.artifacts.some(artifact => artifact.relativePath === `${dir}/sections/browser-setup.md`)).toBe(false);
      const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'qa-only/sections/manifest.json'), 'utf8'));
      expect(manifest.sections.some((section: { id: string }) => section.id === 'browser-setup')).toBe(false);
      for (const name of ['browser-setup.md.tmpl', 'browser-setup.md']) {
        expect(fs.existsSync(path.join(ROOT, 'qa-only/sections', name))).toBe(false);
      }
    });

    test(`${host.name} both QA entrypoints reach shared functional modes before probes`, () => {
      const qaDirectory = host.name === 'claude' ? 'qa' : `${host.hostSubdir}/skills/gstack-qa`;
      const functional = fs.readFileSync(path.join(rendered, qaDirectory, 'sections/system-functional.md'), 'utf8');
      const modes = functional.slice(functional.indexOf('## Functional modes'), functional.indexOf('## Contract map'));
      for (const contract of [
        '**Full** (default)', 'every applicable documented contract', '**Quick** (`--quick`)',
        'success and the highest-risk changed edge', 'contracts not run',
        '**Regression** (`--regression <previous-report>`)', 'before probes, read the supplied',
        'functional report and linked replay evidence', 'missing, unreadable or wrong-target',
        'baseline blocks regression mode', 'browser-only `baseline.json` is not a functional',
        'Re-establish owned setup', 'replay prior failed probes against the documented',
        'never recorded buggy output', 'changed adjacent behavior', 'Preserve the prior report',
        'fixed, still failing and new findings', 'Missing safe replay inputs block affected probes',
        'never count as passes', "Mixed runs apply each surface's mode separately",
        "bounded smoke and explicit plan checks, not Full exploration",
      ]) expect(modes).toContain(contract);
      expect(functional.indexOf('## Functional modes')).toBeLessThan(functional.indexOf('## Execute and retain evidence'));
      for (const skill of QA_SKILLS) {
        const dir = host.name === 'claude' ? skill : `${host.hostSubdir}/skills/gstack-${skill}`;
        const entry = fs.readFileSync(path.join(rendered, dir, 'SKILL.md'), 'utf8');
        expect(entry).toContain('| Mode | full | `--quick`, `--regression <previous-report-or-baseline>` |');
        expect(entry).toContain(sectionPath(context(host.name, skill), skill, 'exploratory'));
        expect(entry).not.toContain('## Functional modes');
        const explorer = fs.readFileSync(path.join(rendered, dir, 'sections/exploratory.md'), 'utf8');
        const functionalRead = 'Read `sections/system-functional.md` in full.';
        expect(entry).not.toContain(functionalRead);
        expect(entry).toContain(skill === 'qa' ? "Follow the shared section's ordered preparation" : 'Load the shared preparation gate now');
        expect(explorer).toContain(generateQAMethodReads(context(host.name, skill)));
        const stages = ['1. Read `sections/scope.md`', 'in full and select the surfaces', functionalRead,
          'Read `sections/qa-patterns.md` in full.', 'Write a **charter**', '1. First demonstrate success'];
        const positions = stages.map(stage => explorer.indexOf(stage));
        expect(positions.every(position => position >= 0)).toBe(true);
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
        expect(explorer.split(functionalRead)).toHaveLength(2);
        expectMentions(explorer, [['do not', 'invocation', 'completed']], 'explorer');
        if (skill === 'qa') {
          expect(entry).toMatch(/`--quick`[^\n]*Quick exploration/i);
          expect(entry).toContain('`--exhaustive` changes only the fix tier');
          for (const tier of ['**Quick:** Fix critical + high severity only', '**Standard:** + medium severity (default)', '**Exhaustive:** + low/cosmetic severity']) expect(entry).toContain(tier);
        } else {
          expectMentions(entry, [['never', 'product', 'write']], 'entry');
          const browserSetup = entry.indexOf('## Browser Setup (conditional)');
          const selectedChecks = entry.indexOf('## Run the Selected Checks');
          expect(browserSetup).toBeGreaterThan(0);
          expect(selectedChecks).toBeGreaterThan(browserSetup);
          expect(entry.lastIndexOf(sectionPath(context(host.name, skill), skill, 'exploratory'))).toBeLessThan(browserSetup);
          expect(entry.slice(browserSetup, selectedChecks)).not.toContain(functionalRead);
          expectMentions(entry, [['do not', 'preparation', 'section']], 'entry');
          expect(entry).toContain('Defer charters, clocks and probes to');
          expectMentions(explorer, [['before', 'complete', 'charters']], 'explorer');
          expect(explorer).toContain('## 3. Parent handoff');
          expect(explorer).toContain('Return test_stub proposals');
          expectMentions(explorer, [['never', 'create', 'freeze']], 'explorer');
          expect(explorer).not.toMatch(/before repair|For \/review and \/ship|every new \/ship/);
        }
      }
      const browser = fs.readFileSync(path.join(rendered, qaDirectory, 'sections/qa-patterns.md'), 'utf8');
      expect(browser).toContain('### Regression (`--regression <baseline>`)');
      expect(browser).not.toContain('## Functional modes');
    });

    test(`${host.name} caller-relative QA resources resolve within the generated installation`, () => {
      const base = host.name === 'claude' ? rendered : path.join(rendered, host.hostSubdir, 'skills');
      const prefix = host.name === 'claude' ? '' : 'gstack-';
      for (const caller of ['review', 'ship']) {
        const dir = path.join(base, `${prefix}${caller}`);
        const body = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
          + (caller === 'ship' // C4: ship is carved on every host
            ? fs.readFileSync(path.join(dir, 'sections/review-army.md'), 'utf8') : '');
        expect(body).toContain(`From the installed /${caller} SKILL.md's directory`);
        expect(body).toContain(`Read \`../${prefix}qa/sections/exploratory.md\` in full`);
        const scopeTarget = path.resolve(dir, `../${prefix}qa/sections/scope.md`);
        expect(fs.realpathSync(scopeTarget)).toBe(path.join(base, `${prefix}qa/sections/scope.md`));
        const target = path.resolve(dir, `../${prefix}qa/sections/exploratory.md`);
        expect(fs.realpathSync(target)).toBe(path.join(base, `${prefix}qa/sections/exploratory.md`));
        expect(fs.readFileSync(target, 'utf8')).toContain('# Shared exploratory QA');
        expect(fs.readFileSync(target, 'utf8')).toContain(sectionPath(context(host.name, 'qa'), 'qa', 'scope'));
        expect(fs.readFileSync(scopeTarget, 'utf8')).toContain('Select **browser**, **functional**');
        if (host.name === 'claude') {
          expect(body).toContain(`If the caller directory is prefixed \`gstack-${caller}\``);
          expect(body).toContain('use `../gstack-qa/sections/exploratory.md` instead');
          if (caller === 'review') {
            expectMentions(body, [['do not', 'installation', 'unresolved']], 'body');
            expectMentions(body, [['never', 'installation', 'product']], 'body');
            expect(body).toContain('Missing/unreadable assets block required QA');
          }
          const registry = path.join(owned, 'prefixed-callers', caller);
          fs.mkdirSync(path.join(registry, `gstack-${caller}`), { recursive: true });
          fs.cpSync(path.join(base, 'qa'), path.join(registry, 'gstack-qa'), { recursive: true });
          const prefixedTarget = path.resolve(registry, `gstack-${caller}`, '../gstack-qa/sections/exploratory.md');
          const prefixedScope = path.resolve(registry, `gstack-${caller}`, '../gstack-qa/sections/scope.md');
          expect(fs.readFileSync(prefixedScope, 'utf8')).toBe(fs.readFileSync(scopeTarget, 'utf8'));
          expect(fs.readFileSync(prefixedTarget, 'utf8')).toBe(fs.readFileSync(target, 'utf8'));
          expect(fs.existsSync(path.resolve(registry, `gstack-${caller}`, '../qa/sections/exploratory.md'))).toBe(false);
        }
      }
    });
  }

  test('freshly rendered QA modes retain the fixed parity and prompt-size limits', () => {
    const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/parity-baseline-v1.64.1.0.json'), 'utf8'));
    const report = runParityChecks({ repoRoot: rendered, baseline,
      invariants: PARITY_INVARIANTS.filter(invariant => QA_SKILLS.includes(invariant.skill)) });
    expect(report.totalChecks).toBe(2);
    expect(report.details.filter(detail => !detail.passed)).toEqual([]);
  });

  test('invalid IDs and missing source assets fail rather than producing a usable pointer', () => {
    for (const host of ALL_HOST_CONFIGS) {
      expect(() => fixture.SECTION(context(host.name, 'qa'), [])).toThrow('requires a section id');
      expect(() => fixture.sectionPath(context(host.name, 'ship'), 'qa', 'unknown')).toThrow('no section "unknown"');
    }
    const template = path.join(owned, 'fixture/qa-only/sections/contract-probes.md.tmpl');
    fs.unlinkSync(template);
    try {
      for (const host of ALL_HOST_CONFIGS) {
        expect(() => fixture.SECTION(context(host.name, 'qa-only'), ['native'])).toThrow('contract-probes.md.tmpl');
      }
    } finally {
      fs.writeFileSync(template, 'PRIVATE_SECTION_BODY\n');
    }
  });

  test('dry-run reports missing QA sections and authored report assets without recreating them', async () => {
    const artifacts = generated.artifacts.filter(artifact =>
      artifact.kind === 'section' && /^(?:\.[^/]+\/skills\/gstack-)?qa\/sections\//.test(artifact.relativePath)
      || artifact.kind === 'asset' && artifact.relativePath.endsWith('/templates/functional-report-template.md'));
    expect(artifacts.length).toBeGreaterThanOrEqual(ALL_HOST_CONFIGS.length);
    const originals = artifacts.map(artifact => ({ ...artifact, body: fs.readFileSync(path.join(rendered, artifact.relativePath)) }));
    for (const artifact of originals) fs.unlinkSync(path.join(rendered, artifact.relativePath));
    try {
      const result = await runGeneration({ host: 'all', outputRoot: rendered, dryRun: true });
      expect(result.exitCode).toBe(1);
      expect(result.diagnostics.filter(diagnostic => diagnostic.kind === 'error')).toEqual([]);
      expect(result.diagnostics.filter(diagnostic => diagnostic.kind === 'stale').map(diagnostic => diagnostic.relativePath).sort())
        .toEqual(artifacts.map(artifact => artifact.relativePath).sort());
      for (const artifact of artifacts) expect(fs.existsSync(path.join(rendered, artifact.relativePath))).toBe(false);
    } finally {
      for (const artifact of originals) fs.writeFileSync(path.join(rendered, artifact.relativePath), artifact.body);
    }
  });
});

describe('installed QA pointers', () => {
  test('QA-only reads methods and finalization before their dependent writes', () => {
    const source = fs.readFileSync(path.join(ROOT, 'qa-only/SKILL.md.tmpl'), 'utf8');
    const stages = ['Load the shared preparation gate now', '{{SECTION:exploratory}}',
      '## Prepare Report Artifacts', '## Run the Selected Checks', 'With its required Reads complete and report ownership resolved, Write the charters',
      '### Assemble the report', '{{SECTION:reporting}}', '### Write the checked report'];
    const positions = stages.map(stage => source.indexOf(stage));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(source.indexOf('Write identical content')).toBeGreaterThan(source.indexOf('{{SECTION:reporting}}'));
    expect(source).not.toContain('{{SLUG_SETUP}}');
    expect(source).not.toContain('{{SLUG_EVAL}}');
    expectMentions(source, [['not', 'finalization', 'preparation']], 'source');
    expectTokens(source, ['**Charters**'], 'source');
    expectMentions(source, [['before', 'preserve', 'charters']], 'source');
  });

  test('QA-only defines standalone permissions, mixed modes and outside changes', () => {
    const source = ['qa-only/SKILL.md.tmpl', 'qa-only/sections/reporting.md.tmpl']
      .map(file => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n').replace(/\s+/g, ' ');
    expect(source).toContain('**caller** means this /qa-only workflow');
    expect(source).toContain('**Owned** means created for this run or explicitly assigned to it, not merely writable');
    expectMentions(source, [['does not', 'permission', 'invoking']], 'source');
    expectMentions(source, [['do not', 'forbidden', 'create']], 'source');
    expectMentions(source, [['unless', 'selected', 'surfaces']], 'source');
    expectMentions(source, [['only', 'source/diff', 'changes']], 'source');
    expectTokens(source, ['`TODOS.md`'], 'source');
    expect(source).toContain('defaulting to functional then browser');
    expectMentions(source, [['does not', 'switching', 'absolute']], 'source');
    expect(source).toContain('CLI executable basename');
    expect(source).toContain('**No explicit permission:** skip learning-store writes and continue to the report');
    expect(source).toContain('**Explicit permission:** Read the named store first');
    expect(source).toContain('Do not run logging helpers');
    expect(source).not.toContain('{{LEARNINGS_LOG}}');
    for (const host of ALL_HOST_CONFIGS) {
      const directory = host.name === 'claude' ? 'qa-only' : `${host.hostSubdir}/skills/gstack-qa-only`;
      const explorer = fs.readFileSync(path.join(rendered, directory, 'sections/exploratory.md'), 'utf8').replace(/\s+/g, ' ');
      expectMentions(explorer, [['do not', 'yourself', 'product']], 'explorer');
      expect(explorer).toContain('Keep the original limits/notes');
    }
  });

  test('report-only scope, modes and output overrides precede browser setup', () => {
    const source = fs.readFileSync(path.join(ROOT, 'qa-only/SKILL.md.tmpl'), 'utf8');
    const stages = ['## Request Parameters', '## Test Plan Context', '{{LEARNINGS_SEARCH}}',
      '## Select Surfaces and Isolation', '{{SECTION:exploratory}}', '## Prepare Report Artifacts',
      '## Browser Setup (conditional)', '{{QA_RESOURCE:browser-setup}}', '## Run the Selected Checks'];
    const positions = stages.map(stage => source.indexOf(stage));
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(source).not.toContain('{{SECTION:browser-setup}}');
    expect(source).not.toContain('{{QA_METHOD_READS}}');
    expect(source).toContain('Load the shared preparation gate now');
    expectMentions(source, [['does not', 'parsing', 'records']], 'source');
    expectTokens(source, ['`--quick`', '`--regression`'], 'source');
    expectMentions(source, [['ask', 'supplied', 'choose']], 'source');
    expect(source).toContain('$REPORT_DIR/qa-report-{target}-{YYYY-MM-DD}.md');
    expect(source).not.toContain('qa-report-{domain}');
    expect(source.indexOf('Set `REPORT_FILE`')).toBeLessThan(source.indexOf('## Browser Setup (conditional)'));
    expectTokens(source, ['`REPORT_FILE`'], 'source');
    expectMentions(source.replace(/\s+/g, ' '), [['not', 'charters', 'findings']], 'source.replace(/\s+/g,  )');
    const browser = fs.readFileSync(path.join(ROOT, 'qa/sections/browser-setup.md.tmpl'), 'utf8');
    expectMentions(browser, [['do not', 'setup/install', 'cookie-import']], 'browser');
    expect(browser).toContain('scope section\'s ownership rules apply even to LOCAL browser targets');
  });

  test('QA entrypoints preserve previous artifacts before browser setup without expanding caller authority', () => {
    for (const skill of QA_SKILLS) {
      const source = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md.tmpl'), 'utf8');
      const browser = skill === 'qa' ? '{{SECTION:browser-setup}}' : '{{QA_RESOURCE:browser-setup}}';
      const setup = source.slice(0, source.indexOf(browser)).replace(/\s+/g, ' ');
      expect(setup).toContain('prior report');
      expect(setup).toMatch(/baseline paths.*before writing/);
      expectMentions(setup, [['only', 'subdirectory', 'otherwise']], 'setup');
      if (skill === 'qa-only') {
        expectMentions(setup, [['never', 'overwrite', 'artifacts']], 'setup');
      } else {
        expectMentions(setup, [['never', 'screenshots', 'exploration']], 'setup');
      }
      expect(setup).toMatch(/impossible.*(?:output blocker|blocker)/);
      expect(setup).toMatch(/(?:rather than expanding|do not expand) write authority/);
    }
    const source = fs.readFileSync(path.join(ROOT, 'qa-only/SKILL.md.tmpl'), 'utf8').replace(/\s+/g, ' ');
    expectMentions(source, [['no', 'established', 'revalidate']], 'source');
    expectMentions(source, [['never', 'destination', 'suffixed']], 'source');
  });

  test('mixed report labels, metadata and baselines have one explicit assembly rule', () => {
    const source = fs.readFileSync(path.join(ROOT, 'qa-only/SKILL.md.tmpl'), 'utf8').replace(/\s+/g, ' ');
    for (const contract of [
      '`mixed-{project-label}`', 'sanitizing the repository name', '`mixed-target`',
      'List the individual targets', 'common metadata once', '**Browser:**', '**Functional:**',
      '`templates/qa-report-template.md`', '`templates/functional-report-template.md`',
      'without duplicating the shared title or metadata',
      'Browser scores apply only to browser coverage; never combine them with functional outcomes',
      'current baseline or replay evidence and checkpoints',
      'Regression also links the prior input baseline/report',
      'Prior baselines are not applicable to Full/Quick',
      'for functional regression the report plus replay evidence is the baseline',
      'Report-only repair/test fields contain proposals or not-run status, never claims of edits',
    ]) expect(source).toContain(contract);
  });

  test('QA-only distinguishes shared browser artifacts from per-surface clocks and checkpoints', () => {
    for (const host of ALL_HOST_CONFIGS) {
      const directory = host.name === 'claude' ? 'qa-only' : `${host.hostSubdir}/skills/gstack-qa-only`;
      const source = fs.readFileSync(path.join(rendered, directory, 'SKILL.md'), 'utf8');
      const start = source.indexOf('### Output Structure');
      expect(start).toBeGreaterThan(-1);
      const layout = source.slice(start, source.indexOf('\n---', start));
      expect(layout).toContain('`REPORT_DIR` stays the report root throughout the run');
      expectTokens(layout.replace(/\s+/g, ' '), ['`$REPORT_DIR/screenshots/`', '`$REPORT_DIR/baseline.json`'], 'layout.replace(/\s+/g,  )');
      expectMentions(layout.replace(/\s+/g, ' '), [['only', 'browser-only', 'screenshots']], 'layout.replace(/\s+/g,  )');
      expectMentions(layout, [['only', 'mixed-surface', 'checkpoints']], 'layout');
      expect(layout).toContain('| One surface (browser or functional) | `$REPORT_DIR` |');
      expect(layout).toContain('| Mixed: browser probes | `$REPORT_DIR/browser` |');
      expect(layout).toContain('| Mixed: functional probes | `$REPORT_DIR/functional` |');
      expect(layout.replace(/\s+/g, ' ')).toContain('only when timed, `deadline.json`');
      expect(layout).toContain('Caller-fixed paths override this layout');
      expectTokens(layout.replace(/\s+/g, ' '), ['`REPORT_DIR`'], 'layout.replace(/\s+/g,  )');
      expectMentions(layout.replace(/\s+/g, ' '), [['do not', 'directory', 'reassign']], 'layout.replace(/\s+/g,  )');
    }
  });

  test('QA-only persists its plan before probes and separates observed facts from hypotheses', () => {
    for (const host of ALL_HOST_CONFIGS) {
      const directory = host.name === 'claude' ? 'qa-only' : `${host.hostSubdir}/skills/gstack-qa-only`;
      const entry = fs.readFileSync(path.join(rendered, directory, 'SKILL.md'), 'utf8');
      const reporting = fs.readFileSync(path.join(rendered, directory, 'sections/reporting.md'), 'utf8');
      const directive = SECTION(context(host.name, 'qa-only'), ['reporting']);
      expect(entry).toContain(directive);
      expect(entry.indexOf(directive)).toBeGreaterThan(entry.indexOf('### Assemble the report'));
      expectMentions(entry, [['does not', 'authorize', 'restart']], 'entry');
      expect(entry).toContain('Do not preload reporting');
      expect(directive).toContain('Read `sections/reporting.md`');
      expect(directive).toContain('Missing/unreadable assets block required QA');
      expect(entry).not.toContain('## 1. Establish each finding once');
      const source = (entry + '\n' + reporting).replace(/\s+/g, ' ');
      expectMentions(source, [['wait', 'successful', 'ownership']], 'source');
      expect(source).toContain('A failed baseline contract stays failed');
      expectMentions(source, [['does not', 'establish', 'exception']], 'source');
      expectMentions(source, [['does not', 'inaccessible', 'page-text']], 'source');
      expectMentions(source, [['not', 'measurement', 'latency']], 'source');
      expect(source).toContain('**Probe budget** (configured limit)');
      expect(source).toContain('**Guarded command time** (sum of measured child spans)');
      expect(source).toContain('**Total session elapsed**: `unmeasured` for the invocation whose report is being written');
      expectMentions(source, [['not', 'deadline', 'window']], 'source');
      expectMentions(source, [['do not', 'status/write', 'receipts']], 'source');
      expectMentions(source, [['only', 'dispatched', 'follow-up']], 'source');
      expectMentions(source, [['not', 'acknowledgement', 'finished']], 'source');
      expectTokens(source, ['**Measured interval**'], 'source');
      expectMentions(source, [['must', 'boundaries', 'start/end']], 'source');
      expectMentions(source, [['not', 'exception-shaped', 'operation']], 'source');
      expectMentions(source, [['not', 'confirmation', 'completion']], 'source');
      expectMentions(source, [['do not', 'conservative', 'paraphrase']], 'source');
      const exploratory = fs.readFileSync(path.join(rendered, directory, 'sections/exploratory.md'), 'utf8').replace(/\s+/g, ' ');
      expectMentions(exploratory, [['not', 'separator', 'child']], 'exploratory');
      expectMentions(source, [['do not', 'exception-only', 'console-only']], 'source');
      expectMentions(source, [['only', 'consistency', 'report']], 'source');
      expectMentions(source, [['only', 'caller-authorized', 'destination']], 'source');
      expectTokens(source, ['`REPORT_FILE`'], 'source');
      expectMentions(source, [['do not', 'automatic', 'learning']], 'source');
      const stages = ['## 1. Establish each finding once', '## 2. Fill timing fields', '## 3. Assemble and check'];
      const positions = stages.map(stage => reporting.indexOf(stage));
      expect(positions.every(position => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  const installers = new Set(['claude', 'codex', 'factory', 'kiro', 'opencode', 'cursor']);
  const helpers = [
    '_link_or_copy', '_print_windows_copy_note_once', '_link_skill_runtime_assets', '_gstack_link_target_abs', '_gstack_target_is_ours',
    '_gstack_generated_header', '_claude_entry_owned_strongly', '_claude_entry_is_ours', '_write_owned_marker',
    '_backup_skill_md', '_cleanup_weak_dir', '_gstack_dir_only_links', '_cleanup_linked_dir',
    '_owned_for_windows_refresh', '_sidecar_root_user_owned', '_prune_stale_generated', '_skill_source_exists',
    '_link_runtime_dists', '_copy_runtime_skill_refs', '_copy_skill_md', '_skill_copy_hash', '_skill_copy_unmodified', '_preserve_skill_copy_edits', '_record_skill_copies',
  ].map(setupFunction).join('\n')
    // Install-registry rows (setup's _setup_arm_* / _setup_row) are not under test here.
    + '\n_setup_arm_begin() { :; }\n_setup_arm_publish() { :; }\n_setup_row() { :; }';
  const kiroStart = setup.indexOf('# 6. Install for Kiro CLI');
  const kiroBlock = setup.slice(kiroStart, setup.indexOf('# 6b.', kiroStart));

  for (const host of ALL_HOST_CONFIGS) {
    for (const copy of process.platform === 'win32' ? [true] : [false, true]) {
      test(`${host.name} ${copy ? 'copies' : 'links'} resolve in global/local ${installers.has(host.name) ? 'setup installs' : 'rendered layouts (no setup arm)'}`, () => {
        const base = fs.mkdtempSync(path.join(owned, `${host.name}-`));
        const source = path.join(base, 'payload');
        const native = host.name === 'claude' ? source : path.join(source, host.hostSubdir, 'skills');
        const names = QA_SKILLS.filter(skill => fs.existsSync(path.join(ROOT, skill, 'sections/manifest.json')));
        expect(names).toContain('qa');
        for (const skill of names) {
          const name = host.name === 'claude' ? skill : `gstack-${skill}`;
          const original = host.name === 'claude' ? path.join(rendered, skill) : path.join(rendered, host.hostSubdir, 'skills', name);
          fs.cpSync(original, path.join(native, name), { recursive: true });
          put(path.join(source, skill, 'SKILL.md.tmpl'), `---\nname: ${skill}\n---\n`);
        }
        const homes = [path.join(base, 'home', path.dirname(host.globalRoot)), path.join(base, 'repo', path.dirname(host.localSkillRoot))];
        if (host.name === 'codex') homes.push(path.join(base, 'custom-codex-home/skills'));
        for (const registry of homes) {
          for (const prefix of host.name === 'claude' ? [0, 1] : [1]) {
            fs.mkdirSync(registry, { recursive: true });
            let install: string;
            if (host.name === 'kiro') {
              for (const file of ['bin/tool', 'lib/helper', 'browse/dist/browse', 'browse/bin/helper']) put(path.join(source, file), 'fixture');
              for (const name of ['gstack', 'gstack-upgrade']) put(path.join(native, name, 'SKILL.md'), '<!-- AUTO-GENERATED from SKILL.md.tmpl -->\n<!-- Regenerate: bun run gen:skill-docs -->\n');
              install = `INSTALL_KIRO=1\nKIRO_SKILLS="$REGISTRY"\n${kiroBlock}`;
            } else if (installers.has(host.name)) {
              const name = `link_${host.name}_skill_dirs`;
              install = `${setupFunction(name)}\n${name} "$SOURCE_GSTACK_DIR" "$REGISTRY"`;
            } else {
              install = names.map(skill => `_link_or_copy "$NATIVE/gstack-${skill}" "$REGISTRY/gstack-${skill}"`).join('\n');
            }
            const script = [
              'set -e', `IS_WINDOWS=${copy ? 1 : 0}`, `SKILL_PREFIX=${prefix}`, 'QUIET=1',
              '_FOREIGN_SKIPPED_ENTRIES=()', '_BACKED_UP_SKILL_MDS=()', '_SKILL_BACKUP_ROOT="$HOME/backups"',
              'GSTACK_USER_RENDER_DIR="$HOME/absent-render"',
              'GSTACK_STATE_ROOT="$HOME/.gstack"', '_SKILL_COPIES_FILE="$GSTACK_STATE_ROOT/skill-copies.tsv"', helpers,
              'log() { :; }', '_browser_hint() { :; }', 'bun_cmd() { :; }', install,
            ].join('\n');
            const runInstall = () => runBashScript(script, {
              cwd: base, timeout: 30_000,
              env: { ...process.env, HOME: path.join(base, 'isolated-home'), REGISTRY: registry, SOURCE_GSTACK_DIR: source, NATIVE: native },
            });
            const result = runInstall();
            expect(result.status, result.stderr).toBe(0);
            expect(result.stderr).not.toContain('command not found');
            for (const skill of names) {
              const name = host.name === 'claude' && !prefix ? skill : `gstack-${skill}`;
              const entry = path.join(registry, name, 'SKILL.md');
              const body = fs.readFileSync(entry, 'utf8');
              const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, skill, 'sections/manifest.json'), 'utf8'));
              for (const section of manifest.sections) {
                const ref = sectionPath(context(host.name, skill), skill, section.id);
                expect(body).toContain(ref);
                const relative = ref.match(/^`([^`]+)`/)![1];
                const installed = path.resolve(path.dirname(entry), relative);
                const resolved = fs.realpathSync(installed);
                expect(resolved.startsWith(fs.realpathSync(base) + path.sep)).toBe(true);
                expect(fs.readFileSync(installed, 'utf8')).toBe(fs.readFileSync(path.join(native, host.name === 'claude' ? skill : `gstack-${skill}`, relative), 'utf8'));
                expect(fs.existsSync(path.resolve(base, relative))).toBe(false);
                fs.renameSync(resolved, `${resolved}.absent`);
                try {
                  expect(() => fs.readFileSync(installed, 'utf8')).toThrow('ENOENT');
                  expect(body).toContain('missing or unreadable');
                  expect(body).toContain('QA setup blocker');
                } finally {
                  fs.renameSync(`${resolved}.absent`, resolved);
                }
              }
              const explorer = fs.readFileSync(path.join(path.dirname(entry), 'sections/exploratory.md'), 'utf8');
              expect(body).not.toContain(generateQAMethodReads(context(host.name, skill)));
              expect(body).toContain(skill === 'qa' ? "Follow the shared section's ordered preparation" : 'Load the shared preparation gate now');
              expect(explorer).toContain(generateQAMethodReads(context(host.name, skill)));
              expect(explorer.indexOf('in full and select the surfaces')).toBeLessThan(explorer.indexOf('Read `sections/system-functional.md`'));
              expect(explorer.indexOf('Read `sections/system-functional.md`')).toBeLessThan(explorer.indexOf('Write a **charter**'));
              const qaName = host.name === 'claude' && !prefix ? 'qa' : 'gstack-qa';
              const qaDirectory = path.join(registry, qaName);
              const functional = fs.readFileSync(path.join(qaDirectory, 'sections/system-functional.md'), 'utf8');
              const reportReference = functional.match(/Use `([^`]+)` relative to the installed QA SKILL\.md\./);
              expect(reportReference).not.toBeNull();
              const report = path.resolve(qaDirectory, reportReference![1]);
              const resolvedReport = fs.realpathSync(report);
              expect(resolvedReport.startsWith(fs.realpathSync(base) + path.sep)).toBe(true);
              expect(fs.readFileSync(report, 'utf8'))
                .toBe(host.name === 'claude' ? REPORT_TEMPLATE : GENERATED_REPORT);
              fs.renameSync(resolvedReport, `${resolvedReport}.absent`);
              try {
                expect(() => fs.readFileSync(report, 'utf8')).toThrow('ENOENT');
                expectMentions(explorer, [['not', 'prerequisites', 'independent']], 'explorer');
                expectMentions(explorer, [['no', 'current-input', 'contracts']], 'explorer');
              } finally {
                fs.renameSync(`${resolvedReport}.absent`, resolvedReport);
              }
            }
            if (host.name === 'kiro') {
              const templates = path.join(registry, 'gstack-qa/templates');
              const report = path.join(templates, 'functional-report-template.md');
              const sourceReport = path.join(native, 'gstack-qa/templates/functional-report-template.md');
              for (const candidate of [templates, report, sourceReport]) {
                expect(fs.realpathSync(candidate).startsWith(fs.realpathSync(base) + path.sep)).toBe(true);
              }
              const original = fs.readFileSync(sourceReport, 'utf8');
              const custom = path.join(templates, 'custom.md');
              fs.writeFileSync(custom, 'unrelated user template');
              try {
                const updated = original + '\nUpdated report instructions.\n';
                fs.writeFileSync(sourceReport, updated);
                if (!copy) {
                  const previous = path.join(source, 'previous-report.md');
                  fs.writeFileSync(previous, original);
                  fs.unlinkSync(report);
                  fs.symlinkSync(previous, report);
                }
                const refreshed = runInstall();
                expect(refreshed.status, refreshed.stderr).toBe(0);
                expect(fs.readFileSync(report, 'utf8')).toBe(updated);
                expect(fs.readFileSync(custom, 'utf8')).toBe('unrelated user template');

                fs.unlinkSync(report);
                fs.writeFileSync(report, 'foreign authored report');
                const fileCollision = runInstall();
                expect(fileCollision.status, fileCollision.stderr).toBe(0);
                expect(fileCollision.stderr).toContain('existing file is not gstack-managed');
                expect(fs.readFileSync(report, 'utf8')).toBe('foreign authored report');

                const foreign = fs.mkdtempSync(path.join(base, 'foreign-'));
                const foreignReport = path.join(foreign, 'functional-report-template.md');
                fs.writeFileSync(foreignReport, 'foreign link target');
                fs.unlinkSync(report);
                fs.symlinkSync(foreignReport, report);
                const fileLinkCollision = runInstall();
                expect(fileLinkCollision.status, fileLinkCollision.stderr).toBe(0);
                expect(fileLinkCollision.stderr).toContain('file link is not gstack-managed');
                expect(fs.readlinkSync(report)).toBe(foreignReport);
                expect(fs.readFileSync(foreignReport, 'utf8')).toBe('foreign link target');

                fs.renameSync(templates, `${templates}.saved`);
                fs.symlinkSync(foreign, templates);
                const directoryLinkCollision = runInstall();
                expect(directoryLinkCollision.status, directoryLinkCollision.stderr).toBe(0);
                expect(directoryLinkCollision.stderr).toContain('directory link is not gstack-managed');
                expect(fs.readlinkSync(templates)).toBe(foreign);
                expect(fs.readFileSync(foreignReport, 'utf8')).toBe('foreign link target');
                expect(fs.readFileSync(`${templates}.saved/custom.md`, 'utf8')).toBe('unrelated user template');

                fs.unlinkSync(templates);
                fs.writeFileSync(templates, 'foreign file at templates directory');
                const directoryFileCollision = runInstall();
                expect(directoryFileCollision.status, directoryFileCollision.stderr).toBe(0);
                expect(directoryFileCollision.stderr).toContain('existing entry is not a directory');
                expect(fs.readFileSync(templates, 'utf8')).toBe('foreign file at templates directory');
              } finally {
                fs.writeFileSync(sourceReport, original);
              }
            }
          }
        }
      }, 60_000);
    }
  }
});
