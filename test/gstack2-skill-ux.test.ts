import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SOURCE_ASSIGNMENTS } from '../scripts/gstack2/assignments';
import {
  ROOT,
  legacySections,
  renderLegacyBody,
  renderPortedLegacyBody,
  renderPortedLegacySection,
  retiredInvocationPattern,
} from '../scripts/gstack2/render-legacy';
import { TREE_NAMES } from '../scripts/gstack2/types';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((entry) => fsp.rm(entry, { recursive: true, force: true })));
});

function ownerModule(source: string): string {
  const assignment = SOURCE_ASSIGNMENTS.find((entry) => entry.source === source);
  if (!assignment) throw new Error(`Unknown source ${source}`);
  return path.join(ROOT, 'skills', assignment.tree, 'references', 'legacy', `${source}.md`);
}

describe('GStack 2 canonical skill UX', () => {
  test('keeps exactly six public skills while excluding the retired shared onboarding machine', () => {
    const publicSkills = fs.readdirSync(path.join(ROOT, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(ROOT, 'skills', entry.name, 'SKILL.md')))
      .map((entry) => entry.name)
      .sort();
    expect(publicSkills).toEqual([...TREE_NAMES].sort());

    for (const assignment of SOURCE_ASSIGNMENTS) {
      const body = fs.readFileSync(ownerModule(assignment.source), 'utf8');
      expect(body, assignment.source).not.toContain('## Preamble (run first)');
      expect(body, assignment.source).not.toMatch(
        /MODEL_OVERLAY: claude|CLAUDE_PLAN_FILE|Add routing rules to CLAUDE\.md|Boil the Ocean principle|TEL_PROMPTED|PROACTIVE_PROMPTED/,
      );
      expect(body, assignment.source).not.toContain('cd <SKILL_DIR> && ./setup');
    }
  });

  test('packages one binding inferred execution-profile contract in every dispatcher', () => {
    for (const tree of TREE_NAMES) {
      const dispatcher = fs.readFileSync(path.join(ROOT, 'skills', tree, 'SKILL.md'), 'utf8');
      const profiles = fs.readFileSync(path.join(ROOT, 'skills', tree, 'references', 'EXECUTION-PROFILES.md'), 'utf8');
      expect(dispatcher, tree).toContain('Depth: <readiness, standard, or deep>');
      expect(dispatcher, tree).toContain('Read `references/EXECUTION-PROFILES.md`');
      expect(profiles, tree).toContain('## Smoke/readiness');
      expect(profiles, tree).toContain('Readiness profile — not a complete review.');
      expect(profiles, tree).toContain('Every selected specialist module remains mandatory.');
      expect(profiles, tree).toContain('## Standard');
      expect(profiles, tree).toContain('## Deep');
      expect(profiles, tree).toContain('never overrides a specialist’s binding question order');
    }
  });

  test('resolves retired user-facing recommendations without rewriting package paths', () => {
    for (const assignment of SOURCE_ASSIGNMENTS) {
      const body = fs.readFileSync(ownerModule(assignment.source), 'utf8');
      expect(body, assignment.source).not.toMatch(retiredInvocationPattern());
    }
    expect(fs.readFileSync(ownerModule('plan-ceo-review'), 'utf8'))
      .toContain('$plan --mode Discovery --module office-hours');
    expect(fs.readFileSync(ownerModule('open-gstack-browser'), 'utf8'))
      .toContain('$GSTACK_BIN/gstack runtime path extension');
  });

  test('packages one consent-first host-neutral bootstrap with every selected skill', () => {
    const source = fs.readFileSync(path.join(ROOT, 'runtime', 'runtime-bootstrap.mjs'));
    for (const tree of TREE_NAMES) {
      const runtime = fs.readFileSync(path.join(ROOT, 'skills', tree, 'references', 'RUNTIME.md'), 'utf8');
      const bootstrap = fs.readFileSync(path.join(ROOT, 'skills', tree, 'references', 'support', 'runtime-bootstrap.mjs'));
      const contract = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills', tree, 'references', 'support', 'runtime-contract.json'), 'utf8'));
      const resultContract = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills', tree, 'references', 'support', 'execution-result-contract.json'), 'utf8'));
      expect(bootstrap, tree).toEqual(source);
      expect(contract, tree).toEqual({ schemaVersion: 1, runtimeVersion: '2.0.0', skillApi: '2.0' });
      expect(resultContract.properties.status.enum, tree).toEqual(['success', 'degraded', 'unsupported', 'failed']);
      expect(resultContract.allOf[0].then.properties.evidence.minItems, tree).toBe(1);
      expect(runtime, tree).toContain('preview --capability <name>');
      expect(runtime, tree).toContain('It never downloads components or mutates runtime state.');
      expect(runtime, tree).toContain('install --capability <name> --yes');
      expect(runtime, tree).toContain('Never run `./setup` inside a standard-installed skill directory');
      expect(runtime, tree).toContain('Deferring installation records no consent');
      expect(runtime, tree).toContain('Logical `browser` expands to `browser-code + browser-headless`');
      expect(runtime, tree).toContain('`browser-visible` expands to `browser-code + browser-visible` and does not require headless');
      expect(runtime, tree).toContain('`pdf` depends on `diagram`');
      expect(runtime, tree).toContain('`all` means those five and intentionally excludes visible Chromium');
      expect(runtime, tree).toContain('summed compressed bytes');
      expect(runtime, tree).toContain('B=$GSTACK_BIN/browse');
      expect(runtime, tree).toContain('BUN_CMD=$GSTACK_BIN/bun');
      expect(runtime, tree).toContain('discovers Git for Windows Bash');
      expect(runtime, tree).toContain('Python is not a global GStack prerequisite');
    }
  });

  test('defers visible Chromium until a workflow reaches a headed point of use', () => {
    for (const source of ['open-gstack-browser', 'pair-agent', 'setup-browser-cookies']) {
      const body = fs.readFileSync(ownerModule(source), 'utf8');
      expect(body, source).toContain('## Visible-browser point-of-use gate');
      expect(body, source).toContain('preview --capability browser-visible');
      expect(body, source).toContain('install --capability browser-visible --yes');
      expect(body, source).toContain('never requires `browser-headless`');
    }
    expect(fs.readFileSync(ownerModule('browse'), 'utf8')).not.toContain('browser-visible');
    expect(fs.readFileSync(ownerModule('qa-only'), 'utf8')).not.toContain('browser-visible');
  });

  test('binds retained runtime helper variables to stable host-neutral paths', () => {
    for (const assignment of SOURCE_ASSIGNMENTS) {
      const body = fs.readFileSync(ownerModule(assignment.source), 'utf8');
      expect(body, assignment.source).not.toMatch(/bun\.sh\/install|bun run \$GSTACK_BIN|command -v bun/);
      if (!/\$(?:GSTACK_BIN|GSTACK_ROOT|GSTACK_STATE_ROOT)\b|\$(?:B|D|P)\b/.test(body)) continue;
      expect(body, assignment.source).toContain('## Host-neutral runtime bindings');
      expect(body, assignment.source).toContain('GSTACK_BIN="$GSTACK_HOME/bin"');
      expect(body, assignment.source).toContain('BUN_CMD="$GSTACK_BIN/bun"');
      expect(body, assignment.source).toContain('B="$GSTACK_BIN/browse"');
    }
  });

  test('the packaged post-approval bootstrap reaches the managed installer without enrolling a host', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gstack-skill-bootstrap-'));
    temporary.push(root);
    const source = path.join(root, 'reviewed checkout');
    const home = path.join(root, 'runtime home');
    await fsp.mkdir(path.join(source, 'runtime'), { recursive: true });
    await fsp.writeFile(path.join(source, 'runtime', 'install.js'), [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'const home = process.argv[process.argv.indexOf("--home") + 1];',
      'fs.mkdirSync(home, { recursive: true });',
      'fs.writeFileSync(path.join(home, "argv.json"), JSON.stringify(process.argv.slice(2)));',
    ].join('\n'));

    const packaged = path.join(ROOT, 'skills', 'qa', 'references', 'support', 'runtime-bootstrap.mjs');
    const module = await import(`${pathToFileURL(packaged).href}?test=${Date.now()}`);
    let stdout = '';
    let stderr = '';
    const code = await module.main([
      'install', '--source', source, '--capability', 'browser', '--home', home, '--yes',
    ], {
      stdout: { write: (chunk: string) => { stdout += chunk; } },
      stderr: { write: (chunk: string) => { stderr += chunk; } },
    });
    expect(code).toBe(0);
    expect(stderr).toContain('Developer-only source install');
    expect(stdout).toContain('No coding host was enrolled');
    expect(JSON.parse(await fsp.readFile(path.join(home, 'argv.json'), 'utf8'))).toContain('--install-now');
  });

  test('cuts canonical active prompt bytes by at least half without dropping carved specialist phases', () => {
    const baselineBytes = SOURCE_ASSIGNMENTS.reduce(
      (total, assignment) => total + Buffer.byteLength(renderLegacyBody(assignment.source)),
      0,
    );
    const canonicalBytes = SOURCE_ASSIGNMENTS.reduce(
      (total, assignment) => total + Buffer.byteLength(renderPortedLegacyBody(assignment.source)),
      0,
    );
    expect(canonicalBytes).toBeLessThan(baselineBytes * 0.5);

    for (const section of legacySections()) {
      const assignment = SOURCE_ASSIGNMENTS.find((entry) => entry.source === section.source)!;
      const filename = path.basename(section.relativePath).replace(/\.tmpl$/, '');
      const reference = `references/sections/${section.source}/${filename}`;
      const module = fs.readFileSync(ownerModule(section.source), 'utf8');
      const packaged = fs.readFileSync(path.join(ROOT, 'skills', assignment.tree, reference), 'utf8');
      expect(module, section.relativePath).toContain(reference);
      expect(packaged.trim(), section.relativePath).toBe(renderPortedLegacySection(section).trim());
      expect(packaged, section.relativePath).not.toMatch(retiredInvocationPattern());
    }

    for (const tree of TREE_NAMES) {
      const artifactRoot = path.join(ROOT, 'skills', tree, 'references', 'artifacts');
      if (!fs.existsSync(artifactRoot)) continue;
      const pending = [artifactRoot];
      while (pending.length) {
        const current = pending.pop()!;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const target = path.join(current, entry.name);
          if (entry.isDirectory()) pending.push(target);
          else if (entry.name.endsWith('.md')) {
            expect(fs.readFileSync(target, 'utf8'), path.relative(ROOT, target)).not.toMatch(retiredInvocationPattern());
          }
        }
      }
    }
  }, 15_000);
});
