/** Execute each outside-review fence with no state from a previous shell. */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { outsideVoiceCommand, outsideVoiceFor, outsideVoicePreflight, outsideVoiceInvocation } from '../scripts/resolvers/outside-voice';
import { generateAdversarialStep, generateCodexDocReview, generateCodexPlanReview } from '../scripts/resolvers/outside-voice-steps';
import { validateOutsideReview } from '../lib/outside-review-result';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { ALL_HOST_CONFIGS } from '../hosts';
import { expectMentions, expectTokens } from './helpers/prompt-structure';

const ROOT = path.resolve(import.meta.dir, '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-outside-preflight-'));
afterAll(() => fs.rmSync(TEMP, { recursive: true, force: true }));

test('adversarial outside failures retain the required native pass without duplicate dispatch', () => {
  for (const host of ALL_HOST_CONFIGS) {
    for (const skillName of ['ship', 'review']) {
      const ctx: TemplateContext = { host: host.name, skillName, tmplPath: `${skillName}/SKILL.md.tmpl`, paths: HOST_PATHS[host.name] };
      const preflight = outsideVoicePreflight(ctx, { disabledBehavior: 'codex-only' });
      expect(preflight).toMatch(/(?:do not dispatch a duplicate|without duplicating it)/);
      expect(preflight).not.toMatch(/fall(?:ing)? back to (?:a|the) .*subagent/i);
      const output = generateAdversarialStep(ctx);
      expect(output).toContain(skillName === 'ship' ? 'adversarial subagent (on `DISPATCH: adversarial-native`)' : 'adversarial subagent (always runs)');
      expectMentions(output, [['do not', 'dispatch', 'retain']], 'output');
      expect(output.match(/Retain the required native pass without duplicating it; it cannot complete outside coverage\./g)).toHaveLength(2);
      expect(output).not.toContain("Use the caller's fallback");
      expectMentions(output, [['only', 'non-blocking', 'adversarial']], 'output');
      expect(output).toContain('GATE: MISSING COVERAGE');
      // C2: the gate names what missing coverage does instead of an unnamed "existing user decision flow".
      if (output.includes('Only a completed response with severity tags')) {
        expect(output).toContain('→ GATE: MISSING COVERAGE; no fix question.');
        expect(outsideVoiceInvocation(ctx)).toContain('missing coverage is never clean/PASS');
        expect(output).not.toContain('preserve the existing user decision flow');
      }
      expect(outsideVoiceInvocation(ctx)).toContain("Use the caller's fallback; missing coverage is never clean/PASS.");
      const disabled = outsideVoicePreflight(ctx, { disabledBehavior: 'skip-all' });
      expect(disabled).toMatch(/(?:do NOT fall back|Disabled ends this entire extra review step)/);
    }
  }
});

test('ship design-lite honors codex_reviews like every other opt-in caller (#3102)', () => {
  for (const host of ALL_HOST_CONFIGS) {
    const ctx: TemplateContext = { host: host.name, skillName: 'ship', tmplPath: 'ship/SKILL.md.tmpl', paths: HOST_PATHS[host.name] };
    const output = outsideVoicePreflight(ctx, { disabledBehavior: 'opt-in' });
    expect(output).not.toContain('No additional opt-in is needed');
    expect(output).not.toContain('_OUTSIDE_CFG=enabled');
    expect(output).toContain('get --stored codex_reviews');
    expect(output).toContain("`CODEX_MODE: disabled` or a send's `consent_missing` line: `codex_reviews` is off or unreadable; do not ask; record `outside_status: disabled`.");
    const other = outsideVoicePreflight({ ...ctx, skillName: 'review' }, { disabledBehavior: 'opt-in' });
    expect(other).not.toContain('_OUTSIDE_CFG=enabled');
    expect(output.match(/```bash\n([\s\S]*?)\n```/)![1]).toBe(other.match(/```bash\n([\s\S]*?)\n```/)![1]);
  }
});

test('CEO and Eng describe the actual disabled route and completion validator', () => {
  for (const host of ALL_HOST_CONFIGS) {
    for (const skillName of ['plan-ceo-review', 'plan-eng-review']) {
      const ctx: TemplateContext = { host: host.name, skillName, tmplPath: `${skillName}/SKILL.md.tmpl`, paths: HOST_PATHS[host.name] };
      const output = generateCodexPlanReview(ctx);
      expect(output).not.toContain('Skip this section entirely');
      if (skillName === 'plan-ceo-review') {
        expectTokens(output.replace(/\s+/g, ' '), ['`disabled`'], 'output.replace(/\s+/g,  )');
        expect(output).toContain('"outside_status":"disabled"');
      } else expect(output).toContain('persist `outside_status: disabled` with the guarded');
      const promptEnd = output.indexOf('\n<plan content>"');
      const prompt = output.slice(output.lastIndexOf('\n"', promptEnd) + 1, promptEnd);
      expect(prompt.startsWith('"')).toBe(true);
      expect(prompt.split('\n')[0]).toContain('.claude/skills/');
      expect(prompt).toContain('End with Recommendation: <action> because <specific reason>');
      expectMentions(prompt, [['no', 'findings', 'explain']], 'prompt');
      const invocation = outsideVoiceInvocation(ctx);
      expect(invocation).toContain('missing Recommendation: <action> because <reason> markers');
      expect(invocation).not.toContain('score/severity/completion');
      if (skillName === 'plan-eng-review') {
        const routing = output.slice(output.indexOf('**Outcome routing:**'), output.indexOf('**Disabled is a terminal branch'));
        expect(routing).toMatch(/\| Disabled \|[^\n]*No prompt, outside process or native replacement\./);
        expect(routing).toMatch(/\| Any other mode \(`not_installed`, `under_current_harness`\) \|[^\n]*Native fallback\./);
        expect(routing).toMatch(/\| Outside execution or output validation fails \|[^\n]*finish termination, then use Native fallback\./);
        expect(routing).toMatch(/\| Native fallback unavailable or fails \|[^\n]*No clean-review credit\./);
        const fallback = output.slice(output.indexOf('**Native fallback'), output.indexOf('Dispatch via the Agent tool'));
        expectMentions(fallback.replace(/\s+/g, ' '), [['no', 'immediately', 'replacement']], 'fallback.replace(/\s+/g,  )');
        const bounded = output.slice(output.indexOf('**Bounded outside-voice wait'), output.indexOf('**Cross-model tension:**'));
        expectMentions(bounded, [['never', 'supplies', 'coverage']], 'bounded');
        expect(output).toContain('A completed native fallback uses SOURCE=in-host, OUTSIDE_STATUS=unavailable, and STATUS=clean or issues_found from its findings');
        expect(output).toContain('"unavailable" if neither reviewer completed');
        expectMentions(output, [['never', 'coverage', 'missing']], 'output');
        // Compact prose must retain the actual wrong-harness execution guard.
        expect(invocation).toContain('exit 78');
        expect(invocation.indexOf('exit 78')).toBeLessThan(invocation.indexOf('_OUTSIDE_TMP=$(mktemp'));
      } else {
        const prose = output.replace(/\s+/g, ' ');
        const fallback = prose.slice(prose.indexOf('**Native fallback —'), prose.indexOf('Dispatch via the Agent tool'));
        expectMentions(fallback, [['before', 'immediately', 'dispatch']], 'fallback');
        expect(fallback).toContain('`CODEX_MODE: disabled`, return to **Record the disabled outcome** without dispatching');
        expectMentions(prose, [['never', 'replacement', 'rechecks']], 'prose');
        expectMentions(prose, [['never', 'supplies', 'coverage']], 'prose');
        expect(invocation).toContain('exit 78');
        expect(invocation.indexOf('exit 78')).toBeLessThan(invocation.indexOf('_OUTSIDE_TMP=$(mktemp'));
      }
    }
  }
  expect(validateOutsideReview('Recommendation: proceed because no findings remain.', 'review').completed).toBe(true);
  expect(validateOutsideReview('SCORE: 10\nAMBIGUITIES: NONE', 'review').completed).toBe(false);
  expect(validateOutsideReview('Recommendation: proceed', 'review').completed).toBe(false);
});

// Value: protects=the plan-review run header offers only CODEX_MODE values its own preflight prints (gates 40477638211 and
// 40454750574 judged "(or unverified)" a branch nothing can enter), while the doc review keeps "(or unverified)" exactly where
// its codex preflight can print it; fails_when=a run header admits a mode no fence echoes or assigns, the routing row stops
// naming the non-ready modes the fence prints, or the doc review loses the branch on a host whose preflight still prints it;
// why_new=the routing-row pins above check one row's wording, not that the header, the routing row and the fence agree on the
// mode set; seam=none; no_claim=the judged clarity of the surrounding prose.
test('plan-review and doc-review run headers admit only the CODEX_MODE values their preflight prints', () => {
  const fenceModes = (output: string) => [...new Set([...output.matchAll(/\`\`\`bash\n([\s\S]*?)\n\`\`\`/g)]
    .flatMap(fence => [...fence[1].matchAll(/(?:echo 'CODEX_MODE: |_CODEX_MODE=")([a-z_]+)/g)].map(match => match[1])))].sort();
  const headers = (output: string) => [...output.matchAll(/^\*\*If \`CODEX_MODE:[^\n]*$/gm)].map(match => match[0]);
  for (const host of ALL_HOST_CONFIGS) {
    for (const skillName of ['plan-ceo-review', 'plan-eng-review', 'plan-devex-review']) {
      const ctx: TemplateContext = { host: host.name, skillName, tmplPath: `${skillName}/SKILL.md.tmpl`, paths: HOST_PATHS[host.name] };
      const output = generateCodexPlanReview(ctx);
      const where = `${host.name} ${skillName}`;
      expect(fenceModes(output), where).toEqual(['disabled', 'not_installed', 'ready', 'under_current_harness']);
      expect(headers(output), where).toEqual([`**If \`CODEX_MODE: ready\` — run ${outsideVoiceFor(ctx).label}:**`]);
      const run = output.slice(output.indexOf(headers(output)[0]), output.indexOf('**Native fallback'));
      expect(run, where).not.toMatch(/\bor `?unverified|CODEX_MODE[^\n]*unverified/);
      if (skillName !== 'plan-devex-review') expect(run, where).toContain('Run this block for \`ready\`, in the one foreground Bash call');
      const routing = output.indexOf('**Outcome routing:**');
      if (routing >= 0) {
        const row = output.slice(routing).match(/^\| Any other mode \(([^)]*)\) \|/m);
        expect(row, where).not.toBeNull();
        expect(row![1].match(/\`([a-z_]+)\`/g)!.map(mode => mode.replaceAll('\`', '')).sort(), where)
          .toEqual(fenceModes(output).filter(mode => mode !== 'ready' && mode !== 'disabled'));
      }
    }
    const ctx: TemplateContext = { host: host.name, skillName: 'document-release', tmplPath: 'document-release/SKILL.md.tmpl', paths: HOST_PATHS[host.name] };
    const doc = generateCodexDocReview(ctx);
    const admitsUnverified = fenceModes(doc).includes('unverified');
    expect(admitsUnverified, host.name).toBe(outsideVoiceFor(ctx).id === 'codex');
    expect(headers(doc), host.name).toEqual([`**If \`CODEX_MODE: ready\`${admitsUnverified ? ' (or \`unverified\`)' : ''} — run ${outsideVoiceFor(ctx).label}:**`]);
  }
});

describe('own-harness review fallback instructions', () => {
  for (const host of ALL_HOST_CONFIGS) {
    for (const [name, render] of [['plan', generateCodexPlanReview], ['documentation', generateCodexDocReview]] as const) {
      test(`${host.name}: ${name} fallback names only the mode its preflight emits`, () => {
        const ctx: TemplateContext = { host: host.name, skillName: 'review', tmplPath: 'review/SKILL.md.tmpl', paths: HOST_PATHS[host.name] };
        const text = render(ctx);
        const mode = name === 'plan' || host.name === 'codex' ? 'under_current_harness' : 'under_codex';
        const preflight = text.match(/```bash\n([\s\S]*?)\n```/)![1];
        expect(preflight).toContain(mode);
        expect([...new Set(text.match(/under_codex|under_current_harness/g))]).toEqual([mode]);
        expect(text.includes("retain the section's native pass if defined")).toBe(false);

        const fallback = text.slice(text.indexOf('**Native fallback'), text.indexOf('Dispatch via the Agent tool'));
        const ownHarnessBranch = `On \`CODEX_MODE: ${mode}\``;
        expect(text.split(ownHarnessBranch)).toHaveLength(2);
        expect(fallback).toContain(ownHarnessBranch);
        expect(fallback).toContain('`outside_status: unavailable`');
        expect(fallback).toContain('run no outside CLI');
        expect(fallback).toContain('use the native subagent below');
        expectMentions(fallback, [['never', 'supplies', 'coverage']], 'fallback');
        expectMentions(fallback, [['never', 'disabled', 'fallback']], 'fallback');
        expect(fallback).toContain('`CODEX_MODE: disabled`, finish this section with `outside_status: disabled`;');
      });
    }
  }
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(TEMP, 'case-'));
  const repo = path.join(dir, "repo ' $(touch NEVER)");
  const home = path.join(dir, 'home');
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  const git = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' });
  if (git.status !== 0) throw new Error(git.stderr);
  const capture = path.join(dir, 'capture.json');
  const fake = path.join(dir, 'fake-claude.ts');
  fs.writeFileSync(fake, `const prompt=await Bun.stdin.text(); await Bun.write(process.env.FIXTURE_CAPTURE!,JSON.stringify({prompt,args:process.argv.slice(2)})); console.log(JSON.stringify({result:'No issues found.\\nRecommendation: ship because the isolated fixture completed its review.'}));`);
  const env = { ...process.env, HOME: home, CODEX_HOME: '', GSTACK_HOME: path.join(home, '.gstack'),
    GSTACK_ROOT: '', GSTACK_BIN: '', GSTACK_ACTIVE_HOST: 'codex', CODEX_THREAD_ID: 'fixture', CODEX_SANDBOX: '', CLAUDECODE: '',
    GSTACK_CLAUDE_BIN: process.execPath, GSTACK_CLAUDE_BIN_ARGS: JSON.stringify([fake]), FIXTURE_CAPTURE: capture };
  const install = (destination: string) => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(ROOT, destination, 'dir');
    return destination;
  };
  const local = path.join(repo, '.agents/skills/gstack');
  const global = path.join(home, '.codex/skills/gstack');
  const ctx: TemplateContext = { host: 'codex', model: 'gpt', skillName: 'review', tmplPath: 'review/SKILL.md.tmpl', paths: HOST_PATHS.codex };
  const run = (command: string, overrides: NodeJS.ProcessEnv = {}) => spawnSync('bash', ['-c', command], {
    cwd: repo, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10_000,
  });
  const preflight = (overrides: NodeJS.ProcessEnv = {}) => {
    const rendered = outsideVoicePreflight(ctx, { disabledBehavior: 'opt-in' });
    const command = rendered.match(/```bash\n([\s\S]*?)\n```/)![1];
    return run(`${command}\nprintf 'RESOLVED_ROOT: %s\\n' "$GSTACK_ROOT"`, overrides);
  };
  return { repo, home, env, local, global, ctx, capture, install, run, preflight };
}

describe('outside reviewer runtime discovery in fresh shells', () => {
  test('a repo-local installation resolves before any preamble exports exist', () => {
    const f = fixture();
    f.install(f.local);
    f.install(f.global);
    const result = f.preflight();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CODEX_MODE: ready');
    expect(result.stdout).toContain(`RESOLVED_ROOT: ${f.local}`);
    expect(result.stderr).toBe('');
    // The availability probe resolves a CLI; it must not dispatch a review.
    expect(fs.existsSync(f.capture)).toBe(false);
  });

  test('global installation and CODEX_HOME both work without a local installation', () => {
    const f = fixture();
    f.install(f.global);
    expect(f.preflight().stdout).toContain(`RESOLVED_ROOT: ${f.global}`);
    const codexHome = path.join(f.home, 'custom codex');
    const custom = f.install(path.join(codexHome, 'skills/gstack'));
    const result = f.preflight({ CODEX_HOME: codexHome });
    expect(result.stdout).toContain('CODEX_MODE: ready');
    expect(result.stdout).toContain(`RESOLVED_ROOT: ${custom}`);
  });

  test('valid explicit runtime roots take priority and stale roots fall back locally', () => {
    const f = fixture();
    f.install(f.local);
    const explicit = f.install(path.join(f.home, 'explicit runtime'));
    expect(f.preflight({ GSTACK_ROOT: explicit }).stdout).toContain(`RESOLVED_ROOT: ${explicit}`);
    // C1: only an exported GSTACK_ROOT (with bin/ and lib/) is honored; a lone GSTACK_BIN falls back to the repo-local install.
    expect(f.preflight({ GSTACK_BIN: path.join(explicit, 'bin') }).stdout).toContain(`RESOLVED_ROOT: ${f.local}`);
    const result = f.preflight({ GSTACK_ROOT: '/missing/gstack', GSTACK_BIN: '/missing/gstack/bin' });
    expect(result.stdout).toContain('CODEX_MODE: ready');
    expect(result.stdout).toContain(`RESOLVED_ROOT: ${f.local}`);
  });

  test('missing CLI reports not_installed rather than an import-path failure', () => {
    const f = fixture();
    f.install(f.local);
    const result = f.preflight({ GSTACK_CLAUDE_BIN: 'missing-gstack-claude-fixture-command' });
    expect(result.stdout).toContain('CODEX_MODE: not_installed');
    expect(result.stderr).toBe('');
    expect(fs.existsSync(f.capture)).toBe(false);
  });

  test('master switch is read from the discovered runtime before outside dispatch', () => {
    const f = fixture();
    f.install(f.local);
    const config = spawnSync(path.join(ROOT, 'bin/gstack-config'), ['set', 'codex_reviews', 'disabled'], {
      cwd: f.repo, env: f.env, encoding: 'utf8', timeout: 5000,
    });
    expect(config.status).toBe(0);
    const command = outsideVoicePreflight(f.ctx, { disabledBehavior: 'codex-only' }).match(/```bash\n([\s\S]*?)\n```/)![1];
    const result = f.run(command);
    expect(result.stdout).toContain('CODEX_MODE: disabled');
    expect(fs.existsSync(f.capture)).toBe(false);
  });

  test('invocation independently discovers runtime and sends the literal prompt', () => {
    const f = fixture();
    f.install(f.local);
    const prompt = path.join(f.repo, "prompt ' literal.txt");
    fs.writeFileSync(prompt, 'Review literal $(touch NEVER) and `touch NEVER` text.');
    const command = outsideVoiceCommand(f.ctx, { promptFile: prompt, timeoutMs: 3000 });
    const result = f.run(command);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OUTSIDE_STATUS: completed provider=claude-code host=codex');
    expect(JSON.parse(fs.readFileSync(f.capture, 'utf8')).prompt).toBe(fs.readFileSync(prompt, 'utf8'));
    expect(fs.existsSync(path.join(f.repo, 'NEVER'))).toBe(false);
  });
});

// Value: protects=the adversarial DIFF_SIZE sums insertions+deletions across files and ignores binary rows;
//   fails_when=the numstat/awk sum reads the wrong field or a binary "-" row breaks it; why_new=no test ran the
//   size block; seam=none; no_claim=the size thresholds that consume DIFF_SIZE
test('adversarial DIFF_SIZE counts changed lines from numstat', () => {
  const ctx: TemplateContext = { host: 'claude', skillName: 'ship', tmplPath: 'ship/SKILL.md.tmpl', paths: HOST_PATHS.claude };
  const fence = generateAdversarialStep(ctx).match(/```bash\n(DIFF_BASE=[\s\S]*?)\n```/);
  expect(fence).not.toBeNull();
  const repo = fs.mkdtempSync(path.join(TEMP, 'diff-size-'));
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(0);
  };
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\n');            // 1 insertion + 1 deletion
  fs.writeFileSync(path.join(repo, 'b.txt'), 'x\ny\nz\n');              // 3 insertions
  fs.writeFileSync(path.join(repo, 'c.bin'), Buffer.from([0, 1, 2, 0])); // binary: "-\t-" in numstat
  git('add', '-A');
  git('commit', '-qm', 'change');
  const r = spawnSync('bash', ['-c', fence![1].replaceAll('<base>', 'main')], { cwd: repo, encoding: 'utf8', timeout: 30_000 });
  expect(r.stderr).toBe('');
  expect(r.stdout.trim()).toBe('DIFF_SIZE: 5');
});
