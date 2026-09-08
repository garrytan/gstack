/** Outside reviews follow harness identity, including lazily loaded workflows. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ALL_HOST_CONFIGS } from '../hosts';
import { ALL_MODEL_NAMES } from '../scripts/models';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { outsideVoiceFor, outsideVoiceCommand } from '../scripts/resolvers/outside-voice';
import { RESOLVERS } from '../scripts/resolvers';
import { installOutsideReviewFixture } from './helpers/outside-voice-fixture';

const ROOT = resolve(import.meta.dir, '..');
let output: string;

function skillDir(host: typeof ALL_HOST_CONFIGS[number], skill: string): string {
  return host.name === 'claude'
    ? join(output, skill === 'gstack' ? '' : skill)
    : join(output, host.hostSubdir, 'skills', skill === 'gstack' ? 'gstack' : `gstack-${skill}`);
}

function readUnion(dir: string): string {
  const sectionDir = join(dir, 'sections');
  return readFileSync(join(dir, 'SKILL.md'), 'utf8')
    + (existsSync(sectionDir) ? readdirSync(sectionDir).sort()
      .filter(file => file.endsWith('.md'))
      .map(file => '\n' + readFileSync(join(sectionDir, file), 'utf8')).join('') : '');
}

beforeAll(() => {
  output = mkdtempSync(join(tmpdir(), 'gstack-outside-routing-'));
  const generated = Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'all', '--out-dir', output], {
    cwd: ROOT, stdout: 'pipe', stderr: 'pipe', timeout: 120_000,
  });
  if (generated.exitCode !== 0) throw new Error(generated.stderr.toString());
});
afterAll(() => { if (output) rmSync(output, { recursive: true, force: true }); });

describe('outside-review host and model matrix', () => {
  for (const host of ALL_HOST_CONFIGS) {
    test(`${host.name}: only its own wrapper is excluded`, () => {
      expect(existsSync(join(skillDir(host, 'codex'), 'SKILL.md'))).toBe(host.name !== 'codex');
      expect(existsSync(join(skillDir(host, 'claude-code'), 'SKILL.md'))).toBe(host.name !== 'claude');
      expect(existsSync(join(skillDir(host, 'claude'), 'SKILL.md'))).toBe(false);
      for (const wrapper of ['codex', 'claude-code']) {
        if (!existsSync(join(skillDir(host, wrapper), 'SKILL.md'))) continue;
        const text = readUnion(skillDir(host, wrapper));
        // Keep all three modes reachable, including carved section files.
        expect(text).toMatch(/\breview\b/i);
        expect(text).toMatch(/\bchallenge\b/i);
        expect(text).toMatch(/\bconsult\b/i);
      }
    });

    test(`${host.name}: every model overlay retains the same provider and routing`, () => {
      const providers = ALL_MODEL_NAMES.map(model => {
        const ctx: TemplateContext = { host: host.name, model, skillName: 'review', tmplPath: 'review/SKILL.md.tmpl', paths: HOST_PATHS[host.name] };
        const voice = outsideVoiceFor(ctx);
        expect(voice.id).toBe(host.name === 'codex' ? 'claude-code' : 'codex');
        expect(voice.skillName).toBe(host.name === 'codex' ? 'claude-code' : 'codex');
        const command = outsideVoiceCommand(ctx, { promptFile: '"$PROMPT_FILE"', timeoutMs: 120_000 });
        expect(command).toContain(host.name === 'codex' ? 'gstack-claude-code' : 'codex');
        if (host.name === 'codex') expect(command).not.toMatch(/\bcodex\s+(?:exec|review)\s/);
        return RESOLVERS.OUTSIDE_VOICE_ROUTING(ctx);
      });
      expect(new Set(providers).size).toBe(1);
    });

    test(`${host.name}: generic and explicit second-opinion routing is installed`, () => {
      const router = readUnion(skillDir(host, 'gstack'));
      expect(router).toMatch(/second opinion/i);
      expect(router).toContain(host.name === 'codex' ? 'claude-code' : 'codex');
      expect(router).toMatch(/explicit/i);
      expect(router).toMatch(/(?:do not|never|without).*?(?:substitut|switch|replac)|(?:keep|honor|respect).*?(?:provider|request)/i);
    });
  }
});

describe('generated automatic review coverage', () => {
  const skills = ['office-hours', 'plan-ceo-review', 'plan-eng-review', 'plan-devex-review', 'plan-design-review', 'design-review', 'design-consultation', 'review', 'ship', 'document-release', 'autoplan', 'spec'];
  for (const skill of skills) {
    test(`Codex /${skill} invokes Claude Code, including lazy sections`, () => {
      const host = ALL_HOST_CONFIGS.find(h => h.name === 'codex')!;
      const text = readUnion(skillDir(host, skill));
      expect(text).toContain('gstack-claude-code');
      // Prose about the CLI is permitted; executable codex review commands are not.
      expect(shellLines(text).filter(line => /\bcodex\s+(?:exec|review)\b/.test(line))).toEqual([]);
      expect(text).toContain('Claude Code');
    });
  }

  test('Codex still omits Review Army specialist dispatch', () => {
    const host = ALL_HOST_CONFIGS.find(h => h.name === 'codex')!;
    for (const skill of ['review', 'ship']) {
      expect(readUnion(skillDir(host, skill))).not.toContain('Step 4.5: Review Army — Specialist Dispatch');
    }
  });
});

/** Only shell fences count as invocation sites: explanatory prose cannot spawn. */
function shellLines(text: string): string[] {
  let inShell = false;
  return text.split('\n').filter(line => {
    if (/^```(?:bash|sh|shell)\s*$/.test(line)) { inShell = true; return false; }
    if (/^```\s*$/.test(line)) { inShell = false; return false; }
    return inShell && !/^\s*#/.test(line);
  });
}

function templateFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name === 'sections') return templateFiles(full);
    return entry.isFile() && entry.name.endsWith('.tmpl') ? [full] : [];
  });
}

test('automatic workflow templates delegate reviewer commands to shared resolvers', () => {
  const skills = ['office-hours', 'plan-ceo-review', 'plan-eng-review', 'plan-devex-review', 'plan-design-review', 'design-review', 'design-consultation', 'design-shotgun', 'review', 'ship', 'document-release', 'autoplan', 'spec'];
  const violations: string[] = [];
  for (const skill of skills) {
    for (const file of templateFiles(join(ROOT, skill))) {
      for (const line of shellLines(readFileSync(file, 'utf8'))) {
        // /spec's --execute worker implements the filed spec; it is not a reviewer.
        if (file.endsWith('spec/sections/gate-and-file.md.tmpl') && line.trim() === 'cat "$ARCHIVE_PATH" | (cd "$SPAWN_PATH" && claude -p 2>&1) &') continue;
        if (/\bcodex\s+(?:exec|review)\b|\bclaude\s+(?:-p|--print)\b|\bgstack-claude-code\s+--/.test(line)) {
          violations.push(`${file.slice(ROOT.length + 1)}: ${line.trim()}`);
        }
      }
    }
  }
  expect(violations).toEqual([]);
});

for (const host of ['claude', 'codex'] as const) {
  test(`${host}: live E2E installs an executable extracted workflow from the actual host render`, () => {
    const repo = mkdtempSync(join(tmpdir(), 'gstack-outside-fixture-'));
    try {
      const dir = installOutsideReviewFixture(output, host, repo, ROOT);
      const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
      expect(text).toContain('Step 0: Detect platform and base branch');
      expect(text).toContain('Step 3: Get the diff');
      expect(text).toContain('Step 5.7: Adversarial review (always-on)');
      expect(text).toContain(host === 'codex' ? 'gstack-claude-code' : 'codex exec');
      expect(text).not.toContain('## Preamble (run first)');
      expect(text.match(/^name:/gm)).toHaveLength(1);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
}
