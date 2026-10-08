/** Generated automatic commands, exercised through fake CLIs without API spend. */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { outsideVoiceCommand, outsideVoiceInvocation, type OutsideCommandOptions } from '../scripts/resolvers/outside-voice';
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
import {existsSync,writeFileSync} from 'node:fs';
const args = process.argv.slice(2);
// The free sandbox preflight (\`codex sandbox ... true\`) succeeds unless a test plants its failure.
if (args[0] === 'sandbox') { if (process.env.FAKE_SANDBOX_STDERR) { console.error(process.env.FAKE_SANDBOX_STDERR); process.exit(1); } process.exit(0); }
const claude = process.env.FAKE_PROVIDER === 'claude-code';
const prompt = claude || (args[0] === 'exec' && args[1] === '-') ? await Bun.stdin.text() : args[0] === 'exec' ? args[1] : '';
writeFileSync(process.env.CAPTURE!, JSON.stringify({args,prompt,cwd:process.cwd()}));
if (process.env.FAKE_NOTICE_ACK) {
  const deadline = Date.now() + 1500;
  while (!existsSync(process.env.FAKE_NOTICE_ACK)) {
    if (Date.now() >= deadline) { console.error('policy notice was not forwarded before provider execution'); process.exit(17); }
    await Bun.sleep(10);
  }
  writeFileSync(process.env.FAKE_PAID_MARKER!, 'provider execution started');
}
if (process.env.FAKE_MODE === 'timeout') {
  if (!claude) console.log('Partial finding before timeout');
  await new Promise(() => {});
}
if (process.env.FAKE_MODE === 'auth') { console.error('authentication_error: please log in'); process.exit(1); }
const response = process.env.FAKE_RESPONSE || 'Medium: changed.ts loses data on retry.\\nRecommendation: fix the seeded defect because changed.ts loses data.';
if (claude) {
  if (process.env.FAKE_MODE === 'malformed') {console.log('{broken');process.exit(0);}
  console.log(JSON.stringify({result:response,session_id:'outside-session',modelUsage:{'model-a':{inputTokens:4},'model-b':{inputTokens:8}}}));
} else if (args.includes('-o')) {
  // codex exec --json -o <file>: events on stdout, the final message in <file>.
  writeFileSync(args[args.indexOf('-o') + 1], response);
  if (process.env.FAKE_EVENTS_FILE) process.stdout.write(await Bun.file(process.env.FAKE_EVENTS_FILE).text());
  else console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:response}}));
} else console.log(response);
if (process.env.FAKE_STDERR_FILE) process.stderr.write(await Bun.file(process.env.FAKE_STDERR_FILE).text());
process.exit(process.env.FAKE_MODE === 'nonzero' ? 4 : 0);
`;
fs.writeFileSync(FAKE_CLAUDE, fakeSource);
fs.writeFileSync(path.join(BIN, 'codex'), `#!/usr/bin/env bun\n${fakeSource}`, {mode:0o755});

function environment(host: 'codex' | 'claude'): NodeJS.ProcessEnv {
  return {...process.env, GSTACK_ROOT:ROOT, GSTACK_BIN:path.join(ROOT,'bin'),
    GSTACK_CLAUDE_BIN:process.execPath, GSTACK_CLAUDE_BIN_ARGS:JSON.stringify([FAKE_CLAUDE]),
    CAPTURE, FAKE_PROVIDER:host === 'codex' ? 'claude-code' : 'codex',
    CODEX_THREAD_ID:host === 'codex' ? 'codex-fixture' : '', CODEX_SANDBOX:'',
    CLAUDECODE:host === 'claude' ? '1' : '', GSTACK_ACTIVE_HOST:host, CODEX_HOME:TMP, GSTACK_CODEX_MODEL:'',
    GSTACK_HOME:path.join(TMP,'state'), GSTACK_STATE_ROOT:'', CODEX_API_KEY:'', OPENAI_API_KEY:'',
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
  test('Claude policy notice reaches the caller before provider execution, while diagnostics remain available', async () => {
    const state = fs.mkdtempSync(path.join(TMP, 'notice-state-'));
    const ack = path.join(state, 'caller-saw-notice');
    const paid = path.join(state, 'provider-started');
    const diagnostics = path.join(state, 'provider-stderr');
    fs.writeFileSync(diagnostics, 'provider diagnostic retained\n');
    const ctx: TemplateContext = { skillName: 'plan-eng-review', tmplPath: 'plan-eng-review/SKILL.md.tmpl', host: 'codex', paths: HOST_PATHS.codex };
    const command = outsideVoiceCommand(ctx, { promptFile: PROMPT, timeoutMs: 3000, role: 'plan-review' });
    const child = Bun.spawn(['bash', '-c', command], {
      cwd: DIR, env: { ...environment('codex'), HOME: TMP, CLAUDE_CONFIG_DIR: path.join(TMP, '.claude'),
        GSTACK_STATE_ROOT: state, GSTACK_CLAUDE_MODEL: '', FAKE_NOTICE_ACK: ack, FAKE_PAID_MARKER: paid, FAKE_STDERR_FILE: diagnostics },
      stdout: 'pipe', stderr: 'pipe', timeout: 8000,
    });
    const stdout = new Response(child.stdout).text();
    let stderr = '';
    const reader = child.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        stderr += decoder.decode(chunk.value, { stream: true });
        if (stderr.includes('NOTICE: gstack') && !fs.existsSync(ack)) {
          expect(fs.existsSync(paid)).toBe(false);
          fs.writeFileSync(ack, 'notice observed');
        }
      }
      expect(await child.exited).toBe(0);
      expect(await stdout).toContain('OUTSIDE_STATUS: completed provider=claude-code host=codex');
      expect(fs.existsSync(paid)).toBe(true);
      expect(stderr.match(/NOTICE: gstack/g)).toHaveLength(1);
      expect(stderr).toContain('CLAUDE_MODEL: plan-review via anthropic: claude-fable-5-1');
      expect(stderr).toContain('provider diagnostic retained');
    } finally {
      reader.releaseLock();
      if (child.exitCode === null) child.kill();
    }
  });

  for (const host of ['codex', 'claude'] as const) {
    test(`${host}: creative direction retains the completed recommendation gate`, () => {
      const options = { purpose: 'design-direction' as const };
      const completed = invoke(host, options, {
        FAKE_RESPONSE: 'Recommendation: use a cardless triage table because daily operators need to compare many rows quickly.',
      });
      expect(completed.status).toBe(0);
      expect(completed.stdout).toContain('OUTSIDE_STATUS: completed');
      for (const response of ['A blue palette could be nice.', 'I cannot provide a design proposal.']) {
        const incomplete = invoke(host, options, { FAKE_RESPONSE: response });
        expect(incomplete.status).not.toBe(0);
        expect(incomplete.stdout).not.toContain('OUTSIDE_STATUS: completed');
      }
    });
  }
  for (const host of ['codex','claude'] as const) {
    test(`${host} dispatches the other CLI and keeps hostile prompt/path text literal`, () => {
      const result = invoke(host);
      expect(result.status).toBe(0);
      // Both CLIs read the prepared prompt on stdin, byte for byte (E5: no argv
      // size limit, no quoting); shell metacharacters stay data.
      expect(capture().prompt).toBe(PROMPT_TEXT);
      expect(capture().cwd).toBe(DIR);
      expect(fs.existsSync(path.join(DIR,'NEVER'))).toBe(false);
      expect(result.stdout).toContain(`OUTSIDE_STATUS: completed provider=${host === 'codex' ? 'claude-code' : 'codex'} host=${host}`);
      if (host === 'codex') {
        expect(capture().args).toContain('--tools');
        expect(capture().args).not.toContain('--resume');
        expect(result.stdout).toContain('model-a');
        expect(result.stdout).toContain('model-b');
      } else expect(capture().args.slice(0,2)).toEqual(['exec','-']);
    });

    test(`${host} rejects its own reviewer markers before any process starts`, () => {
      const result = invoke(host,{},host === 'codex' ? {CLAUDECODE:'1'} : {CODEX_THREAD_ID:'stale-codex'});
      expect(result.status).toBe(78);
      expect(fs.existsSync(CAPTURE)).toBe(false);
      expect(result.stderr).toContain('harness mismatch');
      expect(result.stderr).toContain('markers conflict');
      expect(result.stdout).not.toContain('OUTSIDE_STATUS: completed');
    });

    test(`${host} reports mixed explicit/native conflicts without guessing a repair host`, () => {
      for (const markers of [
        {CLAUDECODE:'1', CODEX_THREAD_ID:'', CODEX_SANDBOX:'', GSTACK_ACTIVE_HOST:'codex'},
        {CLAUDECODE:'', CODEX_THREAD_ID:'codex-fixture', CODEX_SANDBOX:'', GSTACK_ACTIVE_HOST:'claude'},
      ]) {
        const result = invoke(host, {}, markers);
        expect(result.status).toBe(78);
        expect(fs.existsSync(CAPTURE)).toBe(false);
        expect(result.stderr).toContain('markers conflict');
        expect(result.stderr).toContain('setup --host <actual-harness>');
        expect(result.stderr).not.toContain('Repair installed skills: run setup --host');
        expect(result.stdout).not.toContain('OUTSIDE_STATUS: completed');
      }
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
    // Native review carries the review-kind selection in both settings and no skill catalog (#2914, #2847).
    expect(capture().args).toContain('review_model="gpt-6-astra"');
    expect(capture().args).toContain('model="gpt-6-astra"');
    expect(capture().args).toContain('skills.include_instructions=false');
    expect(capture().prompt).toBe('');
    // Completion is distinct from approval; the caller retains the P1 fail gate.
    expect(validateOutsideReview('[P1] Seeded data-loss bug','structured')).toEqual({completed:true,gate:'fail'});
    for (const [severity, gate] of [['P1', 'fail'], ['P2', 'pass']]) {
      const response = `**${severity}:** Seeded data-loss bug`;
      expect(invoke('claude', { structuredBase: 'main', gate: 'structured' }, { FAKE_RESPONSE: response }).status).toBe(0);
      expect(validateOutsideReview(response, 'structured')).toEqual({ completed: true, gate });
    }
  });

  test('INV-1: the generated caller branches on VERDICT: findings complete, untagged is unverified', () => {
    for (const host of ['claude', 'codex'] as const) {
      const findings = invoke(host, { structuredBase: 'main', gate: 'structured' }, { FAKE_RESPONSE: '[P0] Seeded corruption' });
      expect(findings.status).toBe(0);
      expect(findings.stdout).toContain('VERDICT: findings\nFINDINGS: P0\n');
      expect(findings.stdout).toContain('OUTSIDE_STATUS: completed');
      const untagged = invoke(host, { structuredBase: 'main', gate: 'structured' }, { FAKE_RESPONSE: 'The change reads fine to me.' });
      expect(untagged.status).toBe(4);
      expect(untagged.stdout).toContain('VERDICT: unverified');
      expect(untagged.stdout).toContain('OUTSIDE_STATUS: unverified');
      expect(untagged.stdout).not.toContain('OUTSIDE_STATUS: completed');
      expect(untagged.stderr).toContain('ran, verdict unverified');
    }
  });

  describe('B1: Codex sandbox failures are missing coverage, never a pass', () => {
    const FIX = path.join(ROOT, 'test', 'fixtures', 'codex-sandbox');
    const SANDBOX_LINE = "Codex outside review unavailable: Codex's sandbox could not start here (bwrap: No permissions to create new namespace";

    test('the free preflight stops before any paid call', () => {
      const result = invoke('claude', {}, { FAKE_SANDBOX_STDERR: fs.readFileSync(path.join(FIX, 'sandbox-userns-denied.stderr'), 'utf8') });
      expect(result.status).toBe(1);
      expect(fs.existsSync(CAPTURE)).toBe(false);
      expect(result.stderr).toContain(SANDBOX_LINE);
      expect(result.stdout).not.toContain('OUTSIDE_STATUS: completed');
    });

    test('exec: captured events where every command hit the sandbox are unavailable despite exit 0', () => {
      const result = invoke('claude', {}, { FAKE_EVENTS_FILE: path.join(FIX, 'exec-json-userns-denied.jsonl'),
        FAKE_RESPONSE: 'I could not run commands here. No issues found.\nRecommendation: ship because no issues were found.' });
      expect(result.status).toBe(1);
      expect(capture().args).toContain('--json');
      expect(result.stdout).toContain('REASON: sandbox_unavailable');
      expect(result.stderr).toContain(SANDBOX_LINE);
      expect(result.stdout).not.toContain('OUTSIDE_STATUS: completed');
    });

    test('structured review: captured container transcript on stderr is unavailable, healthy transcript completes', () => {
      const failed = invoke('claude', { structuredBase: 'main', gate: 'structured' }, {
        FAKE_RESPONSE: fs.readFileSync(path.join(FIX, 'review-userns-denied.stdout'), 'utf8'),
        FAKE_STDERR_FILE: path.join(FIX, 'review-userns-denied.stderr') });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain(SANDBOX_LINE);
      expect(failed.stdout).not.toContain('OUTSIDE_STATUS: completed');
      expect(capture().args).toContain('sandbox_mode="read-only"');
      const healthy = invoke('claude', { structuredBase: 'main', gate: 'structured' }, {
        FAKE_RESPONSE: '[P2] naming nit', FAKE_STDERR_FILE: path.join(FIX, 'review-healthy.stderr') });
      expect(healthy.status).toBe(0);
      expect(healthy.stdout).toContain('OUTSIDE_STATUS: completed');
    });

    test('GSTACK_CODEX_NO_SANDBOX=1 switches every site to full access, warns, and skips the preflight', () => {
      const env = { GSTACK_CODEX_NO_SANDBOX: '1', FAKE_SANDBOX_STDERR: 'bwrap: No permissions to create new namespace' };
      const exec = invoke('claude', {}, env);
      expect(exec.status).toBe(0);
      expect(capture().args.slice(capture().args.indexOf('-s'), capture().args.indexOf('-s') + 2)).toEqual(['-s', 'danger-full-access']);
      expect(exec.stderr).toContain('WARNING: GSTACK_CODEX_NO_SANDBOX=1: Codex runs this review without a sandbox');
      expect(invoke('claude', { structuredBase: 'main', gate: 'structured' }, { ...env, FAKE_RESPONSE: '[P2] nit' }).status).toBe(0);
      expect(capture().args).toContain('sandbox_mode="danger-full-access"');
      expect(invoke('claude', {}, { GSTACK_CODEX_NO_SANDBOX: 'true' }).status).toBe(0);
      expect(capture().args.slice(capture().args.indexOf('-s'), capture().args.indexOf('-s') + 2)).toEqual(['-s', 'read-only']);
    });
  });

  test('E5: a prompt larger than one argv string reaches Codex intact on stdin', () => {
    const big = path.join(TMP, 'big-prompt.txt');
    const text = `${'x'.repeat(200_000)}\n"quotes" 'single' $(touch NEVER) \\ end\n`;
    fs.writeFileSync(big, text);
    const ctx: TemplateContext = { skillName: 'review', tmplPath: 'review/SKILL.md.tmpl', host: 'claude', paths: HOST_PATHS.codex };
    const result = spawnSync('bash', ['-c', outsideVoiceCommand(ctx, { promptFile: big, timeoutMs: 5000 })], { cwd: DIR, env: environment('claude'), encoding: 'utf8', timeout: 15000 });
    expect(result.status).toBe(0);
    expect(capture().prompt).toBe(text);
    expect(fs.existsSync(path.join(DIR, 'NEVER'))).toBe(false);
  });

  test('Q2: the first automatic Codex review on a machine names the provider and account, once, without blocking', () => {
    const state = path.join(TMP, 'notice-state');
    const first = invoke('claude', {}, { GSTACK_HOME: state, OPENAI_API_KEY: 'sk-test-secret-value' });
    expect(first.status).toBe(0);
    expect(first.stderr).toContain('NOTICE: gstack outside reviews send the review prompt and code to Codex (provider: openai) using the API key in OPENAI_API_KEY.');
    expect(first.stderr).toContain('To turn them off: gstack-config set codex_reviews disabled');
    expect(first.stderr).not.toContain('sk-test-secret-value');
    expect(first.stdout).toContain('OUTSIDE_STATUS: completed');
    const second = invoke('claude', {}, { GSTACK_HOME: state, OPENAI_API_KEY: 'sk-test-secret-value' });
    expect(second.status).toBe(0);
    expect(second.stderr).not.toContain('NOTICE:');
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
    fs.writeFileSync(probe, `#!/usr/bin/env bash
case "$1" in
  select-model) printf 'CODEX_SEL: gpt-6-astra\\nCODEX_SEL_KIND: exec\\nCODEX_SANDBOX: read-only\\n' ;;
  check-sandbox|show-first-use-notice) ;;
  run-with-timeout) echo 'Partial finding'; exit 124 ;;
  log-event|log-hang) printf '%s %s\\n' "$2" "$3" >> "$FAKE_EVENTS" ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });
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
      expect(invoke('claude', {}, { FAKE_RESPONSE: `[P2] the guard drops one write.\n${response}` }).status).toBe(0);
    });
  }

  test('#2776: a provider that ignores TERM is killed at its deadline, keeping partial output', () => {
    const stubborn = path.join(TMP, 'stubborn-bin');
    const pidFile = path.join(TMP, 'stubborn.pid');
    fs.mkdirSync(stubborn, { recursive: true });
    fs.writeFileSync(path.join(stubborn, 'codex'), `#!/bin/bash
[ "$1" = sandbox ] && exit 0
trap '' TERM
echo $$ > "$STUBBORN_PID"
echo 'Partial finding before the deadline'
sleep 30
echo 'Recommendation: approve because the late answer arrived.'
`, { mode: 0o755 });
    const ctx: TemplateContext = { skillName: 'review', tmplPath: 'review/SKILL.md.tmpl', host: 'claude', paths: HOST_PATHS.codex };
    const command = outsideVoiceCommand(ctx, { promptFile: PROMPT, timeoutMs: 1000 });
    const started = Date.now();
    const result = spawnSync('bash', ['-c', command], { cwd: DIR, encoding: 'utf8', timeout: 10000,
      env: { ...environment('claude'), PATH: `${stubborn}${path.delimiter}${process.env.PATH}`, STUBBORN_PID: pidFile, _GSTACK_CODEX_KILL_AFTER: '1' } });
    expect(result.status).toBe(124);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(result.stdout).toContain('Partial finding before the deadline');
    expect(result.stdout).not.toContain('late answer');
    expect(result.stderr).toContain('missing coverage');
    expect(result.stdout).not.toContain('OUTSIDE_STATUS: completed');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test('#2914: an invalid model choice is unavailable coverage before any Codex process starts', () => {
    const result = invoke('claude', {}, { GSTACK_CODEX_MODEL: 'gpt"; touch NEVER; "' });
    expect(result.status).toBe(1);
    expect(fs.existsSync(CAPTURE)).toBe(false);
    expect(fs.existsSync(path.join(DIR, 'NEVER'))).toBe(false);
    expect(result.stderr).toContain('outside review unavailable; missing coverage');
    expect(result.stderr).toContain('GSTACK_CODEX_MODEL=<model>');
    expect(result.stdout).not.toContain('OUTSIDE_STATUS: completed');
  });

  test('#2914: the selected model and its source are printed before the call', () => {
    fs.writeFileSync(path.join(TMP, 'config.toml'), 'model = "gpt-5.6-terra"\n');
    try {
      const result = invoke('claude');
      expect(result.status).toBe(0);
      expect(result.stderr).toContain(`CODEX_MODEL: gpt-5.6-terra (exec; source: ${path.join(TMP, 'config.toml')} model)`);
      expect(capture().args).toContain('model="gpt-5.6-terra"');
      expect(capture().args).toContain('skills.include_instructions=false');
    } finally { fs.rmSync(path.join(TMP, 'config.toml'), { force: true }); }
  });

  test('#2776: every invocation derives its outer gate from the provider deadline, capped at 600000ms', () => {
    for (const host of ['claude', 'codex'] as const) {
      const ctx: TemplateContext = { skillName: 'review', tmplPath: 'review/SKILL.md.tmpl', host, paths: HOST_PATHS.claude };
      for (const [requested, provider] of [[120000, 120000], [300000, 300000], [540000, 540000], [600000, 540000]]) {
        const rendered = outsideVoiceInvocation(ctx, { timeoutMs: requested });
        const gates = [...rendered.matchAll(/timeout: (\d+)/g)].map(m => Number(m[1]));
        expect(gates).toEqual([provider + 60000]);
        expect(rendered).toContain(host === 'claude' ? `run-with-timeout ${provider / 1000} codex` : `--timeout-ms ${provider}`);
      }
    }
  });
});
