/**
 * Source assertions for the opt-in /design-review --build loop: it routes
 * before the audit's clean-tree stop but after nothing that the browser setup
 * needs, never commits, stashes or asks, caps editing at three rounds, reads
 * the lint verdict from JSON and leaves the one DESIGN_BUILD line to
 * gstack-design-build. The seven items live in one place, and each adoption
 * surface recommends the loop without making it a READY prerequisite.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TMPL = read('design-review/SKILL.md.tmpl');
const SKILL = read('design-review/SKILL.md');
const SECTION = read('design-review/sections/build-loop.md.tmpl');

describe('/design-review --build routing (T14, T38, T5)', () => {
  test('the dispatch comes before the clean-tree check and its pointer after the hard rules', () => {
    const dispatch = TMPL.indexOf('**`--build`:**');
    const clean = TMPL.indexOf('**Check for clean working tree:**');
    const browser = TMPL.indexOf('**Check the Aside browser:**');
    expect(dispatch).toBeGreaterThan(0);
    expect(dispatch).toBeLessThan(clean);
    expect(clean).toBeLessThan(browser);
    expect(TMPL.slice(dispatch, clean)).toContain('skip the clean-tree check; run **Check the Aside browser**, then its STOP in Phases 1-6, not the audit.');
    const pointer = TMPL.indexOf('{{SECTION:build-loop}}');
    expect(TMPL.indexOf('{{DESIGN_HARD_RULES}}')).toBeLessThan(pointer);
    expect(pointer).toBeLessThan(TMPL.indexOf('{{SECTION:craft-audit}}'));
    expect(SKILL.indexOf('### Design Hard Rules')).toBeLessThan(SKILL.indexOf('> **STOP.**'));
    expect(SKILL.indexOf('> **STOP.**')).toBe(SKILL.indexOf('> **STOP.** Before a --build run'));
  });

  test('the catalog description and triggers name the build mode', () => {
    expect(/^description: .*--build checks UI while you build it/m.test(SKILL)).toBe(true);
    expect(SKILL).toMatch(/^  - check the UI I am building$/m);
  });
});

describe('the build-loop section (T7, T8, T17, T18, T29, T37)', () => {
  test('never commits, stashes, checks out, resets or asks', () => {
    for (const bad of [/git (commit|stash|checkout|reset|add)\b/, /AskUserQuestion/]) expect(SECTION).not.toMatch(bad);
    expect(SECTION).toContain('never asks');
  });

  test('preflight before any round, at most three editing rounds, then a read-only final pass bound by verify-start', () => {
    const at = (s: string) => { const i = SECTION.indexOf(s); expect([s, i >= 0]).toEqual([s, true]); return i; };
    expect(at('{{BIN_DIR}}/gstack-design-build preflight')).toBeLessThan(at('--run-dir "<run-dir>/round-N"'));
    expect(at('### 3. Rounds (three at most)')).toBeLessThan(at('Stop\nediting after round 3'));
    expect(at('{{BIN_DIR}}/gstack-design-build verify-start')).toBeLessThan(at('{{BIN_DIR}}/gstack-design-build receipt'));
    expect(SECTION).toContain('There is no\nfourth editing round without a written grant.');
  });

  test('the verdict is read from the lint JSON, never its exit status, and DESIGN_BUILD is printed by gstack-design-build only', () => {
    expect(SECTION).toContain('`app.verdict`');
    expect(SECTION).toContain('Never\n   read the lint\'s exit status as the result.');
    for (const bad of [/\$\?/, /exit code/i, /-eq 0/, /echo ["']?DESIGN_BUILD/]) expect(SECTION).not.toMatch(bad);
    expect(SECTION).toContain('Run the printed `LINT_CMD:` line exactly.');
  });

  test('each bash block stands alone: the first resolves the state root and slug, later ones name the helper and the run path literally', () => {
    const blocks = [...SECTION.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(blocks[0]).toContain('SLUG=$(~/.claude/skills/gstack/bin/gstack-slug --get SLUG 2>/dev/null)');
    expect(blocks[0]).toContain('GSTACK_STATE_ROOT=$(~/.claude/skills/gstack/bin/gstack-paths --get GSTACK_STATE_ROOT); : "${GSTACK_STATE_ROOT:?');
    for (const b of blocks.slice(1)) {
      expect(b).not.toMatch(/\$(_DB|RUN|SLUG|GSTACK_STATE_ROOT)\b/);
      expect(b).toContain('{{BIN_DIR}}/gstack-design-build');
    }
    expect(SECTION).toContain("Save it where the driver can write (Aside's\n   session directory; /tmp for $B), then cp it to the `SHOT:` path.");
  });

  test('the seven items are single-sourced in this section', () => {
    const items = ['Row padding holds with one line and with two', 'Adjacent rows have breathing room', 'Comfortable hit areas', 'Nothing overflows at 375', 'Status notes sit on their own line with a warning treatment'];
    for (const item of items) expect(SECTION).toContain(item);
    const others = fs.readdirSync(ROOT, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && /\.(md|tmpl)$/.test(d.name) && !d.parentPath.includes('node_modules') && !d.parentPath.includes('.git'))
      .map((d) => path.relative(ROOT, path.join(d.parentPath, d.name)))
      .filter((f) => !/^design-review\/sections\/build-loop\.md(\.tmpl)?$/.test(f) && !/^\.[\w-]+\/skills\//.test(f) && !f.startsWith('test/'));
    const carriers = others.filter((f) => items.some((i) => fs.readFileSync(path.join(ROOT, f), 'utf8').includes(i)));
    expect(carriers).toEqual([]);
  });
});

describe('adoption surfaces recommend the loop, never require it (T5, T31)', () => {
  test('lane card, routing block, docs/skills.md and /design-html', () => {
    const lane = read('capy/skill/gstack/lane-card.md');
    expect(lane).toContain('UI work (recommended, never a READY prerequisite)');
    expect(lane).toContain('`install.sh --check --for design-review` and `gstack-browser-ensure`');
    expect(lane).toContain('A start that prints `GSTACK_RESULT: skill=design-review status=refused` is `DESIGN_BUILD: unrendered code=INSTALL`');
    expect(read('bin/gstack-skill-start')).toContain('- Building UI → once it renders, invoke /design-review --build <preview url> (opt-in)');
    expect(read('docs/skills.md')).toContain('**`--build` (opt-in, for UI you are building).**');
    expect(read('design-html/SKILL.md.tmpl')).toContain('recommend (opt-in, never required) `/design-review --build <preview url>`');
    expect(read('design-html/SKILL.md')).toContain('/design-review --build <preview url>');
  });
});
