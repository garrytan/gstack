/** Execute each complete generated wrapper fence in its own fresh shell. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-code-skill-'));
const RENDER = path.join(DIR, 'render');
const REPO = path.join(DIR, 'repo');
const SCRATCH = path.join(DIR, 'scratch');
const RUNTIME = path.join(DIR, 'runtime " with $(touch NEVER)');
const BAD_RUNTIME = path.join(DIR, 'bad-runtime');
const PROMPT = path.join(DIR, "prompt ' with $(touch NEVER).txt");
const PROMPT_TEXT = 'Review literal text: $(touch NEVER) `touch NEVER` "\'\n';
const FAKE = path.join(DIR, 'claude.ts');
const CAPTURE = path.join(DIR, 'capture.json');
const q = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
type Mode = 'review' | 'challenge' | 'consult';
const fences = {} as Record<Mode, string>;
const ENV = { ...process.env, GSTACK_CLAUDE_BIN:process.execPath, GSTACK_CLAUDE_BIN_ARGS:JSON.stringify([FAKE]), CAPTURE,
  CLAUDECODE:'', CODEX_THREAD_ID:'test-codex', CODEX_SANDBOX:'', GSTACK_ACTIVE_HOST:'codex',
  GIT_AUTHOR_NAME:'Test', GIT_AUTHOR_EMAIL:'test@example.invalid', GIT_COMMITTER_NAME:'Test', GIT_COMMITTER_EMAIL:'test@example.invalid',
  TMPDIR:SCRATCH,
};

function git(args: string[], cwd = REPO) {
  const result = spawnSync('git', args, {cwd, env:ENV, encoding:'utf8', timeout:5000});
  if (result.status !== 0) throw new Error(result.stderr);
}

beforeAll(() => {
  for (const dir of [REPO, SCRATCH, path.join(BAD_RUNTIME, 'bin')]) fs.mkdirSync(dir, {recursive:true});
  fs.symlinkSync(ROOT, RUNTIME, 'dir');
  fs.symlinkSync(path.join(ROOT, 'lib'), path.join(BAD_RUNTIME, 'lib'), 'dir');
  fs.writeFileSync(path.join(BAD_RUNTIME, 'bin/gstack-claude-code'), '#!/usr/bin/env bash\nprintf "%s\\n" "$RAW_CAPTURE"\n', {mode:0o755});
  fs.writeFileSync(FAKE, `
import {writeFileSync} from 'node:fs';
const prompt = await Bun.stdin.text();
writeFileSync(process.env.CAPTURE!,JSON.stringify({args:process.argv.slice(2),prompt}));
if(process.env.FAKE_ERROR) {process.stdout.write('{broken');process.exit(0);}
console.log(JSON.stringify({result:process.env.FAKE_TEXT || '[P1] Review found a defect.',session_id:'consult-session',modelUsage:{'model-a':{},'model-b':{}}}));
`);
  git(['init','-b','main']);
  fs.writeFileSync(path.join(REPO, 'changed.txt'), 'baseline\n');
  git(['add','changed.txt']);
  git(['commit','-m','baseline']);
  git(['remote','add','origin','.']);
  git(['checkout','-b','work']);
  fs.appendFileSync(path.join(REPO, 'changed.txt'), 'committed change\n');
  git(['commit','-am','change']);
  fs.appendFileSync(path.join(REPO, 'changed.txt'), 'working tree change\n');

  // Output-only generation: no mutation of the checkout's active host renders.
  const generated = spawnSync(process.execPath, ['run', 'scripts/gen-skill-docs.ts', '--host', 'codex', '--out-dir', RENDER], {
    cwd:ROOT, encoding:'utf8', timeout:120000,
  });
  if (generated.status !== 0) throw new Error(generated.stderr);
  const content = fs.readFileSync(path.join(RENDER, '.agents/skills/gstack-claude-code/SKILL.md'), 'utf8');
  for (const mode of ['review','challenge','consult'] as const) {
    const heading = `## ${mode[0].toUpperCase() + mode.slice(1)} mode`;
    const start = content.indexOf(heading);
    const end = content.indexOf('\n## ', start + heading.length);
    if (start === -1) throw new Error(`Missing generated ${mode} section`);
    const section = content.slice(start, end === -1 ? undefined : end);
    const matches = [...section.matchAll(/```bash\n([\s\S]*?)\n```/g)];
    if (matches.length !== 1) throw new Error(`${mode} must have exactly one executable fence, found ${matches.length}`);
    fences[mode] = matches[0][1];
  }
});
afterAll(() => fs.rmSync(DIR, {recursive:true, force:true}));

function shell(mode: Mode, extra: NodeJS.ProcessEnv = {}, options: {resume?: boolean; runtime?: string; cwd?: string} = {}) {
  fs.rmSync(CAPTURE, {force:true});
  fs.writeFileSync(PROMPT, PROMPT_TEXT, {mode:0o600});
  // These are precisely the literal substitutions the skill requests. Do not
  // prepend setup, merge fences, or supply state from a prior shell invocation.
  const script = fences[mode]
    .replace("'<prepared-prompt-file>'", q(PROMPT))
    .replace("'<gstack-runtime-root>'", q(options.runtime ?? RUNTIME))
    .replace("'<base>'", q('main'))
    .replace("'<fresh-or-resume>'", q(options.resume ? 'resume' : 'fresh'));
  return spawnSync('bash', ['-c',script], {cwd:options.cwd ?? REPO, env:{...ENV,...extra}, encoding:'utf8',timeout:10000});
}
function captured() { return JSON.parse(fs.readFileSync(CAPTURE,'utf8')); }
function expectTempsCleaned() {
  expect(fs.existsSync(PROMPT)).toBe(false);
  expect(fs.readdirSync(SCRATCH)).toEqual([]);
  expect(fs.existsSync(path.join(REPO,'NEVER'))).toBe(false);
}
function saveSession(id: string) {
  fs.mkdirSync(path.join(REPO,'.context'),{recursive:true});
  fs.writeFileSync(path.join(REPO,'.context/claude-session-id'),id + '\n');
}
function savedSession() { return fs.readFileSync(path.join(REPO,'.context/claude-session-id'),'utf8'); }

describe('complete generated Claude Code wrapper modes', () => {
  for (const mode of ['review','challenge','consult'] as const) {
    test(`${mode} stale wrapper refuses and cleans its prompt before spawning`, () => {
      const result = shell(mode,{CLAUDECODE:'1',CODEX_THREAD_ID:'',GSTACK_ACTIVE_HOST:'claude'});
      expect(result.status).toBe(78);
      expect(fs.existsSync(CAPTURE)).toBe(false);
      expect(result.stderr).toContain('setup --host claude');
      expectTempsCleaned();
    });
  }
  for (const mode of ['review','challenge'] as const) {
    test(`${mode} independently captures committed and working-tree context with no tools`, () => {
      const result = shell(mode);
      expect(result.status).toBe(0);
      expect(captured().prompt).toStartWith(PROMPT_TEXT);
      expect(captured().prompt).toContain('+committed change');
      expect(captured().prompt).toContain('+working tree change');
      const args = captured().args;
      expect(args[args.indexOf('--tools') + 1]).toBe('');
      expect(args).not.toContain('--resume');
      expect(result.stdout).toContain('[P1] Review found a defect.');
      expect(result.stdout).toContain('model-a');
      expect(result.stdout).toContain('model-b');
      expectTempsCleaned();
    });
    for (const response of ['I cannot review this request. NO_FINDINGS', 'Several observations without a severity.']) {
      test(`${mode} rejects refusal or missing markers after a valid runner completion: ${response}`, () => {
        const result = shell(mode, {FAKE_TEXT:response});
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('missing outside coverage');
        expectTempsCleaned();
      });
    }
  }

  test('fresh and continued consult each run independently and preserve a literal session argument', () => {
    const first = shell('consult', {FAKE_TEXT:'The configuration lives in settings.ts.'});
    expect(first.status).toBe(0);
    expect(captured().prompt).toBe(PROMPT_TEXT);
    const args = captured().args;
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(args).not.toContain('--resume');
    expect(savedSession()).toBe('consult-session\n');
    expectTempsCleaned();
    const previous = 'session " with spaces $(touch NEVER)';
    saveSession(previous);
    const continued = shell('consult', {}, {resume:true});
    expect(continued.status).toBe(0);
    const resumedArgs = captured().args;
    expect(resumedArgs[resumedArgs.indexOf('--resume') + 1]).toBe(previous);
    expect(savedSession()).toBe('consult-session\n');
    expectTempsCleaned();
  });

  test('failed resumed invocation cleans captures without overwriting its previous session', () => {
    saveSession('previous-session');
    const result = shell('consult', {FAKE_ERROR:'1'}, {resume:true});
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('invalid-json');
    expect(savedSession()).toBe('previous-session\n');
    expectTempsCleaned();
  });

  test('complete mode fences reject malformed, false-success and empty runner captures', () => {
    for (const raw of ['{broken','[]','{"status":"error","result":"NO_FINDINGS"}','{"status":"completed","is_error":true,"result":"NO_FINDINGS"}','{"status":"completed","result":" "}']) {
      for (const mode of ['review','challenge','consult'] as const) {
        saveSession('previous-session');
        const result = shell(mode, {RAW_CAPTURE:raw}, {runtime:BAD_RUNTIME});
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('CLAUDE_CODE_ERROR');
        expect(savedSession()).toBe('previous-session\n');
        expectTempsCleaned();
      }
    }
  });

  test('an explicit clean review preserves unknown model identity', () => {
    const result = shell('review', {RAW_CAPTURE:'{"status":"completed","result":"NO_FINDINGS"}'}, {runtime:BAD_RUNTIME});
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('NO_FINDINGS');
    expect(result.stdout).toContain('Model: unknown');
    expectTempsCleaned();
  });

  test('missing resume session stops before a provider call', () => {
    fs.rmSync(path.join(REPO,'.context/claude-session-id'), {force:true});
    const result = shell('consult', {}, {resume:true});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no saved Claude Code session');
    expect(fs.existsSync(CAPTURE)).toBe(false);
    expectTempsCleaned();
  });

  test('an empty branch diff stops before invoking Claude Code', () => {
    const clean = path.join(DIR, 'clean-repo');
    fs.mkdirSync(clean);
    git(['init','-b','main'], clean);
    fs.writeFileSync(path.join(clean, 'file.txt'), 'unchanged\n');
    git(['add','file.txt'], clean);
    git(['commit','-m','baseline'], clean);
    for (const mode of ['review','challenge'] as const) {
      const result = shell(mode, {}, {cwd:clean});
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Nothing to review');
      expect(fs.existsSync(CAPTURE)).toBe(false);
      expectTempsCleaned();
    }
  });
});
