/** Free installed-runtime probe through the real PTY launcher; no provider calls. */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
const ROOT = path.resolve(import.meta.dir, '..');
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('hermetic seeded PTY runtime', () => {
  test('runtime helper and regression select every PTY consumer', () => {
    const consumers = Object.entries(E2E_TOUCHFILES).filter(([, files]) => files.includes('test/helpers/claude-pty-runner.ts')).map(([name]) => name).sort();
    expect(consumers.length).toBeGreaterThan(15);
    for (const file of ['test/helpers/hermetic-skill-runtime.ts', 'test/hermetic-skill-runtime.test.ts'])
      expect(selectTests([file], E2E_TOUCHFILES).selected.sort()).toEqual(consumers);
  });
  test.skipIf(process.platform === 'win32')('uses current lazy files and tools with scoped access, preserving auth, caches, and explicit overrides', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-runtime-probe-'));
    const operatorHome = path.join(dir, 'operator-home');
    const oldRoot = path.join(operatorHome, '.claude', 'skills', 'gstack');
    const section = 'autoplan/sections/ceo-phase.md';
    fs.mkdirSync(path.join(oldRoot, 'autoplan', 'sections'), { recursive:true });
    fs.mkdirSync(path.join(oldRoot, 'bin'));
    fs.writeFileSync(path.join(oldRoot, section), 'STALE OPERATOR PHASE\n');
    fs.writeFileSync(path.join(oldRoot, 'bin/gstack-config'), '#!/bin/sh\necho stale-runtime\n', { mode:0o755 });
    const state = path.join(dir, 'state');
    fs.mkdirSync(state);
    fs.writeFileSync(path.join(state, 'config.yaml'), 'codex_reviews: disabled\n');
    const codexDefault = path.join(operatorHome, '.codex');
    const codexConfigured = path.join(dir, 'configured-codex');
    const codexOverride = path.join(dir, 'override-codex');
    for (const home of [codexDefault,codexConfigured,codexOverride]) {
      fs.mkdirSync(home);
      fs.writeFileSync(path.join(home,'config.toml'), 'model = "unchanged-fixture-model"\n');
      fs.writeFileSync(path.join(home,'auth.json'), '{"fixture_auth":true}\n');
    }
    const customConfig = path.join(dir,'custom-config');
    fs.mkdirSync(customConfig);
    const fake = path.join(dir,'fake-claude');
    fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = path.join(process.env.HOME,'.claude','skills','gstack');
const args = process.argv.slice(2);
const addDir = args.includes('--add-dir') ? args[args.indexOf('--add-dir')+1] : null;
const phase = spawnSync('bash',['-c','cat ~/.claude/skills/gstack/autoplan/sections/ceo-phase.md'],{timeout:5000});
const config = spawnSync('bash',['-c','"$HOME/.claude/skills/gstack/bin/gstack-config" get codex_reviews'],{timeout:5000});
const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME,'.codex');
const record = {
  pid:process.pid, home:process.env.HOME, root:fs.realpathSync(root), args,
  phaseExit:phase.status, phaseHash:createHash('sha256').update(phase.stdout).digest('hex'),
  configExit:config.status, configValue:config.stdout.toString().trim(),
  configDir:process.env.CLAUDE_CONFIG_DIR, state:process.env.GSTACK_HOME,
  runtimeAllowed:addDir !== null && fs.realpathSync(addDir) === fs.realpathSync(root),
  claudeAuthPreserved:process.env.ANTHROPIC_API_KEY === 'fixture-api-key',
  codexHome, codexConfig:fs.readFileSync(path.join(codexHome,'config.toml'),'utf8'),
  codexAuthPreserved:JSON.parse(fs.readFileSync(path.join(codexHome,'auth.json'),'utf8')).fixture_auth === true,
  browserCache:process.env.PLAYWRIGHT_BROWSERS_PATH,
};
fs.writeFileSync(process.env.RUNTIME_RECORD,JSON.stringify(record));
if (process.env.RUNTIME_FAIL === '1') throw new Error('fixture startup failure');
process.stdout.write('RUNTIME_PROBE_READY\n');
process.stdin.resume();
`);
    fs.chmodSync(fake,0o755);
    const runner = pathToFileURL(path.join(ROOT,'test/helpers/claude-pty-runner.ts')).href;
    const cases = [
      {name:'seeded-default',seed:true,owned:true},
      {name:'seeded-startup-failure',seed:true,owned:true,failure:true},
      {name:'seeded-configured-codex',seed:true,owned:true,configuredCodex:codexConfigured},
      {name:'seeded-reset-codex',seed:true,owned:true,configuredCodex:codexConfigured,overrides:{CODEX_HOME:''}},
      {name:'seeded-overrides',seed:true,owned:true,configuredCodex:codexConfigured,overrides:{CODEX_HOME:codexOverride,PLAYWRIGHT_BROWSERS_PATH:'0'}},
      {name:'unseeded',seed:false,owned:false},
      {name:'explicit-home',seed:true,owned:false,overrides:{HOME:operatorHome}},
      {name:'explicit-config',seed:true,owned:false,overrides:{CLAUDE_CONFIG_DIR:customConfig}},
      {name:'legacy',seed:true,owned:false,legacy:true},
    ];
    const children: Array<ReturnType<typeof Bun.spawn>> = [];
    const records: string[] = [];
    const originalSection = digest(path.join(oldRoot,section));
    try {
      for (const item of cases) {
        const record = path.join(dir,item.name+'.json'); records.push(record);
        const worker = path.join(dir,item.name+'.ts');
        fs.writeFileSync(worker, `
import { launchClaudePty } from ${JSON.stringify(runner)};
const session = await launchClaudePty({seedSkills:${item.seed},timeoutMs:10000,
  model:'unchanged-claude-model',env:${JSON.stringify({GSTACK_HOME:state,RUNTIME_RECORD:record,RUNTIME_FAIL:item.failure?'1':'0',...item.overrides})}});
try {
  let failed = false;
  try { await session.waitFor('RUNTIME_PROBE_READY',{timeoutMs:7000,pollMs:20}); }
  catch (error) { failed = true; if (!${Boolean(item.failure)}) throw error; }
  if (failed !== ${Boolean(item.failure)}) throw new Error('unexpected startup outcome');
} finally { await session.close(); }
`);
        const child = Bun.spawn([process.execPath,worker], {
          env:{...process.env,HOME:operatorHome,ANTHROPIC_API_KEY:'fixture-api-key',CODEX_HOME:item.configuredCodex,
            PLAYWRIGHT_BROWSERS_PATH:undefined,EVALS_HERMETIC:item.legacy?'0':'1',BROWSE_TERMINAL_BINARY:fake},
          stdout:'pipe',stderr:'pipe',
        });
        children.push(child);
        const timer = setTimeout(() => child.kill('SIGKILL'),15000);
        try {
          const [code,stdout,stderr] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
          expect(code,item.name+'\n'+stdout+stderr).toBe(0);
        } finally { clearTimeout(timer); }
        const result = JSON.parse(fs.readFileSync(record,'utf8'));
        expect(result.claudeAuthPreserved).toBe(true);
        expect(result.codexAuthPreserved).toBe(true);
        expect(result.codexConfig).toBe('model = "unchanged-fixture-model"\n');
        expect(result.args.slice(0,4)).toEqual(['--model','unchanged-claude-model','--permission-mode','plan']);
        expect(result.state).toBe(state);
        expect(result.phaseExit).toBe(0); expect(result.configExit).toBe(0);
        if (item.owned) {
          expect(result.phaseHash).toBe(digest(path.join(ROOT,section)));
          expect(result.home).not.toBe(operatorHome);
          expect(result.root).toBe(fs.realpathSync(ROOT));
          expect(result.configValue).toBe('disabled'); expect(result.runtimeAllowed).toBe(true);
          const expectedCodex = item.overrides?.CODEX_HOME !== undefined
            ? item.overrides.CODEX_HOME || codexDefault : item.configuredCodex || codexDefault;
          expect(result.codexHome).toBe(expectedCodex);
          const cacheBase = process.platform === 'darwin' ? path.join(operatorHome,'Library','Caches') : path.join(operatorHome,'.cache');
          expect(result.browserCache).toBe(item.overrides?.PLAYWRIGHT_BROWSERS_PATH || path.join(cacheBase,'ms-playwright'));
          expect(fs.existsSync(result.home)).toBe(false);
        } else {
          expect(result.home).toBe(operatorHome); expect(result.phaseHash).toBe(originalSection);
          expect(result.configValue).toBe('stale-runtime'); expect(result.runtimeAllowed).toBe(false);
        }
        if (item.name === 'explicit-config') expect(result.configDir).toBe(customConfig);
        expect(() => process.kill(result.pid,0)).toThrow();
      }
      expect(digest(path.join(oldRoot,section))).toBe(originalSection);
      expect(fs.readFileSync(path.join(state,'config.yaml'),'utf8')).toBe('codex_reviews: disabled\n');
      expect(fs.readdirSync(path.join(operatorHome,'.claude'))).toEqual(['skills']);
    } finally {
      for (const child of children) try { child.kill('SIGKILL'); } catch { /* already reaped */ }
      for (const file of records) if (fs.existsSync(file)) {
        try { process.kill(JSON.parse(fs.readFileSync(file,'utf8')).pid,'SIGKILL'); } catch { /* already reaped */ }
      }
      fs.rmSync(dir,{recursive:true,force:true});
    }
  },120000);
});
