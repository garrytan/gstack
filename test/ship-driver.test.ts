/**
 * GSTA-167 PR 5: ship/DRIVER.md is the compact, host-neutral entry a parent
 * agent reads to run an unattended /ship instead of ship/SKILL.md (61 KB) plus
 * its sections. Its contract, derived from the skeleton rather than a hand list:
 * every step id ship/SKILL.md and its sections name, and every gate or result
 * code the skeleton prints, appears in the driver or in a bin the driver invokes;
 * every STOP anchor resolves to a real heading; the render stays at or under
 * 12 KB, host-neutral and fresh against the generator.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DELEGATE_SEGMENT_CALL, SHIP_STEPS } from '../lib/ship-budget';
import { RESULT_CODES } from '../lib/result-codes';
import { SHIP_DRIVER_STOPS } from '../scripts/resolvers/ship-driver';
import { runGeneration, SHIP_DRIVER_RELPATH } from '../scripts/gen-skill-docs';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const doc = read(SHIP_DRIVER_RELPATH);
const skill = read('ship/SKILL.md');
const body = skill.slice(skill.indexOf('\n# Ship: '));
const sectionFiles: string[] = JSON.parse(read('ship/sections/manifest.json')).sections
  .filter((s: { runner_only?: boolean }) => !s.runner_only).map((s: { file: string }) => `ship/sections/${s.file}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-driver-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const STEP_ID = String.raw`\d+(?:\.\d+)*(?:-[A-Z])?`;
const headingSteps = (text: string) => [...text.matchAll(new RegExp(`^#{2,4} Step (${STEP_ID})[:\s]`, 'gm'))].map(m => m[1]!);
/** Step ids a text names: "Step 9.4", "Steps 9, 9.1 and 9.2"; a range ("Steps 1-3") expands over SHIP_STEPS only when asked. */
function stepsNamed(text: string, expandRanges: boolean): Set<string> {
  const out = new Set<string>();
  const sep = '(?:, and |, | and |–|-(?=\\d))';
  for (const m of text.matchAll(new RegExp(`\\bSteps?\\s+(${STEP_ID}(?:${sep}${STEP_ID})*)`, 'g'))) {
    const parts = m[1]!.split(/(, and |, | and |–|-(?=\d))/);
    for (let i = 0; i < parts.length; i += 2) {
      out.add(parts[i]!);
      const range = parts[i + 1] === '–' || parts[i + 1] === '-';
      if (!range || !expandRanges) continue;
      const from = SHIP_STEPS.indexOf(parts[i] as any), to = SHIP_STEPS.indexOf(parts[i + 2] as any);
      for (const s of SHIP_STEPS.slice(Math.max(0, from), to + 1)) out.add(s);
    }
  }
  return out;
}

/** The bins the driver runs, each with the source of its bin file and the modules it imports (two levels). */
const invoked = [...new Set([...doc.matchAll(/\bgstack-[a-z0-9-]+/g)].map(m => m[0]))].filter(n => fs.existsSync(path.join(ROOT, 'bin', n)));
function binSource(name: string): string {
  const seen = new Set<string>();
  const texts: string[] = [];
  const visit = (file: string, depth: number) => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    texts.push(text);
    if (depth === 0) return;
    for (const m of text.matchAll(/from '(\.{1,2}\/[^']+)'/g)) visit(path.resolve(path.dirname(file), m[1]!.endsWith('.ts') ? m[1]! : `${m[1]}.ts`), depth - 1);
  };
  visit(path.join(ROOT, 'bin', name), 2);
  return texts.join('\n');
}
const bins = invoked.map(binSource).join('\n');

/** GitHub's heading anchors, plus explicit <a id> anchors. */
function anchors(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/^#{1,6} (.+)$/gm)) out.add(m[1]!.toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/ /g, '-'));
  for (const m of text.matchAll(/<a id="([^"]+)"><\/a>/g)) out.add(m[1]!);
  return out;
}

describe('ship/DRIVER.md covers the skeleton', () => {
  test('every step id in ship/SKILL.md and its sections appears in the driver or in a bin the driver invokes', () => {
    const skeleton = new Set([...SHIP_STEPS, ...headingSteps(skill), ...sectionFiles.flatMap(f => headingSteps(read(f)))]);
    expect(skeleton.size).toBeGreaterThanOrEqual(SHIP_STEPS.length + 8);
    const covered = new Set([...stepsNamed(doc, false), ...stepsNamed(bins, true)]);
    expect([...skeleton].filter(s => !covered.has(s))).toEqual([]);
  });

  test('every gate and result code the skeleton prints appears in the driver or in a bin it invokes', () => {
    const codes = new Set([
      ...[...body.matchAll(/`([A-Z][A-Z0-9_]+):/g)].map(m => `${m[1]}:`),
      ...[...body.matchAll(/^\s*- \*\*([A-Z][A-Z0-9_]+)\*\* →/gm)].map(m => m[1]!),
      ...[...body.matchAll(/^\| ([A-Z][A-Z-]+(?:\/[A-Z][A-Z-]+)*)(?::| \()/gm)].flatMap(m => m[1]!.split('/')),
      ...[...body.matchAll(/`[A-Z][A-Z0-9_]+: ([A-Z][A-Z0-9_]+)`/g)].map(m => m[1]!),
      ...Object.keys(RESULT_CODES).filter(k => new RegExp(`\\b${k}\\b`).test(body)),
    ]);
    for (const code of ['STOP:', 'NEXT:', 'CARRY:', 'GSTACK_RESULT:', 'ALREADY_BUMPED', 'NO_VERSION', 'FRESH', 'ZERO-RUN', 'ALREADY_PUSHED', 'QUEUE_RECEIPT_STALE']) expect(codes).toContain(code);
    expect([...codes].filter(c => !doc.includes(c) && !bins.includes(c))).toEqual([]);
  });

  test('every gate the skeleton holds keeps a driver line: tests, pregate, receipt, push, queue, delegation', () => {
    for (const line of ['ZERO-RUN', 'gstack-ship-release finish', 'gstack-pregate clear', 'One re-audit at most', 'gstack-ship-receipt docs-caps',
      'Step 14.5, every ship', 'never clean', 'gstack-ship-receipt write', '`SHIP_RECEIPT:`', 'gstack-ship-receipt result --pr <n>',
      'gstack-ship-queue ready --pr <n>', 'Never force-push', `--delegate measured`, `${DELEGATE_SEGMENT_CALL / 1000}k or more above the host floor`]) {
      expect(doc, line).toContain(line);
    }
  });

  // Value: protects=a driven /ship sends every reviewer the brief ship/SKILL.md sends (GSTA-167 no-loss round 3: shortened reviewer context lost 9 of 19 blockers); fails_when=a review phase paraphrases its section instead of running it, or the driver copies a reviewer prompt line it could let drift;
  //   why_new=the coverage tests above check step ids and codes only; seam=none; no_claim=that the parent reads the section
  test('the review phases run their sections as written and the driver restates no reviewer prompt', () => {
    for (const [phase, sections] of [['## 3. Audits', ['test-coverage', 'plan-completion']], ['## 4. Review', ['review-army']], ['## 5. Adversarial', ['adversarial']]] as const) {
      const text = doc.slice(doc.indexOf(phase), doc.indexOf('\n## ', doc.indexOf(phase) + 1));
      for (const sec of sections) expect(text, phase).toContain(`\`sections/${sec}.md\``);
      expect(text, phase).toMatch(/as\s+(?:they are\s+)?written/);
    }
    expect(doc).toContain('read `sections/documentation.md` and run its audit as written');
    expect(doc).toContain('never shortens a reviewer\'s brief');
    const prompts = ['review-army', 'adversarial', 'test-coverage', 'plan-completion', 'documentation']
      .flatMap(sec => [...read(`ship/sections/${sec}.md`).matchAll(/````?text\n([\s\S]*?)\n````?/g)].flatMap(m => m[1]!.split('\n')))
      .map(l => l.trim()).filter(l => l.length >= 40);
    expect(prompts.length).toBeGreaterThan(20);
    expect(prompts.filter(l => doc.includes(l))).toEqual([]);
  });

  test('the driver says when to fall back to ship/SKILL.md and never reads sections up front', () => {
    expect(doc).toContain('A STOP or decision this file does not cover: read `ship/SKILL.md` at that step');
    expect(doc).toContain('never\nup front');
  });
});

describe('STOP anchors', () => {
  test('every STOP row is rendered and its anchor names a heading that exists', () => {
    for (const s of SHIP_DRIVER_STOPS) {
      expect(doc).toContain(`- ${s.when}: \`${s.read}\``);
      const [file, anchor] = s.read.split('#');
      const text = read(path.join('ship', file!));
      expect(anchors(text).has(anchor!), s.read).toBe(true);
    }
  });

  test('the anchor reader matches GitHub on the headings the driver uses', () => {
    expect(anchors('## Step 9.4: Fix-First and persistence\n## Step 14: TODOS.md (auto-update)\n## Step 9.1: Review Army — Specialist Dispatch'))
      .toEqual(new Set(['step-94-fix-first-and-persistence', 'step-14-todosmd-auto-update', 'step-91-review-army--specialist-dispatch']));
  });
});

describe('shape', () => {
  test('at most 12 KB, no harness vocabulary, and every bin it names exists', () => {
    expect(Buffer.byteLength(doc)).toBeLessThanOrEqual(12 * 1024);
    for (const term of ['AskUserQuestion', 'Agent tool', 'PreToolUse', 'SessionStart', '~/.claude', 'run_in_background']) expect(doc).not.toContain(term);
    const named = [...new Set([...doc.matchAll(/\bgstack-[a-z0-9-]+/g)].map(m => m[0]))];
    expect(named.filter(n => !fs.existsSync(path.join(ROOT, 'bin', n)))).toEqual([]);
    expect(invoked).toEqual(expect.arrayContaining(['gstack-ship-preflight', 'gstack-ship-release', 'gstack-ship-budget', 'gstack-review-plan', 'gstack-ship-receipt', 'gstack-ship-queue']));
  });

  test('the Capy skill points /ship at the driver with the autoplan line\'s shape', () => {
    const capy = read('capy/skill/gstack/SKILL.md');
    for (const s of ['autoplan', 'ship']) {
      expect(capy).toContain(`For \`/${s}\` driven from Capy, read \`${s}/DRIVER.md\` in the checkout (\`~/.local/share/gstack/${s}/DRIVER.md\`)`);
      expect(capy).toContain(`A checkout without that file predates it; follow its \`${s}/SKILL.md\` instead`);
    }
    expect(capy).toContain('--delegate measured');
  });
});

describe('generator inventory', () => {
  test('a fresh render carries ship/DRIVER.md as a claude asset, byte-identical to the committed file', async () => {
    const written = await runGeneration({ host: 'claude', outputRoot: tmp, contentLinkRoot: null });
    expect(written.artifacts).toContainEqual({ relativePath: SHIP_DRIVER_RELPATH, kind: 'asset', host: 'claude' });
    expect(fs.readFileSync(path.join(tmp, SHIP_DRIVER_RELPATH), 'utf8')).toBe(doc);
    const dry = await runGeneration({ host: 'claude', dryRun: true });
    expect(dry.diagnostics.filter(d => d.relativePath === SHIP_DRIVER_RELPATH)).toEqual([]);
  }, 120_000);
});
