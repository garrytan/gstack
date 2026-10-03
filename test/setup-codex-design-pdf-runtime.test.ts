import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { generateDesignSetup } from '../scripts/resolvers/design';
import { generateMakePdfSetup } from '../scripts/resolvers/make-pdf';

// #1159: Codex design and make-pdf skills resolve their binaries from the
// repo-local .agents sidecar first, then from $GSTACK_DESIGN / $GSTACK_MAKE_PDF
// under the global ~/.codex/skills/gstack root. setup never linked either
// dist/ into those roots, so both preflights printed *_NOT_AVAILABLE on a
// fresh install even though the binaries were built.
//
// These tests build each root with the real setup shell code, then run the
// exact bash block the generator emits for Codex, in a fresh process (the way
// Codex runs every shell call), and check the preflight verdict.

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

function extractFunction(name: string): string {
  const start = SETUP_SRC.indexOf(`${name}() {`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Could not locate ${name}() in setup`);
  return SETUP_SRC.slice(start, end + 2);
}

function codexCtx(skillName: string): TemplateContext {
  return { skillName, tmplPath: `${skillName}/SKILL.md.tmpl`, host: 'codex', paths: HOST_PATHS.codex };
}

// First ```bash fence of a rendered resolver section.
function firstBashBlock(rendered: string): string {
  const m = rendered.match(/```bash\n([\s\S]*?)```/);
  if (!m) throw new Error('no bash block in rendered section');
  return m[1];
}

const DESIGN_PREFLIGHT = firstBashBlock(generateDesignSetup(codexCtx('design-shotgun')));
const MAKE_PDF_PREFLIGHT = firstBashBlock(generateMakePdfSetup(codexCtx('make-pdf')));

// A minimal gstack source tree: the two built binaries plus make-pdf's own
// SKILL.md, which must NOT leak into a Codex-scanned root.
function makeSource(sandbox: string): string {
  const src = path.join(sandbox, 'gstack');
  for (const [rel, body] of [
    ['design/dist/design', '#!/bin/sh\necho design\n'],
    ['make-pdf/dist/pdf', '#!/bin/sh\necho pdf\n'],
  ] as const) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), body, { mode: 0o755 });
  }
  fs.mkdirSync(path.join(src, 'design', 'src'), { recursive: true });
  fs.writeFileSync(path.join(src, 'make-pdf', 'SKILL.md'), '---\nname: make-pdf\n---\n');
  return src;
}

function run(cmd: string, opts: { cwd: string; env?: Record<string, string> }) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', ...opts.env };
  return spawnSync('bash', ['-c', cmd], { cwd: opts.cwd, encoding: 'utf-8', timeout: 30000, env });
}

interface Layout {
  rootDir: string;
  /** cwd + env for a preflight run that should hit this root */
  preflight: { cwd: string; env: Record<string, string> };
}

const BUILDERS: Record<string, (sandbox: string, src: string) => { script: string; layout: Layout }> = {
  'codex global root': (sandbox, src) => {
    const rootDir = path.join(sandbox, 'home', '.codex', 'skills', 'gstack');
    const outside = path.join(sandbox, 'not-a-repo');
    fs.mkdirSync(outside, { recursive: true });
    return {
      script: [
        extractFunction('create_codex_runtime_root'),
        `create_codex_runtime_root "${src}" "${rootDir}"`,
      ].join('\n'),
      layout: {
        rootDir,
        // Global fallback: no repo, only the env vars Codex would carry.
        preflight: {
          cwd: outside,
          env: {
            HOME: path.join(sandbox, 'home'),
            GSTACK_DESIGN: path.join(rootDir, 'design', 'dist'),
            GSTACK_MAKE_PDF: path.join(rootDir, 'make-pdf', 'dist'),
          },
        },
      },
    };
  },
  'agents sidecar': (sandbox, src) => {
    const repo = path.join(sandbox, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: repo, timeout: 30000 });
    return {
      script: [
        `SOURCE_GSTACK_DIR="${src}"`,
        extractFunction('_sidecar_root_user_owned'),
        extractFunction('create_agents_sidecar'),
        `create_agents_sidecar "${repo}"`,
      ].join('\n'),
      layout: {
        rootDir: path.join(repo, '.agents', 'skills', 'gstack'),
        // Local-first path: inside the repo, global env vars point nowhere.
        preflight: {
          cwd: repo,
          env: {
            HOME: path.join(sandbox, 'home'),
            GSTACK_DESIGN: path.join(sandbox, 'missing'),
            GSTACK_MAKE_PDF: path.join(sandbox, 'missing'),
          },
        },
      },
    };
  },
};

describe.skipIf(process.platform === 'win32')('setup: Codex roots expose design and make-pdf binaries (#1159)', () => {
  test('generated Codex preflights use the local sidecar first, then $GSTACK_DESIGN / $GSTACK_MAKE_PDF', () => {
    expect(DESIGN_PREFLIGHT).toContain('.agents/skills/gstack/design/dist/design');
    expect(DESIGN_PREFLIGHT).toContain('D="$GSTACK_DESIGN/design"');
    expect(MAKE_PDF_PREFLIGHT).toContain('.agents/skills/gstack/make-pdf/dist/pdf');
    expect(MAKE_PDF_PREFLIGHT).toContain('P="$GSTACK_MAKE_PDF/pdf"');
  });

  for (const [name, build] of Object.entries(BUILDERS)) {
    for (const isWindows of ['0', '1'] as const) {
      const mode = isWindows === '1' ? 'Windows copy install' : 'symlink install';
      test(`${name} (${mode}): design and make-pdf preflights report READY`, () => {
        const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-codex-dist-'));
        try {
          const src = makeSource(sandbox);
          const { script, layout } = build(sandbox, src);
          const b = run(`IS_WINDOWS=${isWindows}\n${extractFunction('_link_or_copy')}\n${script}`, { cwd: sandbox });
          expect(b.stderr).toBe('');
          expect(b.status).toBe(0);

          const designLst = fs.lstatSync(path.join(layout.rootDir, 'design', 'dist'));
          expect(designLst.isSymbolicLink()).toBe(isWindows === '0');
          // dist/ only: make-pdf's SKILL.md and design sources stay out of the root.
          expect(fs.existsSync(path.join(layout.rootDir, 'make-pdf', 'SKILL.md'))).toBe(false);
          expect(fs.existsSync(path.join(layout.rootDir, 'design', 'src'))).toBe(false);

          const d = run(DESIGN_PREFLIGHT, layout.preflight);
          expect(d.stdout).toContain('DESIGN_READY:');
          expect(d.stdout).not.toContain('DESIGN_NOT_AVAILABLE');

          const p = run(MAKE_PDF_PREFLIGHT, layout.preflight);
          expect(p.stdout).toContain('MAKE_PDF_READY:');
          expect(p.stdout).not.toContain('MAKE_PDF_NOT_AVAILABLE');
        } finally {
          fs.rmSync(sandbox, { recursive: true, force: true });
        }
      });
    }
  }

  // Negative control: the pre-fix Codex root (browse only, no design/make-pdf
  // dist) must fail both preflights, proving the READY cells are not vacuous.
  test('a Codex root without design/dist and make-pdf/dist reports NOT_AVAILABLE (pre-fix layout)', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-codex-dist-'));
    try {
      const rootDir = path.join(sandbox, 'home', '.codex', 'skills', 'gstack');
      fs.mkdirSync(path.join(rootDir, 'browse'), { recursive: true });
      const outside = path.join(sandbox, 'not-a-repo');
      fs.mkdirSync(outside, { recursive: true });
      const env = {
        HOME: path.join(sandbox, 'home'),
        GSTACK_DESIGN: path.join(rootDir, 'design', 'dist'),
        GSTACK_MAKE_PDF: path.join(rootDir, 'make-pdf', 'dist'),
      };
      expect(run(DESIGN_PREFLIGHT, { cwd: outside, env }).stdout).toContain('DESIGN_NOT_AVAILABLE');
      expect(run(MAKE_PDF_PREFLIGHT, { cwd: outside, env }).stdout).toContain('MAKE_PDF_NOT_AVAILABLE');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
