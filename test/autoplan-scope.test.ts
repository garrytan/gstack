/**
 * Field wave item 11: /autoplan scope keys on what the Implementation plan
 * changes. UI needs a rendered surface (a rendered file path, or a UI term
 * next to a visual noun); bare UI words and Review-record prose never add the
 * Design phase. Provenance is per axis (flag, marker, detected), `--no-dx`
 * turns DX off, a first-line scope marker in the plan is read (never
 * written), and the interactive path reads the same detector through
 * `gstack-autoplan-snapshot.ts scope`. Runner-level cases run on the
 * simulated Capy host (test/helpers/capy-host.ts).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectScope, detectUiScope, phaseOrder, sectionScopeOff } from '../lib/autoplan-prompts';
import { capyHost } from './helpers/capy-host';
import { AUTOPLAN, ROOT, env, readRun } from './helpers/autoplan-run-fixture';

const host = capyHost({ verifiedBun: '1.4.2' });
afterAll(() => host.cleanup());
let n = 0;
const planFile = (body: string, record = '', firstLine = '') => {
  const dir = path.join(host.base, `plan-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'plan.md');
  fs.writeFileSync(file, `${firstLine ? `${firstLine}\n` : ''}# Plan ${n}\n\n## Implementation plan\n\n${body}\n\n## Review record\n\n${record}\n`);
  return file;
};
const hostEnv = () => env({ ...host.env, PATH: host.launchPath, GSTACK_SESSION_KIND: 'unattended', GSTACK_STATE_ROOT: host.stateRoot, GSTACK_HOME: host.stateRoot });
const next = (args: string[]) => spawnSync('bun', [AUTOPLAN, 'next', ...args], { cwd: ROOT, env: hostEnv(), encoding: 'utf8', timeout: 120_000 });
const snapshotScope = (file: string) => {
  const r = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-autoplan-snapshot.ts'), 'scope', file], { cwd: ROOT, env: hostEnv(), encoding: 'utf8', timeout: 60_000 });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
};

const CLI_PROSE = 'The sync component reads frontmatter; a malformed form is held. The doctor screen output (terminal) lists each held file with a status line.';
const DX_PROSE = 'Add a CLI flag --since to the sync command and document the flag in the command help.';

describe('UI evidence is a rendered surface in the Implementation plan', () => {
  test('non-visual CLI prose with UI words is weak evidence: no Design phase, sections still load', () => {
    const r = detectUiScope(CLI_PROSE);
    expect(r.uiRequired).toBe(false);
    expect(r.uiMatches).toBe(4);
    expect(r.uiEvidence).toEqual({ terms: [{ term: 'component', count: 1 }, { term: 'screen', count: 1 }, { term: 'form', count: 1 }, { term: 'list', count: 1 }], visual: [], files: [] });
    const scope = detectScope(planFile(CLI_PROSE), ROOT, {});
    expect(scope.ui).toBe(false);
    expect(phaseOrder(scope)).not.toContain('design');
    expect(sectionScopeOff('ui', scope)).toBe(false);
  });

  test('UI words only in the Review record give ui=false (Review record prose is not scanned)', () => {
    const scope = detectScope(planFile('Retry the webhook worker with backoff in lib/worker.ts.', 'The Settings page layout gets a new button and a modal; the sidebar nav moves.'), ROOT, {});
    expect(scope.ui).toBe(false);
    expect(scope.ui_matches).toBe(0);
  });

  test('a rendered file path, quoted or backticked, gives ui=true and is printed as evidence', () => {
    expect(detectUiScope('Edit src/components/Settings.tsx to add the toggle.').uiEvidence.files).toEqual(['src/components/Settings.tsx']);
    expect(detectUiScope('Render "app/views/home/index.html.erb" with the new partial.').uiRequired).toBe(true);
    expect(detectUiScope('Move the colors into `web/theme.scss`.').uiEvidence.files).toEqual(['web/theme.scss']);
    expect(detectUiScope('Touch lib/pages.ts and docs/components.md only.').uiRequired).toBe(false);
    expect(detectScope(planFile('Edit src/components/Settings.tsx to add a retry toggle.'), ROOT, {}).ui).toBe(true);
  });

  test('a UI term next to a visual noun is UI; the same term far from one is not', () => {
    const near = detectUiScope('Add a retry button to the settings page.');
    expect(near.uiRequired).toBe(true);
    expect(near.uiEvidence.visual).toEqual(['button~page']);
    expect(detectUiScope('The status layout of the JSON report is stable.').uiRequired).toBe(false);
    expect(detectUiScope('Add a button. Write a long unrelated paragraph about the queue and its retry budget and the man page.').uiRequired).toBe(false);
  });
});

let repos = 0;
/** A repo root with Lit-style template files, plain .ts, test files and links out of the root. */
const templateRepo = () => {
  const root = path.join(host.base, `tpl-${++repos}`, 'repo');
  const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  write('plugins/web-ui/src/personas.ts', 'export const row = (p) => html`<div class="permission-row">${p.name}</div>`;\n');
  write('src/spaced.js', 'const t = svg `<path d="M0 0"/>`;\n');
  write('lib/pages.ts', 'export const pages = ["a.html"];\nconst xhtml`x` = 1;\n');
  write('src/split.ts', 'const t = html\n`<p></p>`;\n');
  write('test/view.ts', 'html`<p></p>`;\n');
  write('src/view.test.ts', 'html`<p></p>`;\n');
  write('src/__tests__/view.ts', 'html`<p></p>`;\n');
  write('../outside.ts', 'html`<p></p>`;\n');
  fs.symlinkSync(path.join(root, '..', 'outside.ts'), path.join(root, 'src', 'linked.ts'));
  return root;
};
const PERSONA_PROSE = 'Each grant is a permission row in plugins/web-ui/src/personas.ts with a role menu; the picker sits under the section.';

describe('template files and list-style terms (GST-1750)', () => {
  test('a named .ts/.js file holding a tagged html, css or svg template is a rendered file', () => {
    const root = templateRepo();
    expect(detectUiScope(PERSONA_PROSE, root)).toMatchObject({ uiRequired: true, uiEvidence: { files: ['plugins/web-ui/src/personas.ts'] } });
    expect(detectUiScope('Draw the icon in ./src/spaced.js.', root).uiEvidence.files).toEqual(['./src/spaced.js']);
  });

  test('without a root, or for a plain, test, missing or out-of-root file, a .ts path is not UI', () => {
    const root = templateRepo();
    expect(detectUiScope(PERSONA_PROSE).uiRequired).toBe(false);
    for (const file of ['lib/pages.ts', 'src/split.ts', 'test/view.ts', 'src/view.test.ts', 'src/__tests__/view.ts', 'src/missing.ts', '../outside.ts', 'src/linked.ts']) {
      expect(detectUiScope(`Touch ${file} only.`, root).uiRequired, file).toBe(false);
    }
  });

  test('row, list, picker, menu and section are UI terms: near a visual noun they add Design, bare they do not', () => {
    for (const [prose, pair] of [['Show the grants as a list on the persona page.', 'list~page'], ['Add a role picker to the settings view.', 'picker~view'], ['Each row gets the shared row style.', 'row~style'], ['The page menu opens on hover.', 'menu~page'], ['Move the help section under the page header.', 'section~page']]) {
      expect(detectUiScope(prose!).uiEvidence.visual, prose).toEqual([pair]);
    }
    expect(detectUiScope('List the files in each section and write one row per menu entry.')).toMatchObject({ uiRequired: false, uiMatches: 4 });
  });
});

describe('per-axis provenance, --no-dx and the plan marker', () => {
  test('--no-ui alone labels a detected DX as detected, not flag-forced', () => {
    const scope = detectScope(planFile(DX_PROSE), ROOT, { ui: false });
    expect(scope.dx).toBe(true);
    expect(scope.sources).toEqual({ ui: 'flag', dx: 'detected' });
  });

  test('a first-line marker with no CLI flags sets scope from the marker, and the source plan is untouched', () => {
    const file = planFile('Edit src/components/Settings.tsx to add a retry toggle.', '', '<!-- gstack-autoplan-scope: --no-ui --developer-tool -->');
    const before = fs.readFileSync(file);
    const scope = detectScope(file, ROOT, {});
    expect(scope).toMatchObject({ ui: false, dx: true, developer_tool: true, sources: { ui: 'marker', dx: 'marker' }, pin: null });
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(() => detectScope(planFile('x', '', '<!-- gstack-autoplan-scope: --bogus -->'), ROOT, {})).toThrow(/unknown scope flag --bogus/);
  });

  test('runner: CLI flags print SCOPE evidence and a SCOPE_PIN hint, never write the plan, and persist in run.json', () => {
    const file = planFile(`${DX_PROSE} ${CLI_PROSE}`);
    const before = fs.readFileSync(file);
    const out = path.join(host.base, 'run-pin');
    const r = next(['--out', out, '--plan', file, '--no-ui', '--developer-tool']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^SCOPE: ui=no \(terms: component×1, screen×1, form×1, list×1; visual: none; files: none\) dx=yes \(detected: [^)]*flag×2[^)]*\) docs_only=no \(detected\) source=ui:flag,dx:flag$/m);
    expect(r.stdout).toContain(`SCOPE_PIN: add <!-- gstack-autoplan-scope: --no-ui --developer-tool --> as the first line of ${file} to keep these flags`);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(readRun(out).scope).toMatchObject({ cli_flags: ['--no-ui', '--developer-tool'], marker: null, sources: { ui: 'flag', dx: 'flag' } });
    expect(r.stdout).toContain('source=ui:flag,dx:flag; checklist=');
  });

  test('runner: a marker that already says the CLI flags prints no SCOPE_PIN', () => {
    const file = planFile(DX_PROSE, '', '<!-- gstack-autoplan-scope: --developer-tool --no-ui -->');
    const r = next(['--out', path.join(host.base, 'run-pinned'), '--plan', file, '--no-ui', '--developer-tool']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^SCOPE: .* source=ui:flag,dx:flag$/m);
    expect(r.stdout).not.toContain('SCOPE_PIN:');
  });

  test('runner: --no-dx removes the DX phase from a plan whose terms detect it', () => {
    const r = next(['--out', path.join(host.base, 'run-nodx'), '--plan', planFile(DX_PROSE), '--no-ui', '--no-dx']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^PHASE: ceo snapshot=[0-9a-f]{64} order=ceo,eng$/m);
    expect(r.stdout).toMatch(/^SCOPE: ui=no .* dx=no .* source=ui:flag,dx:flag$/m);
  });
});

describe('interactive parity: one detector', () => {
  test('snapshot scope returns uiRequired with its evidence', () => {
    expect(snapshotScope(planFile('Edit src/components/Settings.tsx.'))).toMatchObject({ uiRequired: true, uiEvidence: { files: ['src/components/Settings.tsx'] } });
    expect(snapshotScope(planFile(CLI_PROSE, 'The Settings page layout gets a new button.'))).toMatchObject({ uiRequired: false, uiMatches: 4 });
  });

  test('snapshot scope reads a named template file from the repo root it runs in', () => {
    const root = templateRepo();
    const r = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-autoplan-snapshot.ts'), 'scope', planFile(PERSONA_PROSE)], { cwd: root, env: hostEnv(), encoding: 'utf8', timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ uiRequired: true, uiEvidence: { files: ['plugins/web-ui/src/personas.ts'], visual: [] } });
  });

  test('autoplan Step 2 takes UI scope from the returned uiRequired instead of a prose grep', () => {
    const step2 = fs.readFileSync(path.join(ROOT, 'autoplan', 'SKILL.md.tmpl'), 'utf8').split('### Step 2: Read context')[1]!.split('### Step 3:')[0]!;
    expect(step2).toContain('`uiRequired`');
    expect(step2).not.toMatch(/grep the plan/i);
    expect(fs.readFileSync(path.join(ROOT, 'autoplan', 'SKILL.md'), 'utf8')).toContain('`uiRequired`');
  });
});
