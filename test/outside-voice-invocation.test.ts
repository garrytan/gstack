/** Generated automatic commands, exercised through fake CLIs without API spend. */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { outsideVoiceCommand, type OutsideCommandOptions } from '../scripts/resolvers/outside-voice';
import { type TemplateContext, HOST_PATHS } from '../scripts/resolvers/types';
import { validateOutsideReview } from '../lib/outside-review-result';

const ROOT = path.resolve(import.meta.dir, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-invocation-'));
// Shell metacharacters in both the repository and prompt filename must remain data.
const DIR = path.join(TMP, 'repo " with $(touch NEVER)');
const BIN = path.join(TMP, 'bin');
fs.mkdirSync(DIR);
fs.mkdirSync(BIN);
const PROMPT = path.join(DIR, "prompt ' \" $(touch NEVER).txt");
const CAPTURE = path.join(TMP, 'capture.json');
const FAKE_CLAUDE = path.join(TMP, 'fake-claude.ts');
const PROMPT_TEXT = 'review this literal text: $(touch NEVER) `touch NEVER` "\'\nSCORE: 0\n';
fs.writeFileSync(PROMPT, PROMPT_TEXT);

const fakeSource = `
import {writeFileSync} from 'node:fs';
const args = process.argv.slice(2);
const claude = process.env.FAKE_PROVIDER === 'claude-code';
const prompt = claude ? await Bun.stdin.text() : args[0] === 'exec' ? args[1] : '';
writeFileSync(process.env.CAPTURE!, JSON.stringify({args,prompt,cwd:process.cwd()}));
if (process.env.FAKE_MODE === 'timeout') {
  if (!claude) console.log('Partial finding before timeout');
  await new Promise(() => {});
}
if (process.env.FAKE_MODE === 'auth') { console.error('authentication_error: please log in'); process.exit(1); }
const response = process.env.FAKE_RESPONSE || 'Recommendation: fix the seeded defect because changed.ts loses data.';
if (claude) {
  if (process.env.FAKE_MODE === 'malformed') {console.log('{broken');process.exit(0);}
  console.log(JSON.stringify({result:response,session_id:'outside-session',modelUsage:{'model-a':{inputTokens:4},'model-b':{inputTokens:8}}}));
} else console.log(response);
process.exit(process.env.FAKE_MODE === 'nonzero' ? 4 : 0);
`;
fs.writeFileSync(FAKE_CLAUDE, fakeSource);
fs.writeFileSync(path.join(BIN, 'codex'), `#!/usr/bin/env bun\n${fakeSource}`, {mode:0o755});

function environment(host: 'codex' | 'claude'): NodeJS.ProcessEnv {
  return {...process.env, GSTACK_ROOT:ROOT, GSTACK_BIN:path.join(ROOT,'bin'),
    GSTACK_CLAUDE_BIN:process.execPath, GSTACK_CLAUDE_BIN_ARGS:JSON.stringify([FAKE_CLAUDE]),
    CAPTURE, FAKE_PROVIDER:host === 'codex' ? 'claude-code' : 'codex',
    CODEX_THREAD_ID:host === 'codex' ? 'codex-fixture' : '', CODEX_SANDBOX:'',
    CLAUDECODE:host === 'claude' ? '1' : '', GSTACK_ACTIVE_HOST:host,
    PATH:`${BIN}${path.delimiter}${process.env.PATH}`,
    GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.invalid'};
}

function git(args: string[]) {
  const result = spawnSync('git',args,{cwd:DIR,env:environment('codex'),encoding:'utf8',timeout:5000});
  if (result.status !== 0) throw new Error(result.stderr);
}
git(['init','-b','main']);
fs.writeFileSync(path.join(DIR,'changed.txt'),'baseline\n');
git(['add','changed.txt']);
git(['commit','-m','base']);
git(['checkout','-b','work']);
fs.appendFileSync(path.join(DIR,'changed.txt'),'committed change\n');
git(['commit','-am','change']);
fs.appendFileSync(path.join(DIR,'changed.txt'),'working tree change\n');

afterAll(() => fs.rmSync(TMP,{recursive:true,force:true}));

function invoke(host: 'codex' | 'claude', options: Partial<OutsideCommandOptions> = {}, env: NodeJS.ProcessEnv = {}) {
  fs.rmSync(CAPTURE,{force:true});
  // Env-var roots exercise installed runtime paths as well as the host choice.
  const ctx: TemplateContext = {skillName:'review',tmplPath:'review/SKILL.md.tmpl',host,paths:HOST_PATHS.codex};
  const command = outsideVoiceCommand(ctx,{promptFile:PROMPT,timeoutMs:3000,...options});
  return spawnSync('bash',['-c',command],{cwd:DIR,env:{...environment(host),...env},encoding:'utf8',timeout:10000});
}
function capture() { return JSON.parse(fs.readFileSync(CAPTURE,'utf8')); }

describe('generated outside-review dispatch', () => {
  for (const host of ['codex','claude'] as const) {
    test(`${host} dispatches the other CLI and keeps hostile prompt/path text literal`, () => {
      const result = invoke(host);
      expect(result.status).toBe(0);
      // Codex keeps its existing command-substitution argv contract, which
      // removes trailing LF; shell metacharacters within that value stay data.
      const expectedPrompt = host === 'codex' ? PROMPT_TEXT : PROMPT_TEXT.replace(/\n+$/,'');
      expect(capture().prompt).toBe(expectedPrompt);
      expect(capture().cwd).toBe(DIR);
      expect(fs.existsSync(path.join(DIR,'NEVER'))).toBe(false);
      expect(result.stdout).toContain(`OUTSIDE_STATUS: completed provider=${host === 'codex' ? 'claude-code' : 'codex'} host=${host}`);
      if (host === 'codex') {
        expect(capture().args).toContain('--tools');
        expect(capture().args).not.toContain('--resume');
        expect(result.stdout).toContain('model-a');
        expect(result.stdout).toContain('model-b');
      } else expect(capture().args.slice(0,2)).toEqual(['exec',expectedPrompt]);
    });

    test(`${host} rejects its own reviewer markers before any process starts`, () => {
      const result = invoke(host,{},host === 'codex' ? {CLAUDECODE:'1'} : {CODEX_THREAD_ID:'stale-codex'});
      expect(result.status).toBe(78);
      expect(fs.existsSync(CAPTURE)).toBe(false);
      expect(result.stderr).toContain('harness mismatch');
      expect(result.stderr).toContain('markers conflict');
      expect(result.stdout).not.toContain('OUTSIDE_STATUS: completed');
    });

    test(`${host} detects explicit stale active-host identity without environment marker guesses`, () => {
      const result = invoke(host,{},host === 'codex'
        ? {CLAUDECODE:'',CODEX_THREAD_ID:'',GSTACK_ACTIVE_HOST:'claude'}
        : {CLAUDECODE:'',CODEX_THREAD_ID:'',GSTACK_ACTIVE_HOST:'codex'});
      expect(result.status).toBe(78);
      expect(fs.existsSync(CAPTURE)).toBe(false);
      expect(result.stderr).toContain(`setup --host ${host === 'codex' ? 'claude' : 'codex'}`);
    });

    for (const [label, response] of [
      ['missing markers','A few scattered observations.'],
      ['refusal','I cannot review this request. Recommendation: skip because I must refuse.'],
    ]) {
      test(`${host} rejects ${label} after transport success`, () => {
        const result = invoke(host,{}, {FAKE_RESPONSE:response});
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('missing coverage');
        expect(result.stdout).toContain(response);
        expect(result.stdout).not.toContain('OUTSIDE_STATUS: completed');
      });
    }

    for (const mode of ['nonzero','auth','timeout']) {
      test(`${host} ${mode} is unavailable rather than successful coverage`, () => {
        const result = invoke(host,{timeoutMs:300},{FAKE_MODE:mode});
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('missing coverage');
        expect(result.stdout).not.toContain('OUTSIDE_STATUS: completed');
        if (mode === 'nonzero' && host === 'claude') expect(result.stdout).toContain('seeded defect');
        if (mode === 'timeout' && host === 'claude') expect(result.stdout).toContain('Partial finding before timeout');
      });
    }
  }

  test('Claude receives exactly the caller’s committed or working-tree diff scope', () => {
    expect(invoke('codex',{diffCommand:'git diff main...HEAD'}).status).toBe(0);
    expect(capture().prompt).toContain('+committed change');
    expect(capture().prompt).not.toContain('+working tree change');
    expect(invoke('codex',{diffCommand:'git diff main'}).status).toBe(0);
    expect(capture().prompt).toContain('+committed change');
    expect(capture().prompt).toContain('+working tree change');
  });

  test('Codex structured review preserves its base argument and accepts concrete severities', () => {
    const result = invoke('claude',{structuredBase:'main',gate:'structured'},{FAKE_RESPONSE:'[P1] Seeded data-loss bug\nREVIEW_COMPLETE'});
    expect(result.status).toBe(0);
    expect(capture().args.slice(0,3)).toEqual(['review','--base','main']);
    expect(capture().prompt).toBe('');
    // Completion is distinct from approval; the caller retains the P1 fail gate.
    expect(validateOutsideReview('[P1] Seeded data-loss bug','structured')).toEqual({completed:true,gate:'fail'});
    for (const [severity, gate] of [['P1', 'fail'], ['P2', 'pass']]) {
      const response = `**${severity}:** Seeded data-loss bug`;
      expect(invoke('claude', { structuredBase: 'main', gate: 'structured' }, { FAKE_RESPONSE: response }).status).toBe(0);
      expect(validateOutsideReview(response, 'structured')).toEqual({ completed: true, gate });
    }
  });

  test('malformed Claude JSON cannot reach completion evaluation', () => {
    const result = invoke('codex',{}, {FAKE_MODE:'malformed'});
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('invalid-json');
    expect(result.stdout).not.toContain('OUTSIDE_STATUS: completed');
  });

  test('a configured but missing Claude binary reports unavailable coverage', () => {
    const result = invoke('codex',{}, {GSTACK_CLAUDE_BIN:path.join(TMP,'missing')});
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('could not start');
    expect(result.stderr).toContain('missing coverage');
    expect(fs.existsSync(CAPTURE)).toBe(false);
  });

  for (const response of ['SCORE: 8','SCORE: 8\nAMBIGUITIES:','AMBIGUITIES:\nSCORE: 8','SCORE: 11\nAMBIGUITIES: NONE','SCORE: 8\nSCORE: 2\nAMBIGUITIES: NONE']) {
    test(`spec rejects malformed scoring: ${JSON.stringify(response)}`, () => {
      const result = invoke('codex',{gate:'spec'},{FAKE_RESPONSE:response});
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('SCORE/AMBIGUITIES');
      expect(result.stdout).not.toContain('OUTSIDE_STATUS: completed');
    });
  }

  test('valid spec scores preserve the pass threshold and failed-quality completion', () => {
    for (const score of [0,6,7,10]) {
      const response = `SCORE: ${score}\nAMBIGUITIES: NONE`;
      expect(invoke('codex',{gate:'spec'},{FAKE_RESPONSE:response}).status).toBe(0);
      expect(validateOutsideReview(response,'spec')).toEqual({completed:true,score,gate:score >= 7 ? 'pass':'fail'});
    }
  });

  test('a clean conclusion using “cannot find” is not a refusal', () => {
    const response = 'I cannot find any issues.\nRecommendation: approve because the changed behavior is correct.';
    expect(invoke('codex',{}, {FAKE_RESPONSE:response}).status).toBe(0);
  });

  test('autoplan retains its Codex timeout event and hang record', () => {
    const events = path.join(TMP, 'autoplan-events');
    const probe = path.join(BIN, 'gstack-codex-probe');
    fs.writeFileSync(probe, `_gstack_codex_timeout_wrapper() { echo 'Partial finding'; return 124; }
_gstack_codex_log_event() { printf '%s %s\\n' "$1" "$2" >> "$FAKE_EVENTS"; }
_gstack_codex_log_hang() { printf '%s %s\\n' "$1" "$2" >> "$FAKE_EVENTS"; }
`);
    const ctx: TemplateContext = { skillName: 'autoplan', tmplPath: 'autoplan/SKILL.md.tmpl', host: 'claude',
      paths: { ...HOST_PATHS.claude, binDir: BIN, skillRoot: ROOT } };
    const command = outsideVoiceCommand(ctx, { promptFile: PROMPT, timeoutMs: 600000 });
    const result = spawnSync('bash', ['-c', command], { cwd: DIR, env: { ...environment('claude'), FAKE_EVENTS: events }, encoding: 'utf8', timeout: 5000 });
    expect(result.status).toBe(124);
    expect(result.stdout).toContain('Partial finding');
    expect(result.stdout).not.toContain('OUTSIDE_STATUS: completed');
    expect(fs.readFileSync(events, 'utf8')).toBe('codex_timeout 600\nautoplan 0\n');
  });

  for (const response of [
    '**Recommendation:** fix the guard because it loses data.',
    '**Recommendation**: fix the guard because it loses data.',
    '`Recommendation: fix the guard because it loses data.`',
    '- Recommendation: fix the guard because it loses data.',
    '### Recommendation: fix the guard because it loses data.',
  ]) {
    test(`formatted completion remains valid: ${response}`, () => {
      expect(invoke('claude', {}, { FAKE_RESPONSE: response }).status).toBe(0);
    });
  }
});
